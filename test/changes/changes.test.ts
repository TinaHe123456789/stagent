import { describe, expect, it } from 'vitest';
import { activeChangeIdFromLines, knownHead, projectChanges } from '../../src/changes/changes.js';
import { project } from '../../src/projection/projection.js';
import { CURRENT, LineBuilder } from '../helpers/lines.js';

const start = (b: LineBuilder, changeId: string, track: 'small' | 'feature' = 'small', source: 'claude-code' | 'external' = 'claude-code') =>
  b.add({ type: 'change.started', changeId, track, baseCommit: 'c0', source, description: `改动 ${changeId}` });

const phaseOf = (b: LineBuilder, opts: { current?: typeof CURRENT; running?: string } = {}) => {
  const current = opts.current ?? CURRENT;
  const projection = project(b.lines, current);
  return projectChanges(b.lines, { current, projection, runningChangeId: opts.running ?? null });
};

/** 在改动 c 里起草并锁定一个例子。 */
const lockIn = (b: LineBuilder, c: string, featureId: string, exampleId: string, kind: 'behavior' | 'visual' = 'behavior') => {
  b.add({ type: 'example.drafted', exampleId, featureId, given: 'g', when: 'w', then: `期望 ${exampleId}`, kind, changeId: c });
  return b.add({ type: 'example.locked', exampleId, checkPath: `.stagent/checks/${exampleId}.mjs`, checkHash: `h-${exampleId}`, by: 'user', changeId: c });
};

const runFor = (b: LineBuilder, c: string, results: Array<[string, 'passed' | 'failed' | 'errored']>, opts: { valid?: boolean; workTreeHash?: string } = {}) => {
  b.run(results, opts);
  (b.lines.at(-1)!.event as { changeId?: string }).changeId = c;
  return b;
};

