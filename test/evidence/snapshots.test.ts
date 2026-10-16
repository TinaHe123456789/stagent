import { readdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  SnapshotIntegrityError,
  cleanOrphanSnapshots,
  readSnapshot,
  snapshotPath,
  snapshotsDir,
  writeSnapshot,
} from '../../src/evidence/snapshots.js';
import { sha256Hex } from '../../src/ledger/hash.js';
import type { Event } from '../../src/ledger/types.js';
import { tmpProject } from '../helpers/tmp.js';

describe('检查快照', () => {
  it('按内容寻址：id == sha256(内容)，读回时重算校验', async () => {
    const root = await tmpProject();
    const content = Buffer.from('test("x", () => {})\n');
    const id = await writeSnapshot(root, content);
    expect(id).toBe(sha256Hex(content));
    expect((await readSnapshot(root, id)).equals(content)).toBe(true);
    expect(await writeSnapshot(root, content)).toBe(id);
  });

  it('被篡改或缺失时拒绝读取', async () => {
    const root = await tmpProject();
    const id = await writeSnapshot(root, Buffer.from('original'));
    await writeFile(snapshotPath(root, id), 'tampered');
    await expect(readSnapshot(root, id)).rejects.toMatchObject({ name: 'SnapshotIntegrityError', problem: 'tampered' });
    await expect(readSnapshot(root, 'b'.repeat(64))).rejects.toBeInstanceOf(SnapshotIntegrityError);
  });

  it('重新写入会修复被篡改的快照', async () => {
    const root = await tmpProject();
    const id = await writeSnapshot(root, Buffer.from('original'));
    await writeFile(snapshotPath(root, id), 'tampered');
    await writeSnapshot(root, Buffer.from('original'));
    expect((await readSnapshot(root, id)).toString()).toBe('original');
  });

  it('拒绝非法 id（防路径穿越）', () => {
    expect(() => snapshotPath('/tmp', '../x')).toThrow(/非法快照/);
  });

  it('启动清理：删除未被 example.locked / run.completed 引用的快照与临时文件', async () => {
    const root = await tmpProject();
    const locked = await writeSnapshot(root, Buffer.from('locked'));
    const ran = await writeSnapshot(root, Buffer.from('red check draft'));
    const orphan = await writeSnapshot(root, Buffer.from('orphan'));
    await writeFile(`${snapshotPath(root, orphan)}.tmp-abc`, 'half');
    const events: Event[] = [
      { type: 'example.locked', exampleId: 'e1', checkPath: 'c', checkHash: locked, by: 'user' },
      {
        type: 'run.completed', runId: 'r', purpose: 'red_check', startCommit: 'a', endCommit: 'a',
        startWorkTreeHash: 'h', endWorkTreeHash: 'h', workTreeHashSpec: 's', valid: true,
        snapshots: { e2: ran }, results: [], commit: 'a', workTreeHash: 'h',
      },
    ];
    const removed = await cleanOrphanSnapshots(root, events);
    expect(removed).toEqual([orphan, `${orphan}.tmp-abc`].sort());
    expect((await readdir(snapshotsDir(root))).sort()).toEqual([locked, ran].sort());
  });

  it('没有快照目录时清理不报错', async () => {
    expect(await cleanOrphanSnapshots(await tmpProject(), [])).toEqual([]);
  });
});
