/**
 * 最小 Git 适配：M1-2 只需要 HEAD 与文件清单。
 * 完整的 Git 适配器（基准、diff、合并，simple-git）在 M2 加入。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 仓库还没有任何提交时的 HEAD 占位。 */
export const UNBORN_COMMIT = 'unborn';

export class GitError extends Error {
  override name = 'GitError';
}

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new GitError(`git ${args.join(' ')} 失败：${(e.stderr ?? e.message).trim()}`);
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** 当前 HEAD 提交；没有提交时返回 UNBORN_COMMIT。 */
export async function headCommit(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim() || UNBORN_COMMIT;
  } catch {
    return UNBORN_COMMIT;
  }
}

/** 以 NUL 分隔的 git 输出拆成路径列表。 */
export function splitNul(out: string): string[] {
  return out.split('\0').filter((p) => p !== '');
}

/** a 是否是 b 的祖先（含相等）。 */
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}