describe('改动状态机（§5.4）', () => {
  it('小改动档：实现中 → 检查中 → 可合并', () => {
    const b = new LineBuilder().feature('f').example('f', 'a');
    start(b, 'c1');
    expect(phaseOf(b).active).toMatchObject({ phase: 'implementing', step: 2 });
    expect(phaseOf(b, { running: 'c1' }).active).toMatchObject({ phase: 'checking', step: 3 });
    runFor(b, 'c1', [['a', 'passed']]);
    expect(phaseOf(b).active).toMatchObject({ phase: 'mergeable', step: 4, blockers: [] });
  });

  it('新功能档：确认例子 → 锁定 → 实现中；有未锁定草稿时回到确认例子', () => {
    const b = start(new LineBuilder().feature('f'), 'c1', 'feature');
    expect(phaseOf(b).active).toMatchObject({ phase: 'confirm_examples', step: 1, blockers: ['新功能档：先起草验收例子'] });
    b.add({ type: 'example.drafted', exampleId: 'a', featureId: 'f', given: 'g', when: 'w', then: 't', kind: 'behavior', changeId: 'c1' });
    expect(phaseOf(b).active).toMatchObject({ phase: 'confirm_examples', pendingDraftIds: ['a'] });
    b.add({ type: 'example.locked', exampleId: 'a', checkPath: 'p', checkHash: 'h-a', by: 'user', changeId: 'c1' });
    expect(phaseOf(b).active).toMatchObject({ phase: 'implementing', lockedExampleIds: ['a'] });
    b.add({ type: 'example.drafted', exampleId: 'b', featureId: 'f', given: 'g', when: 'w', then: 't', kind: 'behavior', changeId: 'c1' });
    expect(phaseOf(b).active!.phase).toBe('confirm_examples');
  });

  it('草稿都跑过先失败检查但未锁定 → 先失败检查', () => {
    const b = start(new LineBuilder().feature('f'), 'c1', 'feature');
    b.add({ type: 'example.drafted', exampleId: 'a', featureId: 'f', given: 'g', when: 'w', then: 't', kind: 'behavior', changeId: 'c1' });
    b.run([['a', 'failed']], { purpose: 'red_check' });
    (b.lines.at(-1)!.event as { changeId?: string }).changeId = 'c1';
    expect(phaseOf(b).active!.phase).toBe('red_check');
  });

  it('检查失败 → 被阻止，并点名功能（#4 检测部分）；代码再改 → 实现中（交给修复）', () => {
    const b = new LineBuilder().feature('f', '登录').example('f', 'a');
    start(b, 'c1');
    runFor(b, 'c1', [['a', 'failed']]);
    const blocked = phaseOf(b).active!;
    expect(blocked.phase).toBe('blocked');
    expect(blocked.blockers[0]).toContain('「登录」');
    expect(phaseOf(b, { current: { ...CURRENT, workTreeHash: 'edited' } }).active!.phase).toBe('implementing');
  });

  it('运行无效 → 被阻止', () => {
    const b = new LineBuilder().feature('f').example('f', 'a');
    start(b, 'c1');
    runFor(b, 'c1', [['a', 'passed']], { valid: false });
    expect(phaseOf(b).active).toMatchObject({ phase: 'blocked' });
  });

  it('全部通过且有外观例子 → 待你确认外观；确认 → 可合并；不满意 → 实现中', () => {
    const b = start(new LineBuilder().feature('f'), 'c1', 'feature');
    lockIn(b, 'c1', 'f', 'v', 'visual');
    runFor(b, 'c1', [['v', 'passed']]);
    expect(phaseOf(b).active!.phase).toBe('awaiting_visual');
    const ok = new LineBuilder();
    ok.lines.push(...b.lines);
    ok.add({ type: 'visual.confirmed', exampleId: 'v', screenshot: 's.png', ok: true });
    expect(phaseOf(ok).active!.phase).toBe('mergeable');
    b.add({ type: 'visual.confirmed', exampleId: 'v', screenshot: 's.png', ok: false, note: '按钮太小' });
    expect(phaseOf(b).active!.phase).toBe('implementing');
  });

  it('升档 / 降档记录历史，阶段随档位变化（#13）', () => {
    const b = new LineBuilder();
    start(b, 'c1');
    b.add({ type: 'change.track_upgraded', changeId: 'c1', by: 'user' });
    let c = phaseOf(b).active!;
    expect(c).toMatchObject({ track: 'feature', initialTrack: 'small', phase: 'confirm_examples' });
    b.add({ type: 'change.track_downgraded', changeId: 'c1', by: 'user', reason: '只是改颜色' });
    c = phaseOf(b).active!;
    expect(c.track).toBe('small');
    expect(c.trackHistory.map((t) => [t.from, t.to, t.reason])).toEqual([
      ['small', 'feature', undefined],
      ['feature', 'small', '只是改颜色'],
    ]);
  });

  it('合并或放弃后不再是进行中的改动', () => {
    const b = new LineBuilder();
    start(b, 'c1');
    expect(activeChangeIdFromLines(b.lines)).toBe('c1');
    b.add({ type: 'change.merged', changeId: 'c1', mergeCommit: 'm1' });
    expect(phaseOf(b).active).toBeNull();
    expect(phaseOf(b).changes[0]!.phase).toBe('merged');
    expect(activeChangeIdFromLines(b.lines)).toBeNull();
    start(b, 'c2');
    b.add({ type: 'change.abandoned', changeId: 'c2', reason: '不做了' });
    expect(phaseOf(b).active).toBeNull();
  });

  it('未托管提交归到当时进行中的改动', () => {
    const b = new LineBuilder();
    start(b, 'c1');
    b.add({ type: 'change.unmanaged_commit', fromCommit: 'c0', toCommit: 'c9' });
    expect(phaseOf(b).active!.unmanagedCommits).toMatchObject([{ fromCommit: 'c0', toCommit: 'c9' }]);
  });
});

describe('knownHead', () => {
  it('取最后出现的基准 / 合并 / 未托管提交；没有时退回最近运行的 endCommit；都没有为 null', () => {
    expect(knownHead(new LineBuilder().lines)).toBeNull();
    const b = new LineBuilder().feature('f').example('f', 'a').run([['a', 'passed']]);
    expect(knownHead(b.lines)).toBe('c1');
    start(b, 'x');
    expect(knownHead(b.lines)).toBe('c0');
    b.add({ type: 'change.merged', changeId: 'x', mergeCommit: 'm1' });
    expect(knownHead(b.lines)).toBe('m1');
    b.add({ type: 'change.unmanaged_commit', fromCommit: 'm1', toCommit: 'u2' });
    expect(knownHead(b.lines)).toBe('u2');
  });
});
