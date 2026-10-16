/**
 * 改动投影与状态机（规格 §5.0–§5.4）。纯函数：阶段只由服务端从事件推导，
 * Claude Code 和前端都不能直接设置状态。
 *
 * 阶段推导（对每个改动，按顺序取第一条成立的）：
 *
 * | 条件                                                         | 阶段       |
 * |--------------------------------------------------------------|------------|
 * | 有 change.merged / change.abandoned                           | 已合并 / 已放弃 |
 * | 本改动的检查正在运行                                           | 检查中     |
 * | 新功能档，且本改动还没有锁定例子、或还有未锁定的草稿            | 确认例子（草稿已跑过先失败检查 → 先失败检查） |
 * | 本改动还没有运行过检查                                         | 实现中     |
 * | 最近一次运行之后工作区又变了（交给修复 / 外部改动继续）          | 实现中     |
 * | 外观被确认为不满意（运行之后的 visual.confirmed ok=false）       | 实现中     |
 * | 有失败、未验证的锁定例子，或运行无效                            | 被阻止     |
 * | 本改动锁定的外观例子还没在运行后被确认                          | 待你确认外观 |
 * | 其余                                                          | 可合并     |
 *
 * 同一时间最多一个进行中的改动（未合并且未放弃）。
 */
import type { EventOf, IsoTime, LedgerLine, Sha256Hex, Track } from '../ledger/types.js';
import type { CurrentWorkTree, ExampleView, LedgerProjection } from '../projection/projection.js';

export type ChangePhase =
  | 'confirm_examples'
  | 'red_check'
  | 'implementing'
  | 'checking'
  | 'blocked'
  | 'awaiting_visual'
  | 'mergeable'
  | 'merged'
  | 'abandoned';

export const PHASE_LABELS: Record<ChangePhase, string> = {
  confirm_examples: '确认例子',
  red_check: '先失败检查',
  implementing: '实现中',
  checking: '检查中',
  blocked: '被阻止',
  awaiting_visual: '待你确认外观',
  mergeable: '可合并',
  merged: '已合并',
  abandoned: '已放弃',
};

/** 抽屉进度条：①确认例子 → ②实现 → ③检查 → ④确认并合并。 */
export const PHASE_STEP: Record<ChangePhase, 1 | 2 | 3 | 4> = {
  confirm_examples: 1,
  red_check: 1,
  implementing: 2,
  checking: 3,
  blocked: 3,
  awaiting_visual: 4,
  mergeable: 4,
  merged: 4,
  abandoned: 2,
};

export const TERMINAL_PHASES: ReadonlySet<ChangePhase> = new Set(['merged', 'abandoned']);

export interface TrackChange {
  from: Track;
  to: Track;
  at: IsoTime;
  reason?: string;
}

export interface ChangeView {
  changeId: string;
  description: string;
  source: EventOf<'change.started'>['source'];
  track: Track;
  /** 创建时的档位。 */
  initialTrack: Track;
  trackHistory: TrackChange[];
  baseCommit: string;
  firstObservedWorkTreeHash?: Sha256Hex;
  startedAt: IsoTime;
  phase: ChangePhase;
  phaseLabel: string;
  step: 1 | 2 | 3 | 4;
  /** 本改动起草的例子（含已锁定）。 */
  draftedExampleIds: string[];
  lockedExampleIds: string[];
  pendingDraftIds: string[];
  /** 待锁定草稿的内容，供「确认例子」决策卡展示。 */
  pendingDrafts: { exampleId: string; featureId: string; given: string; when: string; then: string; kind: 'behavior' | 'visual'; checkPath?: string }[];
  lastRun: { runId: string; at: IsoTime; valid: boolean; fresh: boolean } | null;
  /** 被阻止 / 等待的原因（给人看的句子），最严重的在前。 */
  blockers: string[];
  /** 本改动期间检测到的、未经 Stagent 合并的提交。 */
  unmanagedCommits: { fromCommit: string; toCommit: string; at: IsoTime }[];
  endedAt: IsoTime | null;
}

export interface ChangeContext {
  current: CurrentWorkTree;
  projection: LedgerProjection;
  /** 正在为哪个改动运行检查（运行时状态）。 */
  runningChangeId: string | null;
}

export interface ChangesProjection {
  changes: ChangeView[];
  active: ChangeView | null;
}

