/**
 * 核心不变量回归测试（tasks.md：从 M1-3 起，每个任务的 PR 都必须让这组测试保持通过）。
 *
 * 已建立：Invariant 2（无 API 可直接写已验证）、Invariant 3（已验证可追溯到有效 run）、
 * Invariant 4（改锁定检查后旧 run 不再作证，投影部分）。Invariant 1（claim 不能产生已验证）的投影部分也在这里。
 */
import { describe, expect, it } from 'vitest';
import { Ledger } from '../../src/ledger/index.js';
import { project } from '../../src/projection/projection.js';
import type { FeatureView } from '../../src/projection/projection.js';
import { routesOf } from '../../src/server/http.js';
import { CURRENT, LineBuilder } from '../helpers/lines.js';
import { FAIL, serverProject } from '../helpers/server.js';

/** 一个"想把东西写成已验证"的请求体：覆盖各种可能的字段名。 */
const FORGED = {
  status: 'verified',
  state: 'verified',
  verified: true,
  passed: true,
  stateLabel: '已验证（1 个例子）',
  results: [{ exampleId: 'x', status: 'passed' }],
  run: { valid: true },
  reason: '伪造的已验证请求',
  name: '伪造',
  given: 'g',
  when: 'w',
  then: 't',
};

describe('Invariant 2：不存在任何 API 能直接把功能写成已验证', () => {
  it('对每个写接口发送伪造的"已验证"请求，功能都不会变成已验证，也不会出现非执行器写入的 run', async () => {
    const p = await serverProject();
    const { featureId, exampleId, changeId } = await p.lock('登录', '.stagent/checks/a.mjs', FAIL);
    const writeRoutes = routesOf(p.app).filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
    expect(writeRoutes.length).toBeGreaterThan(0);

    for (const r of writeRoutes) {
      const url = r.url.replace(':id', r.url.startsWith('/api/changes') ? changeId : featureId).replace(':exampleId', exampleId);
      await p.app.inject({ method: r.method as 'POST', url, payload: { ...FORGED, exampleId, featureId, checkPath: '.stagent/checks/a.mjs' } });
      await p.service.waitForRun();
    }

    const features = (await p.call<FeatureView[]>('GET', '/api/features')).body;
    expect(features.some((f) => f.state === 'verified')).toBe(false);
    expect(features.flatMap((f) => f.examples).some((x) => x.state === 'verified')).toBe(false);
    // 账本里的每条 run.completed 都来自执行器：结果与真实检查（永远失败）一致。
    const runs = (await Ledger.open(p.root)).events().filter((e) => e.type === 'run.completed');
    for (const run of runs) {
      if (run.type !== 'run.completed') continue;
      expect(run.results.every((x) => x.status !== 'passed')).toBe(true);
    }
  });

  it('写接口清单是已知的（新增写接口时必须在这里评估是否会绕过证据）', async () => {
    const p = await serverProject();
    const writes = routesOf(p.app)
      .filter((r) => r.method !== 'GET' && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(writes).toEqual([
      'POST /api/changes',
      'POST /api/changes/:id/check',
      'POST /api/changes/:id/examples',
      'POST /api/changes/:id/examples/lock',
      'POST /api/changes/:id/track',
      'POST /api/ledger/accept',
      'POST /api/runs',
      'POST /api/runs/current/cancel',
    ]);
  });
});

describe('Invariant 1（投影部分）：claim 不能产生已验证', () => {
  it('只有 claim、或 claim + errored/flaky/过期结果，都不是已验证', () => {
    const claim = { type: 'claim.reported' as const, changeId: 'c', exampleId: 'e', text: '已全部实现并通过' };
    const cases = [
      new LineBuilder().feature('f').example('f', 'e').add(claim),
      new LineBuilder().feature('f').example('f', 'e').add(claim).run([['e', 'errored']]),
      new LineBuilder().feature('f').example('f', 'e').add(claim).run([['e', 'flaky']]),
      new LineBuilder().feature('f').example('f', 'e').add(claim).run([['e', 'passed']], { workTreeHash: 'old' }),
      new LineBuilder().feature('f').example('f', 'e').add(claim).run([['e', 'passed']], { valid: false }),
    ];
    for (const b of cases) {
      const f = project(b.lines, CURRENT).features[0]!;
      expect(f.state).not.toBe('verified');
      expect(f.examples[0]!.reason).toBe('ai_claim_only');
    }
  });
});

describe('Invariant 3：已验证可追溯到有效 run', () => {
  it('每个已验证例子的 lastResult 指向一条 valid=true、新鲜、passed 的 run.completed', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/a.mjs', 'process.exit(0);\n');
    await p.runAll();
    const features = (await p.call<FeatureView[]>('GET', '/api/features')).body;
    const runs = new Map(
      (await Ledger.open(p.root))
        .events()
        .flatMap((e) => (e.type === 'run.completed' ? [[e.runId, e] as const] : [])),
    );
    const verified = features.flatMap((f) => f.examples).filter((x) => x.state === 'verified');
    expect(verified.length).toBeGreaterThan(0);
    for (const x of verified) {
      const run = runs.get(x.lastResult!.runId)!;
      expect(run.valid).toBe(true);
      expect(run.snapshots[x.exampleId]).toBe(x.checkHash);
      expect(run.results.find((r) => r.exampleId === x.exampleId)!.status).toBe('passed');
      expect(x.lastResult!.fresh).toBe(true);
    }
  });
});

describe('Invariant 4（投影部分）：修改锁定检查后旧 run 不再作证', () => {
  it('解锁并以新内容重新锁定后，旧快照上的 passed 不再算数', () => {
    const b = new LineBuilder()
      .feature('f')
      .example('f', 'e', 'old-hash')
      .run([['e', 'passed', 'old-hash']])
      .add({ type: 'example.unlocked', exampleId: 'e', reason: '修改例子', by: 'user' })
      .add({ type: 'example.locked', exampleId: 'e', checkPath: '.stagent/checks/e.mjs', checkHash: 'new-hash', by: 'user' });
    const x = project(b.lines, CURRENT).features[0]!.examples[0]!;
    expect(x).toMatchObject({ state: 'unverified', reason: 'not_run', checkHash: 'new-hash' });
  });
});
