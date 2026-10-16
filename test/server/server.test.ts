import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../../src/ledger/index.js';
import type { Overview } from '../../src/projection/overview.js';
import type { FeatureView } from '../../src/projection/projection.js';
import { APP_CHECK, FAIL, PASS, serverProject } from '../helpers/server.js';

type O = Overview & { runError: string | null; project: { name: string; branch: string | null } };

describe('M1 闭环演示（端到端）', () => {
  it('锁定 → 快照 → 运行 → 已验证 → 改工作区 → 证据过期 → 篡改锁定检查 → 不再已验证，旧 run 仍在账本', async () => {
    const p = await serverProject();
    let o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.status).toBe('empty');
    expect(o.project.branch).toBe('main');

    const { featureId } = await p.lock('登录', '.stagent/checks/login/a.mjs', APP_CHECK);
    await p.lock('登录', '.stagent/checks/login/b.mjs', PASS, featureId);
    o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.status).toBe('blocked');
    expect(o.reasons[0]!.text).toContain('尚未运行');

    await p.runAll();
    o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.status).toBe('ok');
    let f = (await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body;
    expect(f.stateLabel).toBe('已验证（2 个例子）');

    // 改工作区（源码）→ 证据过期
    await writeFile(join(p.root, 'src/app.js'), 'export const x = 1; // touched\n');
    f = (await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body;
    expect(f.state).toBe('unverified');
    expect(f.examples.map((x) => x.reason)).toEqual(['stale', 'stale']);

    // 重新运行 → 回到已验证
    await p.runAll();
    expect((await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body.state).toBe('verified');

    // 篡改工作区里的锁定检查 → 不再已验证（锁定检查不可豁免，workTreeHash 变化）
    await writeFile(join(p.root, '.stagent/checks/login/a.mjs'), PASS);
    f = (await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body;
    expect(f.state).not.toBe('verified');
    // 旧 run 仍在账本（Invariant 3/4：证据不被删改，只是不再作证）
    const runs = (await Ledger.open(p.root)).events().filter((e) => e.type === 'run.completed');
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.type === 'run.completed' && r.results.every((x) => x.status === 'passed'))).toBe(true);
  });

  it('改坏代码 → ⛔ 点名被破坏的功能；改回 → ✅', async () => {
    const p = await serverProject();
    await p.lock('购物车', '.stagent/checks/cart/a.mjs', APP_CHECK);
    await p.runAll();
    await writeFile(join(p.root, 'src/app.js'), 'export const x = 2;\n');
    await p.runAll();
    let o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.status).toBe('blocked');
    expect(o.reasons[0]!.text).toBe('购物车 被破坏：1 个已锁定例子失败');
    await writeFile(join(p.root, 'src/app.js'), 'export const x = 1;\n');
    await p.runAll();
    o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.status).toBe('ok');
  });
});

