import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SnapshotIntegrityError, readSnapshot, snapshotPath } from '../../src/evidence/snapshots.js';
import { checkRelPath, renderCommand, runChecks, type CheckSpec } from '../../src/executor/executor.js';
import { headCommit } from '../../src/git/git.js';
import { Ledger } from '../../src/ledger/index.js';
import { fixtureProject, gitProject, lockExample, lockScript, nodeConfig } from '../helpers/project.js';

const PASS = 'process.exit(0);\n';
const FAIL = 'process.exit(1);\n';

/** 第一次运行时失败、之后通过（标记文件放在被 .gitignore 忽略的 node_modules 下，不影响 workTreeHash）。 */
const failOnce = (id: string) => `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const marker = process.env.STAGENT_PROJECT_ROOT + '/node_modules/.marker-${id}';
if (existsSync(marker)) process.exit(0);
mkdirSync(process.env.STAGENT_PROJECT_ROOT + '/node_modules', { recursive: true });
writeFileSync(marker, '');
process.exit(1);
`;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('执行器：基本运行', () => {
  it('退出码 0 → passed，非 0 → failed；run.completed 带四个起止值与快照集合（Invariant 3）', async () => {
    const { root, ledger } = await gitProject();
    const ok = await lockScript(root, ledger, 'ok', PASS);
    const bad = await lockScript(root, ledger, 'bad', FAIL);
    const { final, runs } = await runChecks({ projectRoot: root, ledger, checks: [ok, bad], config: nodeConfig({ flakyRetries: 0 }) });

    expect(runs).toHaveLength(1);
    const e = final.event;
    expect(e.results.map((r) => [r.exampleId, r.status])).toEqual([['ok', 'passed'], ['bad', 'failed']]);
    expect(e.valid).toBe(true);
    expect(e.purpose).toBe('regression');
    const head = await headCommit(root);
    expect(e).toMatchObject({ startCommit: head, endCommit: head, commit: head });
    expect(e.startWorkTreeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.endWorkTreeHash).toBe(e.startWorkTreeHash);
    expect(e.workTreeHash).toBe(e.endWorkTreeHash);
    expect(e.workTreeHashSpec).toMatch(/^[0-9a-f]{64}$/);
    expect(e.snapshots).toEqual({
      ok: (ok.source as { checkSnapshotId: string }).checkSnapshotId,
      bad: (bad.source as { checkSnapshotId: string }).checkSnapshotId,
    });
    expect(e.results[0]!.checkSnapshotId).toBe(e.snapshots.ok);

    // 已写入账本，且账本仍完好。
    const reopened = await Ledger.open(root);
    expect(reopened.state).toBe('ok');
    expect(reopened.events().filter((x) => x.type === 'run.completed')).toHaveLength(1);
  });

  it('日志写到 .stagent/runs/<runId>/logs/，检查还原到 runs/<runId>/checks/', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'hello', 'console.log("hello from check");\n');
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig() });
    const r = final.event.results[0]!;
    expect(r.logPath).toMatch(new RegExp(`^\\.stagent/runs/${final.event.runId}/logs/hello\\.1\\.log$`));
    expect(await readFile(join(root, r.logPath), 'utf8')).toContain('hello from check');
    const restored = join(root, '.stagent/runs', final.event.runId, 'checks', 'f', 'hello.mjs');
    expect(await readFile(restored, 'utf8')).toContain('hello from check');
  });

  it('空检查列表也写一条 run.completed', async () => {
    const { root, ledger } = await gitProject();
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [], config: nodeConfig() });
    expect(final.event.results).toEqual([]);
    expect(final.event.valid).toBe(true);
  });

  it('{path} 等占位符做 shell 转义', () => {
    const cmd = renderCommand('run {path} --id {exampleId}', {
      restoredPath: ".stagent/runs/r/checks/it's here.spec.ts",
      spec: { exampleId: 'a b', checkPath: 'x', source: { kind: 'draft', path: 'x' } },
    });
    expect(cmd).toBe(`run '.stagent/runs/r/checks/it'\\''s here.spec.ts' --id 'a b'`);
    expect(checkRelPath('.stagent/checks/login/a.spec.ts')).toBe(join('login', 'a.spec.ts'));
    expect(() => checkRelPath('../outside.ts')).toThrow(/项目内/);
  });
});

