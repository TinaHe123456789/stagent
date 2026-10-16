/**
 * 状态投影（规格 §4.2）：从账本事件推导功能与例子的证据状态。纯函数，随时可从事件重建。
 *
 * 例子级判定表（对每个当前锁定的例子，取"快照 id 等于当前 checkHash"的最近一条非 red_check 结果）：
 *
 * | 条件                                                      | 状态   | 未验证细分        |
 * |-----------------------------------------------------------|--------|-------------------|
 * | 结果 failed，run.valid，且 run 的 workTreeHash/spec 等于当前 | 失败   |                   |
 * | 结果 passed，run.valid，且新鲜                              | 已验证 |                   |
 * | 有 claim.reported，但不满足以上两条                         | 未验证 | 仅 AI 声称        |
 * | 没有任何结果                                               | 未验证 | 未执行            |
 * | 最近结果所在 run valid=false                               | 未验证 | 证据无效          |
 * | 最近结果不新鲜（之后工作区变了）                            | 未验证 | 证据过期          |
 * | 最近结果 flaky / errored / not_run                         | 未验证 | 结果不稳定 / 执行异常 / 未执行 |
 *
 * - purpose 为 red_check 的运行不参与判定。
 * - 只认快照 id 与当前锁定 checkHash 一致的结果：修改锁定检查（重新锁定）后，旧 run 不再作证（Invariant 4）。
 * - 已验证只能来自 run.completed（Invariant 2/3）；claim 永远不能产生已验证（Invariant 1）。
 *
 * 功能级：任一锁定例子失败 → 被破坏；有 ≥ 1 个锁定例子且全部已验证 → 已验证（N 个例子）；其余 → 未验证。
 * 覆盖薄弱：锁定例子少于 2 个，或只有 visual 类例子。
 */
import type {
  CheckResult,
  EventOf,
  ExampleKind,
  FeatureOrigin,
  IsoTime,
  LedgerLine,
  Sha256Hex,
} from '../ledger/types.js';

export type ExampleState = 'verified' | 'failed' | 'unverified';
export type UnverifiedReason = 'ai_claim_only' | 'errored' | 'flaky' | 'invalid' | 'stale' | 'not_run';
export type FeatureState = 'verified' | 'broken' | 'unverified';

export const UNVERIFIED_LABELS: Record<UnverifiedReason, string> = {
  ai_claim_only: '仅 AI 声称',
  errored: '执行异常',
  flaky: '结果不稳定',
  invalid: '证据无效',
  stale: '证据过期',
  not_run: '未执行',
};

export interface CurrentWorkTree {
  workTreeHash: Sha256Hex;
  workTreeHashSpec: Sha256Hex;
}

export interface ResultRef {
  runId: string;
  at: IsoTime;
  status: CheckResult['status'];
  valid: boolean;
  /** run 结束时的工作区与当前一致。 */
  fresh: boolean;
  durationMs: number;
  logPath: string;
  detail?: string;
  attempts: number;
}

export interface ExampleView {
  exampleId: string;
  featureId: string;
  given: string;
  when: string;
  then: string;
  kind: ExampleKind;
  checkPath: string;
  checkHash: Sha256Hex;
  lockedAt: IsoTime;
  state: ExampleState;
  /** 仅 state 为 unverified 时存在。 */
  reason?: UnverifiedReason;
  /** 给人看的一句话原因。 */
  explanation: string;
  lastResult: ResultRef | null;
  claims: { text: string; at: IsoTime }[];
}

export interface FeatureView {
  featureId: string;
  name: string;
  origin: FeatureOrigin;
  tag: '新功能' | '已验收' | '接入扫描发现';
  state: FeatureState;
  stateLabel: string;
  examples: ExampleView[];
  /** 起草但尚未锁定的例子数。 */
  draftCount: number;
  lockedCount: number;
  verifiedCount: number;
  coverage: { weak: boolean; reason?: string };
  /** 本功能例子最近一次被系统运行的时间。 */
  lastRunAt: IsoTime | null;
  createdAt: IsoTime;
}

export interface LedgerProjection {
  features: FeatureView[];
  lastGuardBlock: (EventOf<'guard.blocked'> & { at: IsoTime; seq: number }) | null;
  lastRun: { runId: string; at: IsoTime; durationMs: number; slowest: { exampleId: string; durationMs: number }[] } | null;
}

