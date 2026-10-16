import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/config.js';
import { HOOK_COMMAND, HOOK_MATCHER, PRE_MERGE_MARKER } from '../../src/guard/install.js';
import { initProject } from '../../src/init/init.js';
import { gitIn } from '../helpers/project.js';
import { tmpProject } from '../helpers/tmp.js';

async function repo() {
  const root = await tmpProject();
  gitIn(root, 'init', '-q', '-b', 'main');
  return root;
}

const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('init：Claude Code PreToolUse hook', () => {
  it('新建 .claude/settings.json 并写入 hook', async () => {
    const root = await repo();
    const r = await initProject(root);
    expect(r.hooksInstalled).toBe(true);
    expect(r.created).toContain('.claude/settings.json');
    const s = await readJson(join(root, '.claude/settings.json'));
    expect(s).toEqual({ hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } });
  });

  it('合并进已有 settings.json：保留其他键与别的 hook，重复运行不重复添加', async () => {
    const root = await repo();
    await mkdir(join(root, '.claude'));
    const foreign = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] }],
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier' }] }],
      },
    };
    await writeFile(join(root, '.claude/settings.json'), JSON.stringify(foreign));
    const first = await initProject(root);
    expect(first.hooksInstalled).toBe(true);
    expect(first.created).not.toContain('.claude/settings.json');
    const second = await initProject(root);
    expect(second.hooksInstalled).toBe(false);

    const s = await readJson(join(root, '.claude/settings.json'));
    expect(s.permissions).toEqual(foreign.permissions);
    expect(s.hooks.PostToolUse).toEqual(foreign.hooks.PostToolUse);
    expect(s.hooks.PreToolUse).toEqual([
      foreign.hooks.PreToolUse[0],
      { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] },
    ]);
  });

  it('settings.json 不是合法 JSON → 不覆盖，给出警告', async () => {
    const root = await repo();
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/settings.json'), '{ broken');
    const r = await initProject(root);
    expect(r.hooksInstalled).toBe(false);
    expect(r.warnings.some((w) => w.includes('settings.json'))).toBe(true);
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe('{ broken');
  });
});

describe('init：.git/hooks/pre-merge-commit 合并提醒', () => {
  const hookPath = (root: string) => join(root, '.git/hooks/pre-merge-commit');

  it('安装可执行的提醒脚本，只提醒不阻止（exit 0），重复运行不变', async () => {
    const root = await repo();
    expect((await initProject(root)).preMergeReminder).toBe('installed');
    const text = await readFile(hookPath(root), 'utf8');
    expect(text).toContain(PRE_MERGE_MARKER);
    expect(text.trimEnd().endsWith('exit 0')).toBe(true);
    expect((await stat(hookPath(root))).mode & 0o111).not.toBe(0);
    expect((await initProject(root)).preMergeReminder).toBe('unchanged');
  });

  it('合并时真的只提醒：git merge 成功并在 stderr 里提示通过 Stagent 合并', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.txt'), 'a\n');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-q', '-m', 'a');
    await initProject(root);
    gitIn(root, 'checkout', '-q', '-b', 'feat');
    await writeFile(join(root, 'b.txt'), 'b\n');
    gitIn(root, 'add', 'b.txt');
    gitIn(root, 'commit', '-q', '-m', 'b');
    gitIn(root, 'checkout', '-q', 'main');
    await writeFile(join(root, 'c.txt'), 'c\n');
    gitIn(root, 'add', 'c.txt');
    gitIn(root, 'commit', '-q', '-m', 'c');
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-edit', 'feat'], { cwd: root, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Stagent');
  });

  it('已有别人的 pre-merge-commit → 跳过并警告，不覆盖', async () => {
    const root = await repo();
    await writeFile(hookPath(root), '#!/bin/sh\necho mine\n');
    const r = await initProject(root);
    expect(r.preMergeReminder).toBe('skipped');
    expect(r.warnings.some((w) => w.includes('pre-merge-commit'))).toBe(true);
    expect(await readFile(hookPath(root), 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('guard.preMergeReminder=false → 不安装，并移除自己装过的', async () => {
    const root = await repo();
    await initProject(root);
    const configPath = join(root, '.stagent/config.json');
    const config = await readJson(configPath);
    await writeFile(configPath, JSON.stringify({ ...config, guard: { preMergeReminder: false } }));
    expect((await initProject(root)).preMergeReminder).toBe('removed');
    await expect(stat(hookPath(root))).rejects.toThrow();
    expect((await initProject(root)).preMergeReminder).toBe('disabled');
  });

  it('不是 git 仓库 → 不安装', async () => {
    expect((await initProject(await tmpProject())).preMergeReminder).toBe('no-git');
  });
});

describe('config.guard.preMergeReminder', () => {
  it('默认 true，可设为 false，非布尔值报错', () => {
    expect(resolveConfig({}).guard).toEqual({ bashRules: [], preMergeReminder: true });
    expect(resolveConfig({ guard: { preMergeReminder: false } }).guard.preMergeReminder).toBe(false);
    expect(() => resolveConfig({ guard: { preMergeReminder: 'no' } })).toThrow('guard.preMergeReminder');
  });
});
