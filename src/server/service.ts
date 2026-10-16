/**
 * Stagent 服务核心：把账本、执行器、投影与改动编排连起来，供 HTTP 层调用。
 *
 * 状态只由服务端从事件推导：没有任何方法能直接把功能或例子写成"已验证"（Invariant 2），
 * 已验证只能来自执行器写入的 run.completed；改动阶段同样只由事件推导（§5.4）。
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { activeChangeIdFromLines, knownHead, projectChanges, type ChangeView, type ChangesProjection } from '../changes/changes.js';
import { loadConfig, type StagentConfig } from '../config/config.js';
import { cleanOrphanSnapshots, writeSnapshot } from '../evidence/snapshots.js';
import { computeWorkTreeHash, type WorkTreeHashResult } from '../evidence/worktree-hash.js';
import { CHECKS_RELATIVE_DIR, runChecks, type CheckSpec } from '../executor/executor.js';
import { git, headCommit, isAncestor, UNBORN_COMMIT } from '../git/git.js';
import { assertReason, Ledger, LedgerLockedError } from '../ledger/ledger.js';
import type { ExampleKind, LedgerLine, Track } from '../ledger/types.js';
import { buildOverview, type Overview, type RunProgressView } from '../projection/overview.js';
import { project, type FeatureView, type LedgerProjection } from '../projection/projection.js';
import { EventBus } from './event-bus.js';
import { WorkspaceWatcher } from './watcher.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceOptions {
  /** 测试注入配置；默认读 .stagent/config.json。 */
  config?: StagentConfig;
  /** 外部改动静止多久算"静止"（§5.3：防抖 2 秒）。 */
  watchDebounceMs?: number;
  /** 外部改动静止后自动进入检查（默认 true）。 */
  autoCheckExternal?: boolean;
}

/** 一次读盘得到的完整状态。 */
interface Snapshot {
  lines: readonly LedgerLine[];
  current: WorkTreeHashResult;
  projection: LedgerProjection;
  changes: ChangesProjection;
}

export type OverviewResponse = Overview & { runError: string | null; project: { name: string; branch: string | null } };

export class StagentService {
  readonly bus = new EventBus();
  private run: (RunProgressView & { controller: AbortController; promise: Promise<void>; changeId: string | null }) | null = null;
  private lastRunError: string | null = null;
  private watcher: WorkspaceWatcher | null = null;
  private lastSeenWorkTreeHash: string | null = null;
  /** 运行进行中又来了需要检查的事情（外部改动静止、未托管提交），运行结束后再跑一次。 */
  private pendingCheck = false;
  /** 外部改动检测串行执行，避免同一批改动建出两个改动。 */
  private settling: Promise<void> = Promise.resolve();
  private activeIdCache: string | null = null;

  private constructor(
    readonly root: string,
    readonly ledger: Ledger,
    private readonly options: ServiceOptions,
  ) {}

  /** 打开账本（版本不符会抛错）；账本完好时清理孤儿快照。 */
  static async open(root: string, options: ServiceOptions = {}): Promise<StagentService> {
    const ledger = await Ledger.open(root);
    if (ledger.state === 'ok') await cleanOrphanSnapshots(root, ledger.events());
    return new StagentService(root, ledger, options);
  }

  async config(): Promise<StagentConfig> {
    return this.options.config ?? loadConfig(this.root);
  }

  /** 重新读盘校验账本，按当前工作区投影功能与改动。 */
  private async snapshot(): Promise<Snapshot> {
    const report = await this.ledger.verify();
    const config = await this.config();
    const current = await computeWorkTreeHash(this.root, { ignoreGlobs: config.evidence.ignoreGlobs });
    const projection = project(report.lines, current);
    const changes = projectChanges(report.lines, {
      current,
      projection,
      runningChangeId: this.run?.changeId ?? null,
    });
    this.activeIdCache = changes.active?.changeId ?? null;
    return { lines: report.lines, current, projection, changes };
  }

  async projection(): Promise<LedgerProjection> {
    return (await this.snapshot()).projection;
  }