interface LockedExample {
  checkPath: string;
  checkHash: Sha256Hex;
  at: IsoTime;
}

interface StoredResult {
  run: EventOf<'run.completed'>;
  result: CheckResult;
  at: IsoTime;
}

export function project(lines: readonly LedgerLine[], current: CurrentWorkTree): LedgerProjection {
  const features = new Map<string, { e: EventOf<'feature.created'>; at: IsoTime; retired: boolean }>();
  const drafts = new Map<string, EventOf<'example.drafted'>>();
  const locked = new Map<string, LockedExample>();
  const results = new Map<string, StoredResult>(); // `${exampleId}\0${snapshotId}` → 最近结果
  const claims = new Map<string, { text: string; at: IsoTime }[]>();
  let lastGuardBlock: LedgerProjection['lastGuardBlock'] = null;
  let lastRun: LedgerProjection['lastRun'] = null;

  for (const { event: e, at, seq } of lines) {
    switch (e.type) {
      case 'feature.created':
        features.set(e.featureId, { e, at, retired: false });
        break;
      case 'feature.retired': {
        const f = features.get(e.featureId);
        if (f) f.retired = true;
        break;
      }
      case 'example.drafted':
        drafts.set(e.exampleId, e);
        break;
      case 'example.locked':
        locked.set(e.exampleId, { checkPath: e.checkPath, checkHash: e.checkHash, at });
        break;
      case 'example.unlocked':
        locked.delete(e.exampleId);
        break;
      case 'claim.reported':
        if (e.exampleId) {
          const list = claims.get(e.exampleId) ?? [];
          list.push({ text: e.text, at });
          claims.set(e.exampleId, list);
        }
        break;
      case 'run.completed':
        if (e.purpose === 'red_check') break;
        for (const r of e.results) {
          const snap = e.snapshots[r.exampleId];
          if (snap) results.set(`${r.exampleId}\0${snap}`, { run: e, result: r, at });
        }
        lastRun = {
          runId: e.runId,
          at,
          durationMs: e.results.reduce((s, r) => s + r.durationMs, 0),
          slowest: [...e.results]
            .sort((a, b) => b.durationMs - a.durationMs)
            .slice(0, 3)
            .map((r) => ({ exampleId: r.exampleId, durationMs: r.durationMs })),
        };
        break;
      case 'guard.blocked':
        lastGuardBlock = { ...e, at, seq };
        break;
      default:
        break;
    }
  }

  const examplesByFeature = new Map<string, ExampleView[]>();
  for (const [exampleId, lock] of locked) {
    const draft = drafts.get(exampleId);
    if (!draft) continue; // 没有起草记录的锁定无法归属功能
    const stored = results.get(`${exampleId}\0${lock.checkHash}`) ?? null;
    const view = judgeExample(exampleId, draft, lock, stored, claims.get(exampleId) ?? [], current);
    const list = examplesByFeature.get(draft.featureId) ?? [];
    list.push(view);
    examplesByFeature.set(draft.featureId, list);
  }

  const draftCounts = new Map<string, number>();
  for (const d of drafts.values()) {
    if (!locked.has(d.exampleId)) draftCounts.set(d.featureId, (draftCounts.get(d.featureId) ?? 0) + 1);
  }

  const featureViews: FeatureView[] = [];
  for (const [featureId, f] of features) {
    if (f.retired) continue;
    const examples = (examplesByFeature.get(featureId) ?? []).sort((a, b) => a.lockedAt.localeCompare(b.lockedAt));
    featureViews.push(judgeFeature(f.e, f.at, examples, draftCounts.get(featureId) ?? 0));
  }
  featureViews.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return { features: featureViews, lastGuardBlock, lastRun };
}

