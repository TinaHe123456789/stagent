import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeView, ChangesProjection } from '../../src/changes/changes.js';
import { headCommit } from '../../src/git/git.js';
import { Ledger } from '../../src/ledger/index.js';
import type { Event } from '../../src/ledger/types.js';
import type { FeatureView } from '../../src/projection/projection.js';
import { buildServer } from '../../src/server/http.js';
import { StagentService, type OverviewResponse } from '../../src/server/service.js';
import { gitIn, nodeConfig } from '../helpers/project.js';
import { APP_CHECK, FAIL, PASS, serverProject } from '../helpers/server.js';

const events = async (root: string): Promise<Event[]> => (await Ledger.open(root)).events();
const ofType = <T extends Event['type']>(es: Event[], t: T) => es.filter((e) => e.type === t) as Extract<Event, { type: T }>[];

/** 一个已经检查通过、可以合并的改动。 */
async function mergeable(config = nodeConfig({ flakyRetries: 1 }), options = {}) {
  const p = await serverProject(config, options);
  const { changeId, featureId, exampleId } = await p.lock('登录', '.stagent/checks/login.mjs', APP_CHECK);
  await writeFile(join(p.root, 'src/app.js'), 'export const x = 1; // 新实现\n');
  await p.runAll();
  expect((await p.call<ChangeView>('GET', `/api/changes/${changeId}`)).body.phase).toBe('mergeable');
  return { ...p, changeId, featureId, exampleId };
}