  async overview(): Promise<OverviewResponse> {
    const { projection, changes } = await this.snapshot();
    const overview = buildOverview({
      projection,
      ledger: { state: this.ledger.state, brokenLinks: this.ledger.report.brokenLinks },
      run: this.run ? publicRun(this.run) : null,
      change: changes.active,
    });
    return { ...overview, runError: this.lastRunError, project: { name: basename(this.root), branch: await currentBranch(this.root) } };
  }

  async features(): Promise<FeatureView[]> {
    return (await this.projection()).features;
  }

  async feature(featureId: string): Promise<FeatureView> {
    const f = (await this.features()).find((x) => x.featureId === featureId);
    if (!f) throw new HttpError(404, `功能 ${featureId} 不存在`);
    return f;
  }

  get running(): boolean {
    return this.run !== null;
  }

  // ---- 改动（§5） ----

  async changes(): Promise<ChangesProjection> {
    return (await this.snapshot()).changes;
  }

  async change(changeId: string): Promise<ChangeView> {
    const c = (await this.changes()).changes.find((x) => x.changeId === changeId);
    if (!c) throw new HttpError(404, `改动 ${changeId} 不存在`);
    return c;
  }

  /** 当前进行中的改动 id（守卫写 guard.blocked 时引用；取最近一次读盘的结果）。 */
  activeChangeId(): string | null {
    return this.activeIdCache;
  }

  /** 该 Claude Code 会话是否是「确认例子」阶段的起草会话（M3-2 提供；目前总是 false）。 */
  isDraftingSession(_sessionId?: string): boolean {
    return false;
  }

