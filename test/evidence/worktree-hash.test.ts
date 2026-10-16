import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { computeWorkTreeHash, pathFilter, workTreeHashSpec } from '../../src/evidence/worktree-hash.js';
import { gitIn, gitProject } from '../helpers/project.js';

const defaults = { ignoreGlobs: DEFAULT_CONFIG.evidence.ignoreGlobs };

async function project() {
  return gitProject({
    'src/app.js': 'export const x = 1;\n',
    'README.md': '# app\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'docs/guide.md': 'guide\n',
  });
}

async function hash(root: string, ignoreGlobs = defaults.ignoreGlobs) {
  return (await computeWorkTreeHash(root, { ignoreGlobs })).workTreeHash;
}

describe('workTreeHash（验收 #24 哈希部分）', () => {
  it('同一工作区两次计算结果一致', async () => {
    const { root } = await project();
    expect(await hash(root)).toBe(await hash(root));
  });

  it('只改 README（默认 ignoreGlobs 豁免 *.md）不改变哈希', async () => {
    const { root } = await project();
    const before = await hash(root);
    await writeFile(join(root, 'README.md'), '# app\n\n更多说明\n');
    await writeFile(join(root, 'docs/guide.md'), 'changed\n');
    expect(await hash(root)).toBe(before);
  });

  it('改依赖锁文件会改变哈希', async () => {
    const { root } = await project();
    const before = await hash(root);
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"x":{}}}\n');
    expect(await hash(root)).not.toBe(before);
  });

  it('改源码、加未跟踪文件、删已跟踪文件都会改变哈希', async () => {
    const { root } = await project();
    const h0 = await hash(root);
    await writeFile(join(root, 'src/app.js'), 'export const x = 2;\n');
    const h1 = await hash(root);
    expect(h1).not.toBe(h0);
    await writeFile(join(root, 'src/new.js'), 'new\n');
    const h2 = await hash(root);
    expect(h2).not.toBe(h1);
    await rm(join(root, 'src/new.js'));
    expect(await hash(root)).toBe(h1);
    await rm(join(root, 'src/app.js'));
    const entries = (await computeWorkTreeHash(root, defaults)).entries;
    expect(entries.find((e) => e.path === 'src/app.js')?.kind).toBe('deleted');
    expect(await hash(root)).not.toBe(h1);
  });

  it('.gitignore 忽略的文件不参与', async () => {
    const { root } = await project();
    const before = await hash(root);
    await mkdir(join(root, 'node_modules/x'), { recursive: true });
    await writeFile(join(root, 'node_modules/x/index.js'), 'x\n');
    expect(await hash(root)).toBe(before);
  });

  it('可执行位与符号链接参与', async () => {
    const { root } = await project();
    const h0 = await hash(root);
    await chmod(join(root, 'src/app.js'), 0o755);
    const h1 = await hash(root);
    expect(h1).not.toBe(h0);
    await symlink('app.js', join(root, 'src/link.js'));
    const entries = (await computeWorkTreeHash(root, defaults)).entries;
    expect(entries.find((e) => e.path === 'src/link.js')?.kind).toBe('symlink');
    expect(await hash(root)).not.toBe(h1);
  });

  it('提交本身不改变哈希（哈希只看工作区内容，提交变化由 commit 字段记录）', async () => {
    const { root } = await project();
    await writeFile(join(root, 'src/app.js'), 'export const x = 3;\n');
    const before = await hash(root);
    gitIn(root, 'commit', '-qam', 'x');
    expect(await hash(root)).toBe(before);
  });
});

describe('workTreeHashSpec 与豁免规则', () => {
  it('改 ignoreGlobs 会改变 spec 与哈希', async () => {
    const { root } = await project();
    expect(workTreeHashSpec(['**/*.md'])).not.toBe(workTreeHashSpec(['**/*.md', 'docs/**']));
    expect(await hash(root, ['**/*.md'])).not.toBe(await hash(root, []));
  });

  it('ignoreGlobs 的顺序与重复不影响 spec', () => {
    expect(workTreeHashSpec(['a/**', 'b/**', 'a/**'])).toBe(workTreeHashSpec(['b/**', 'a/**']));
  });

  it('.stagent/checks/** 与 config.json 不可豁免', async () => {
    const include = pathFilter(['.stagent/**', '**/*']);
    expect(include('.stagent/checks/login/a.spec.ts')).toBe(true);
    expect(include('.stagent/config.json')).toBe(true);
    expect(include('src/app.js')).toBe(false);

    const { root } = await project();
    await mkdir(join(root, '.stagent/checks/f'), { recursive: true });
    await writeFile(join(root, '.stagent/checks/f/a.md'), 'check v1\n');
    const before = await hash(root, ['.stagent/**', '**/*.md']);
    await writeFile(join(root, '.stagent/checks/f/a.md'), 'check v2\n');
    expect(await hash(root, ['.stagent/**', '**/*.md'])).not.toBe(before);
  });
});

describe('账本自身不使证据过期（验收 #25 哈希部分）', () => {
  it('追加事件、写快照、写运行产物都不改变哈希', async () => {
    const { root, ledger } = await project();
    const before = await hash(root);
    await ledger.append({ type: 'feature.created', featureId: 'f1', name: '登录', origin: 'new' });
    await mkdir(join(root, '.stagent/ledger/snapshots'), { recursive: true });
    await writeFile(join(root, '.stagent/ledger/snapshots/' + 'a'.repeat(64)), 'x');
    await mkdir(join(root, '.stagent/docs'), { recursive: true });
    await writeFile(join(root, '.stagent/docs/features.md'), '# features\n');
    expect(await hash(root)).toBe(before);
    // 即使用户把 events.jsonl 提交进仓库也一样。
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'ledger');
    await ledger.append({ type: 'feature.created', featureId: 'f2', name: '注册', origin: 'new' });
    expect(await hash(root)).toBe(before);
  });
});
