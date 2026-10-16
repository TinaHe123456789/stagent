/**
 * Stagent 服务核心：把账本、执行器与投影连起来，供 HTTP 层调用。
 *
 * 状态只由服务端从事件推导：没有任何方法能直接把功能或例子写成"已验证"（Invariant 2），
 * 已验证只能来自执行器写入的 run.completed。
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { loadConfig, type StagentConfig } from '../config/config.js';
import { cleanOrphanSnapshots, writeSnapshot } from '../evidence/snapshots.js';
import { computeWorkTreeHash } from '../evidence/worktree-hash.js';
import { CHECKS_RELATIVE_DIR, runChecks, type CheckSpec } from '../executor/executor.js';
import { assertReason, Ledger, LedgerLockedError } from '../ledger/ledger.js';
import type { ExampleKind } from '../ledger/types.js';
import { buildOverview, type Overview, type RunProgressView } from '../projection/overview.js';
import { project, type FeatureView, type LedgerProjection } from '../projection/projection.js';
import { git } from '../git/git.js';
import { EventBus } from './event-bus.js';

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
}

export class StagentService {
  readonly bus = new EventBus();
  private run: (RunProgressView & { controller: AbortController; promise: Promise<void> }) | null = null;
  private lastRunError: string | null = null;

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

  /** 重新读盘校验账本，按当前工作区投影。 */
  async projection(): Promise<LedgerProjection> {
    const report = await this.ledger.verify();
    const config = await this.config();
    const current = await computeWorkTreeHash(this.root, { ignoreGlobs: config.evidence.ignoreGlobs });
    return project(report.lines, current);
  }

  async overview(): Promise<Overview & { runError: string | null; project: { name: string; branch: string | null } }> {
    const projection = await this.projection();
    const report = this.ledger.report;
    const overview = buildOverview({
      projection,
      ledger: { state: this.ledger.state, brokenLinks: report.brokenLinks },
      run: this.run ? publicRun(this.run) : null,
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

  /** 手动全量回归：运行全部已锁定例子（v1 不做选择性运行）。异步执行，进度经 SSE 推送。 */
  async startRegression(): Promise<{ total: number }> {
    if (this.run) throw new HttpError(409, '已有检查在运行');
    this.assertWritable();
    const features = await this.features();
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
    };
    this.run = state;
    this.lastRunError = null;
    this.bus.publish('run.started', publicRun(state));

    state.promise = runChecks({
      projectRoot: this.root,
      ledger: this.ledger,
      checks,
      purpose: 'regression',
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
        this.bus.publish('run.finished', { runId: outcome.final.event.runId, valid: outcome.final.event.valid });
      })
      .catch((err: Error) => {
        this.lastRunError = err.message;
        this.bus.publish('run.failed', { message: err.message });
      })
      .finally(() => {
        this.run = null;
      });
    return { total: checks.length };
  }

  cancelRun(): void {
    if (!this.run) throw new HttpError(409, '当前没有在运行的检查');
    this.run.controller.abort();
  }

  /** 等当前运行结束（测试与优雅退出用）。 */
  async waitForRun(): Promise<void> {
    await this.run?.promise;
  }

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

  // ---- M1 临时演示入口：在 M2-2 中由正式的改动流程替换 ----

  async devAddFeature(input: { name?: unknown }): Promise<{ featureId: string }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new HttpError(400, '功能名称不能为空');
    const featureId = `f-${randomBytes(4).toString('hex')}`;
    await this.write(() => this.ledger.append({ type: 'feature.created', featureId, name, origin: 'new' }));
    return { featureId };
  }

  /**
   * 起草并锁定一个例子：检查文件必须已在 .stagent/checks/ 下。
   * 只写 example.drafted / example.locked 与快照；不接受、也不写任何结果或状态。
   */
  async devLockExample(featureId: string, input: Record<string, unknown>): Promise<{ exampleId: string; checkHash: string }> {
    const features = await this.features();
    if (!features.some((f) => f.featureId === featureId)) throw new HttpError(404, `功能 ${featureId} 不存在`);
    const text = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const given = text('given');
    const when = text('when');
    const then = text('then');
    if (!given || !when || !then) throw new HttpError(400, '情况、操作、期望都要填写');
    const kind: ExampleKind = input.kind === 'visual' ? 'visual' : 'behavior';
    const checkPath = checkPathInput(text('checkPath'));
    let content: Buffer;
    try {
      content = await readFile(join(this.root, checkPath));
    } catch {
      throw new HttpError(400, `检查文件 ${checkPath} 不存在`);
    }

    const exampleId = `e-${randomBytes(4).toString('hex')}`;
    const checkHash = await writeSnapshot(this.root, content);
    await this.write(() =>
      this.ledger.transaction(async (tx) => {
        await tx.append({ type: 'example.drafted', exampleId, featureId, given, when, then, kind, checkPath });
        await tx.append({ type: 'example.locked', exampleId, checkPath, checkHash, by: 'user' });
      }),
    );
    return { exampleId, checkHash };
  }

  // ---- 内部 ----

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

function checkPathInput(p: string): string {
  if (!p) throw new HttpError(400, '缺少检查文件路径');
  const n = normalize(p);
  const prefix = normalize(CHECKS_RELATIVE_DIR) + sep;
  if (isAbsolute(n) || !n.startsWith(prefix)) throw new HttpError(400, '检查文件必须在 .stagent/checks/ 下');
  return n.split(sep).join('/');
}
