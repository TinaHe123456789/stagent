import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireServiceLock, ServiceAlreadyRunningError, SERVICE_LOCK_RELATIVE_PATH } from '../../src/server/service-lock.js';
import { startService, type RunningService } from '../../src/server/start.js';
import { gitProject } from '../helpers/project.js';
import { tmpProject } from '../helpers/tmp.js';

const running: RunningService[] = [];
const blockers: Server[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
  await Promise.all(blockers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function occupy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => {
      blockers.push(s);
      resolve(true);
    });
  });
}

describe('本地服务启动', () => {
  it('从指定端口起找空闲端口；写 service.lock；同一项目第二个实例被拒绝', async () => {
    const base = 45000 + Math.floor(Math.random() * 1000);
    await occupy(base);
    const { root } = await gitProject();
    const r = await startService({ root, port: base, serveWeb: false });
    running.push(r);
    expect(r.port).toBeGreaterThan(base);
    const lock = JSON.parse(await readFile(join(root, SERVICE_LOCK_RELATIVE_PATH), 'utf8')) as { pid: number; port: number };
    expect(lock).toMatchObject({ pid: process.pid, port: r.port });
    const res = await fetch(`${r.url}/api/overview`);
    expect(res.status).toBe(200);

    // 锁文件指向另一个存活进程（用父进程 pid 模拟）→ 拒绝启动
    await writeFile(join(root, SERVICE_LOCK_RELATIVE_PATH), JSON.stringify({ pid: process.ppid, port: r.port, startedAt: '' }));
    await expect(startService({ root, port: base, serveWeb: false })).rejects.toBeInstanceOf(ServiceAlreadyRunningError);
  });

  it('陈旧锁（进程已退出）被接管；关闭后释放锁', async () => {
    const root = await tmpProject();
    await mkdir(join(root, '.stagent'), { recursive: true });
    await writeFile(join(root, SERVICE_LOCK_RELATIVE_PATH), JSON.stringify({ pid: 999_999_9, port: 1, startedAt: '' }));
    const lock = await acquireServiceLock(root);
    await lock.release();
    await expect(readFile(join(root, SERVICE_LOCK_RELATIVE_PATH))).rejects.toThrow();
  });

  it('不是 git 仓库时拒绝启动', async () => {
    await expect(startService({ root: await tmpProject(), serveWeb: false })).rejects.toThrow(/git/);
  });
});
