import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectStack, initProject } from '../../src/init/init.js';
import { Ledger } from '../../src/ledger/index.js';
import { gitIn } from '../helpers/project.js';
import { tmpProject } from '../helpers/tmp.js';

async function repo(files: Record<string, string> = {}) {
  const root = await tmpProject();
  gitIn(root, 'init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) await writeFile(join(root, p), c);
  return root;
}

describe('stagent init', () => {
  it('创建 .stagent/、账本 meta 行、config.json 草稿与 .gitignore 条目', async () => {
    const root = await repo({ '.gitignore': 'node_modules/' });
    const r = await initProject(root);
    expect(r.created).toEqual(expect.arrayContaining(['.stagent/ledger/', '.stagent/checks/', '.stagent/ledger/events.jsonl', '.stagent/config.json']));
    expect(r.warnings).toEqual([]);
    const ledger = await Ledger.open(root);
    expect(ledger.events()[0]).toMatchObject({ type: 'ledger.meta', ledgerVersion: 3, projectId: r.projectId });
    const gi = await readFile(join(root, '.gitignore'), 'utf8');
    expect(gi).toBe('node_modules/\n# stagent\n.stagent/runs/\n.stagent/service.lock\n');
    const config = JSON.parse(await readFile(join(root, '.stagent/config.json'), 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({ checkCommand: 'npx playwright test {path}', devServer: null });
  });

  it('再次运行不覆盖任何文件', async () => {
    const root = await repo();
    const first = await initProject(root);
    await writeFile(join(root, '.stagent/config.json'), '{"checkCommand":"custom {path}"}');
    const second = await initProject(root);
    expect(second.created).toEqual([]);
    expect(second.gitignoreAdded).toEqual([]);
    expect(second.projectId).toBe(first.projectId);
    expect(second.config).toEqual({ checkCommand: 'custom {path}' });
  });

  it('检测技术栈：Next.js + Playwright → 开发服务器 3000；Vite + vitest → 5173', async () => {
    const next = await repo({
      'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15' }, devDependencies: { '@playwright/test': '1' } }),
    });
    expect(await detectStack(next)).toEqual({ framework: 'next', testRunner: 'playwright' });
    expect((await initProject(next)).config).toMatchObject({
      checkCommand: 'npx playwright test {path}',
      devServer: { command: 'npm run dev', url: 'http://localhost:3000' },
    });
    const vite = await repo({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6', vitest: '3' } }) });
    expect((await initProject(vite)).config).toMatchObject({
      checkCommand: 'npx vitest run {path}',
      devServer: { url: 'http://localhost:5173' },
    });
    const py = await repo({ 'pyproject.toml': '' });
    expect(await detectStack(py)).toEqual({ framework: 'python', testRunner: 'pytest' });
  });

  it('不是 git 仓库时给出警告', async () => {
    const r = await initProject(await tmpProject());
    expect(r.warnings[0]).toContain('git');
  });
});