interface Acc {
  started: EventOf<'change.started'>;
  at: IsoTime;
  track: Track;
  trackHistory: TrackChange[];
  drafted: string[];
  locked: string[];
  runs: { event: EventOf<'run.completed'>; at: IsoTime; seq: number }[];
  redCheckDrafts: Set<string>;
  unmanaged: ChangeView['unmanagedCommits'];
  ended: { phase: 'merged' | 'abandoned'; at: IsoTime } | null;
}

export function projectChanges(lines: readonly LedgerLine[], ctx: ChangeContext): ChangesProjection {
  const changes = new Map<string, Acc>();
  const visualConfirms = new Map<string, { ok: boolean; seq: number }>();
  const lockedKind = new Map<string, EventOf<'example.drafted'>['kind']>();
  const draftEvents = new Map<string, EventOf<'example.drafted'>>();
  let activeId: string | null = null;

  for (const { event: e, at, seq } of lines) {
    switch (e.type) {
      case 'change.started':
        changes.set(e.changeId, {
          started: e,
          at,
          track: e.track,
          trackHistory: [],
          drafted: [],
          locked: [],
          runs: [],
          redCheckDrafts: new Set(),
          unmanaged: [],
          ended: null,
        });
        activeId = e.changeId;
        break;
      case 'change.track_upgraded':
      case 'change.track_downgraded': {
        const c = changes.get(e.changeId);
        if (!c) break;
        const to: Track = e.type === 'change.track_upgraded' ? 'feature' : 'small';
        c.trackHistory.push({ from: c.track, to, at, ...('reason' in e && e.reason ? { reason: e.reason } : {}) });
        c.track = to;
        break;
      }
      case 'example.drafted':
        lockedKind.set(e.exampleId, e.kind);
        draftEvents.set(e.exampleId, e);
        if (e.changeId) changes.get(e.changeId)?.drafted.push(e.exampleId);
        break;
      case 'example.locked':
        if (e.changeId) changes.get(e.changeId)?.locked.push(e.exampleId);
        break;
      case 'run.completed': {
        if (!e.changeId) break;
        const c = changes.get(e.changeId);
        if (!c) break;
        if (e.purpose === 'red_check') for (const id of Object.keys(e.snapshots)) c.redCheckDrafts.add(id);
        else c.runs.push({ event: e, at, seq });
        break;
      }
      case 'visual.confirmed':
        visualConfirms.set(e.exampleId, { ok: e.ok, seq });
        break;
      case 'change.unmanaged_commit':
        if (activeId) changes.get(activeId)?.unmanaged.push({ fromCommit: e.fromCommit, toCommit: e.toCommit, at });
        break;
      case 'change.merged':
      case 'change.abandoned': {
        const c = changes.get(e.changeId);
        if (c && !c.ended) c.ended = { phase: e.type === 'change.merged' ? 'merged' : 'abandoned', at };
        if (activeId === e.changeId) activeId = null;
        break;
      }
      default:
        break;
    }
  }

  const examples = new Map(ctx.projection.features.flatMap((f) => f.examples.map((x) => [x.exampleId, { x, feature: f.name }])));
  const views = [...changes.values()].map((c) => judgeChange(c, ctx, examples, visualConfirms, lockedKind, draftEvents));
  const active = views.find((v) => v.changeId === activeId && !TERMINAL_PHASES.has(v.phase)) ?? null;
  return { changes: views, active };
}

