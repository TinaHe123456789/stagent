/**
 * 首页结论卡（规格 §11、D3）：只回答"能不能继续、差什么、需要我做什么"。
 *
 * 五种状态：✅ 系统完好 · ⛔ 不能合并 · 👀 等你确认 · ⏳ 检查中 · 🔒 账本被修改；
 * 另有空账本（还没有任何已验证功能）的引导状态。原因最多 3 条，按严重程度排序；
 * 被禁用的按钮必须带原因。
 */
import type { ChangeView } from '../changes/changes.js';
import type { BrokenLink } from '../ledger/verify.js';
import type { ExampleView, FeatureView, LedgerProjection, UnverifiedReason } from './projection.js';

export type CardStatus = 'ok' | 'blocked' | 'needs_you' | 'checking' | 'ledger_modified' | 'empty';

export const CARD_STATUS_LABELS: Record<CardStatus, { icon: string; title: string }> = {
  ok: { icon: '✅', title: '系统完好' },
  blocked: { icon: '⛔', title: '不能合并' },
  needs_you: { icon: '👀', title: '等你确认' },
  checking: { icon: '⏳', title: '检查中' },
  ledger_modified: { icon: '🔒', title: '账本被修改' },
  empty: { icon: '📒', title: '还没有任何已验证功能' },
};

export type ActionId =
  | 'run_regression'
  | 'cancel_run'
  | 'accept_ledger'
  | 'merge'
  | 'add_feature'
  | 'scan'
  | 'new_change'
  | 'lock_examples'
  | 'start_check'
  | 'fix'
  | 'merge_override'
  | 'confirm_visual'
  | 'abandon'
  | 'restore_locked'
  | 'modify_locked'
  | 'release';

export interface CardAction {
  id: ActionId;
  label: string;
  enabled: boolean;
  /** enabled 为 false 时必填：写在按钮旁边。 */
  disabledReason?: string;
  primary?: boolean;
}

export interface CardReason {
  /** 数字越小越严重。 */
  severity: number;
  text: string;
  featureIds: string[];
}

export interface RunProgressView {
  runId: string | null;
  done: number;
  total: number;
  current: string | null;
  startedAt: string;
}

export interface Overview {
  status: CardStatus;
  icon: string;
  title: string;
  canContinue: boolean;
  reasons: CardReason[];
  actions: CardAction[];
  stats: { verified: number; broken: number; unverified: number; lockedExamples: number; features: number };
  run: RunProgressView | null;
  /** 最近一次运行超过 5 分钟时的提示（§7）。 */
  slowRunHint: { durationMs: number; slowest: { exampleId: string; durationMs: number }[] } | null;
  lastGuardBlock: LedgerProjection['lastGuardBlock'];
  ledger: { state: 'ok' | 'locked'; brokenLinks: BrokenLink[] };
  /** 进行中的改动（同一时间最多一个）。 */
  change: ChangeView | null;
}

export const SLOW_RUN_MS = 5 * 60 * 1000;

const SEVERITY: Record<'failed' | UnverifiedReason | 'no_examples' | 'weak', number> = {
  failed: 1,
  ai_claim_only: 2,
  errored: 3,
  invalid: 4,
  flaky: 5,
  stale: 6,
  not_run: 7,
  no_examples: 8,
  weak: 9,
};

/** 授权相关的状态（由服务计算）。 */
export interface AuthSummary {
  /** 已消费、未结算的授权（崩溃留下，不自动重试）。 */
  dangling: { authId: string; action: string; changeId?: string; at: string }[];
  /** 工作区或快照与锁定时不一致的锁定检查（合并门会拒绝）。 */
  tamperedChecks: { exampleId: string; featureName: string; checkPath: string; problem: string }[];
  releaseConfigured: boolean;
}

export interface OverviewInput {
  projection: LedgerProjection;
  ledger: { state: 'ok' | 'locked'; brokenLinks: BrokenLink[] };
  run: RunProgressView | null;
  change?: ChangeView | null;
  auth?: AuthSummary;
}

