/**
 * 授权三段式事务与服务端合并门（规格 §6、D21/D22，tasks.md M2-3）。
 *
 * 每个不可逆动作都走同一条路径，且全部串行执行：
 *   1. 预检（合并门、阶段、参数）——不通过直接拒绝，账本里什么都不写；
 *   2. 一次写入 auth.granted + auth.consumed（+ 决策记录）——**先于副作用**落盘，授权一次性；
 *   3. 执行副作用（git 提交、还原、运行发布命令……）；
 *   4. 一次写入结果事件 + auth.settled。副作用失败时写 auth.settled { ok: false }（补偿），不写结果事件。
 *
 * 第 2 步之后、第 4 步之前崩溃，账本里留下"已消费、未结算"的悬挂授权：
 * 重启后列出来、不自动重试（发布命令绝不会因为重启而执行第二次）。
 *
 * 合并门是唯一的强制边界（Invariant 5）：重算全部锁定检查的快照哈希与工作区哈希、校验事件链，
 * 通过后才 git add -A + commit 并写 change.merged。在 Stagent 之外的提交只会被标为未托管提交，
 * 改动不会因此变成已合并。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChangeView } from '../changes/changes.js';
import type { StagentConfig } from '../config/config.js';
import { readSnapshot, SnapshotIntegrityError, writeSnapshot } from '../evidence/snapshots.js';
import { RUNS_RELATIVE_DIR } from '../executor/executor.js';
import { runCommand } from '../executor/process.js';
import { git, headCommit, isAncestor, UNBORN_COMMIT } from '../git/git.js';
import { sha256Hex } from '../ledger/hash.js';
import type { Ledger } from '../ledger/ledger.js';
import { assertReason } from '../ledger/ledger.js';
import { Mutex } from '../ledger/mutex.js';
import type { AuthAction, ChangedFile, Event, EventOf, IsoTime, LedgerLine } from '../ledger/types.js';
import type { FeatureView } from '../projection/projection.js';

export const AUTH_ACTIONS: readonly AuthAction[] = [
  'merge',
  'merge_override',
  'abandon',
  'modify_locked',
  'delete',
  'release',
  'budget_raise',
];

export const AUTH_LABELS: Record<AuthAction, string> = {
  merge: '合并',
  merge_override: '授权强行合并',
  abandon: '放弃改动',
  modify_locked: '修改锁定例子',
  delete: '退役功能',
  release: '发布上线',
  budget_raise: '提高费用上限',
};

/** 发布命令最长运行时间。 */
const RELEASE_TIMEOUT_MS = 10 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** 测试用：模拟进程在消费授权后、执行副作用前崩溃（验收 #19）。 */
export class SimulatedCrash extends Error {
  override name = 'SimulatedCrash';
}

export interface TamperedCheck {
  exampleId: string;
  featureId: string;
  featureName: string;
  checkPath: string;
  checkHash: string;
  problem: 'modified' | 'missing' | 'snapshot_tampered' | 'snapshot_missing';
}

export interface DanglingAuth {
  authId: string;
  action: AuthAction;
  changeId?: string;
  at: IsoTime;
  reason: string;
}

export interface AuthRequest {
  action?: unknown;
  changeId?: unknown;
  reason?: unknown;
  featureId?: unknown;
  exampleId?: unknown;
  amount?: unknown;
}

export interface AuthResult {
  authId: string;
  action: AuthAction;
  ok: boolean;
  detail?: string;
  mergeCommit?: string;
  files?: ChangedFile[];
  exitCode?: number;
}

/** Authorizer 需要从服务拿到的东西。 */
export interface AuthHost {
  root: string;
  ledger: Ledger;
  config(): Promise<StagentConfig>;
  state(): Promise<{ lines: readonly LedgerLine[]; features: FeatureView[]; active: ChangeView | null; changes: ChangeView[]; workTreeHash: string }>;
  /** 带 SSE 通知与 423 处理的账本写入。 */
  write<T>(fn: () => Promise<T>): Promise<T>;
  isRunning(): boolean;
  /** 副作用改动了工作区之后，告诉文件监听"这是我们自己改的"。 */
  acknowledgeWorkTree(): Promise<void>;
  requestRegression(): Promise<void>;
}

export interface AuthorizerOptions {
  crashBefore?: AuthAction;
}

export class Authorizer {
  private readonly mutex = new Mutex();
  private readonly inFlight = new Set<string>();
  private busy = false;

  constructor(
    private readonly host: AuthHost,
    private readonly options: AuthorizerOptions = {},
  ) {}

