/**
 * 检查执行器（规格 §7）："证据只来自系统亲自运行的检查"。
 *
 * 一轮运行：
 * 1. 解析每个检查的快照（锁定例子用 example.locked 的快照；red_check 用草稿内容，先写成快照）；
 *    快照缺失或被篡改 → 整轮拒绝执行（SnapshotIntegrityError），不写任何结果。
 * 2. 记录起点 startCommit / startWorkTreeHash。
 * 3. 把快照还原到 .stagent/runs/<runId>/checks/，按 config.devServer 启动开发服务器。
 * 4. 逐个执行：执行前重算还原文件的 sha256；退出码 0 → passed，非 0 → failed，超时 / 依赖缺失 → errored，
 *    被取消 → not_run。failed 同轮复跑 config.flakyRetries 次，复跑通过记为 flaky；errored 重试 1 次。
 * 5. 记录终点 endCommit / endWorkTreeHash；起止不一致 → valid=false（运行期间代码变了，结果不作证）。
 * 6. 追加 run.completed（四个起止值 + 快照集合，Invariant 3）。valid=false 时自动重跑一次。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { loadConfig, type StagentConfig } from '../config/config.js';
import { computeWorkTreeHash } from '../evidence/worktree-hash.js';
import { readSnapshot, writeSnapshot } from '../evidence/snapshots.js';
import { headCommit } from '../git/git.js';
import { sha256Hex } from '../ledger/hash.js';
import type { Ledger } from '../ledger/ledger.js';
import type { CheckAttempt, CheckResult, EventOf, LedgerLine, RunPurpose, Sha256Hex } from '../ledger/types.js';
import { DevServerError, startDevServer, type DevServerHandle } from './dev-server.js';
import { runCommand, shellQuote } from './process.js';

export const RUNS_RELATIVE_DIR = join('.stagent', 'runs');
export const CHECKS_RELATIVE_DIR = join('.stagent', 'checks');

/** 检查内容的来源。 */
export type CheckSource =
  /** 锁定例子：从 .stagent/ledger/snapshots/<id> 还原，不读工作区。 */
  | { kind: 'snapshot'; checkSnapshotId: Sha256Hex }
  /** 先失败检查：运行工作区里的草稿（相对项目根目录），执行前写成快照并记入 run.completed.snapshots。 */
  | { kind: 'draft'; path: string };

export interface CheckSpec {
  exampleId: string;
  /** 锁定时的检查路径（相对项目根目录，如 .stagent/checks/login/captcha.spec.ts）。 */
  checkPath: string;
  source: CheckSource;
}

export interface RunProgress {
  runId: string;
  phase: 'starting' | 'dev_server' | 'check' | 'finished';
  index?: number;
  total: number;
  exampleId?: string;
  status?: CheckResult['status'];
}

export interface RunRequest {
  projectRoot: string;
  ledger: Ledger;
  checks: CheckSpec[];
  purpose?: RunPurpose;
  changeId?: string;
  /** 不传则读 .stagent/config.json。 */
  config?: StagentConfig;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
  /** valid=false 时自动重跑一次（默认 true）。 */
  rerunInvalid?: boolean;
}

export type RunCompleted = EventOf<'run.completed'>;

export interface RunOutcome {
  /** 本次调用写入的全部 run.completed（valid=false 重跑时为两条）。 */
  runs: LedgerLine<RunCompleted>[];
  /** 最后一条。 */
  final: LedgerLine<RunCompleted>;
}

export async function runChecks(req: RunRequest): Promise<RunOutcome> {
  const config = req.config ?? (await loadConfig(req.projectRoot));
  const runs: LedgerLine<RunCompleted>[] = [];
  runs.push(await executeOnce(req, config));
  if (!runs[0]!.event.valid && req.rerunInvalid !== false && !req.signal?.aborted) {
    runs.push(await executeOnce(req, config));
  }
  return { runs, final: runs[runs.length - 1]! };
}

interface PreparedCheck {
  spec: CheckSpec;
  snapshotId: Sha256Hex;
  content: Buffer;
  /** 还原后的文件，相对项目根目录。 */
  restoredPath: string;
}

