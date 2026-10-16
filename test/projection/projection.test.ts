import { describe, expect, it } from 'vitest';
import { project } from '../../src/projection/projection.js';
import { CURRENT, LineBuilder } from '../helpers/lines.js';

const exampleOf = (b: LineBuilder, id: string, current = CURRENT) =>
  project(b.lines, current).features.flatMap((f) => f.examples).find((x) => x.exampleId === id)!;

describe('例子级判定表', () => {
  it('新鲜且有效的 passed → 已验证', () => {
    const b = new LineBuilder().feature('f').example('f', 'e').run([['e', 'passed']]);
    expect(exampleOf(b, 'e')).toMatchObject({ state: 'verified' });
  });

  it('新鲜且有效的 failed → 失败', () => {
    const b = new LineBuilder().feature('f').example('f', 'e').run([['e', 'failed']]);
    expect(exampleOf(b, 'e')).toMatchObject({ state: 'failed' });
  });

  it('锁定后没运行过 → 未验证 · 未执行', () => {
    const b = new LineBuilder().feature('f').example('f', 'e');
    expect(exampleOf(b, 'e')).toMatchObject({ state: 'unverified', reason: 'not_run', lastResult: null });
  });

  it('工作区在运行后变了 → 未验证 · 证据过期（passed 与 failed 都一样）', () => {
    const b = new LineBuilder().feature('f').example('f', 'e').example('f', 'e2').run([['e', 'passed'], ['e2', 'failed']]);
    const changed = { ...CURRENT, workTreeHash: 'wt2' };
    expect(exampleOf(b, 'e', changed)).toMatchObject({ state: 'unverified', reason: 'stale' });
    expect(exampleOf(b, 'e2', changed)).toMatchObject({ state: 'unverified', reason: 'stale' });
  });

  it('workTreeHashSpec 变了（改 ignoreGlobs）→ 证据过期', () => {
    const b = new LineBuilder().feature('f').example('f', 'e').run([['e', 'passed']]);
    expect(exampleOf(b, 'e', { ...CURRENT, workTreeHashSpec: 'spec2' })).toMatchObject({ reason: 'stale' });
  });

  it('run valid=false → 未验证 · 证据无效', () => {
    const b = new LineBuilder().feature('f').example('f', 'e').run([['e', 'passed']], { valid: false });
    expect(exampleOf(b, 'e')).toMatchObject({ state: 'unverified', reason: 'invalid' });
  });

  it.each([
    ['flaky', 'flaky'],
    ['errored', 'errored'],
    ['not_run', 'not_run'],
  ] as const)('结果 %s → 未验证 · %s', (status, reason) => {
    const b = new LineBuilder().feature('f').example('f', 'e').run([['e', status]]);
    expect(exampleOf(b, 'e')).toMatchObject({ state: 'unverified', reason });
  });

  it('flaky 的说明是"结果不稳定"（验收 #21）', () => {
    const b = new LineBuilder().feature('f').example('f', 'e').run([['e', 'flaky']]);
    expect(exampleOf(b, 'e').explanation).toContain('结果不稳定');
  });

  it('最近一次结果为准：先 passed 后 failed → 失败', () => {
    const b = new LineBuilder().feature('f').example('f', 'e').run([['e', 'passed']]).run([['e', 'failed']]);
    expect(exampleOf(b, 'e').state).toBe('failed');
  });

  it('red_check 运行不参与判定', () => {
    const b = new LineBuilder().feature('f').example('f', 'e').run([['e', 'passed']]).run([['e', 'failed']], { purpose: 'red_check' });
    expect(exampleOf(b, 'e').state).toBe('verified');
    const only = new LineBuilder().feature('f').example('f', 'e').run([['e', 'passed']], { purpose: 'red_check' });
    expect(exampleOf(only, 'e')).toMatchObject({ state: 'unverified', reason: 'not_run' });
  });

  it('baseline 运行参与判定', () => {
    const b = new LineBuilder().feature('f').example('f', 'e').run([['e', 'passed']], { purpose: 'baseline' });
    expect(exampleOf(b, 'e').state).toBe('verified');
  });

  it('有 claim 但没有新鲜的 passed → 仅 AI 声称（errored 不会被当成通过）', () => {
    const b = new LineBuilder()
      .feature('f')
      .example('f', 'e')
      .add({ type: 'claim.reported', changeId: 'c', exampleId: 'e', text: '已实现' })
      .run([['e', 'errored']]);
    const x = exampleOf(b, 'e');
    expect(x).toMatchObject({ state: 'unverified', reason: 'ai_claim_only' });
    expect(x.explanation).toContain('执行异常');
    expect(x.claims).toHaveLength(1);
  });

  it('claim 与 failed 并存 → 显示失败，claim 保留', () => {
    const b = new LineBuilder()
      .feature('f')
      .example('f', 'e')
      .add({ type: 'claim.reported', changeId: 'c', exampleId: 'e', text: '已实现' })
      .run([['e', 'failed']]);
    expect(exampleOf(b, 'e')).toMatchObject({ state: 'failed', claims: [{ text: '已实现' }] });
  });

  it('claim 与新鲜 passed 并存 → 已验证（证据来自系统运行）', () => {
    const b = new LineBuilder()
      .feature('f')
      .example('f', 'e')
      .add({ type: 'claim.reported', changeId: 'c', exampleId: 'e', text: '已实现' })
      .run([['e', 'passed']]);
    expect(exampleOf(b, 'e').state).toBe('verified');
  });
});