describe('证据失效豁免与账本自身（验收 #24、#25 端到端）', () => {
  it('只改 README → 仍然已验证；改 package-lock → 证据过期', async () => {
    const p = await serverProject();
    const { featureId } = await p.lock('登录', '.stagent/checks/a.mjs', PASS);
    await p.runAll();
    await writeFile(join(p.root, 'README.md'), '# app\n\n新的说明\n');
    expect((await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body.state).toBe('verified');
    await writeFile(join(p.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    expect((await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body.examples[0]!.reason).toBe('stale');
  });

  it('追加事件（新增功能、锁定新例子）不让已有证据过期', async () => {
    const p = await serverProject();
    const { featureId } = await p.lock('登录', '.stagent/checks/a.mjs', PASS);
    await p.runAll();
    await p.call('POST', '/api/dev/features', { name: '注册' });
    expect((await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body.state).toBe('verified');
  });
});

describe('结果不稳定（验收 #21 界面）', () => {
  it('先失败后通过 → 功能未验证，例子显示"结果不稳定"', async () => {
    const p = await serverProject();
    const flaky = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const m = process.env.STAGENT_PROJECT_ROOT + '/node_modules/.flaky';
if (existsSync(m)) process.exit(0);
mkdirSync(process.env.STAGENT_PROJECT_ROOT + '/node_modules', { recursive: true }); writeFileSync(m, ''); process.exit(1);
`;
    const { featureId } = await p.lock('支付', '.stagent/checks/pay.mjs', flaky);
    await p.runAll();
    const f = (await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body;
    expect(f.state).toBe('unverified');
    expect(f.examples[0]).toMatchObject({ reason: 'flaky' });
    expect(f.examples[0]!.explanation).toContain('结果不稳定');
    const o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.reasons.some((r) => r.text.includes('结果不稳定'))).toBe(true);
  });
});

describe('接口行为', () => {
  it('运行中再次 POST /api/runs → 409；概览显示 ⏳；可以取消', async () => {
    const p = await serverProject();
    await p.lock('慢', '.stagent/checks/slow.mjs', 'setTimeout(() => {}, 30_000);\n');
    expect((await p.call('POST', '/api/runs')).status).toBe(202);
    expect((await p.call('POST', '/api/runs')).status).toBe(409);
    const o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.status).toBe('checking');
    expect(o.run).toMatchObject({ total: 1 });
    expect((await p.call('POST', '/api/runs/current/cancel')).status).toBe(202);
    await p.service.waitForRun();
    expect((await p.call<O>('GET', '/api/overview')).body.run).toBeNull();
  });

  it('没有锁定例子时 POST /api/runs → 400', async () => {
    const p = await serverProject();
    expect((await p.call('POST', '/api/runs')).status).toBe(400);
  });

  it('快照被篡改 → 运行被拒绝，概览带 runError', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/a.mjs', FAIL);
    const ex = (await p.call<FeatureView[]>('GET', '/api/features')).body[0]!.examples[0]!;
    await writeFile(join(p.root, '.stagent/ledger/snapshots', ex.checkHash), PASS);
    await p.runAll();
    const o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.runError).toContain('拒绝执行');
    expect(o.status).toBe('blocked');
  });

  it('锁定例子的输入校验：路径必须在 .stagent/checks/ 下且存在', async () => {
    const p = await serverProject();
    const { featureId } = (await p.call<{ featureId: string }>('POST', '/api/dev/features', { name: '登录' })).body;
    const body = { given: 'g', when: 'w', then: 't' };
    expect((await p.call('POST', `/api/dev/features/${featureId}/examples`, { ...body, checkPath: 'src/app.js' })).status).toBe(400);
    expect((await p.call('POST', `/api/dev/features/${featureId}/examples`, { ...body, checkPath: '.stagent/checks/nope.mjs' })).status).toBe(400);
    expect((await p.call('POST', `/api/dev/features/${featureId}/examples`, { checkPath: '.stagent/checks/x.mjs' })).status).toBe(400);
    expect((await p.call('POST', '/api/dev/features/f-missing/examples', body)).status).toBe(404);
    expect((await p.call('POST', '/api/dev/features', { name: '  ' })).status).toBe(400);
    expect((await p.call('GET', '/api/features/f-missing')).status).toBe(404);
  });

  it('账本被篡改 → 🔒，写接口 423；接受当前状态后恢复', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/a.mjs', PASS);
    const path = Ledger.pathFor(p.root);
    await writeFile(path, (await readFile(path, 'utf8')).replace('"name":"登录"', '"name":"注册"'));

    let o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.status).toBe('ledger_modified');
    expect((await p.call('POST', '/api/runs')).status).toBe(423);
    expect((await p.call('POST', '/api/dev/features', { name: 'x' })).status).toBe(423);
    expect((await p.call('POST', '/api/ledger/accept', { reason: '好' })).status).toBe(400);
    expect((await p.call('POST', '/api/ledger/accept', { reason: '我改了功能名称' })).status).toBe(200);
    o = (await p.call<O>('GET', '/api/overview')).body;
    expect(o.status).not.toBe('ledger_modified');
    expect((await p.call('POST', '/api/ledger/accept', { reason: '再接受一次' })).status).toBe(409);
  });
});
