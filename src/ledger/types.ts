/**
 * 账本事件类型（规格 §4.1）。
 *
 * M1-1 一次性写全所有事件类型，后续任务直接复用，不再改事件格式；确需改动时先改规格并升级 LEDGER_VERSION。
 * 标注 "v2.2" 的事件来自 tasks.md 引用的 spec v2.2 增补；字段以 tasks.md 的描述为准，规格补齐后如有出入以规格为准。
 */

export const LEDGER_VERSION = 3;

export type Sha256Hex = string;
export type IsoTime = string;

export type Track = 'small' | 'feature';
export type ChangeSource = 'claude-code' | 'external';
export type ExampleKind = 'behavior' | 'visual';
export type FeatureOrigin = 'new' | 'scan';
export type RecordKind = 'decision' | 'pitfall';
export type RecordScope = 'project' | 'personal';

/** 需授权的动作（§6 D22，含 v2.2 的 merge / abandon / budget_raise）。 */
export type AuthAction =
  | 'merge'
  | 'merge_override'
  | 'abandon'
  | 'modify_locked'
  | 'delete'
  | 'release'
  | 'budget_raise';

/** 运行目的：常规回归、先失败检查（不参与判定）、接入基线。 */
export type RunPurpose = 'regression' | 'red_check' | 'baseline';

export type CheckStatus = 'passed' | 'failed' | 'not_run' | 'errored' | 'flaky';

export interface CheckAttempt {
  status: Exclude<CheckStatus, 'flaky' | 'not_run'>;
  exitCode: number | null;
  durationMs: number;
  logPath: string;
}

export interface CheckResult {
  exampleId: string;
  status: CheckStatus;
  durationMs: number;
  logPath: string;
  screenshot?: string;
  /** 本次运行实际使用的检查快照（== example.locked.checkHash）。 */
  checkSnapshotId?: Sha256Hex;
  /** 同轮复跑记录；flaky 时至少两条。 */
  attempts?: CheckAttempt[];
  /** errored / not_run 的原因（如开发服务器未就绪、超时、依赖缺失）。 */
  detail?: string;
}

/** 文件归属：某个文件承载哪些功能（M4-3）。 */
export interface FileAttribution {
  path: string;
  featureIds: string[];
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  from?: string;
}

export interface PlanStep {
  stepId: string;
  title: string;
  dependsOn: string[];
  track: Track;
  targetFeatureIds?: string[];
}