  /** 有授权事务进行中（这期间 HEAD 的变化是 Stagent 自己造成的，不算未托管提交）。 */
  get inProgress(): boolean {
    return this.busy;
  }

  /**
   * POST /api/auth：校验原因 → 预检 → 三段式执行。授权一次性：每次调用产生一个新 authId，立即消费。
   * 除 merge 外原因必填且至少 4 个字。
   */
  async authorize(req: AuthRequest): Promise<AuthResult> {
    const action = req.action as AuthAction;
    if (!AUTH_ACTIONS.includes(action)) throw new AuthError(400, `未知的授权动作：${String(req.action)}`);
    const reason = typeof req.reason === 'string' ? req.reason.trim() : '';
    if (action !== 'merge') {
      try {
        assertReason(reason);
      } catch (err) {
        throw new AuthError(400, (err as Error).message);
      }
    }
    if (this.host.ledger.state === 'locked') throw new AuthError(423, '账本被修改，所有写操作已禁用');

    return this.mutex.runExclusive(async () => {
      this.busy = true;
      try {
        return await this.execute(action, reason, req);
      } finally {
        this.busy = false;
      }
    });
  }

  /** 合并门：所有锁定检查的快照与工作区文件都必须和锁定时的 checkHash 一致。 */
  async tamperedChecks(features?: FeatureView[]): Promise<TamperedCheck[]> {
    const list = features ?? (await this.host.state()).features;
    const out: TamperedCheck[] = [];
    for (const f of list) {
      for (const x of f.examples) {
        const base = { exampleId: x.exampleId, featureId: f.featureId, featureName: f.name, checkPath: x.checkPath, checkHash: x.checkHash };
        try {
          await readSnapshot(this.host.root, x.checkHash);
        } catch (err) {
          const problem = err instanceof SnapshotIntegrityError && err.problem === 'missing' ? 'snapshot_missing' : 'snapshot_tampered';
          out.push({ ...base, problem });
          continue;
        }
        const content = await readFile(join(this.host.root, x.checkPath)).catch(() => null);
        if (content === null) out.push({ ...base, problem: 'missing' });
        else if (sha256Hex(content) !== x.checkHash) out.push({ ...base, problem: 'modified' });
      }
    }
    return out;
  }

  /** 已消费、未结算、且不在进行中的授权（崩溃留下的）。 */
  dangling(lines: readonly LedgerLine[]): DanglingAuth[] {
    const granted = new Map<string, EventOf<'auth.granted'>>();
    const consumed = new Map<string, { e: EventOf<'auth.consumed'>; at: IsoTime }>();
    for (const { event: e, at } of lines) {
      if (e.type === 'auth.granted') granted.set(e.authId, e);
      else if (e.type === 'auth.consumed') consumed.set(e.authId, { e, at });
      else if (e.type === 'auth.settled') consumed.delete(e.authId);
    }
    return [...consumed.values()]
      .filter(({ e }) => !this.inFlight.has(e.authId))
      .map(({ e, at }) => ({
        authId: e.authId,
        action: e.action,
        ...(e.changeId ? { changeId: e.changeId } : {}),
        at,
        reason: granted.get(e.authId)?.reason ?? '',
      }));
  }