describe('功能级状态与覆盖', () => {
  it('全部锁定例子已验证 → 已验证（N 个例子）', () => {
    const b = new LineBuilder().feature('f', '登录').example('f', 'a').example('f', 'b').run([['a', 'passed'], ['b', 'passed']]);
    const f = project(b.lines, CURRENT).features[0]!;
    expect(f).toMatchObject({ state: 'verified', stateLabel: '已验证（2 个例子）', tag: '已验收', verifiedCount: 2, lockedCount: 2 });
    expect(f.coverage.weak).toBe(false);
    expect(f.lastRunAt).not.toBeNull();
  });

  it('任一失败 → 被破坏；有未验证 → 未验证', () => {
    const b = new LineBuilder()
      .feature('f1').example('f1', 'a').example('f1', 'b')
      .feature('f2').example('f2', 'c').example('f2', 'd')
      .run([['a', 'passed'], ['b', 'failed'], ['c', 'passed'], ['d', 'errored']]);
    const [f1, f2] = project(b.lines, CURRENT).features;
    expect(f1).toMatchObject({ state: 'broken', stateLabel: '被破坏（1 个例子失败）' });
    expect(f2).toMatchObject({ state: 'unverified' });
  });

  it('没有例子的功能 → 未验证（尚无例子），覆盖薄弱', () => {
    const f = project(new LineBuilder().feature('f').lines, CURRENT).features[0]!;
    expect(f).toMatchObject({ state: 'unverified', stateLabel: '未验证（尚无例子）', coverage: { weak: true } });
  });

  it('覆盖薄弱：少于 2 个，或只有 visual', () => {
    const one = new LineBuilder().feature('f').example('f', 'a').run([['a', 'passed']]);
    expect(project(one.lines, CURRENT).features[0]!.coverage).toEqual({ weak: true, reason: '锁定例子少于 2 个' });
    const visual = new LineBuilder().feature('f').example('f', 'a', 'ha', 'visual').example('f', 'b', 'hb', 'visual');
    expect(project(visual.lines, CURRENT).features[0]!.coverage).toEqual({ weak: true, reason: '只有外观类例子' });
  });

  it('退役的功能不显示；解锁的例子不计入', () => {
    const b = new LineBuilder()
      .feature('gone').feature('f').example('f', 'a').example('f', 'b')
      .add({ type: 'feature.retired', featureId: 'gone', reason: '不要了', authId: 'x' })
      .add({ type: 'example.unlocked', exampleId: 'b', reason: '改例子', by: 'user' });
    const features = project(b.lines, CURRENT).features;
    expect(features.map((f) => f.featureId)).toEqual(['f']);
    expect(features[0]!.lockedCount).toBe(1);
  });

  it('起草未锁定的例子只计入草稿数', () => {
    const b = new LineBuilder()
      .feature('f')
      .add({ type: 'example.drafted', exampleId: 'd', featureId: 'f', given: 'g', when: 'w', then: 't', kind: 'behavior' });
    expect(project(b.lines, CURRENT).features[0]).toMatchObject({ draftCount: 1, lockedCount: 0 });
  });

  it('最近的拦截与最近一次运行', () => {
    const b = new LineBuilder()
      .feature('f').example('f', 'a')
      .add({ type: 'guard.blocked', path: '.stagent/checks/a.mjs', tool: 'Write', detail: '锁定检查' })
      .run([['a', 'passed']]);
    const p = project(b.lines, CURRENT);
    expect(p.lastGuardBlock).toMatchObject({ tool: 'Write' });
    expect(p.lastRun).toMatchObject({ durationMs: 10 });
  });
});
