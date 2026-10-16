/**
 * workTreeHash（规格 §4.1 v2.2）：一次运行"看到的是哪份代码"的指纹。
 *
 * - 文件集合：git 跟踪的文件 + 未被 .gitignore 忽略的未跟踪文件（`git ls-files -co --exclude-standard`），
 *   以及已跟踪但在工作区被删除的文件。
 * - 固定排除清单：账本本身（events.jsonl）、快照、运行产物、生成文档等——它们由 stagent 写入，
 *   不代表代码变化，否则每追加一个事件证据就过期（验收 #25）。
 * - config.evidence.ignoreGlobs：用户豁免的文件（如 README），改动不使证据过期（验收 #24）。
 *   NON_IGNORABLE 中的路径（锁定检查、配置）无论 ignoreGlobs 怎么写都参与哈希。
 * - 每个条目按类型计算 entryHash；workTreeHash = sha256(specHash + 排序后的 "path\0entryHash\n")。
 * - workTreeHashSpec = sha256(JCS(规则本身))；规则（含 ignoreGlobs）一变，spec 就变，新旧哈希不可比较。
 */
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { git, splitNul } from '../git/git.js';
import { canonicalize } from '../ledger/jcs.js';
import { sha256Hex } from '../ledger/hash.js';
import type { Sha256Hex } from '../ledger/types.js';

export const WORKTREE_HASH_VERSION = 1;

/** 由 stagent 自己写入、永不参与哈希的路径。 */
export const FIXED_EXCLUDES: readonly string[] = [
  '.stagent/ledger/events.jsonl',
  '.stagent/ledger/snapshots/**',
  '.stagent/runs/**',
  '.stagent/docs/**',
  '.stagent/service.lock',
];

/** 不可被 ignoreGlobs 豁免的路径。 */
export const NON_IGNORABLE: readonly string[] = ['.stagent/checks/**', '.stagent/config.json'];

export type EntryKind = 'file' | 'symlink' | 'deleted' | 'gitlink';

export interface WorkTreeEntry {
  path: string;
  kind: EntryKind;
  entryHash: Sha256Hex;
}

export interface WorkTreeHashResult {
  workTreeHash: Sha256Hex;
  workTreeHashSpec: Sha256Hex;
  entries: WorkTreeEntry[];
}

export interface WorkTreeHashOptions {
  ignoreGlobs?: readonly string[];
}

const GLOB_OPTS = { dot: true } as const;

export function workTreeHashSpec(ignoreGlobs: readonly string[] = []): Sha256Hex {
  return sha256Hex(canonicalize(specObject(ignoreGlobs)));
}

function specObject(ignoreGlobs: readonly string[]) {
  return {
    version: WORKTREE_HASH_VERSION,
    fileSet: 'git ls-files -co --exclude-standard + deleted',
    excludes: [...FIXED_EXCLUDES],
    nonIgnorable: [...NON_IGNORABLE],
    ignoreGlobs: [...new Set(ignoreGlobs)].sort(),
    entry: {
      file: 'sha256("file\\0" + mode + "\\0" + sha256(content))',
      symlink: 'sha256("symlink\\0" + target)',
      deleted: 'sha256("deleted")',
      gitlink: 'sha256("gitlink\\0" + HEAD)',
    },
  };
}

/** 判断路径是否参与哈希（路径为项目根目录下的 POSIX 相对路径）。 */
export function pathFilter(ignoreGlobs: readonly string[] = []): (path: string) => boolean {
  const excluded = picomatch([...FIXED_EXCLUDES], GLOB_OPTS);
  const protectedPath = picomatch([...NON_IGNORABLE], GLOB_OPTS);
  const ignored = ignoreGlobs.length > 0 ? picomatch([...ignoreGlobs], GLOB_OPTS) : () => false;
  return (path) => {
    if (excluded(path)) return false;
    if (protectedPath(path)) return true;
    return !ignored(path);
  };
}

export async function computeWorkTreeHash(
  projectRoot: string,
  options: WorkTreeHashOptions = {},
): Promise<WorkTreeHashResult> {
  const ignoreGlobs = options.ignoreGlobs ?? [];
  const spec = workTreeHashSpec(ignoreGlobs);
  const include = pathFilter(ignoreGlobs);

  // -c 跟踪 + -o 未跟踪（排除 .gitignore），--deduplicate 去掉冲突状态下的重复项。
  const listed = splitNul(
    await git(projectRoot, ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--deduplicate']),
  );
  const paths = [...new Set(listed.map((p) => p.replace(/\/$/, '')))].filter(include).sort(compareCodeUnits);

  const entries: WorkTreeEntry[] = [];
  for (const path of paths) entries.push(await entryFor(projectRoot, path));

  const body = entries.map((e) => `${e.path}\0${e.entryHash}\n`).join('');
  return { workTreeHash: sha256Hex(`${spec}\n${body}`), workTreeHashSpec: spec, entries };
}

async function entryFor(projectRoot: string, path: string): Promise<WorkTreeEntry> {
  const abs = join(projectRoot, path);
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, kind: 'deleted', entryHash: sha256Hex('deleted') };
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    return { path, kind: 'symlink', entryHash: sha256Hex(`symlink\0${await readlink(abs)}`) };
  }
  if (st.isDirectory()) {
    // 子模块（gitlink）或未跟踪的嵌套仓库：用它的 HEAD 代表内容。
    let head = 'unknown';
    try {
      head = (await git(abs, ['rev-parse', 'HEAD'])).trim();
    } catch {
      // 没有提交的嵌套仓库
    }
    return { path, kind: 'gitlink', entryHash: sha256Hex(`gitlink\0${head}`) };
  }
  const mode = st.mode & 0o111 ? '755' : '644';
  const contentHash = sha256Hex(await readFile(abs));
  return { path, kind: 'file', entryHash: sha256Hex(`file\0${mode}\0${contentHash}`) };
}

/** 按 UTF-16 码元排序，与 JCS 键排序一致，且不受区域设置影响。 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