async function executeOnce(req: RunRequest, config: StagentConfig): Promise<LedgerLine<RunCompleted>> {
  const root = req.projectRoot;
  const runId = newRunId();
  const runDir = join(root, RUNS_RELATIVE_DIR, runId);
  const total = req.checks.length;
  req.onProgress?.({ runId, phase: 'starting', total });

  // 1. 快照：任何一个缺失或被篡改都拒绝整轮执行。
  const prepared: PreparedCheck[] = [];
  for (const spec of req.checks) {
    const { snapshotId, content } = await resolveSource(root, spec.source);
    prepared.push({ spec, snapshotId, content, restoredPath: join(RUNS_RELATIVE_DIR, runId, 'checks', checkRelPath(spec.checkPath)) });
  }

  // 2. 起点。
  const ignoreGlobs = config.evidence.ignoreGlobs;
  const startCommit = await headCommit(root);
  const start = await computeWorkTreeHash(root, { ignoreGlobs });

  // 3. 还原检查与日志目录。
  await mkdir(join(runDir, 'logs'), { recursive: true });
  for (const p of prepared) {
    const abs = join(root, p.restoredPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, p.content);
  }

  const env: NodeJS.ProcessEnv = { ...process.env, STAGENT_PROJECT_ROOT: root, STAGENT_RUN_ID: runId };
  const results: CheckResult[] = [];
  let devServer: DevServerHandle | null = null;
  let devServerFailure: string | null = null;
  if (config.devServer && prepared.length > 0) {
    req.onProgress?.({ runId, phase: 'dev_server', total });
    try {
      devServer = await startDevServer(config.devServer, {
        cwd: root,
        env,
        logPath: join(runDir, 'logs', 'dev-server.log'),
        signal: req.signal,
      });
    } catch (err) {
      devServerFailure = err instanceof DevServerError ? err.message : `开发服务器启动失败：${(err as Error).message}`;
    }
  }

  // 4. 逐个执行。
  try {
    for (const [index, p] of prepared.entries()) {
      let result: CheckResult;
      if (req.signal?.aborted) {
        result = notRun(p, '运行已取消');
      } else if (devServerFailure) {
        result = { ...notRun(p, devServerFailure), status: 'errored', logPath: rel(root, join(runDir, 'logs', 'dev-server.log')) };
      } else {
        result = await executeCheck(root, runDir, runId, p, config, env, req.signal);
      }
      results.push(result);
      req.onProgress?.({ runId, phase: 'check', index, total, exampleId: p.spec.exampleId, status: result.status });
    }
  } finally {
    await devServer?.stop();
  }

  // 5. 终点。
  const endCommit = await headCommit(root);
  const end = await computeWorkTreeHash(root, { ignoreGlobs });
  const valid = startCommit === endCommit && start.workTreeHash === end.workTreeHash && start.workTreeHashSpec === end.workTreeHashSpec;

  // 6. 写账本。
  const event: RunCompleted = {
    type: 'run.completed',
    runId,
    ...(req.changeId ? { changeId: req.changeId } : {}),
    purpose: req.purpose ?? 'regression',
    startCommit,
    endCommit,
    startWorkTreeHash: start.workTreeHash,
    endWorkTreeHash: end.workTreeHash,
    workTreeHashSpec: end.workTreeHashSpec,
    valid,
    snapshots: Object.fromEntries(prepared.map((p) => [p.spec.exampleId, p.snapshotId])),
    results,
    commit: endCommit,
    workTreeHash: end.workTreeHash,
  };
  const line = (await req.ledger.append(event)) as LedgerLine<RunCompleted>;
  req.onProgress?.({ runId, phase: 'finished', total });
  return line;
}

async function resolveSource(root: string, source: CheckSource): Promise<{ snapshotId: Sha256Hex; content: Buffer }> {
  if (source.kind === 'snapshot') {
    return { snapshotId: source.checkSnapshotId, content: await readSnapshot(root, source.checkSnapshotId) };
  }
  const content = await readFile(join(root, safeRelative(source.path)));
  return { snapshotId: await writeSnapshot(root, content), content };
}