  /** 用户确认悬挂授权已处理：补一条 auth.settled { ok: false }，不重试副作用。 */
  async dismissDangling(authId: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const { lines } = await this.host.state();
      if (!this.dangling(lines).some((d) => d.authId === authId)) throw new AuthError(404, `没有悬挂的授权 ${authId}`);
      await this.host.write(() =>
        this.host.ledger.append({ type: 'auth.settled', authId, ok: false, detail: '用户确认：悬挂授权已人工处理，未重试' }),
      );
    });
  }

  /** 放弃改动前的预览：会被还原的文件（.stagent/ 不受影响）。 */
  async abandonPreview(changeId: string): Promise<{ restoreTo: string; files: { path: string; status: string }[]; note: string }> {
    const { active } = await this.host.state();
    const change = this.requireActive(active, changeId);
    if (change.baseCommit === UNBORN_COMMIT || !change.baseCommit) throw new AuthError(409, '改动没有基准提交，无法还原');
    return { restoreTo: change.baseCommit, files: await this.filesToRestore(change.baseCommit), note: '.stagent/ 下的账本、快照与检查不会被还原' };
  }

  // ---- 内部 ----

  private async execute(action: AuthAction, reason: string, req: AuthRequest): Promise<AuthResult> {
    const plan = await this.precheck(action, req);
    const authId = `a-${randomBytes(4).toString('hex')}`;
    const changeId = plan.changeId;

    // 第 2 步：授权与消费一起落盘，先于任何副作用。
    await this.host.write(() =>
      this.host.ledger.transaction(async (tx) => {
        await tx.append({ type: 'auth.granted', authId, action, ...(changeId ? { changeId } : {}), reason });
        await tx.append({ type: 'auth.consumed', authId, action, ...(changeId ? { changeId } : {}) });
        if (action !== 'merge') {
          await tx.append({
            type: 'record.saved',
            recordId: `r-${authId}`,
            kind: 'decision',
            tags: ['授权'],
            scope: 'project',
            title: `${AUTH_LABELS[action]}${plan.subject ? `：${plan.subject}` : ''}`,
            body: reason,
            ...(changeId ? { changeId } : {}),
          });
        }
      }),
    );

    this.inFlight.add(authId);
    try {
      if (this.options.crashBefore === action) throw new SimulatedCrash(`模拟崩溃：${action} 已消费授权、尚未执行副作用`);
      let outcome: { events: Event[]; ok: boolean; detail?: string; result: Partial<AuthResult> };
      try {
        outcome = await plan.run(authId);
      } catch (err) {
        if (err instanceof SimulatedCrash) throw err;
        // 补偿：副作用失败，只记 auth.settled { ok: false }。
        const detail = (err as Error).message;
        await this.host.write(() => this.host.ledger.append({ type: 'auth.settled', authId, ok: false, detail }));
        throw new AuthError(err instanceof AuthError ? err.statusCode : 500, `${AUTH_LABELS[action]}失败：${detail}`);
      }
      await this.host.write(() =>
        this.host.ledger.transaction(async (tx) => {
          for (const e of outcome.events) await tx.append(e);
          await tx.append({ type: 'auth.settled', authId, ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}) });
        }),
      );
      await plan.after?.();
      return { authId, action, ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}), ...outcome.result };
    } finally {
      this.inFlight.delete(authId);
    }
  }

  private requireActive(active: ChangeView | null, changeId: unknown): ChangeView {
    if (typeof changeId !== 'string' || !changeId) throw new AuthError(400, '缺少 changeId');
    if (!active || active.changeId !== changeId) throw new AuthError(409, '该改动不是进行中的改动（可能已合并或已放弃）');
    return active;
  }

  private async precheck(
    action: AuthAction,
    req: AuthRequest,
  ): Promise<{
    changeId?: string;
    subject?: string;
    run: (authId: string) => Promise<{ events: Event[]; ok: boolean; detail?: string; result: Partial<AuthResult> }>;
    after?: () => Promise<void>;
  }> {
    const state = await this.host.state();
    switch (action) {
      case 'merge':
      case 'merge_override': {
        const change = this.requireActive(state.active, req.changeId);
        if (this.host.isRunning() || change.phase === 'checking') throw new AuthError(409, '检查进行中，结束后再合并');
        if (action === 'merge' && change.phase !== 'mergeable') {
          throw new AuthError(409, `改动处于「${change.phaseLabel}」阶段，不能合并${change.blockers[0] ? `：${change.blockers[0]}` : ''}`);
        }
        if (action === 'merge_override' && (change.phase === 'confirm_examples' || change.phase === 'red_check')) {
          throw new AuthError(409, '还在确认例子阶段，不能强行合并');
        }
        await this.gate(state.features);
        return {
          changeId: change.changeId,
          subject: change.description,
          run: async (authId) => {
            const { mergeCommit, files } = await this.commit(change);
            return {
              events: [{ type: 'change.merged', changeId: change.changeId, mergeCommit, files, authId }],
              ok: true,
              result: { mergeCommit, files },
            };
          },
          after: () => this.host.acknowledgeWorkTree(),
        };
      }

      case 'abandon': {
        const change = this.requireActive(state.active, req.changeId);
        if (this.host.isRunning() || change.phase === 'checking') throw new AuthError(409, '检查进行中，结束后再放弃');
        if (change.baseCommit === UNBORN_COMMIT || !change.baseCommit) throw new AuthError(409, '改动没有基准提交，无法还原');
        const reason = String(req.reason).trim();
        const cleanup = this.abandonCleanup(state.lines, change, reason);
        return {
          changeId: change.changeId,
          subject: change.description,
          run: async (authId) => {
            const files = await this.filesToRestore(change.baseCommit);
            await git(this.host.root, ['restore', `--source=${change.baseCommit}`, '--staged', '--worktree', '--', '.', ':(exclude).stagent']);
            await git(this.host.root, ['clean', '-fdq', '--', '.', ':(exclude).stagent']);
            return {
              events: [
                ...cleanup(authId),
                { type: 'change.abandoned', changeId: change.changeId, reason, authId, files: files.map((f) => f.path) },
              ],
              ok: true,
              result: { files: files.map((f) => ({ path: f.path, status: 'modified' as const })) },
            };
          },
          after: () => this.host.acknowledgeWorkTree(),
        };
      }

      case 'modify_locked': {
        const exampleId = typeof req.exampleId === 'string' ? req.exampleId : '';
        const x = state.features.flatMap((f) => f.examples).find((e) => e.exampleId === exampleId);
        if (!x) throw new AuthError(404, `例子 ${exampleId || '（未指定）'} 不是锁定例子`);
        return {
          ...(state.active ? { changeId: state.active.changeId } : {}),
          subject: x.then,
          run: async (authId) => ({
            events: [{ type: 'example.unlocked', exampleId, reason: String(req.reason).trim(), by: 'user', authId }],
            ok: true,
            result: {},
          }),
        };
      }

      case 'delete': {
        const featureId = typeof req.featureId === 'string' ? req.featureId : '';
        const f = state.features.find((x) => x.featureId === featureId);
        if (!f) throw new AuthError(404, `功能 ${featureId || '（未指定）'} 不存在`);
        const reason = String(req.reason).trim();
        return {
          subject: f.name,
          run: async (authId) => ({
            events: [
              ...f.examples.map(
                (x): Event => ({ type: 'example.unlocked', exampleId: x.exampleId, reason: `功能退役：${reason}`, by: 'user', authId }),
              ),
              { type: 'feature.retired', featureId, reason, authId },
            ],
            ok: true,
            result: {},
          }),
        };
      }

      case 'release': {
        const config = await this.host.config();
        const command = config.releaseCommand;
        if (!command) throw new AuthError(400, '没有配置发布命令（config.json 的 releaseCommand）');
        if (this.host.isRunning()) throw new AuthError(409, '检查进行中，结束后再发布');
        return {
          subject: command,
          run: async (authId) => {
            const logPath = join(this.host.root, RUNS_RELATIVE_DIR, `release-${authId}.log`);
            await mkdir(dirname(logPath), { recursive: true });
            const r = await runCommand(command, {
              cwd: this.host.root,
              env: { ...process.env, STAGENT_PROJECT_ROOT: this.host.root, STAGENT_AUTH_ID: authId },
              logPath,
              timeoutMs: RELEASE_TIMEOUT_MS,
            });
            if (r.spawnError) throw new Error(`无法启动发布命令：${r.spawnError.message}`);
            const exitCode = r.exitCode ?? -1;
            return {
              events: [{ type: 'release.executed', command, exitCode, by: 'user', authId }],
              ok: exitCode === 0,
              ...(exitCode === 0 ? {} : { detail: r.timedOut ? '发布命令超时' : `发布命令退出码 ${exitCode}` }),
              result: { exitCode },
            };
          },
        };
      }

      case 'budget_raise': {
        // M3-1 触发；这里只记录授权本身。
        const amount = typeof req.amount === 'number' && req.amount > 0 ? req.amount : null;
        return {
          ...(state.active ? { changeId: state.active.changeId } : {}),
          ...(amount ? { subject: `上限提高到 ${amount}` } : {}),
          run: async () => ({ events: [], ok: true, ...(amount ? { detail: `amount=${amount}` } : {}), result: {} }),
        };
      }
    }
  }

  /** 合并门：校验事件链 + 全部锁定检查。 */
  private async gate(features: FeatureView[]): Promise<void> {
    const report = await this.host.ledger.verify();
    if (report.status === 'locked') throw new AuthError(423, '账本被修改，不能合并');
    const tampered = await this.tamperedChecks(features);
    if (tampered.length) {
      throw new AuthError(409, `锁定检查被修改：${tampered.map((t) => t.checkPath).join('、')}（还原锁定文件，或授权修改锁定例子）`);
    }
  }

  /** git add -A + commit；返回提交与相对基准的文件清单（供 M4-3 使用）。 */
  private async commit(change: ChangeView): Promise<{ mergeCommit: string; files: ChangedFile[] }> {
    const root = this.host.root;
    await git(root, ['add', '-A']);
    const message = `${change.description || '改动'}\n\nStagent-Change: ${change.changeId}`;
    try {
      await gitWithIdentity(root, ['commit', '-q', '--allow-empty', '-m', message]);
    } catch (err) {
      await git(root, ['reset', '-q']).catch(() => undefined); // 补偿：撤销暂存
      throw err;
    }
    const mergeCommit = await headCommit(root);
    // 账本与快照是 Stagent 自己的记录，不算这次改动碰过的业务文件（M4-3 据此做文件归属）。
    const files = (await changedFiles(root, change.baseCommit, mergeCommit)).filter((f) => !f.path.startsWith('.stagent/ledger/'));
    return { mergeCommit, files };
  }

  private async filesToRestore(base: string): Promise<{ path: string; status: string }[]> {
    const root = this.host.root;
    const out = new Map<string, string>();
    const head = await headCommit(root);
    if (head !== base && (await isAncestor(root, base, head))) {
      for (const f of await changedFiles(root, base, head)) if (!f.path.startsWith('.stagent/')) out.set(f.path, `已提交（${f.status}）`);
    }
    const status = (await git(root, ['status', '--porcelain=v1', '-z', '--', '.', ':(exclude).stagent'])).split('\0').filter(Boolean);
    for (const entry of status) {
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (code.startsWith('R')) continue;
      out.set(path, code === '??' ? '新文件（会删除）' : code.includes('D') ? '已删除（会恢复）' : '已修改（会还原）');
    }
    return [...out.entries()].map(([path, s]) => ({ path, status: s })).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** 放弃新功能档改动：解锁本改动锁定的例子，退役本改动新建且只属于本改动的功能。 */
  private abandonCleanup(lines: readonly LedgerLine[], change: ChangeView, reason: string): (authId: string) => Event[] {
    const startSeq = lines.find((l) => l.event.type === 'change.started' && l.event.changeId === change.changeId)?.seq ?? 0;
    const createdAfter = new Set(
      lines.filter((l) => l.seq > startSeq && l.event.type === 'feature.created').map((l) => (l.event as EventOf<'feature.created'>).featureId),
    );
    const featureExamples = new Map<string, { changeId?: string }[]>();
    for (const { event: e } of lines) {
      if (e.type === 'example.drafted') featureExamples.set(e.featureId, [...(featureExamples.get(e.featureId) ?? []), { changeId: e.changeId }]);
    }
    const retire = [...createdAfter].filter((fid) => (featureExamples.get(fid) ?? []).every((x) => x.changeId === change.changeId));
    return (authId) => [
      ...change.lockedExampleIds.map(
        (exampleId): Event => ({ type: 'example.unlocked', exampleId, reason: `改动放弃：${reason}`, by: 'user', authId }),
      ),
      ...retire.map((featureId): Event => ({ type: 'feature.retired', featureId, reason: `改动放弃：${reason}`, authId })),
    ];
  }
}

