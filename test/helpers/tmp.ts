import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const dirs: string[] = [];

/** 每个测试一个临时项目根目录，测试结束后删除。 */
export async function tmpProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stagent-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
