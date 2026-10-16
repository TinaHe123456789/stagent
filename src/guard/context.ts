/**
 * 守卫判定所需的上下文：锁定检查路径、项目根目录、符号链接解析。
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import type { Event } from '../ledger/types.js';

/** 当前锁定的检查路径：每个例子最近一次 example.locked，且之后没有 example.unlocked（/ 分隔）。 */
export function lockedCheckPaths(events: readonly Event[]): Set<string> {
  const byExample = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'example.locked') byExample.set(e.exampleId, e.checkPath);
    else if (e.type === 'example.unlocked') byExample.delete(e.exampleId);
  }
  return new Set([...byExample.values()].map((p) => normalize(p).split(sep).join('/')));
}

/** 从 start 向上找第一个含 .stagent/ 的目录；找不到返回 null。 */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.stagent'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 真实路径：路径本身可能还不存在（Write 新文件），所以解析最近的已存在祖先，再接上剩余部分。
 * 用来识别 `ln -s .stagent x` 之后写 `x/ledger/events.jsonl` 这类绕过。
 */
export function realpathNearest(absPath: string): string {
  const rest: string[] = [];
  let dir = resolve(absPath);
  for (;;) {
    try {
      return join(realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return resolve(absPath);
      rest.push(basename(dir));
      dir = parent;
    }
  }
}