async function executeCheck(
  root: string,
  runDir: string,
  runId: string,
  p: PreparedCheck,
  config: StagentConfig,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<CheckResult> {
  const attempts: CheckAttempt[] = [];
  const base = { exampleId: p.spec.exampleId, checkSnapshotId: p.snapshotId };
  const command = renderCommand(config.checkCommand, p);
  const logBase = join(runDir, 'logs', safeFileName(p.spec.exampleId));

  const attempt = async (): Promise<{ attempt: CheckAttempt; detail?: string; aborted: boolean }> => {
    const n = attempts.length + 1;
    const logPath = `${logBase}.${n}.log`;
    // 执行前重算还原文件的哈希：还原后、执行前被替换的检查不作证。
    const restored = await readFile(join(root, p.restoredPath)).catch(() => null);
    if (restored === null || sha256Hex(restored) !== p.snapshotId) {
      await writeFile(logPath, '[stagent] 还原的检查文件在执行前被修改或删除\n');
      const a: CheckAttempt = { status: 'errored', exitCode: null, durationMs: 0, logPath: rel(root, logPath) };
      attempts.push(a);
      return { attempt: a, detail: '还原的检查文件在执行前被修改', aborted: false };
    }
    const r = await runCommand(command, {
      cwd: root,
      env: { ...env, STAGENT_EXAMPLE_ID: p.spec.exampleId, STAGENT_ATTEMPT: String(n) },
      logPath,
      timeoutMs: config.checkTimeoutMs,
      signal,
    });
    let status: CheckAttempt['status'];
    let detail: string | undefined;
    if (r.aborted) {
      status = 'errored';
      detail = '运行已取消';
    } else if (r.timedOut) {
      status = 'errored';
      detail = `超时（${config.checkTimeoutMs}ms）`;
    } else if (r.spawnError) {
      status = 'errored';
      detail = `无法启动检查命令：${r.spawnError.message}`;
    } else if (r.exitCode === 127 || r.exitCode === 126) {
      status = 'errored';
      detail = `检查命令不存在或不可执行（退出码 ${r.exitCode}），可能缺少依赖`;
    } else if (r.exitCode === null) {
      status = 'errored';
      detail = `检查进程被信号 ${r.signal} 终止`;
    } else {
      status = r.exitCode === 0 ? 'passed' : 'failed';
    }
    const a: CheckAttempt = { status, exitCode: r.exitCode, durationMs: r.durationMs, logPath: rel(root, logPath) };
    attempts.push(a);
    return { attempt: a, detail, aborted: r.aborted };
  };

  const first = await attempt();
  let status: CheckResult['status'] = first.attempt.status;
  let detail = first.detail;

  if (first.aborted) {
    return finish('not_run', '运行已取消');
  }
  if (first.attempt.status === 'errored') {
    // errored 自动重试 1 次，以重试结果为准。
    const retry = await attempt();
    if (retry.aborted) return finish('not_run', '运行已取消');
    status = retry.attempt.status;
    detail = retry.detail;
  } else if (first.attempt.status === 'failed') {
    // failed 同轮复跑：任何一次通过 → flaky（结果不稳定，不作为通过的证据）。
    for (let i = 0; i < config.flakyRetries; i++) {
      const again = await attempt();
      if (again.aborted) return finish('not_run', '运行已取消');
      if (again.attempt.status === 'passed') {
        status = 'flaky';
        detail = undefined;
        break;
      }
    }
  }
  return finish(status, detail);

  function finish(s: CheckResult['status'], d: string | undefined): CheckResult {
    const last = attempts[attempts.length - 1]!;
    return {
      ...base,
      status: s,
      durationMs: attempts.reduce((sum, a) => sum + a.durationMs, 0),
      logPath: last.logPath,
      attempts: [...attempts],
      ...(d ? { detail: d } : {}),
    };
  }
}

function notRun(p: PreparedCheck, detail: string): CheckResult {
  return { exampleId: p.spec.exampleId, checkSnapshotId: p.snapshotId, status: 'not_run', durationMs: 0, logPath: '', detail };
}

/** 渲染检查命令模板：{path} 还原后的文件，{checkPath} 原路径，{exampleId}。全部 shell 转义。 */
export function renderCommand(template: string, p: { restoredPath: string; spec: CheckSpec }): string {
  const vars: Record<string, string> = {
    path: toPosix(p.restoredPath),
    checkPath: toPosix(p.spec.checkPath),
    exampleId: p.spec.exampleId,
  };
  return template.replace(/\{(path|checkPath|exampleId)\}/g, (_, k: string) => shellQuote(vars[k]!));
}

/** 检查在 runs/<runId>/checks/ 下的相对路径：去掉 .stagent/checks/ 前缀。 */
export function checkRelPath(checkPath: string): string {
  const safe = safeRelative(checkPath);
  const prefix = normalize(CHECKS_RELATIVE_DIR) + sep;
  return safe.startsWith(prefix) ? safe.slice(prefix.length) : safe;
}

function safeRelative(p: string): string {
  const n = normalize(p);
  if (isAbsolute(n) || n === '..' || n.startsWith(`..${sep}`)) throw new Error(`检查路径必须在项目内：${p}`);
  return n;
}

function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

function rel(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${ts}-${randomBytes(3).toString('hex')}`;
}