const DANGLING_LABELS: Record<string, string> = {
  merge: '合并',
  merge_override: '强行合并',
  abandon: '放弃改动',
  modify_locked: '修改锁定例子',
  delete: '退役功能',
  release: '发布上线',
  budget_raise: '提高费用上限',
};

export function buildOverview(input: OverviewInput): Overview {
  const base = buildCard(input);
  const dangling = input.auth?.dangling ?? [];
  if (dangling.length === 0) return base;
  // 悬挂授权放在最前：它说明上次有个不可逆动作做到一半，系统不会自己重试。
  const text = `有 ${dangling.length} 个授权已消费但没有完成（${dangling.map((d) => DANGLING_LABELS[d.action] ?? d.action).join('、')}），可能是中途崩溃，系统不会自动重试，请确认后处理`;
  return { ...base, reasons: [{ severity: 0, text, featureIds: [] }, ...base.reasons].slice(0, 3) };
}

function buildCard({ projection, ledger, run, change = null, auth }: OverviewInput): Overview {
  const features = projection.features;
  const examples = features.flatMap((f) => f.examples);
  const stats = {
    verified: features.filter((f) => f.state === 'verified').length,
    broken: features.filter((f) => f.state === 'broken').length,
    unverified: features.filter((f) => f.state === 'unverified').length,
    lockedExamples: examples.length,
    features: features.length,
  };
  const failed = examples.filter((x) => x.state === 'failed');
  const unverified = examples.filter((x) => x.state === 'unverified');
  const reasons = collectReasons(features).slice(0, 3);
  const slowRunHint =
    projection.lastRun && projection.lastRun.durationMs > SLOW_RUN_MS
      ? { durationMs: projection.lastRun.durationMs, slowest: projection.lastRun.slowest }
      : null;
  const common = { stats, run, slowRunHint, lastGuardBlock: projection.lastGuardBlock, ledger, change };

  const mergeCounts = [failed.length ? `${failed.length} 失败` : '', unverified.length ? `${unverified.length} 未验证` : '']
    .filter(Boolean)
    .join(' · ');
  const merge: CardAction = {
    id: 'merge',
    label: mergeCounts ? `合并（${mergeCounts}）` : '合并',
    enabled: false,
    disabledReason: !change
      ? '当前没有进行中的改动'
      : mergeCounts
        ? `还有 ${mergeCounts}`
        : `改动处于「${change.phaseLabel}」阶段`,
  };
  if (change?.phase === 'mergeable' && !mergeCounts) {
    merge.enabled = true;
    delete merge.disabledReason;
  }
  const runAction = (primary: boolean): CardAction =>
    examples.length > 0
      ? { id: 'run_regression', label: '运行全量回归', enabled: true, primary }
      : { id: 'run_regression', label: '运行全量回归', enabled: false, disabledReason: '还没有锁定的例子', primary };

  if (ledger.state === 'locked') {
    return {
      ...common,
      status: 'ledger_modified',
      ...CARD_STATUS_LABELS.ledger_modified,
      canContinue: false,
      reasons: [
        {
          severity: 0,
          text: `events.jsonl 第 ${ledger.brokenLinks.map((b) => b.seq).join('、')} 行与事件链不符，所有写操作已禁用`,
          featureIds: [],
        },
      ],
      actions: [
        { id: 'accept_ledger', label: '我确认，接受当前状态', enabled: true, primary: true },
        { ...runAction(false), enabled: false, disabledReason: '账本被修改，写操作已禁用' },
      ],
    };
  }

  if (run) {
    return {
      ...common,
      status: 'checking',
      ...CARD_STATUS_LABELS.checking,
      canContinue: false,
      reasons: [
        {
          severity: 0,
          text: run.current ? `正在运行 ${run.done + 1}/${run.total}：${run.current}` : `准备运行 ${run.total} 个检查`,
          featureIds: [],
        },
      ],
      actions: [{ id: 'cancel_run', label: '取消', enabled: true, primary: true }, merge],
    };
  }

  const tampered = auth?.tamperedChecks ?? [];
  if (tampered.length) {
    return {
      ...common,
      status: 'blocked',
      ...CARD_STATUS_LABELS.blocked,
      canContinue: false,
      reasons: [
        {
          severity: 0,
          text: `锁定检查被修改：${tampered.map((t) => `「${t.featureName}」${t.checkPath}`).join('、')}（Cursor 或手写的改动只在合并前校验）`,
          featureIds: [],
        },
        ...reasons,
      ].slice(0, 3),
      actions: [
        { id: 'restore_locked', label: '还原锁定文件', enabled: true, primary: true },
        { id: 'modify_locked', label: '授权修改锁定例子', enabled: true },
        { ...merge, enabled: false, disabledReason: '锁定检查被修改' },
      ],
    };
  }

  if (change) return changeCard(change, { common, reasons, merge, runAction });

  if (features.length === 0) {
    return {
      ...common,
      status: 'empty',
      ...CARD_STATUS_LABELS.empty,
      canContinue: false,
      reasons: [],
      actions: [
        { id: 'scan', label: '扫描现有代码', enabled: false, disabledReason: '扫描接入在 M4-1 提供' },
        { id: 'add_feature', label: '描述第一个功能', enabled: true, primary: true },
      ],
    };
  }

  const blocking = failed.length > 0 || unverified.length > 0;
  if (blocking) {
    const needsRun = unverified.some((x) => x.reason === 'stale' || x.reason === 'not_run' || x.reason === 'invalid');
    return {
      ...common,
      status: 'blocked',
      ...CARD_STATUS_LABELS.blocked,
      canContinue: false,
      reasons,
      actions: [runAction(needsRun || failed.length === 0), newChange(false), merge],
    };
  }

  return {
    ...common,
    status: 'ok',
    ...CARD_STATUS_LABELS.ok,
    canContinue: true,
    reasons,
    actions: [newChange(true), runAction(false), ...(auth?.releaseConfigured ? [releaseAction()] : []), merge],
  };
}