describe('合并门与合并', () => {
  it('可合并的改动：git 提交，写 change.merged（含文件清单），授权三段式完整，合并免填原因', async () => {
    const p = await mergeable();
    const base = await headCommit(p.root);
    const r = await p.call<{ ok: boolean; mergeCommit: string; files: { path: string }[] }>('POST', `/api/changes/${p.changeId}/merge`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const head = await headCommit(p.root);
    expect(head).not.toBe(base);
    expect(r.body.mergeCommit).toBe(head);
    expect(gitIn(p.root, 'log', '-1', '--format=%B')).toContain(`Stagent-Change: ${p.changeId}`);
    expect(gitIn(p.root, 'status', '--porcelain', '--', '.', ':(exclude).stagent').trim()).toBe('');

    const es = await events(p.root);
    const merged = ofType(es, 'change.merged');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.files!.map((f) => f.path)).toEqual(expect.arrayContaining(['src/app.js', '.stagent/checks/login.mjs']));
    expect(merged[0]!.files!.some((f) => f.path.startsWith('.stagent/ledger/'))).toBe(false);
    const granted = ofType(es, 'auth.granted');
    expect(granted).toEqual([{ type: 'auth.granted', authId: merged[0]!.authId, action: 'merge', changeId: p.changeId, reason: '' }]);
    expect(ofType(es, 'auth.settled')).toEqual([{ type: 'auth.settled', authId: merged[0]!.authId, ok: true }]);
    expect(ofType(es, 'record.saved')).toHaveLength(0); // 合并不写决策记录

    expect((await p.call<ChangesProjection>('GET', '/api/changes')).body.active).toBeNull();
    // 合并后的提交不算未托管提交
    expect(await p.service.checkHead()).toBe(false);
    // 合并不让证据过期
    const f = (await p.call<FeatureView>('GET', `/api/features/${p.featureId}`)).body;
    expect(f.state).toBe('verified');
  });

  it('不是可合并阶段 → 409，账本里不写任何授权事件', async () => {
    const p = await serverProject();
    const { changeId } = await p.lock('登录', '.stagent/checks/login.mjs', FAIL);
    await p.runAll();
    const r = await p.call<{ error: string }>('POST', `/api/changes/${changeId}/merge`);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('被阻止');
    expect((await events(p.root)).some((e) => e.type.startsWith('auth.'))).toBe(false);
  });

  it('Cursor 改了锁定检查 → 合并按钮禁用并显示「锁定检查被修改」，合并门拒绝；还原锁定文件后恢复（#3）', async () => {
    const p = await mergeable();
    await writeFile(join(p.root, '.stagent/checks/login.mjs'), PASS); // 外部工具把检查改成永远通过
    let o = (await p.call<OverviewResponse>('GET', '/api/overview')).body;
    expect(o.status).toBe('blocked');
    expect(o.reasons[0]!.text).toContain('锁定检查被修改');
    expect(o.auth.tamperedChecks).toMatchObject([{ exampleId: p.exampleId, problem: 'modified' }]);
    const merge = o.actions.find((a) => a.id === 'merge')!;
    expect(merge).toMatchObject({ enabled: false, disabledReason: '锁定检查被修改' });
    expect(o.actions.map((a) => a.id)).toEqual(['restore_locked', 'modify_locked', 'merge']);

    // 就算重新检查（执行器用的是快照，照样通过），合并门也拒绝
    await p.runAll();
    const r = await p.call<{ error: string }>('POST', `/api/changes/${p.changeId}/merge`);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('锁定检查被修改');
    expect(r.body.error).toContain('.stagent/checks/login.mjs');
    const ov = await p.call('POST', '/api/auth', { action: 'merge_override', changeId: p.changeId, reason: '我想强行合并' });
    expect(ov.status).toBe(409); // 强行合并也不能绕过锁定检查

    expect((await p.call('POST', `/api/examples/${p.exampleId}/restore`)).status).toBe(200);
    expect(await readFile(join(p.root, '.stagent/checks/login.mjs'), 'utf8')).toBe(APP_CHECK);
    o = (await p.call<OverviewResponse>('GET', '/api/overview')).body;
    expect(o.auth.tamperedChecks).toEqual([]);
  });

  it('快照被篡改 → 合并门拒绝', async () => {
    const p = await mergeable();
    const f = (await p.call<FeatureView>('GET', `/api/features/${p.featureId}`)).body;
    await writeFile(join(p.root, '.stagent/ledger/snapshots', f.examples[0]!.checkHash), PASS);
    expect((await p.call('POST', `/api/changes/${p.changeId}/merge`)).status).toBe(409);
  });

  it('并发两笔合并：只有一笔消费授权，账本恰好一条 auth.consumed（#17）', async () => {
    const p = await mergeable();
    const [a, b] = await Promise.all([
      p.call('POST', `/api/changes/${p.changeId}/merge`),
      p.call('POST', `/api/changes/${p.changeId}/merge`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const es = await events(p.root);
    expect(ofType(es, 'auth.consumed')).toHaveLength(1);
    expect(ofType(es, 'change.merged')).toHaveLength(1);
  });

  it('在 Stagent 之外 git commit --no-verify：改动不会变成已合并，只记为未托管提交（Invariant 5）', async () => {
    const p = await mergeable();
    gitIn(p.root, 'add', '-A');
    gitIn(p.root, 'commit', '-q', '--no-verify', '-m', 'bypass');
    expect(await p.service.checkHead()).toBe(true);
    await p.service.waitForRun();
    const es = await events(p.root);
    expect(ofType(es, 'change.merged')).toHaveLength(0);
    expect(ofType(es, 'change.unmanaged_commit')).toHaveLength(1);
    expect((await p.call<ChangesProjection>('GET', '/api/changes')).body.active?.changeId).toBe(p.changeId);
  });
});

describe('授权强行合并（#9）', () => {
  it('必须填原因（至少 4 个字）；原因进入决策记录', async () => {
    const p = await serverProject();
    const { changeId } = await p.lock('登录', '.stagent/checks/login.mjs', FAIL);
    await p.runAll();
    expect((await p.call('POST', '/api/auth', { action: 'merge_override', changeId })).status).toBe(400);
    expect((await p.call('POST', '/api/auth', { action: 'merge_override', changeId, reason: '急用' })).status).toBe(400);
    expect((await events(p.root)).some((e) => e.type.startsWith('auth.'))).toBe(false);

    const reason = '客户今晚要演示，登录失败的例子明天修';
    const r = await p.call<{ ok: boolean }>('POST', '/api/auth', { action: 'merge_override', changeId, reason });
    expect(r.status).toBe(200);
    const es = await events(p.root);
    expect(ofType(es, 'auth.granted')[0]).toMatchObject({ action: 'merge_override', reason });
    expect(ofType(es, 'record.saved')).toMatchObject([{ kind: 'decision', tags: ['授权'], body: reason, changeId }]);
    expect(ofType(es, 'change.merged')).toHaveLength(1);
  });

  it('确认例子阶段不能强行合并；未知动作 400', async () => {
    const p = await serverProject();
    const c = (await p.call<ChangeView>('POST', '/api/changes', { description: '新功能', track: 'feature' })).body;
    expect((await p.call('POST', '/api/auth', { action: 'merge_override', changeId: c.changeId, reason: '想直接合并' })).status).toBe(409);
    expect((await p.call('POST', '/api/auth', { action: 'nuke', reason: '随便试试' })).status).toBe(400);
  });
});

describe('放弃改动', () => {
  it('先预览受影响文件，再授权放弃：还原到基准，.stagent/ 不动，本改动的例子解锁、新功能退役', async () => {
    const p = await serverProject();
    const { changeId, featureId } = await p.lock('登录', '.stagent/checks/login.mjs', APP_CHECK);
    await writeFile(join(p.root, 'src/app.js'), 'export const x = 99;\n');
    await writeFile(join(p.root, 'src/extra.js'), 'export {};\n');

    const preview = await p.call<{ files: { path: string; status: string }[]; restoreTo: string }>('GET', `/api/changes/${changeId}/abandon-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.files.map((f) => f.path)).toEqual(['src/app.js', 'src/extra.js']);
    expect(preview.body.restoreTo).toBe(await headCommit(p.root));

    expect((await p.call('POST', '/api/auth', { action: 'abandon', changeId })).status).toBe(400);
    const r = await p.call('POST', '/api/auth', { action: 'abandon', changeId, reason: '方向不对，重新来' });
    expect(r.status).toBe(200);
    expect(await readFile(join(p.root, 'src/app.js'), 'utf8')).toBe('export const x = 1;\n');
    expect(existsSync(join(p.root, 'src/extra.js'))).toBe(false);
    expect(existsSync(join(p.root, '.stagent/checks/login.mjs'))).toBe(true);
    expect((await Ledger.open(p.root)).state).toBe('ok');

    const es = await events(p.root);
    expect(ofType(es, 'change.abandoned')).toMatchObject([{ changeId, reason: '方向不对，重新来', files: ['src/app.js', 'src/extra.js'] }]);
    expect(ofType(es, 'example.unlocked')).toHaveLength(1);
    expect(ofType(es, 'feature.retired')).toMatchObject([{ featureId }]);
    expect((await p.call<ChangesProjection>('GET', '/api/changes')).body.active).toBeNull();
    expect((await p.call<FeatureView[]>('GET', '/api/features')).body).toEqual([]);

    // 还原是 Stagent 自己做的：文件监听不会把它当成新的外部改动
    await p.service.startWatching();
    await p.service.onWorkspaceSettled();
    expect((await p.call<ChangesProjection>('GET', '/api/changes')).body.active).toBeNull();
  });
});

describe('修改锁定例子：解锁 → 改 → 重锁 → 自动回归', () => {
  it('经授权解锁后才能重锁；重锁写新快照并自动跑回归', async () => {
    const p = await serverProject();
    const { exampleId, featureId } = await p.lock('登录', '.stagent/checks/login.mjs', PASS);
    await p.runAll();
    expect((await p.call('POST', `/api/examples/${exampleId}/relock`, {})).status).toBe(409);

    const r = await p.call('POST', '/api/auth', { action: 'modify_locked', exampleId, reason: '期望写错了，改成 5 位验证码' });
    expect(r.status).toBe(200);
    let f = (await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body;
    expect(f.lockedCount).toBe(0);

    await writeFile(join(p.root, '.stagent/checks/login.mjs'), 'process.exit(0); // v2\n');
    expect((await p.call('POST', `/api/examples/${exampleId}/relock`, { then: '要求输入 5 位验证码' })).status).toBe(200);
    await p.service.waitForRun();
    f = (await p.call<FeatureView>('GET', `/api/features/${featureId}`)).body;
    expect(f.examples[0]).toMatchObject({ then: '要求输入 5 位验证码', state: 'verified' });
    const locks = ofType(await events(p.root), 'example.locked').filter((e) => e.exampleId === exampleId);
    expect(locks).toHaveLength(2);
    expect(locks[1]!.checkHash).not.toBe(locks[0]!.checkHash);
    // 再次重锁需要新的授权
    expect((await p.call('POST', `/api/examples/${exampleId}/relock`, {})).status).toBe(409);
  });
});

describe('退役功能、发布与费用上限', () => {
  it('delete：功能退役，例子解锁', async () => {
    const p = await serverProject();
    const { featureId } = await p.lock('旧功能', '.stagent/checks/old.mjs', PASS);
    expect((await p.call('POST', '/api/auth', { action: 'delete', featureId: 'f-nope', reason: '不要这个功能了' })).status).toBe(404);
    expect((await p.call('POST', '/api/auth', { action: 'delete', featureId, reason: '不要这个功能了' })).status).toBe(200);
    expect((await p.call<FeatureView[]>('GET', '/api/features')).body).toEqual([]);
    const es = await events(p.root);
    expect(ofType(es, 'feature.retired')).toMatchObject([{ featureId, reason: '不要这个功能了' }]);
  });

  it('release：运行配置的发布命令，记录退出码；失败时 settled ok=false；未配置 400', async () => {
    const ok = await serverProject(nodeConfig({ releaseCommand: 'echo shipped > released.txt' }));
    const r = await ok.call<{ ok: boolean; exitCode: number }>('POST', '/api/auth', { action: 'release', reason: 'v1.0 上线' });
    expect(r.body).toMatchObject({ ok: true, exitCode: 0 });
    expect(await readFile(join(ok.root, 'released.txt'), 'utf8')).toBe('shipped\n');
    let es = await events(ok.root);
    expect(ofType(es, 'release.executed')).toMatchObject([{ command: 'echo shipped > released.txt', exitCode: 0, by: 'user' }]);

    const bad = await serverProject(nodeConfig({ releaseCommand: 'exit 3' }));
    const r2 = await bad.call<{ ok: boolean; detail: string }>('POST', '/api/auth', { action: 'release', reason: 'v1.1 上线' });
    expect(r2.body).toMatchObject({ ok: false, detail: '发布命令退出码 3' });
    es = await events(bad.root);
    expect(ofType(es, 'auth.settled')[0]).toMatchObject({ ok: false });

    const none = await serverProject();
    expect((await none.call('POST', '/api/auth', { action: 'release', reason: 'v1.2 上线' })).status).toBe(400);
  });

  it('budget_raise：只记录授权（M3-1 触发）', async () => {
    const p = await serverProject();
    const r = await p.call<{ ok: boolean }>('POST', '/api/auth', { action: 'budget_raise', reason: '这次改动比较大', amount: 20 });
    expect(r.body.ok).toBe(true);
    expect(ofType(await events(p.root), 'auth.settled')).toMatchObject([{ ok: true, detail: 'amount=20' }]);
  });
});

describe('崩溃与悬挂授权（#19）', () => {
  it('release 在消费授权后、执行前崩溃 → 重启后列为悬挂，不再执行；确认后结算', async () => {
    const config = nodeConfig({ releaseCommand: 'echo shipped >> released.txt' });
    const p = await serverProject(config, { crashBefore: 'release' });
    const r = await p.call('POST', '/api/auth', { action: 'release', reason: '晚上发版' });
    expect(r.status).toBe(500);
    expect(existsSync(join(p.root, 'released.txt'))).toBe(false);
    let es = await events(p.root);
    expect(ofType(es, 'auth.consumed')).toHaveLength(1);
    expect(ofType(es, 'auth.settled')).toHaveLength(0);

    // "重启"：新服务实例读同一份账本
    const restarted = await StagentService.open(p.root, { config });
    const app = await buildServer(restarted, { serveWeb: false });
    const o = (await app.inject({ method: 'GET', url: '/api/overview' })).json() as OverviewResponse;
    expect(o.auth.dangling).toMatchObject([{ action: 'release', reason: '晚上发版' }]);
    expect(o.reasons[0]!.text).toContain('不会自动重试');
    await new Promise((res) => setTimeout(res, 200));
    expect(existsSync(join(p.root, 'released.txt'))).toBe(false);

    const authId = o.auth.dangling[0]!.authId;
    expect((await app.inject({ method: 'POST', url: `/api/auth/${authId}/dismiss` })).statusCode).toBe(200);
    es = await events(p.root);
    expect(ofType(es, 'auth.settled')).toMatchObject([{ authId, ok: false }]);
    expect(existsSync(join(p.root, 'released.txt'))).toBe(false);
    await app.close();
  });

  it('abandon 在消费后崩溃 → 文件没有被还原，改动仍在进行中', async () => {
    const p = await serverProject(undefined, { crashBefore: 'abandon' });
    const { changeId } = await p.lock('登录', '.stagent/checks/login.mjs', PASS);
    await writeFile(join(p.root, 'src/app.js'), 'export const x = 2;\n');
    expect((await p.call('POST', '/api/auth', { action: 'abandon', changeId, reason: '不做了算了' })).status).toBe(500);
    expect(await readFile(join(p.root, 'src/app.js'), 'utf8')).toBe('export const x = 2;\n');
    expect((await p.call<ChangesProjection>('GET', '/api/changes')).body.active?.changeId).toBe(changeId);
  });
});