/** 每个事件体都带 type；账本行在其外再包一层信封（见 LedgerLine）。 */
export type Event =
  // ---- 账本自身 ----
  | { type: 'ledger.meta'; ledgerVersion: number; projectId: string; createdAt: IsoTime }
  | {
      type: 'ledger.integrity_override';
      /** override 行之前文件全部字节的 sha256（不含 override 行）。 */
      prefixSha256: Sha256Hex;
      /** 接受的断链行号（seq）。 */
      brokenLinks: number[];
      reason: string;
      by: 'user';
    }
  | { type: 'ledger.head_recovered'; previousHead: Sha256Hex | null; recoveredHead: Sha256Hex; by: 'user' } // M6
  | { type: 'ledger.trust_established'; head: Sha256Hex; by: 'user' } // M6 TOFU
  | { type: 'ledger.restored'; fromCommit: string; discardedLines: number; by: 'user' } // M6

  // ---- 功能与例子 ----
  | { type: 'feature.created'; featureId: string; name: string; origin: FeatureOrigin; entryFiles?: string[] }
  | { type: 'feature.retired'; featureId: string; reason: string; authId: string }
  | {
      type: 'example.drafted';
      exampleId: string;
      featureId: string;
      given: string;
      when: string;
      then: string;
      kind: ExampleKind;
      checkPath?: string;
      /** 检查代码的大白话摘要（§16）。 */
      summary?: string;
    }
  | {
      type: 'example.locked';
      exampleId: string;
      checkPath: string;
      checkHash: Sha256Hex;
      by: 'user';
      /** 锁定前的先失败检查（v2.2）：runId 指向 purpose:'red_check' 的运行；豁免时为 waived。 */
      redCheck?: { runId: string; status: 'failed' } | { waived: true; reason: string } | { baseline: true };
    }
  | { type: 'example.unlocked'; exampleId: string; reason: string; by: 'user'; authId?: string }
  | { type: 'example.red_waived'; exampleId: string; checkHash: Sha256Hex; reason: string; by: 'user' }
  | { type: 'example.known_inconsistent'; exampleId: string; runId: string; reason: string; by: 'user' }

  // ---- 改动 ----
  | {
      type: 'change.started';
      changeId: string;
      track: Track;
      baseCommit: string;
      source: ChangeSource;
      description?: string;
      firstObservedWorkTreeHash?: Sha256Hex;
      planId?: string;
      stepId?: string;
      targetFeatureIds?: string[];
    }
  | { type: 'change.track_upgraded'; changeId: string; by: 'user' }
  | { type: 'change.track_downgraded'; changeId: string; by: 'user'; reason?: string }
  | { type: 'change.interrupted'; changeId: string; reason: string }
  | { type: 'change.unmanaged_commit'; fromCommit: string; toCommit: string }
  | { type: 'change.files_attributed'; changeId: string; attributions: FileAttribution[]; by: 'ai' | 'user' | 'target' }
  | { type: 'claim.reported'; changeId: string; exampleId?: string; text: string; malformed?: boolean }
  | {
      type: 'run.completed';
      runId: string;
      changeId?: string;
      purpose: RunPurpose;
      /** run 起止四个值（§4.1 Invariant 3）。 */
      startCommit: string;
      endCommit: string;
      startWorkTreeHash: Sha256Hex;
      endWorkTreeHash: Sha256Hex;
      workTreeHashSpec: Sha256Hex;
      /** 起止任一不一致 → false，结果不作证。 */
      valid: boolean;
      /** 本次运行使用的快照集合：exampleId → checkSnapshotId。 */
      snapshots: Record<string, Sha256Hex>;
      results: CheckResult[];
      /** 旧字段：等价于 endCommit / endWorkTreeHash，保留以对齐 §4.1 原始定义。 */
      commit: string;
      workTreeHash: Sha256Hex;
    }
  | { type: 'visual.confirmed'; exampleId: string; runId?: string; screenshot: string; ok: boolean; note?: string }
  | { type: 'guard.blocked'; changeId?: string; path: string; tool: string; detail: string }

  // ---- 授权三段式（v2.2）----
  | { type: 'auth.granted'; authId: string; action: AuthAction; changeId?: string; reason: string }
  | { type: 'auth.consumed'; authId: string; action: AuthAction; changeId?: string }
  | { type: 'auth.settled'; authId: string; ok: boolean; detail?: string }

  | { type: 'change.merged'; changeId: string; mergeCommit: string; files?: ChangedFile[]; authId?: string }
  | { type: 'change.abandoned'; changeId: string; reason: string; authId?: string; files?: string[] }

  // ---- 记录与规则 ----
  | {
      type: 'record.saved';
      recordId: string;
      kind: RecordKind;
      tags: string[];
      scope: RecordScope;
      title?: string;
      body?: string;
      changeId?: string;
    }
  | { type: 'record.deleted'; recordId: string; authId: string }
  | {
      type: 'rule.proposed' | 'rule.accepted' | 'rule.retired';
      ruleId: string;
      text: string;
      appliesWhen: string;
      expiresWhen: string;
      tags?: string[];
    }

  // ---- 需求计划（v2.2 M4-4）----
  | { type: 'plan.drafted'; planId: string; title: string; steps: PlanStep[] }
  | { type: 'plan.confirmed'; planId: string; by: 'user' }
  | { type: 'plan.revised'; planId: string; steps: PlanStep[]; reason: string; by: 'user' }
  | { type: 'plan.closed'; planId: string; reason: string }

  // ---- 发布 ----
  | { type: 'release.executed'; command: string; exitCode: number; by: 'user'; authId?: string };

export type EventType = Event['type'];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

/**
 * events.jsonl 的一行。
 * hash = sha256(prevHash + JCS({ seq, at, event }))，即信封中除 prevHash / hash 之外的全部字段都受哈希保护。
 */
export interface LedgerLine<E extends Event = Event> {
  seq: number;
  at: IsoTime;
  event: E;
  prevHash: Sha256Hex;
  hash: Sha256Hex;
}

/** 首行的 prevHash。 */
export const GENESIS_HASH: Sha256Hex = '0'.repeat(64);