function judgeExample(
  exampleId: string,
  draft: EventOf<'example.drafted'>,
  lock: LockedExample,
  stored: StoredResult | null,
  claims: { text: string; at: IsoTime }[],
  current: CurrentWorkTree,
): ExampleView {
  const fresh =
    stored !== null &&
    stored.run.endWorkTreeHash === current.workTreeHash &&
    stored.run.workTreeHashSpec === current.workTreeHashSpec;
  const lastResult: ResultRef | null = stored
    ? {
        runId: stored.run.runId,
        at: stored.at,
        status: stored.result.status,
        valid: stored.run.valid,
        fresh,
        durationMs: stored.result.durationMs,
        logPath: stored.result.logPath,
        ...(stored.result.detail ? { detail: stored.result.detail } : {}),
        attempts: stored.result.attempts?.length ?? 1,
      }
    : null;

  const base = {
    exampleId,
    featureId: draft.featureId,
    given: draft.given,
    when: draft.when,
    then: draft.then,
    kind: draft.kind,
    checkPath: lock.checkPath,
    checkHash: lock.checkHash,
    lockedAt: lock.at,
    lastResult,
    claims,
  };

  const trusted = stored !== null && stored.run.valid && fresh;
  if (trusted && stored.result.status === 'failed') {
    return { ...base, state: 'failed', explanation: '系统运行检查失败' };
  }
  if (trusted && stored.result.status === 'passed') {
    return { ...base, state: 'verified', explanation: '系统在当前代码上运行检查通过' };
  }

  const underlying = underlyingReason(stored, fresh);
  if (claims.length > 0) {
    return {
      ...base,
      state: 'unverified',
      reason: 'ai_claim_only',
      explanation: `AI 声称已完成，但系统没有在当前代码上验证通过（${explain(underlying, stored)}）`,
    };
  }
  return { ...base, state: 'unverified', reason: underlying, explanation: explain(underlying, stored) };
}

function underlyingReason(stored: StoredResult | null, fresh: boolean): Exclude<UnverifiedReason, 'ai_claim_only'> {
  if (!stored) return 'not_run';
  if (!stored.run.valid) return 'invalid';
  if (!fresh) return 'stale';
  switch (stored.result.status) {
    case 'flaky':
      return 'flaky';
    case 'errored':
      return 'errored';
    case 'not_run':
      return 'not_run';
    default:
      // passed / failed 但不新鲜或无效的情况已在上面处理；走到这里说明判定表有遗漏。
      return 'stale';
  }
}

function explain(reason: UnverifiedReason, stored: StoredResult | null): string {
  switch (reason) {
    case 'not_run':
      return stored ? `未执行${stored.result.detail ? `：${stored.result.detail}` : ''}` : '锁定后还没有运行过';
    case 'invalid':
      return '证据无效：运行期间代码有变化，结果不作证';
    case 'stale':
      return '证据过期：上次运行之后代码有改动，需要重新运行';
    case 'flaky':
      return '结果不稳定：同一轮里先失败后通过';
    case 'errored':
      return `执行异常${stored?.result.detail ? `：${stored.result.detail}` : ''}`;
    case 'ai_claim_only':
      return '仅 AI 声称';
  }
}

function judgeFeature(
  e: EventOf<'feature.created'>,
  createdAt: IsoTime,
  examples: ExampleView[],
  draftCount: number,
): FeatureView {
  const lockedCount = examples.length;
  const verifiedCount = examples.filter((x) => x.state === 'verified').length;
  const failedCount = examples.filter((x) => x.state === 'failed').length;
  const state: FeatureState =
    failedCount > 0 ? 'broken' : lockedCount > 0 && verifiedCount === lockedCount ? 'verified' : 'unverified';
  const stateLabel =
    state === 'verified'
      ? `已验证（${lockedCount} 个例子）`
      : state === 'broken'
        ? `被破坏（${failedCount} 个例子失败）`
        : lockedCount === 0
          ? '未验证（尚无例子）'
          : '未验证';
  const weak =
    lockedCount < 2
      ? { weak: true, reason: lockedCount === 0 ? '尚无锁定例子' : '锁定例子少于 2 个' }
      : examples.every((x) => x.kind === 'visual')
        ? { weak: true, reason: '只有外观类例子' }
        : { weak: false };
  const runTimes = examples.map((x) => x.lastResult?.at).filter((t): t is string => !!t);
  return {
    featureId: e.featureId,
    name: e.name,
    origin: e.origin,
    tag: e.origin === 'scan' ? '接入扫描发现' : state === 'verified' ? '已验收' : '新功能',
    state,
    stateLabel,
    examples,
    draftCount,
    lockedCount,
    verifiedCount,
    coverage: weak,
    lastRunAt: runTimes.length ? runTimes.sort().at(-1)! : null,
    createdAt,
  };
}
