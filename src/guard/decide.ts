/**
 * PreToolUse 判定（规格 §6 守卫·写时拦截）：纯函数，输入是 Claude Code hook 的 stdin JSON。
 *
 * - Write / Edit / MultiEdit / NotebookEdit：目标在项目 .stagent/ 下 → 拒绝；锁定检查给出专门的原因；
 *   `.stagent/checks/draft/**` 只对「确认例子」阶段的起草会话放行（draftAllowed）。项目根目录之外的文件不归我们管。
 * - Bash：命中危险命令规则（rules.ts，含 config.guard.bashRules）→ 拒绝。
 * - 其余工具与无法识别的输入一律放行（不输出任何决定，交给 Claude Code 正常的权限流程）。
 *
 * 路径先按 hook 的 cwd 解析成绝对路径，再相对项目根目录归一化，`..` 穿越因此无效；
 * 调用方可传 realpath 解析符号链接（例如 `ln -s .stagent x` 后写 x/ledger/...）。
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { compileBashRules, matchBashRules, type BashRule } from './rules.js';

export const GUARDED_FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

export interface GuardContext {
  projectRoot: string;
  /** 当前锁定检查的路径（相对项目根目录，/ 分隔）。 */
  lockedCheckPaths: ReadonlySet<string>;
  draftAllowed: boolean;
  /** config.guard.bashRules。 */
  extraBashRules: readonly string[];
  /** 把绝对路径解析成真实路径（跟随符号链接）；默认不解析。 */
  realpath?: (absPath: string) => string;
}

export type GuardDecision =
  | { decision: 'allow' }
  | {
      decision: 'deny';
      reason: string;
      /** 文件工具：相对项目根目录的路径；Bash：命令（截断到 200 字）。 */
      path: string;
      tool: string;
      ruleId?: string;
    };

export interface PreToolUseInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

const ALLOW: GuardDecision = { decision: 'allow' };

/** 宽松解析 hook 输入；不是 PreToolUse 事件或缺字段返回 null。 */
export function parsePreToolUse(input: unknown): PreToolUseInput | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (o.hook_event_name !== undefined && o.hook_event_name !== 'PreToolUse') return null;
  if (typeof o.tool_name !== 'string') return null;
  if (typeof o.tool_input !== 'object' || o.tool_input === null || Array.isArray(o.tool_input)) return null;
  return {
    tool_name: o.tool_name,
    tool_input: o.tool_input as Record<string, unknown>,
    ...(typeof o.session_id === 'string' ? { session_id: o.session_id } : {}),
    ...(typeof o.cwd === 'string' ? { cwd: o.cwd } : {}),
    ...(typeof o.hook_event_name === 'string' ? { hook_event_name: o.hook_event_name } : {}),
  };
}

export function decidePreToolUse(input: unknown, ctx: GuardContext, rules?: readonly BashRule[]): GuardDecision {
  const hook = parsePreToolUse(input);
  if (!hook) return ALLOW;
  const tool = hook.tool_name;

  if ((GUARDED_FILE_TOOLS as readonly string[]).includes(tool)) {
    const raw = tool === 'NotebookEdit' ? (hook.tool_input.notebook_path ?? hook.tool_input.file_path) : hook.tool_input.file_path;
    if (typeof raw !== 'string' || raw === '') return ALLOW;
    return decideFile(raw, tool, hook.cwd, ctx);
  }

  if (tool === 'Bash') {
    const command = hook.tool_input.command;
    if (typeof command !== 'string' || command.trim() === '') return ALLOW;
    const hit = matchBashRules(command, rules ?? compileBashRules(ctx.extraBashRules).rules, { draftAllowed: ctx.draftAllowed });
    if (!hit) return ALLOW;
    return { decision: 'deny', reason: hit.reason, path: truncate(command, 200), tool, ruleId: hit.id };
  }

  return ALLOW;
}

function decideFile(raw: string, tool: string, cwd: string | undefined, ctx: GuardContext): GuardDecision {
  const root = resolve(ctx.projectRoot);
  const base = cwd && isAbsolute(cwd) ? cwd : root;
  const abs = resolve(base, raw);
  // 字面路径与真实路径（跟随符号链接）都要检查：任一落在 .stagent/ 下就按它处理。
  const candidates = [projectRelative(root, abs)];
  if (ctx.realpath) {
    try {
      candidates.push(projectRelative(safeReal(ctx.realpath, root), ctx.realpath(abs)));
    } catch {
      // 解析失败就只看字面路径
    }
  }
  for (const rel of candidates) {
    if (rel === null) continue;
    const d = decideRelative(rel, tool, ctx);
    if (d.decision === 'deny') return d;
  }
  return ALLOW;
}

function decideRelative(rel: string, tool: string, ctx: GuardContext): GuardDecision {
  const lower = rel.toLowerCase();
  const locked = [...ctx.lockedCheckPaths].some((p) => p.toLowerCase() === lower);
  if (locked) {
    return {
      decision: 'deny',
      tool,
      path: rel,
      ruleId: 'locked-check',
      reason: `${rel} 是锁定的验收检查，不能修改。如果你认为例子需要改，请在回报里说明，由用户授权修改`,
    };
  }
  if (lower !== '.stagent' && !lower.startsWith('.stagent/')) return ALLOW;
  if (lower.startsWith('.stagent/checks/draft/')) {
    if (ctx.draftAllowed) return ALLOW;
    return {
      decision: 'deny',
      tool,
      path: rel,
      ruleId: 'draft-not-allowed',
      reason: `${rel} 是例子草稿，只有「确认例子」阶段的起草会话可以写入。请先在 Stagent 里开始确认例子，或在回报里说明`,
    };
  }
  return { decision: 'deny', tool, path: rel, ruleId: 'stagent-dir', reason: `${rel} ${areaReason(lower)}` };
}

function areaReason(lower: string): string {
  if (lower.startsWith('.stagent/ledger/snapshots/')) return '是检查快照，只能由 Stagent 写入，不能修改';
  if (lower.startsWith('.stagent/ledger/')) return '是 Stagent 账本，只能由 Stagent 追加写入，不能修改';
  if (lower === '.stagent/config.json') return '是 Stagent 配置，请让用户在 Stagent 或编辑器里自己修改';
  if (lower.startsWith('.stagent/checks/'))
    return '在验收检查目录里，不能直接写入。如果你认为例子需要改或要加新例子，请在回报里说明，由用户授权';
  return '在 .stagent/ 下，只能由 Stagent 自己写入';
}

/** 相对项目根目录的 / 分隔路径；在根目录之外返回 null。 */
function projectRelative(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  if (rel === '') return null;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function safeReal(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