function releaseAction(): CardAction {
  return { id: 'release', label: '发布上线（需授权）', enabled: true };
}

function abandonAction(): CardAction {
  return { id: 'abandon', label: '放弃改动（需授权）', enabled: true };
}

function newChange(primary: boolean): CardAction {
  return { id: 'new_change', label: '描述一个改动', enabled: true, primary };
}

/** 有进行中的改动时，结论卡围绕它回答"能不能继续、差什么、要我做什么"。 */
function changeCard(
  change: ChangeView,
  ctx: {
    common: Omit<Overview, 'status' | 'icon' | 'title' | 'canContinue' | 'reasons' | 'actions'>;
    reasons: CardReason[];
    merge: CardAction;
    runAction: (primary: boolean) => CardAction;
  },
): Overview {
  const { common, merge } = ctx;
  const head: CardReason[] = change.blockers.slice(0, 3).map((text, i) => ({ severity: i === 0 ? 1 : 2, text, featureIds: [] }));
  const top3 = (extra: CardReason[]) => [...extra, ...ctx.reasons.filter((r) => !extra.some((e) => e.text === r.text))].slice(0, 3);
  const name = change.description ? `「${change.description}」` : '';
  switch (change.phase) {
    case 'confirm_examples':
    case 'red_check':
      return {
        ...common,
        status: 'needs_you',
        ...CARD_STATUS_LABELS.needs_you,
        canContinue: false,
        reasons: top3(head),
        actions: [
          change.pendingDraftIds.length > 0
            ? { id: 'lock_examples', label: `确认并锁定 ${change.pendingDraftIds.length} 个例子`, enabled: true, primary: true }
            : { id: 'lock_examples', label: '确认并锁定例子', enabled: false, disabledReason: '先起草至少一个例子', primary: true },
          abandonAction(),
          merge,
        ],
      };
    case 'implementing':
      return {
        ...common,
        status: 'blocked',
        ...CARD_STATUS_LABELS.blocked,
        canContinue: false,
        reasons: top3(head.length ? head : [{ severity: 1, text: `改动${name}实现中`, featureIds: [] }]),
        actions: [{ id: 'start_check', label: '开始检查（全量回归）', enabled: true, primary: true }, abandonAction(), merge],
      };
    case 'blocked':
      return {
        ...common,
        status: 'blocked',
        ...CARD_STATUS_LABELS.blocked,
        canContinue: false,
        reasons: top3(head),
        actions: [
          { id: 'fix', label: '交给 Claude Code 修复', enabled: false, disabledReason: 'Claude Code 驱动在 M3 提供；你自己修改后会回到「实现中」' },
          { id: 'merge_override', label: '授权强行合并', enabled: true },
          ctx.runAction(false),
          abandonAction(),
          merge,
        ],
      };
    case 'awaiting_visual':
      return {
        ...common,
        status: 'needs_you',
        ...CARD_STATUS_LABELS.needs_you,
        canContinue: false,
        reasons: top3(head),
        actions: [
          { id: 'confirm_visual', label: '确认外观', enabled: false, disabledReason: '截图确认在 M4-2 提供', primary: true },
          { id: 'merge_override', label: '授权强行合并', enabled: true },
          abandonAction(),
          merge,
        ],
      };
    default:
      // mergeable（终止阶段不会作为进行中的改动传进来）
      return {
        ...common,
        status: 'ok',
        ...CARD_STATUS_LABELS.ok,
        canContinue: true,
        reasons: top3([{ severity: 5, text: `改动${name}全部检查通过，可以合并`, featureIds: [] }]),
        actions: [{ ...merge, primary: true }, ctx.runAction(false), abandonAction()],
      };
  }
}

