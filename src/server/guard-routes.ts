/**
 * 守卫接口（规格 §6 写时拦截，M2-1）：`stagent hook pre-tool-use` 把 Claude Code 的 hook stdin 原样转发到这里。
 *
 * 服务运行时它是账本唯一的写入者（写锁是进程内互斥锁），所以由服务判定并写 guard.blocked；
 * 服务不在时 hook 走离线模式（src/guard/hook-cli.ts）。
 *
 * 账本锁定（🔒）时照常判定（.stagent/ 内的写入一律拒绝），只是不写 guard.blocked，接口不报错。
 */
import type { FastifyInstance } from 'fastify';
import type { StagentConfig } from '../config/config.js';
import { lockedCheckPaths, realpathNearest } from '../guard/context.js';
import { decidePreToolUse, parsePreToolUse, type GuardDecision } from '../guard/decide.js';
import { LedgerLockedError, type Ledger } from '../ledger/ledger.js';
import type { EventBus } from './event-bus.js';

export interface GuardHost {
  root: string;
  ledger: Ledger;
  bus: EventBus;
  config(): Promise<StagentConfig>;
  /** 当前进行中的改动（M2-2 提供）；没有则为 null。 */
  activeChangeId(): string | null;
  /** 该会话是否是「确认例子」阶段的起草会话（M3-2 提供）；暂时恒为 false。 */
  isDraftingSession(sessionId: string | undefined): boolean;
}

export interface GuardResponse {
  decision: 'allow' | 'deny';
  reason?: string;
  ruleId?: string;
}

export function registerGuardRoutes(app: FastifyInstance, host: GuardHost): void {
  app.post<{ Body: unknown }>('/api/guard/pre-tool-use', async (req): Promise<GuardResponse> => {
    const d = await guardDecide(host, req.body);
    if (d.decision === 'allow') return { decision: 'allow' };
    await recordBlock(host, d);
    return { decision: 'deny', reason: d.reason, ...(d.ruleId ? { ruleId: d.ruleId } : {}) };
  });
}

async function guardDecide(host: GuardHost, body: unknown): Promise<GuardDecision> {
  const hook = parsePreToolUse(body);
  if (!hook) return { decision: 'allow' };
  // 每次都重新读盘：锁定集合以账本为准，账本被改也能及时发现。
  try {
    await host.ledger.verify();
  } catch {
    // 读盘失败时用内存里最近一次的账本内容判定
  }
  let extraBashRules: string[] = [];
  try {
    extraBashRules = (await host.config()).guard.bashRules;
  } catch {
    // 配置坏了也要能拦截：只用默认规则
  }
  return decidePreToolUse(hook, {
    projectRoot: host.root,
    lockedCheckPaths: lockedCheckPaths(host.ledger.events()),
    draftAllowed: host.isDraftingSession(hook.session_id),
    extraBashRules,
    realpath: realpathNearest,
  });
}

async function recordBlock(host: GuardHost, d: Extract<GuardDecision, { decision: 'deny' }>): Promise<void> {
  if (host.ledger.state === 'locked') return;
  const changeId = host.activeChangeId();
  try {
    const line = await host.ledger.append({
      type: 'guard.blocked',
      ...(changeId ? { changeId } : {}),
      path: d.path,
      tool: d.tool,
      detail: d.reason,
    });
    host.bus.publish('ledger.appended', { seq: line.seq, type: line.event.type });
  } catch (err) {
    if (err instanceof LedgerLockedError) host.bus.publish('ledger.locked', { brokenLinks: err.report.brokenLinks });
    // 其他写入失败不影响拦截本身
  }
}