/** 相对 base 的文件清单（含重命名）。base 不存在时列出提交里的全部文件。 */
export async function changedFiles(root: string, base: string, head: string): Promise<ChangedFile[]> {
  const out =
    base && base !== UNBORN_COMMIT
      ? await git(root, ['diff', '--name-status', '-z', '--find-renames', base, head])
      : await git(root, ['show', '--name-status', '-z', '--format=', head]);
  const parts = out.split('\0').filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]!;
    if (code.startsWith('R')) {
      const from = parts[i++]!;
      files.push({ path: parts[i++]!, status: 'renamed', from });
    } else {
      files.push({ path: parts[i++]!, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' });
    }
  }
  return files;
}

/** 仓库没有配置提交身份时用 Stagent 的默认身份；STAGENT_MERGE 让 pre-merge-commit 提醒静默。 */
async function gitWithIdentity(root: string, args: string[]): Promise<string> {
  const hasEmail = await git(root, ['config', 'user.email']).then((s) => s.trim() !== '', () => false);
  const identity = hasEmail ? [] : ['-c', 'user.name=Stagent', '-c', 'user.email=stagent@localhost'];
  return git(root, [...identity, ...args], { env: { ...process.env, STAGENT_MERGE: '1' } });
}

/** 把锁定检查从快照还原到工作区（「还原锁定文件」，不需要授权）。 */
export async function restoreLockedCheck(root: string, checkPath: string, checkHash: string): Promise<void> {
  const content = await readSnapshot(root, checkHash);
  await mkdir(dirname(join(root, checkPath)), { recursive: true });
  await writeFile(join(root, checkPath), content);
}

/** 重新锁定被授权解锁的例子：以工作区当前内容写新快照。 */
export async function snapshotForRelock(root: string, checkPath: string): Promise<string> {
  return writeSnapshot(root, await readFile(join(root, checkPath)));
}