function collectReasons(features: FeatureView[]): CardReason[] {
  const out: CardReason[] = [];
  const broken = features.filter((f) => f.state === 'broken');
  if (broken.length) {
    const n = broken.reduce((s, f) => s + f.examples.filter((x) => x.state === 'failed').length, 0);
    out.push({
      severity: SEVERITY.failed,
      text: `${names(broken)} 被破坏：${n} 个已锁定例子失败`,
      featureIds: broken.map((f) => f.featureId),
    });
  }

  const byReason = new Map<UnverifiedReason, { examples: ExampleView[]; features: FeatureView[] }>();
  for (const f of features) {
    for (const x of f.examples) {
      if (x.state !== 'unverified' || !x.reason) continue;
      const g = byReason.get(x.reason) ?? { examples: [], features: [] };
      g.examples.push(x);
      if (!g.features.includes(f)) g.features.push(f);
      byReason.set(x.reason, g);
    }
  }
  const reasonText: Record<UnverifiedReason, (n: number, who: string) => string> = {
    ai_claim_only: (n, who) => `${n} 个例子仅 AI 声称，系统未验证（${who}）`,
    errored: (n, who) => `${n} 个例子执行异常（${who}）`,
    invalid: (n, who) => `${n} 个例子证据无效：运行期间代码有变化（${who}）`,
    flaky: (n, who) => `${n} 个例子结果不稳定：先失败后通过（${who}）`,
    stale: (n, who) => `${n} 个例子证据过期：上次运行后代码有改动（${who}）`,
    not_run: (n, who) => `${n} 个例子尚未运行（${who}）`,
  };
  for (const [reason, g] of byReason) {
    out.push({
      severity: SEVERITY[reason],
      text: reasonText[reason](g.examples.length, names(g.features)),
      featureIds: g.features.map((f) => f.featureId),
    });
  }

  const empty = features.filter((f) => f.lockedCount === 0);
  if (empty.length) {
    out.push({
      severity: SEVERITY.no_examples,
      text: `${empty.length} 个功能尚无例子（${names(empty)}）`,
      featureIds: empty.map((f) => f.featureId),
    });
  }
  const weak = features.filter((f) => f.lockedCount > 0 && f.coverage.weak);
  if (weak.length) {
    out.push({
      severity: SEVERITY.weak,
      text: `${weak.length} 个功能覆盖薄弱（${names(weak)}）`,
      featureIds: weak.map((f) => f.featureId),
    });
  }
  return out.sort((a, b) => a.severity - b.severity);
}

function names(features: FeatureView[]): string {
  const shown = features.slice(0, 3).map((f) => f.name);
  return features.length > 3 ? `${shown.join('、')} 等 ${features.length} 个` : shown.join('、');
}
