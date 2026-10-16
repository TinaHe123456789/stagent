/**
 * 锁定检查快照（规格 §4.1 v2.2、§6 执行器隔离）。
 *
 * `.stagent/ledger/snapshots/<sha256>` 按内容寻址：文件名就是内容的 sha256，
 * 所以 checkSnapshotId == example.locked.checkHash。执行器只从快照还原检查，
 * 不读工作区里可能被改过的版本。快照随仓库提交，换机器也能还原。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../ledger/hash.js';
import type { Event, Sha256Hex } from '../ledger/types.js';

export const SNAPSHOTS_RELATIVE_DIR = join('.stagent', 'ledger', 'snapshots');

const SNAPSHOT_NAME = /^[0-9a-f]{64}$/;

export class SnapshotIntegrityError extends Error {
  override name = 'SnapshotIntegrityError';
  constructor(
    readonly snapshotId: Sha256Hex,
    readonly problem: 'missing' | 'tampered',
    readonly actual?: Sha256Hex,
  ) {
    super(
      problem === 'missing'
        ? `检查快照 ${snapshotId} 不存在，拒绝执行`
        : `检查快照 ${snapshotId} 内容被修改（实际 sha256 ${actual}），拒绝执行`,
    );
  }
}

export function snapshotsDir(projectRoot: string): string {
  return join(projectRoot, SNAPSHOTS_RELATIVE_DIR);
}

export function snapshotPath(projectRoot: string, snapshotId: Sha256Hex): string {
  if (!SNAPSHOT_NAME.test(snapshotId)) throw new Error(`非法快照 id：${snapshotId}`);
  return join(snapshotsDir(projectRoot), snapshotId);
}

/**
 * 写入快照并返回其 id（内容 sha256）。已存在且内容完好则不重写；
 * 已存在但被改过则用正确内容覆盖（内容寻址，正确内容是唯一的）。
 * 先写临时文件再 rename，崩溃不会留下半个快照。
 */
export async function writeSnapshot(projectRoot: string, content: Uint8Array): Promise<Sha256Hex> {
  const id = sha256Hex(content);
  const path = snapshotPath(projectRoot, id);
  const existing = await readOrNull(path);
  if (existing && sha256Hex(existing) === id) return id;
  await mkdir(snapshotsDir(projectRoot), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
  return id;
}

/** 读取快照并重算 sha256；缺失或不一致抛 SnapshotIntegrityError。 */
export async function readSnapshot(projectRoot: string, snapshotId: Sha256Hex): Promise<Buffer> {
  const content = await readOrNull(snapshotPath(projectRoot, snapshotId));
  if (content === null) throw new SnapshotIntegrityError(snapshotId, 'missing');
  const actual = sha256Hex(content);
  if (actual !== snapshotId) throw new SnapshotIntegrityError(snapshotId, 'tampered', actual);
  return content;
}

/** 账本引用的全部快照：example.locked.checkHash 与 run.completed.snapshots。 */
export function referencedSnapshots(events: Iterable<Event>): Set<Sha256Hex> {
  const refs = new Set<Sha256Hex>();
  for (const e of events) {
    if (e.type === 'example.locked') refs.add(e.checkHash);
    else if (e.type === 'run.completed') for (const id of Object.values(e.snapshots)) refs.add(id);
  }
  return refs;
}

/**
 * 启动时清理孤儿快照：账本未引用的快照（如写完快照、写 example.locked 前崩溃）与残留临时文件。
 * 返回删除的文件名。
 */
export async function cleanOrphanSnapshots(projectRoot: string, events: Iterable<Event>): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(snapshotsDir(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const refs = referencedSnapshots(events);
  const removed: string[] = [];
  for (const name of names) {
    if (SNAPSHOT_NAME.test(name) && refs.has(name)) continue;
    await rm(join(snapshotsDir(projectRoot), name), { force: true, recursive: true });
    removed.push(name);
  }
  return removed.sort();
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
