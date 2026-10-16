import { describe, expect, it } from 'vitest';
import { buildOverview, SLOW_RUN_MS } from '../../src/projection/overview.js';
import { project } from '../../src/projection/projection.js';
import { CURRENT, LineBuilder } from '../helpers/lines.js';

const ok = { state: 'ok' as const, brokenLinks: [] };
const overviewOf = (b: LineBuilder, extra: Partial<Parameters<typeof buildOverview>[0]> = {}) =>
  buildOverview({ projection: project(b.lines, CURRENT), ledger: ok, run: null, ...extra });

describe('结论卡', () => {
  it('空账本：还没有任何已验证功能，提供两个入口', () => {
    const o = overviewOf(new LineBuilder());
    expect(o.status).toBe('empty');
    expect(o.title).toBe('还没有任何已验证功能');
    expect(o.actions.map((a) => a.label)).toEqual(['扫描现有代码', '描述第一个功能']);
    // 被禁用的按钮必须写原因
    expect(o.actions.filter((a) => !a.enabled).every((a) => a.disabledReason)).toBe(true);
  });

  it('全部已验证 → ✅ 系统完好，可以继续', () => {
    const o = overviewOf(new LineBuilder().feature('f').example('f', 'a').example('f', 'b').run([['a', 'passed'], ['b', 'passed']]));
    expect(o).toMatchObject({ status: 'ok', icon: '✅', canContinue: true });
    expect(o.stats).toEqual({ verified: 1, broken: 0, unverified: 0, lockedExamples: 2, features: 1 });
  });

  it('有失败 → ⛔，点名被破坏的功能；合并按钮禁用且写明原因', () => {
    const b = new LineBuilder()
      .feature('f1', '登录').example('f1', 'a')
      .feature('f2', '结算').example('f2', 'b').example('f2', 'c')
      .run([['a', 'failed'], ['b', 'passed'], ['c', 'errored']]);
    const o = overviewOf(b);
    expect(o).toMatchObject({ status: 'blocked', icon: '⛔', canContinue: false });
    expect(o.reasons[0]!.text).toContain('登录 被破坏');
    const merge = o.actions.find((a) => a.id === 'merge')!;
    expect(merge).toMatchObject({ enabled: false, label: '合并（1 失败 · 1 未验证）' });
    expect(merge.disabledReason).toBeTruthy();
  });

  it('原因按严重度排序，最多 3 条', () => {
    const b = new LineBuilder()
      .feature('a').example('a', 'x1')
      .feature('b').example('b', 'x2')
      .feature('c').example('c', 'x3')
      .feature('d').example('d', 'x4')
      .feature('e')
      .run([['x1', 'not_run'], ['x2', 'flaky'], ['x3', 'errored'], ['x4', 'failed']]);
    const o = overviewOf(b);
    expect(o.reasons).toHaveLength(3);
    expect(o.reasons.map((r) => r.severity)).toEqual([...o.reasons.map((r) => r.severity)].sort((p, q) => p - q));
    expect(o.reasons[0]!.text).toContain('被破坏');
    expect(o.reasons[1]!.text).toContain('执行异常');
    expect(o.reasons[2]!.text).toContain('结果不稳定');
  });

  it('证据过期 → ⛔，主操作是运行全量回归', () => {
    const b = new LineBuilder().feature('f').example('f', 'a').run([['a', 'passed']]);
    const o = buildOverview({ projection: project(b.lines, { ...CURRENT, workTreeHash: 'changed' }), ledger: ok, run: null });
    expect(o.status).toBe('blocked');
    expect(o.reasons[0]!.text).toContain('证据过期');
    expect(o.actions[0]).toMatchObject({ id: 'run_regression', enabled: true, primary: true });
  });

  it('只有"尚无例子"与"覆盖薄弱"不阻止继续', () => {
    const b = new LineBuilder().feature('f').example('f', 'a').run([['a', 'passed']]).feature('g');
    const o = overviewOf(b);
    expect(o.status).toBe('ok');
    expect(o.reasons.map((r) => r.text)).toEqual(['1 个功能尚无例子（g）', '1 个功能覆盖薄弱（f）']);
  });

  it('检查中 → ⏳，显示进度与当前检查名，可以取消', () => {
    const b = new LineBuilder().feature('f').example('f', 'a');
    const o = overviewOf(b, { run: { runId: 'r', done: 1, total: 3, current: '登录：进入首页', startedAt: 'x' } });
    expect(o).toMatchObject({ status: 'checking', icon: '⏳' });
    expect(o.reasons[0]!.text).toBe('正在运行 2/3：登录：进入首页');
    expect(o.actions[0]).toMatchObject({ id: 'cancel_run', enabled: true });
  });

  it('账本被修改 → 🔒，写操作禁用，提供"我确认，接受当前状态"', () => {
    const b = new LineBuilder().feature('f').example('f', 'a').run([['a', 'passed']]);
    const o = overviewOf(b, { ledger: { state: 'locked', brokenLinks: [{ seq: 3, reason: 'hash_mismatch' }] } });
    expect(o).toMatchObject({ status: 'ledger_modified', icon: '🔒' });
    expect(o.reasons[0]!.text).toContain('第 3 行');
    expect(o.actions[0]).toMatchObject({ id: 'accept_ledger', enabled: true });
    expect(o.actions[1]).toMatchObject({ enabled: false });
  });

  it('上次运行超过 5 分钟 → 提示最慢的检查', () => {
    const b = new LineBuilder().feature('f').example('f', 'a');
    b.run([['a', 'passed']]);
    const run = b.lines.at(-1)!.event as { results: { durationMs: number }[] };
    run.results[0]!.durationMs = SLOW_RUN_MS + 1;
    expect(overviewOf(b).slowRunHint).toMatchObject({ slowest: [{ exampleId: 'a' }] });
  });
});