describe('执行器：只从快照执行（验收 #3 执行器部分）', () => {
  it('删除工作区里的检查文件，仍从快照执行', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'ok', PASS);
    await rm(join(root, spec.checkPath));
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig() });
    expect(final.event.results[0]!.status).toBe('passed');
  });

  it('工作区里的检查被改成"永远通过"，执行的仍是锁定内容', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'strict', FAIL);
    await writeFile(join(root, spec.checkPath), PASS);
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig({ flakyRetries: 0 }) });
    expect(final.event.results[0]!.status).toBe('failed');
  });

  it('快照被篡改 → 拒绝执行整轮，不写 run.completed', async () => {
    const { root, ledger } = await gitProject();
    const a = await lockScript(root, ledger, 'a', PASS);
    const b = await lockScript(root, ledger, 'b', FAIL);
    const id = (b.source as { checkSnapshotId: string }).checkSnapshotId;
    await writeFile(snapshotPath(root, id), PASS);
    const before = ledger.report.nextSeq;
    await expect(runChecks({ projectRoot: root, ledger, checks: [a, b], config: nodeConfig() })).rejects.toBeInstanceOf(
      SnapshotIntegrityError,
    );
    expect((await Ledger.open(root)).report.nextSeq).toBe(before);
  });

  it('快照缺失 → 拒绝执行', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'a', PASS);
    await rm(snapshotPath(root, (spec.source as { checkSnapshotId: string }).checkSnapshotId));
    await expect(runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig() })).rejects.toMatchObject({
      problem: 'missing',
    });
  });
});

describe('执行器：run 一致性（验收 #16 执行器部分）', () => {
  it('运行期间改工作区 → valid=false，并自动重跑一次', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(
      root,
      ledger,
      'touch',
      `import { existsSync, writeFileSync } from 'node:fs';
const f = process.env.STAGENT_PROJECT_ROOT + '/src/touched.js';
if (!existsSync(f)) writeFileSync(f, 'export {};\\n');
`,
    );
    const { runs, final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig() });
    expect(runs).toHaveLength(2);
    expect(runs[0]!.event.valid).toBe(false);
    expect(runs[0]!.event.startWorkTreeHash).not.toBe(runs[0]!.event.endWorkTreeHash);
    expect(final.event.valid).toBe(true);
    expect(final.event.runId).not.toBe(runs[0]!.event.runId);
  });

  it('运行期间提交 commit → valid=false', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(
      root,
      ledger,
      'commit',
      `import { execSync } from 'node:child_process';
execSync('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m during-run', { cwd: process.env.STAGENT_PROJECT_ROOT });
`,
    );
    const { runs } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig(), rerunInvalid: false });
    expect(runs).toHaveLength(1);
    const e = runs[0]!.event;
    expect(e.valid).toBe(false);
    expect(e.startCommit).not.toBe(e.endCommit);
    expect(e.startWorkTreeHash).toBe(e.endWorkTreeHash);
  });

  it('重跑仍然 valid=false 时不再继续重跑', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(
      root,
      ledger,
      'always-touch',
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.STAGENT_PROJECT_ROOT + '/src/t.js', String(Math.random()));
`,
    );
    const { runs } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig() });
    expect(runs.map((r) => r.event.valid)).toEqual([false, false]);
  });

  it('运行产物与账本追加不会让运行变成 valid=false', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'ok', 'console.log("lots of log output");\n');
    const { runs } = await runChecks({ projectRoot: root, ledger, checks: [spec, spec], config: nodeConfig() });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.event.valid).toBe(true);
  });
});

describe('执行器：不稳定与异常（验收 #21 执行器部分）', () => {
  it('先失败后通过 → flaky，attempts 两条', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'flaky', failOnce('flaky'));
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig() });
    const r = final.event.results[0]!;
    expect(r.status).toBe('flaky');
    expect(r.attempts!.map((a) => a.status)).toEqual(['failed', 'passed']);
    expect(r.attempts![0]!.logPath).not.toBe(r.attempts![1]!.logPath);
  });

  it('flakyRetries=0 时先失败就是 failed', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'once', failOnce('once'));
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig({ flakyRetries: 0 }) });
    expect(final.event.results[0]!.status).toBe('failed');
    expect(final.event.results[0]!.attempts).toHaveLength(1);
  });

  it('一直失败 → failed，复跑 flakyRetries 次', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'bad', FAIL);
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig({ flakyRetries: 2 }) });
    expect(final.event.results[0]!.status).toBe('failed');
    expect(final.event.results[0]!.attempts).toHaveLength(3);
  });

  it('超时 → errored，并重试 1 次', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'slow', 'setTimeout(() => {}, 30_000);\n');
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig({ checkTimeoutMs: 300 }) });
    const r = final.event.results[0]!;
    expect(r.status).toBe('errored');
    expect(r.detail).toMatch(/超时/);
    expect(r.attempts).toHaveLength(2);
  });

  it('errored 后重试通过 → passed', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(
      root,
      ledger,
      'warmup',
      `if (process.env.STAGENT_ATTEMPT === '1') setTimeout(() => {}, 30_000); else process.exit(0);\n`,
    );
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config: nodeConfig({ checkTimeoutMs: 500 }) });
    const r = final.event.results[0]!;
    expect(r.status).toBe('passed');
    expect(r.attempts!.map((a) => a.status)).toEqual(['errored', 'passed']);
  });

  it('检查命令不存在（依赖缺失）→ errored', async () => {
    const { root, ledger } = await gitProject();
    const spec = await lockScript(root, ledger, 'x', PASS);
    const { final } = await runChecks({
      projectRoot: root,
      ledger,
      checks: [spec],
      config: nodeConfig({ checkCommand: 'stagent-no-such-runner {path}' }),
    });
    expect(final.event.results[0]!.status).toBe('errored');
    expect(final.event.results[0]!.detail).toMatch(/依赖/);
  });

  it('取消 → 剩余检查 not_run', async () => {
    const { root, ledger } = await gitProject();
    const slow = await lockScript(root, ledger, 'slow', 'setTimeout(() => {}, 30_000);\n');
    const next = await lockScript(root, ledger, 'next', PASS);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const { final, runs } = await runChecks({ projectRoot: root, ledger, checks: [slow, next], config: nodeConfig(), signal: ac.signal });
    expect(runs).toHaveLength(1);
    expect(final.event.results.map((r) => r.status)).toEqual(['not_run', 'not_run']);
  });
});

describe('执行器：开发服务器', () => {
  const SERVER = `import { createServer } from 'node:http';
createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1');
`;

  it('就绪后才执行检查，结束后关闭', async () => {
    const port = await freePort();
    const { root, ledger } = await gitProject({ 'server.mjs': SERVER });
    const spec = await lockScript(
      root,
      ledger,
      'hits-server',
      `const res = await fetch('http://127.0.0.1:${port}/'); process.exit(res.status === 200 ? 0 : 1);\n`,
    );
    const config = nodeConfig({ devServer: { command: `PORT=${port} node server.mjs`, url: `http://127.0.0.1:${port}/`, timeoutMs: 10_000 } });
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [spec], config });
    expect(final.event.results[0]!.status).toBe('passed');
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('开发服务器起不来 → 所有检查 errored，并给出启动日志', async () => {
    const { root, ledger } = await gitProject();
    const a = await lockScript(root, ledger, 'a', PASS);
    const b = await lockScript(root, ledger, 'b', PASS);
    const config = nodeConfig({ devServer: { command: 'echo boom; exit 3', url: 'http://127.0.0.1:1/', timeoutMs: 5_000 } });
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [a, b], config });
    expect(final.event.results.map((r) => r.status)).toEqual(['errored', 'errored']);
    expect(final.event.results[0]!.detail).toMatch(/提前退出/);
    expect(await readFile(join(root, final.event.results[0]!.logPath), 'utf8')).toContain('boom');
  });

  it('健康检查超时 → errored', async () => {
    const port = await freePort();
    const { root, ledger } = await gitProject();
    const a = await lockScript(root, ledger, 'a', PASS);
    const config = nodeConfig({
      devServer: { command: 'node -e "setTimeout(() => {}, 30000)"', url: `http://127.0.0.1:${port}/`, timeoutMs: 600 },
    });
    const { final } = await runChecks({ projectRoot: root, ledger, checks: [a], config });
    expect(final.event.results[0]!.status).toBe('errored');
    expect(final.event.results[0]!.detail).toMatch(/未就绪/);
  });
});

