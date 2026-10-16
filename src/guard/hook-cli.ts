/**
 * `stagent hook pre-tool-use`（规格 §6）：Claude Code 每次调用 Write / Edit / MultiEdit / NotebookEdit / Bash 前执行。
 *
 * - 在线：.stagent/service.lock 指向一个活着的服务 → 把 stdin 原样 POST 到 /api/guard/pre-tool-use，
 *   由服务判定并写 guard.blocked（服务是账本唯一的写入者）。
 * - 离线：没有服务 → 只读打开账本算锁定路径，按 draftAllowed=false 判定；拒绝时直接追加 guard.blocked（账本未锁定才写）。
 * - 服务锁里的进程还活着但请求失败（卡住、超时）→ 本地判定但不写账本，避免两个进程同时写同一条事件链。
 *
 * 输出遵循 Claude Code hook 约定：拒绝时 stdout 打印 hookSpecificOutput JSON 并 exit 0；放行时不输出任何内容
 * （不强制 allow，交给正常的权限流程）。任何异常都不会让进程崩溃：退化为不读账本的本地判定，
 * 所以服务挂了也不会让 .stagent/ 失守（fail-closed）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { Ledger } from '../ledger/ledger.js';
import { SERVICE_LOCK_RELATIVE_PATH } from '../server/service-lock.js';
import { findProjectRoot, lockedCheckPaths, realpathNearest } from './context.js';
import { decidePreToolUse, parsePreToolUse, type GuardDecision, type PreToolUseInput } from './decide.js';
import { compileBashRules } from './rules.js';

export const HOOK_TIMEOUT_MS = 3_000;

export interface HookOptions {
  stdin: string;
  /** 项目根目录；默认从 hook 输入的 cwd 向上找 .stagent/。 */
  root?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface HookResult {
  stdout: string;
  /** 给人看的诊断信息（Claude Code 不会把 stderr 给模型看）。 */
  stderr: string;
  exitCode: number;
  /** 判定来源，测试与诊断用。 */
  mode: 'ignored' | 'online' | 'offline';
  decision: 'allow' | 'deny';
}

export async function runPreToolUseHook(opts: HookOptions): Promise<HookResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(opts.stdin);
  } catch {
    return result('ignored', null, '');
  }
  const hook = parsePreToolUse(raw);
  if (!hook || hook.hook_event_name !== 'PreToolUse') return result('ignored', null, '');

  const env = opts.env ?? process.env;
  const root = resolve(
    opts.root ??
      (hook.cwd ? findProjectRoot(hook.cwd) : null) ??
      (env.CLAUDE_PROJECT_DIR ? findProjectRoot(env.CLAUDE_PROJECT_DIR) : null) ??
      process.cwd(),
  );

  try {
    const service = readServiceLock(root);
    if (service) {
      const online = await askService(service.port, raw, opts.fetchImpl ?? fetch, opts.timeoutMs ?? HOOK_TIMEOUT_MS);
      if (online) {
        const d: GuardDecision =
          online.decision === 'deny'
            ? { decision: 'deny', reason: online.reason ?? '已被 Stagent 守卫拦截', path: '', tool: hook.tool_name }
            : { decision: 'allow' };
        return result('online', d, '');
      }
      // 服务还活着但没回答：本地判定，不写账本。
      const { d, warnings } = await offlineDecide(root, hook, false);
      return result('offline', d, [`stagent: 服务（端口 ${service.port}）未响应，已本地判定`, ...warnings].join('\n'));
    }
    const { d, warnings } = await offlineDecide(root, hook, true);
    return result('offline', d, warnings.join('\n'));
  } catch (err) {
    const d = decidePreToolUse(hook, { projectRoot: root, lockedCheckPaths: new Set(), draftAllowed: false, extraBashRules: [] });
    return result('offline', d, `stagent: 守卫出错，已按默认规则判定：${(err as Error).message}`);
  }
}

async function offlineDecide(
  root: string,
  hook: PreToolUseInput,
  mayWrite: boolean,
): Promise<{ d: GuardDecision; warnings: string[] }> {
  let ledger: Ledger | null = null;
  try {
    ledger = await Ledger.open(root);
  } catch {
    // 没有账本（未 init）或版本不符：仍按默认规则拦截
  }
  let extra: string[] = [];
  try {
    extra = (await loadConfig(root)).guard.bashRules;
  } catch {
    // 配置坏了只用默认规则
  }
  const compiled = compileBashRules(extra);
  const d = decidePreToolUse(
    hook,
    {
      projectRoot: root,
      lockedCheckPaths: lockedCheckPaths(ledger?.events() ?? []),
      draftAllowed: false,
      extraBashRules: extra,
      realpath: realpathNearest,
    },
    compiled.rules,
  );
  if (d.decision === 'deny' && mayWrite && ledger && ledger.state === 'ok') {
    try {
      await ledger.append({ type: 'guard.blocked', path: d.path, tool: d.tool, detail: d.reason });
    } catch {
      // 写不进账本（如刚被篡改而锁定）不影响拦截
    }
  }
  return { d, warnings: compiled.warnings.map((w) => `stagent: ${w}`) };
}

interface LockInfo {
  pid: number;
  port: number;
}

/** 读服务锁：进程还活着且已写入端口才算在线。 */
function readServiceLock(root: string): LockInfo | null {
  const path = join(root, SERVICE_LOCK_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; port?: unknown };
    if (typeof info.pid !== 'number' || typeof info.port !== 'number' || !isAlive(info.pid)) return null;
    return { pid: info.pid, port: info.port };
  } catch {
    return null;
  }
}

async function askService(
  port: number,
  body: unknown,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ decision: 'allow' | 'deny'; reason?: string } | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/guard/pre-tool-use`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { decision?: unknown; reason?: unknown };
    if (json.decision !== 'allow' && json.decision !== 'deny') return null;
    return { decision: json.decision, ...(typeof json.reason === 'string' ? { reason: json.reason } : {}) };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function result(mode: HookResult['mode'], d: GuardDecision | null, stderr: string): HookResult {
  if (!d || d.decision === 'allow') return { stdout: '', stderr, exitCode: 0, mode, decision: 'allow' };
  return { stdout: denyOutput(d.reason), stderr, exitCode: 0, mode, decision: 'deny' };
}

/** Claude Code PreToolUse 的拒绝输出。 */
export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Stagent 守卫：${reason}` },
  });
}
