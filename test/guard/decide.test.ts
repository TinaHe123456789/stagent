import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lockedCheckPaths, realpathNearest } from '../../src/guard/context.js';
import { decidePreToolUse, type GuardContext } from '../../src/guard/decide.js';
import { tmpProject } from '../helpers/tmp.js';

const ROOT = '/work/app';
const LOCKED = '.stagent/checks/login/a.mjs';

function ctx(over: Partial<GuardContext> = {}): GuardContext {
  return { projectRoot: ROOT, lockedCheckPaths: new Set([LOCKED]), draftAllowed: false, extraBashRules: [], ...over };
}

function hook(tool_name: string, tool_input: Record<string, unknown>, cwd = ROOT) {
  return { session_id: 's1', transcript_path: '/t.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name, tool_input };
}

describe('decidePreToolUse：文件工具', () => {
  it('Write 锁定检查 → 拒绝，带路径与"锁定检查"原因', () => {
    const d = decidePreToolUse(hook('Write', { file_path: `${ROOT}/${LOCKED}`, content: 'x' }), ctx());
    expect(d).toMatchObject({ decision: 'deny', path: LOCKED, tool: 'Write', ruleId: 'locked-check' });
    if (d.decision === 'deny') expect(d.reason).toContain('锁定的验收检查');
  });

  it('Edit 账本 → 拒绝', () => {
    const d = decidePreToolUse(hook('Edit', { file_path: '.stagent/ledger/events.jsonl', old_string: 'a', new_string: 'b' }), ctx());
    expect(d).toMatchObject({ decision: 'deny', path: '.stagent/ledger/events.jsonl', ruleId: 'stagent-dir' });
    if (d.decision === 'deny') expect(d.reason).toContain('账本');
  });

  it('MultiEdit config.json、快照、未锁定的检查 → 拒绝', () => {
    for (const p of ['.stagent/config.json', '.stagent/ledger/snapshots/ab/abc', '.stagent/checks/new.mjs', '.stagent/service.lock']) {
      expect(decidePreToolUse(hook('MultiEdit', { file_path: p, edits: [] }), ctx())).toMatchObject({ decision: 'deny', path: p });
    }
  });

  it('NotebookEdit 用 notebook_path', () => {
    expect(decidePreToolUse(hook('NotebookEdit', { notebook_path: '.stagent/checks/x.ipynb', new_source: '' }), ctx())).toMatchObject({
      decision: 'deny',
      tool: 'NotebookEdit',
    });
    expect(decidePreToolUse(hook('NotebookEdit', { notebook_path: 'notebooks/x.ipynb', new_source: '' }), ctx())).toEqual({
      decision: 'allow',
    });
  });

  it('草稿目录只对起草会话放行', () => {
    const input = hook('Write', { file_path: '.stagent/checks/draft/login/a.mjs', content: 'x' });
    expect(decidePreToolUse(input, ctx())).toMatchObject({ decision: 'deny', ruleId: 'draft-not-allowed' });
    expect(decidePreToolUse(input, ctx({ draftAllowed: true }))).toEqual({ decision: 'allow' });
    // 起草会话也不能借 .. 写到草稿目录外
    const escape = hook('Write', { file_path: '.stagent/checks/draft/../a.mjs', content: 'x' });
    expect(decidePreToolUse(escape, ctx({ draftAllowed: true }))).toMatchObject({ decision: 'deny', path: '.stagent/checks/a.mjs' });
    // 锁定检查即使在草稿目录里也不放行
    const lockedDraft = hook('Write', { file_path: '.stagent/checks/draft/l.mjs', content: 'x' });
    expect(decidePreToolUse(lockedDraft, ctx({ draftAllowed: true, lockedCheckPaths: new Set(['.stagent/checks/draft/l.mjs']) }))).toMatchObject({
      decision: 'deny',
      ruleId: 'locked-check',
    });
  });

  it('相对路径按 cwd 解析，../ 穿越与绝对路径都能识别', () => {
    // cwd 在子目录，../.stagent 指回项目根
    expect(decidePreToolUse(hook('Write', { file_path: '../.stagent/ledger/events.jsonl' }, `${ROOT}/src`), ctx())).toMatchObject({
      decision: 'deny',
      path: '.stagent/ledger/events.jsonl',
    });
    expect(decidePreToolUse(hook('Edit', { file_path: `${ROOT}/src/../.stagent/checks/login/a.mjs` }), ctx())).toMatchObject({
      decision: 'deny',
      ruleId: 'locked-check',
    });
    expect(decidePreToolUse(hook('Write', { file_path: './src/./../.stagent/x' }), ctx())).toMatchObject({ decision: 'deny' });
    // 大小写变体（大小写不敏感的文件系统上是同一个目录）
    expect(decidePreToolUse(hook('Write', { file_path: '.Stagent/ledger/events.jsonl' }), ctx())).toMatchObject({ decision: 'deny' });
  });

  it('项目外的文件、普通源码、子目录里别的 .stagent 不归守卫管', () => {
    expect(decidePreToolUse(hook('Write', { file_path: '/tmp/x.txt' }), ctx())).toEqual({ decision: 'allow' });
    expect(decidePreToolUse(hook('Write', { file_path: '/work/other/.stagent/ledger/events.jsonl' }), ctx())).toEqual({ decision: 'allow' });
    expect(decidePreToolUse(hook('Write', { file_path: '../other/file.ts' }), ctx())).toEqual({ decision: 'allow' });
    expect(decidePreToolUse(hook('Edit', { file_path: 'src/app.ts' }), ctx())).toEqual({ decision: 'allow' });
    expect(decidePreToolUse(hook('Write', { file_path: 'packages/a/.stagent/x' }), ctx())).toEqual({ decision: 'allow' });
    expect(decidePreToolUse(hook('Write', { file_path: '.stagentrc' }), ctx())).toEqual({ decision: 'allow' });
  });

  it('符号链接指向 .stagent/ 时按真实路径拒绝', async () => {
    const root = await tmpProject();
    await mkdir(join(root, '.stagent', 'ledger'), { recursive: true });
    await symlink(join(root, '.stagent'), join(root, 'innocent'));
    const input = hook('Write', { file_path: 'innocent/ledger/events.jsonl' }, root);
    const c = ctx({ projectRoot: root });
    expect(decidePreToolUse(input, c)).toEqual({ decision: 'allow' }); // 不解析符号链接时看不出来
    expect(decidePreToolUse(input, { ...c, realpath: realpathNearest })).toMatchObject({
      decision: 'deny',
      path: '.stagent/ledger/events.jsonl',
    });
  });
});

describe('decidePreToolUse：Bash 与其他输入', () => {
  it('命中默认规则 → 拒绝，path 为命令，带 ruleId', () => {
    const d = decidePreToolUse(hook('Bash', { command: 'git push --force' }), ctx());
    expect(d).toMatchObject({ decision: 'deny', tool: 'Bash', path: 'git push --force', ruleId: 'git-push-force' });
  });

  it('额外配置规则', () => {
    const input = hook('Bash', { command: 'npm publish' });
    expect(decidePreToolUse(input, ctx())).toEqual({ decision: 'allow' });
    expect(decidePreToolUse(input, ctx({ extraBashRules: ['^npm publish'] }))).toMatchObject({ decision: 'deny', ruleId: 'config:0' });
  });

  it('普通命令、其他工具、非 PreToolUse 事件、残缺输入 → 放行', () => {
    expect(decidePreToolUse(hook('Bash', { command: 'npm test' }), ctx())).toEqual({ decision: 'allow' });
    expect(decidePreToolUse(hook('Read', { file_path: '.stagent/ledger/events.jsonl' }), ctx())).toEqual({ decision: 'allow' });
    expect(decidePreToolUse({ ...hook('Write', { file_path: LOCKED }), hook_event_name: 'PostToolUse' }, ctx())).toEqual({ decision: 'allow' });
    for (const bad of [null, 42, 'x', [], {}, { tool_name: 'Write' }, { tool_name: 'Write', tool_input: { file_path: 3 } }]) {
      expect(decidePreToolUse(bad, ctx())).toEqual({ decision: 'allow' });
    }
  });
});

describe('lockedCheckPaths', () => {
  it('取每个例子最近的锁定，解锁后移除', () => {
    const paths = lockedCheckPaths([
      { type: 'example.locked', exampleId: 'a', checkPath: '.stagent/checks/a.mjs', checkHash: 'h', by: 'user' },
      { type: 'example.locked', exampleId: 'b', checkPath: '.stagent/checks/b.mjs', checkHash: 'h', by: 'user' },
      { type: 'example.unlocked', exampleId: 'b', reason: '修改例子', by: 'user' },
      { type: 'example.locked', exampleId: 'a', checkPath: '.stagent/checks/./a2.mjs', checkHash: 'h2', by: 'user' },
    ]);
    expect([...paths]).toEqual(['.stagent/checks/a2.mjs']);
  });
});