function judgeChange(
  c: Acc,
  ctx: ChangeContext,
  examples: Map<string, { x: ExampleView; feature: string }>,
  visualConfirms: Map<string, { ok: boolean; seq: number }>,
  kinds: Map<string, EventOf<'example.drafted'>['kind']>,
  draftEvents: Map<string, EventOf<'example.drafted'>>,
): ChangeView {
  const lockedSet = new Set(c.locked);
  const pendingDraftIds = c.drafted.filter((id) => !lockedSet.has(id));
  const last = c.runs[c.runs.length - 1] ?? null;
  const fresh =
    last !== null &&
    last.event.endWorkTreeHash === ctx.current.workTreeHash &&
    last.event.workTreeHashSpec === ctx.current.workTreeHashSpec;

  const blockers: string[] = [];
  const phase = ((): ChangePhase => {
    if (c.ended) return c.ended.phase;
    if (ctx.runningChangeId === c.started.changeId) return 'checking';
    if (c.track === 'feature' && (c.locked.length === 0 || pendingDraftIds.length > 0)) {
      if (pendingDraftIds.length > 0 && pendingDraftIds.every((id) => c.redCheckDrafts.has(id))) return 'red_check';
      blockers.push(
        c.drafted.length === 0
          ? '新功能档：先起草验收例子'
          : `新功能档：还有 ${pendingDraftIds.length} 个例子草稿等你确认并锁定`,
      );
      return 'confirm_examples';
    }
    if (!last) {
      blockers.push('还没有检查：改完后点「开始检查」');
      return 'implementing';
    }
    if (!fresh) {
      blockers.push('上次检查之后代码又有改动，需要重新检查');
      return 'implementing';
    }
    const rejected = c.locked.filter((id) => {
      const v = visualConfirms.get(id);
      return v !== undefined && v.seq > last.seq && !v.ok;
    });
    if (rejected.length) {
      blockers.push(`${rejected.length} 个外观例子你确认为不满意，回到实现`);
      return 'implementing';
    }
    if (!last.event.valid) blockers.push('检查运行期间代码有变化，结果无效');
    for (const { x, feature } of examples.values()) {
      if (x.state === 'failed') blockers.push(`「${feature}」的例子失败：${x.then}`);
    }
    for (const { x, feature } of examples.values()) {
      if (x.state === 'unverified') blockers.push(`「${feature}」的例子未验证（${x.explanation}）`);
    }
    if (blockers.length) return 'blocked';
    const visualPending = c.locked.filter((id) => {
      if (kinds.get(id) !== 'visual') return false;
      const v = visualConfirms.get(id);
      return !(v && v.seq > last.seq && v.ok);
    });
    if (visualPending.length) {
      blockers.push(`${visualPending.length} 个外观例子等你确认截图`);
      return 'awaiting_visual';
    }
    return 'mergeable';
  })();

  return {
    changeId: c.started.changeId,
    description: c.started.description ?? '',
    source: c.started.source,
    track: c.track,
    initialTrack: c.started.track,
    trackHistory: c.trackHistory,
    baseCommit: c.started.baseCommit,
    ...(c.started.firstObservedWorkTreeHash ? { firstObservedWorkTreeHash: c.started.firstObservedWorkTreeHash } : {}),
    startedAt: c.at,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    step: PHASE_STEP[phase],
    draftedExampleIds: c.drafted,
    lockedExampleIds: c.locked,
    pendingDraftIds,
    pendingDrafts: pendingDraftIds.flatMap((id) => {
      const d = draftEvents.get(id);
      return d
        ? [{ exampleId: id, featureId: d.featureId, given: d.given, when: d.when, then: d.then, kind: d.kind, ...(d.checkPath ? { checkPath: d.checkPath } : {}) }]
        : [];
    }),
    lastRun: last ? { runId: last.event.runId, at: last.at, valid: last.event.valid, fresh } : null,
    blockers,
    unmanagedCommits: c.unmanaged,
    endedAt: c.ended?.at ?? null,
  };
}

/**
 * Stagent 已知的最近一个 HEAD：用来判断"有人在 Stagent 之外直接 git commit"。
 * 取 change.started.baseCommit、change.merged.mergeCommit、change.unmanaged_commit.toCommit 中最后出现的；
 * 都没有时退回到最近一次运行的 endCommit；仍没有则返回 null（新项目，不做判断）。
 */
export function knownHead(lines: readonly LedgerLine[]): string | null {
  let known: string | null = null;
  let lastRunCommit: string | null = null;
  for (const { event: e } of lines) {
    if (e.type === 'change.started') known = e.baseCommit;
    else if (e.type === 'change.merged') known = e.mergeCommit;
    else if (e.type === 'change.unmanaged_commit') known = e.toCommit;
    else if (e.type === 'run.completed') lastRunCommit = e.endCommit;
  }
  return known ?? lastRunCommit;
}

/** 只看事件就能判断的进行中改动（未合并、未放弃的最近一个），用于在账本写锁内做互斥检查。 */
export function activeChangeIdFromLines(lines: readonly LedgerLine[]): string | null {
  let active: string | null = null;
  for (const { event: e } of lines) {
    if (e.type === 'change.started') active = e.changeId;
    else if ((e.type === 'change.merged' || e.type === 'change.abandoned') && e.changeId === active) active = null;
  }
  return active;
}