  /**
   * 创建改动（§5.0）：同一时间只能有一个进行中的改动，否则 409。
   * 由 Stagent 发起的改动将由 Claude Code 执行（M3），source 记为 claude-code。
   */
  async createChange(input: { description?: unknown; track?: unknown }): Promise<ChangeView> {
    this.assertWritable();
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description) throw new HttpError(400, '请描述这次改动');
    const track: Track = input.track === 'feature' ? 'feature' : 'small';
    const snap = await this.snapshot();
    if (snap.changes.active) {
      throw new HttpError(409, `已有进行中的改动「${snap.changes.active.description}」，请先合并或放弃`);
    }
    const changeId = newId('c');
    const baseCommit = await headCommit(this.root);
    // 在账本写锁内再查一次，两个并发请求只有一个能建成（另一个 409）。
    await this.write(() =>
      this.ledger.transaction(async (tx) => {
        if (activeChangeIdFromLines(tx.report.lines)) throw new HttpError(409, '已有进行中的改动，请先合并或放弃');
        await tx.append({ type: 'change.started', changeId, track, baseCommit, source: 'claude-code', description });
      }),
    );
    return this.change(changeId);
  }

  /** 升档 / 降档（§5.2）。降档只能在本改动还没有锁定例子时进行。 */
  async setTrack(changeId: string, input: { track?: unknown; reason?: unknown }): Promise<ChangeView> {
    const c = await this.activeChange(changeId);
    const track = input.track;
    if (track !== 'small' && track !== 'feature') throw new HttpError(400, 'track 必须是 small 或 feature');
    if (track === c.track) throw new HttpError(409, `已经是${track === 'feature' ? '新功能档' : '小改动档'}`);
    if (track === 'small' && c.lockedExampleIds.length > 0) {
      throw new HttpError(409, '本改动已经锁定了例子，不能降为小改动档');
    }
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined;
    await this.write(() =>
      this.ledger.append(
        track === 'feature'
          ? { type: 'change.track_upgraded', changeId, by: 'user' }
          : { type: 'change.track_downgraded', changeId, by: 'user', ...(reason ? { reason } : {}) },
      ),
    );
    return this.change(changeId);
  }

  /**
   * 新功能档：起草一个验收例子（情况 → 操作 → 期望）。M3-2 起由 Claude Code 起草；
   * 目前由你手写检查文件（放在 .stagent/checks/ 下）后在这里登记。可指定已有功能或新建功能。
   */
  async draftExample(changeId: string, input: Record<string, unknown>): Promise<{ exampleId: string; featureId: string }> {
    const c = await this.activeChange(changeId);
    if (c.track !== 'feature') throw new HttpError(409, '小改动档不新增例子；需要新例子请先升为新功能档');
    // 实现中也可以补例子：有未锁定的草稿时，改动回到「确认例子」。
    if (c.phase === 'checking') throw new HttpError(409, '检查进行中，结束后再起草例子');
    const text = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const given = text('given');
    const when = text('when');
    const then = text('then');
    if (!given || !when || !then) throw new HttpError(400, '情况、操作、期望都要填写');
    const kind: ExampleKind = input.kind === 'visual' ? 'visual' : 'behavior';
    const checkPath = checkPathInput(text('checkPath'));
    try {
      await readFile(join(this.root, checkPath));
    } catch {
      throw new HttpError(400, `检查文件 ${checkPath} 不存在`);
    }

    let featureId = text('featureId');
    const featureName = text('featureName');
    const features = await this.features();
    if (featureId && !features.some((f) => f.featureId === featureId)) throw new HttpError(404, `功能 ${featureId} 不存在`);
    if (!featureId && !featureName) throw new HttpError(400, '请选择已有功能或填写新功能名称');
    const exampleId = newId('e');
    const createFeature = !featureId;
    if (createFeature) featureId = newId('f');
    await this.write(() =>
      this.ledger.transaction(async (tx) => {
        if (createFeature) await tx.append({ type: 'feature.created', featureId, name: featureName, origin: 'new' });
        await tx.append({ type: 'example.drafted', exampleId, featureId, given, when, then, kind, checkPath, changeId });
      }),
    );
    return { exampleId, featureId };
  }

  /**
   * 确认并锁定例子（POST /api/changes/:id/examples/lock）：写检查快照与 example.locked。
   * 不传 exampleIds 时锁定本改动全部草稿。先失败检查的强制要求在 M3-2 加入。
   */
  async lockExamples(changeId: string, input: { exampleIds?: unknown }): Promise<ChangeView> {
    const c = await this.activeChange(changeId);
    const ids = Array.isArray(input.exampleIds) ? input.exampleIds.filter((x): x is string => typeof x === 'string') : c.pendingDraftIds;
    if (ids.length === 0) throw new HttpError(400, '没有待锁定的例子草稿');
    const unknown = ids.filter((id) => !c.pendingDraftIds.includes(id));
    if (unknown.length) throw new HttpError(409, `这些例子不是本改动的待锁定草稿：${unknown.join('、')}`);

    const drafts = new Map<string, string>();
    for (const { event: e } of this.ledger.lines()) if (e.type === 'example.drafted' && e.checkPath) drafts.set(e.exampleId, e.checkPath);
    const locks: { exampleId: string; checkPath: string; checkHash: string }[] = [];
    for (const exampleId of ids) {
      const checkPath = drafts.get(exampleId)!;
      let content: Buffer;
      try {
        content = await readFile(join(this.root, checkPath));
      } catch {
        throw new HttpError(400, `检查文件 ${checkPath} 不存在`);
      }
      locks.push({ exampleId, checkPath, checkHash: await writeSnapshot(this.root, content) });
    }
    await this.write(() =>
      this.ledger.transaction(async (tx) => {
        for (const l of locks) await tx.append({ type: 'example.locked', ...l, by: 'user', changeId });
      }),
    );
    return this.change(changeId);
  }

  /** 实现完成，开始检查：对全部已锁定例子跑全量回归（§5.2 / §7）。 */
  async startCheck(changeId: string): Promise<{ total: number }> {
    const c = await this.activeChange(changeId);
    if (c.phase === 'confirm_examples' || c.phase === 'red_check') {
      throw new HttpError(409, '还在确认例子阶段：先锁定例子再开始检查');
    }
    return this.startRegression();
  }

  // ---- 运行 ----

  /** 手动全量回归：运行全部已锁定例子（v1 不做选择性运行）。异步执行，进度经 SSE 推送。 */
  async startRegression(): Promise<{ total: number }> {
    if (this.run) throw new HttpError(409, '已有检查在运行');
    this.assertWritable();
    const snap = await this.snapshot();
    const features = snap.projection.features;
    const changeId = snap.changes.active?.changeId ?? null;
    const checks: CheckSpec[] = features.flatMap((f) =>
      f.examples.map((x) => ({
        exampleId: x.exampleId,
        checkPath: x.checkPath,
        source: { kind: 'snapshot' as const, checkSnapshotId: x.checkHash },
      })),
    );
    if (checks.length === 0) throw new HttpError(400, '还没有锁定的例子');
    const names = new Map(features.flatMap((f) => f.examples.map((x) => [x.exampleId, `${f.name}：${x.then}`])));

    const controller = new AbortController();
    const config = await this.config();
    const state = {
      runId: null as string | null,
      done: 0,
      total: checks.length,
      current: (names.get(checks[0]!.exampleId) ?? checks[0]!.exampleId) as string | null,
      startedAt: new Date().toISOString(),
      controller,
      promise: Promise.resolve(),
      changeId,
    };
    this.run = state;
    this.lastRunError = null;
    this.pendingCheck = false;
    this.bus.publish('run.started', { ...publicRun(state), changeId });

    state.promise = runChecks({
      projectRoot: this.root,
      ledger: this.ledger,
      checks,
      purpose: 'regression',
      ...(changeId ? { changeId } : {}),
      config,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'starting') {
          state.runId = p.runId;
          state.done = 0;
          state.current = names.get(checks[0]!.exampleId) ?? null;
        } else if (p.phase === 'check' && p.index !== undefined) {
          state.done = p.index + 1;
          const next = checks[p.index + 1];
          state.current = next ? (names.get(next.exampleId) ?? next.exampleId) : null;
        }
        this.bus.publish('run.progress', { ...publicRun(state), phase: p.phase, exampleId: p.exampleId, status: p.status });
      },
    })
      .then((outcome) => {
        for (const r of outcome.runs) this.bus.publish('ledger.appended', { seq: r.seq, type: r.event.type });
        this.bus.publish('run.finished', { runId: outcome.final.event.runId, valid: outcome.final.event.valid, changeId });
        this.lastSeenWorkTreeHash = outcome.final.event.endWorkTreeHash;
      })
      .catch((err: Error) => {
        this.lastRunError = err.message;
        this.bus.publish('run.failed', { message: err.message });
      })
      .finally(() => {
        this.run = null;
        if (this.pendingCheck && !controller.signal.aborted) {
          this.pendingCheck = false;
          void this.startRegression().catch(() => undefined);
        }
      });
    return { total: checks.length };
  }

  cancelRun(): void {
    if (!this.run) throw new HttpError(409, '当前没有在运行的检查');
    this.pendingCheck = false;
    this.run.controller.abort();
  }

  /** 等当前运行（以及运行结束后排队的那一次）结束（测试与优雅退出用）。 */
  async waitForRun(): Promise<void> {
    while (this.run) await this.run.promise;
  }

  // ---- 外部改动（§5.3） ----

  /** 开始监听工作区（chokidar，防抖后调用 onWorkspaceSettled），并定时检查 HEAD。 */
  async startWatching(): Promise<void> {
    if (this.watcher) return;
    this.lastSeenWorkTreeHash = (await this.snapshot()).current.workTreeHash;
    this.watcher = new WorkspaceWatcher(this.root, {
      debounceMs: this.options.watchDebounceMs ?? 2000,
      onSettled: () => this.onWorkspaceSettled(),
      onHeadPoll: () => this.checkHead(),
    });
    await this.watcher.start();
  }

  async stopWatching(): Promise<void> {
    await this.watcher?.stop();
    this.watcher = null;
  }

  /**
   * 工作区静止：工作区真的变了（workTreeHash 变化，过滤掉被忽略文件的噪音）时——
   * 没有进行中的改动 → 建一个外部改动（source: external, track: small，基准为当前 HEAD）；
   * 有进行中的改动 → 变化并入它（不新建）。外部来源的改动在静止后自动进入检查。
   */
  onWorkspaceSettled(): Promise<void> {
    this.settling = this.settling.then(() => this.settleOnce()).catch(() => undefined);
    return this.settling;
  }

  private async settleOnce(): Promise<void> {
    if (this.ledger.state === 'locked') return;
    let snap = await this.snapshot();
    if (snap.current.workTreeHash === this.lastSeenWorkTreeHash) return;
    this.lastSeenWorkTreeHash = snap.current.workTreeHash;
    this.bus.publish('workspace.changed', { workTreeHash: snap.current.workTreeHash });

    if (!snap.changes.active) {
      const baseCommit = await headCommit(this.root);
      const firstObservedWorkTreeHash = snap.current.workTreeHash;
      await this.write(() =>
        this.ledger.transaction(async (tx) => {
          if (activeChangeIdFromLines(tx.report.lines)) return; // 期间刚建了改动：并入它
          await tx.append({
            type: 'change.started',
            changeId: newId('c'),
            track: 'small',
            baseCommit,
            source: 'external',
            description: '外部改动（Cursor 或手写）',
            firstObservedWorkTreeHash,
          });
        }),
      );
      this.bus.publish('change.started', { source: 'external' });
      snap = await this.snapshot();
    }
    const active = snap.changes.active;
    if (active?.source === 'external' && active.phase === 'implementing' && this.options.autoCheckExternal !== false) {
      await this.requestCheck(snap);
    }
  }

  /**
   * HEAD 前进了、却没有对应的 change.merged：有人在 Stagent 之外直接 git commit。
   * 记一条 change.unmanaged_commit，并补跑全量回归（§5.3）。启动时与监听期间定时调用。
   */
  async checkHead(): Promise<boolean> {
    if (this.ledger.state === 'locked') return false;
    const snap = await this.snapshot();
    const known = knownHead(snap.lines);
    const head = await headCommit(this.root);
    if (!known || !head || head === UNBORN_COMMIT || head === known || known === UNBORN_COMMIT) return false;
    if (!(await isAncestor(this.root, known, head))) return false; // 切分支 / 回退不算"前进"
    await this.write(() => this.ledger.append({ type: 'change.unmanaged_commit', fromCommit: known, toCommit: head }));
    await this.requestCheck(await this.snapshot());
    return true;
  }

  private async requestCheck(snap: Snapshot): Promise<void> {
    if (snap.projection.features.every((f) => f.lockedCount === 0)) return;
    if (this.run) {
      this.pendingCheck = true;
      return;
    }
    await this.startRegression().catch(() => undefined);
  }

  // ---- 账本 ----

  /** "我确认，接受当前状态"：写 ledger.integrity_override。 */
  async acceptLedger(reason: string): Promise<void> {
    try {
      assertReason(reason);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    if (this.ledger.state !== 'locked') await this.ledger.verify();
    if (this.ledger.state !== 'locked') throw new HttpError(409, '账本未被修改，无需接受当前状态');
    const line = await this.ledger.acceptCurrentState(reason);
    this.bus.publish('ledger.appended', { seq: line.seq, type: line.event.type });
  }

  // ---- 内部 ----

  private async activeChange(changeId: string): Promise<ChangeView> {
    this.assertWritable();
    const { changes } = await this.snapshot();
    const c = changes.changes.find((x) => x.changeId === changeId);
    if (!c) throw new HttpError(404, `改动 ${changeId} 不存在`);
    if (changes.active?.changeId !== changeId) throw new HttpError(409, `改动已${c.phaseLabel}，不能再操作`);
    return c;
  }

  private assertWritable(): void {
    if (this.ledger.state === 'locked') throw new HttpError(423, '账本被修改，写操作已禁用');
  }

  private async write<T>(fn: () => Promise<T>): Promise<T> {
    this.assertWritable();
    try {
      const before = this.ledger.report.nextSeq;
      const result = await fn();
      this.bus.publish('ledger.appended', { fromSeq: before, toSeq: this.ledger.report.nextSeq - 1 });
      return result;
    } catch (err) {
      if (err instanceof LedgerLockedError) {
        this.bus.publish('ledger.locked', { brokenLinks: err.report.brokenLinks });
        throw new HttpError(423, '账本被修改，写操作已禁用');
      }
      throw err;
    }
  }
}

async function currentBranch(root: string): Promise<string | null> {
  try {
    const b = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
    return b || null;
  } catch {
    return null;
  }
}

function publicRun(r: RunProgressView): RunProgressView {
  return { runId: r.runId, done: r.done, total: r.total, current: r.current, startedAt: r.startedAt };
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

function checkPathInput(p: string): string {
  if (!p) throw new HttpError(400, '缺少检查文件路径');
  const n = normalize(p);
  const prefix = normalize(CHECKS_RELATIVE_DIR) + sep;
  if (isAbsolute(n) || !n.startsWith(prefix)) throw new HttpError(400, '检查文件必须在 .stagent/checks/ 下');
  return n.split(sep).join('/');
}