describe('执行器：先失败检查（purpose: red_check）', () => {
  it('运行工作区里的草稿内容，草稿写成快照并记入 snapshots', async () => {
    const { root, ledger } = await gitProject();
    const draftPath = '.stagent/checks/draft/new.mjs';
    await mkdir(join(root, '.stagent/checks/draft'), { recursive: true });
    await writeFile(join(root, draftPath), FAIL);
    const spec: CheckSpec = { exampleId: 'new', checkPath: draftPath, source: { kind: 'draft', path: draftPath } };
    const { final } = await runChecks({
      projectRoot: root,
      ledger,
      checks: [spec],
      purpose: 'red_check',
      changeId: 'c1',
      config: nodeConfig({ flakyRetries: 0 }),
    });
    expect(final.event).toMatchObject({ purpose: 'red_check', changeId: 'c1' });
    expect(final.event.results[0]!.status).toBe('failed');
    const id = final.event.snapshots.new!;
    expect((await readSnapshot(root, id)).toString()).toBe(FAIL);
  });
});

describe('执行器：示例项目（vitest 检查）', () => {
  it('锁定两个 vitest 检查 → passed；改坏源码 → failed', { timeout: 90_000 }, async () => {
    const { root, ledger } = await fixtureProject();
    const a = await lockExample(root, ledger, 'adds', '.stagent/checks/sum/adds-two-numbers.spec.mjs');
    const b = await lockExample(root, ledger, 'negatives', '.stagent/checks/sum/handles-negatives.spec.mjs');

    const first = await runChecks({ projectRoot: root, ledger, checks: [a, b] });
    expect(first.final.event.valid).toBe(true);
    expect(first.final.event.results.map((r) => r.status)).toEqual(['passed', 'passed']);

    await writeFile(join(root, 'src/sum.mjs'), 'export function sum(a, b) { return a - b; }\n');
    const second = await runChecks({ projectRoot: root, ledger, checks: [a, b] });
    expect(second.final.event.results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(second.final.event.startWorkTreeHash).not.toBe(first.final.event.startWorkTreeHash);
  });
});
