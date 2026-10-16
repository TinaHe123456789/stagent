import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeView, ChangesProjection } from '../../src/changes/changes.js';
import { headCommit } from '../../src/git/git.js';
import { Ledger } from '../../src/ledger/index.js';
import type { OverviewResponse } from '../../src/server/service.js';
import { gitIn } from '../helpers/project.js';
import { APP_CHECK, PASS, serverProject } from '../helpers/server.js';

const until = async (fn: () => Promise<boolean>, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('等待超时');
};

describe('改动接口', () => {
  it('创建小改动 → 实现中；开始检查 → 可合并；概览围绕进行中的改动', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/a.mjs', PASS);
    const first = (await p.call<ChangesProjection>('GET', '/api/changes')).body.active!;
    expect(first.phase).toBe('implementing');
    expect(first.source).toBe('claude-code');

    expect((await p.call('POST', `/api/changes/${first.changeId}/check`)).status).toBe(202);
    await p.service.waitForRun();
    const c = (await p.call<ChangeView>('GET', `/api/changes/${first.changeId}`)).body;
    expect(c).toMatchObject({ phase: 'mergeable', step: 4, lastRun: { valid: true, fresh: true } });
    const o = (await p.call<OverviewResponse>('GET', '/api/overview')).body;
    expect(o.status).toBe('ok');
    expect(o.change?.changeId).toBe(first.changeId);
    const merge = o.actions.find((a) => a.id === 'merge')!;
    expect(merge).toMatchObject({ enabled: true, primary: true });
  });

  it('同一时间只能有一个进行中的改动：并发创建只有一个成功，其余 409（#14）', async () => {
    const p = await serverProject();
    const results = await Promise.all(
      [1, 2, 3].map((i) => p.call('POST', '/api/changes', { description: `改动 ${i}` })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const started = (await Ledger.open(p.root)).events().filter((e) => e.type === 'change.started');
    expect(started).toHaveLength(1);
  });

  it('升档 / 降档事件完整；锁定例子后不能降档（#13）', async () => {
    const p = await serverProject();
    const c = (await p.call<ChangeView>('POST', '/api/changes', { description: '改按钮颜色' })).body;
    expect(c).toMatchObject({ track: 'small', phase: 'implementing' });
    let r = await p.call<ChangeView>('POST', `/api/changes/${c.changeId}/track`, { track: 'feature' });
    expect(r.body).toMatchObject({ track: 'feature', phase: 'confirm_examples' });
    expect((await p.call('POST', `/api/changes/${c.changeId}/track`, { track: 'feature' })).status).toBe(409);
    r = await p.call<ChangeView>('POST', `/api/changes/${c.changeId}/track`, { track: 'small', reason: '其实只改颜色' });
    expect(r.body.track).toBe('small');
    const events = (await Ledger.open(p.root)).events().filter((e) => e.type.startsWith('change.track_'));
    expect(events).toEqual([
      { type: 'change.track_upgraded', changeId: c.changeId, by: 'user' },
      { type: 'change.track_downgraded', changeId: c.changeId, by: 'user', reason: '其实只改颜色' },
    ]);

    await p.lock('登录', '.stagent/checks/a.mjs', PASS); // 会把改动升回新功能档并锁定例子
    expect((await p.call('POST', `/api/changes/${c.changeId}/track`, { track: 'small' })).status).toBe(409);
    expect((await p.call('POST', `/api/changes/${c.changeId}/track`, { track: 'huge' })).status).toBe(400);
  });

  it('小改动档不能起草例子；确认例子阶段不能开始检查', async () => {
    const p = await serverProject();
    await p.writeCheck('.stagent/checks/a.mjs', PASS);
    const small = (await p.call<ChangeView>('POST', '/api/changes', { description: '改文案' })).body;
    const draft = { featureName: '登录', given: 'g', when: 'w', then: 't', checkPath: '.stagent/checks/a.mjs' };
    expect((await p.call('POST', `/api/changes/${small.changeId}/examples`, draft)).status).toBe(409);
    await p.call('POST', `/api/changes/${small.changeId}/track`, { track: 'feature' });
    expect((await p.call('POST', `/api/changes/${small.changeId}/check`)).status).toBe(409);
    expect((await p.call('POST', `/api/changes/${small.changeId}/examples/lock`, {})).status).toBe(400);
    expect((await p.call('POST', `/api/changes/${small.changeId}/examples`, draft)).status).toBe(201);
    const locked = await p.call<ChangeView>('POST', `/api/changes/${small.changeId}/examples/lock`, {});
    expect(locked.body).toMatchObject({ phase: 'implementing', pendingDraftIds: [] });
    expect((await p.call('POST', `/api/changes/${small.changeId}/examples/lock`, { exampleIds: ['e-nope'] })).status).toBe(409);
  });

  it('改动破坏已验收例子 → 结论卡 ⛔ 并点名功能（#4 检测部分）', async () => {
    const p = await serverProject();
    await p.lock('购物车', '.stagent/checks/cart.mjs', APP_CHECK);
    await p.runAll();
    await writeFile(join(p.root, 'src/app.js'), 'export const x = 2;\n');
    let o = (await p.call<OverviewResponse>('GET', '/api/overview')).body;
    expect(o.change?.phase).toBe('implementing');
    await p.runAll();
    o = (await p.call<OverviewResponse>('GET', '/api/overview')).body;
    expect(o).toMatchObject({ status: 'blocked', icon: '⛔' });
    expect(o.change?.phase).toBe('blocked');
    expect(o.reasons[0]!.text).toContain('购物车');
    const fix = o.actions.find((a) => a.id === 'fix')!;
    expect(fix.enabled).toBe(false);
    expect(fix.disabledReason).toBeTruthy();
  });
});

describe('外部改动（§5.3）', () => {
  it('没有进行中的改动时，工作区变化 → 自动建外部改动（small，基准为 HEAD）并自动检查', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/a.mjs', APP_CHECK);
    const c1 = (await p.call<ChangesProjection>('GET', '/api/changes')).body.active!;
    await (await Ledger.open(p.root)).append({ type: 'change.merged', changeId: c1.changeId, mergeCommit: await headCommit(p.root) });
    await p.service.startWatching();

    await p.service.onWorkspaceSettled(); // 没变化：不建改动
    expect((await p.call<ChangesProjection>('GET', '/api/changes')).body.active).toBeNull();

    await writeFile(join(p.root, 'src/app.js'), 'export const x = 1; // cursor edit\n');
    await p.service.onWorkspaceSettled();
    const active = (await p.call<ChangesProjection>('GET', '/api/changes')).body.active!;
    expect(active).toMatchObject({ source: 'external', track: 'small', baseCommit: await headCommit(p.root) });
    expect(active.firstObservedWorkTreeHash).toMatch(/^[0-9a-f]{64}$/);
    await p.service.waitForRun();
    expect((await p.call<ChangeView>('GET', `/api/changes/${active.changeId}`)).body.phase).toBe('mergeable');
  });

  it('有进行中的改动时，外部变化并入当前改动，不新建（#14）', async () => {
    const p = await serverProject();
    const c = (await p.call<ChangeView>('POST', '/api/changes', { description: '改首页' })).body;
    await p.service.startWatching();
    await writeFile(join(p.root, 'src/app.js'), 'export const x = 1; // edit\n');
    await p.service.onWorkspaceSettled();
    const { changes, active } = (await p.call<ChangesProjection>('GET', '/api/changes')).body;
    expect(changes).toHaveLength(1);
    expect(active?.changeId).toBe(c.changeId);
  });

  it('真实文件监听：防抖后识别外部改动', async () => {
    const p = await serverProject(undefined, { watchDebounceMs: 100, autoCheckExternal: false });
    await p.service.startWatching();
    await writeFile(join(p.root, 'src/new-file.js'), 'export {};\n');
    await until(async () => (await p.call<ChangesProjection>('GET', '/api/changes')).body.active?.source === 'external');
  });

  it('被 .gitignore 忽略的文件变化不算改动', async () => {
    const p = await serverProject();
    await p.service.startWatching();
    await writeFile(join(p.root, '.gitignore'), 'node_modules/\n.stagent/runs/\n*.log\n');
    gitIn(p.root, 'commit', '-qam', 'ignore logs');
    await p.service.onWorkspaceSettled(); // .gitignore 本身变化 → 外部改动
    const before = (await p.call<ChangesProjection>('GET', '/api/changes')).body.changes.length;
    await writeFile(join(p.root, 'debug.log'), 'noise\n');
    await p.service.onWorkspaceSettled();
    expect((await p.call<ChangesProjection>('GET', '/api/changes')).body.changes.length).toBe(before);
  });

  it('在 Stagent 之外直接 git commit → 标注未托管提交并补跑回归（#15）', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/a.mjs', APP_CHECK);
    await p.runAll();
    const base = await headCommit(p.root);
    expect(await p.service.checkHead()).toBe(false);

    await writeFile(join(p.root, 'src/app.js'), 'export const x = 1; // committed outside\n');
    gitIn(p.root, 'add', '-A');
    gitIn(p.root, 'commit', '-qm', 'outside');
    const head = await headCommit(p.root);
    const runsBefore = (await Ledger.open(p.root)).events().filter((e) => e.type === 'run.completed').length;

    expect(await p.service.checkHead()).toBe(true);
    await p.service.waitForRun();
    const events = (await Ledger.open(p.root)).events();
    expect(events.filter((e) => e.type === 'change.unmanaged_commit')).toEqual([
      { type: 'change.unmanaged_commit', fromCommit: base, toCommit: head },
    ]);
    const runs = events.filter((e) => e.type === 'run.completed');
    expect(runs.length).toBe(runsBefore + 1);
    expect(runs.at(-1)).toMatchObject({ startCommit: head });
    // 只记一次
    expect(await p.service.checkHead()).toBe(false);
  });

  it('切回旧提交（不是前进）不算未托管提交', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/a.mjs', PASS);
    await writeFile(join(p.root, 'src/app.js'), 'export const x = 1; // v2\n');
    gitIn(p.root, 'commit', '-qam', 'v2');
    expect(await p.service.checkHead()).toBe(true);
    await p.service.waitForRun();
    gitIn(p.root, 'checkout', '-q', 'HEAD~1');
    expect(await p.service.checkHead()).toBe(false);
  });
});
