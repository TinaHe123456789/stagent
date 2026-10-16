import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, type StagentConfig } from '../../src/config/config.js';
import { writeSnapshot } from '../../src/evidence/snapshots.js';
import type { CheckSpec } from '../../src/executor/executor.js';
import { Ledger } from '../../src/ledger/index.js';
import { tmpProject } from './tmp.js';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'mini-project');
export const VITEST_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'vitest');

export function gitIn(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=stagent-test', '-c', 'user.email=test@stagent.local', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

/** 空 git 仓库（带一个初始提交）+ 账本。 */
export async function gitProject(files: Record<string, string> = { 'src/app.js': 'export const x = 1;\n' }) {
  const root = await tmpProject();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.stagent/runs/\n');
  gitIn(root, 'init', '-q', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'init');
  const ledger = await Ledger.init(root, { projectId: 'p-test' });
  return { root, ledger };
}

/** 复制最小示例项目（vitest 检查）到临时目录，git 初始化并提交，创建账本。 */
export async function fixtureProject() {
  const root = await tmpProject();
  await cp(FIXTURE_DIR, root, { recursive: true });
  await rename(join(root, 'gitignore.txt'), join(root, '.gitignore'));
  // 夹具里写的是 `vitest`，临时目录没有 node_modules，换成本仓库的绝对路径。
  const configPath = join(root, '.stagent', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { checkCommand: string };
  config.checkCommand = config.checkCommand.replace(/^vitest /, `${VITEST_BIN} `);
  await writeFile(configPath, JSON.stringify(config, null, 2));
  gitIn(root, 'init', '-q', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'fixture');
  const ledger = await Ledger.init(root, { projectId: 'p-fixture' });
  return { root, ledger };
}

/** 锁定一个例子：写快照 + example.locked，返回执行器用的 CheckSpec。 */
export async function lockExample(root: string, ledger: Ledger, exampleId: string, checkPath: string): Promise<CheckSpec> {
  const checkHash = await writeSnapshot(root, await readFile(join(root, checkPath)));
  await ledger.append({ type: 'example.locked', exampleId, checkPath, checkHash, by: 'user' });
  return { exampleId, checkPath, source: { kind: 'snapshot', checkSnapshotId: checkHash } };
}

/** 写一个检查脚本并锁定（node 直接运行，退出码即结果）。 */
export async function lockScript(root: string, ledger: Ledger, exampleId: string, source: string): Promise<CheckSpec> {
  const checkPath = `.stagent/checks/f/${exampleId}.mjs`;
  await mkdir(dirname(join(root, checkPath)), { recursive: true });
  await writeFile(join(root, checkPath), source);
  return lockExample(root, ledger, exampleId, checkPath);
}

export function nodeConfig(overrides: Record<string, unknown> = {}): StagentConfig {
  return resolveConfig({ checkCommand: 'node {path}', checkTimeoutMs: 10_000, ...overrides });
}
