/**
 * 单实例锁 .stagent/service.lock：同一个项目同一时间只允许一个 stagent 服务。
 * 锁文件记录 pid 与端口；持有进程已退出则视为陈旧锁并接管。
 */
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const SERVICE_LOCK_RELATIVE_PATH = join('.stagent', 'service.lock');

export interface ServiceLockInfo {
  pid: number;
  port: number | null;
  startedAt: string;
}

export class ServiceAlreadyRunningError extends Error {
  override name = 'ServiceAlreadyRunningError';
  constructor(readonly info: ServiceLockInfo) {
    super(
      `本项目已有 stagent 服务在运行（pid ${info.pid}${info.port ? `，http://localhost:${info.port}` : ''}）`,
    );
  }
}

export interface ServiceLock {
  /** 端口确定后写回锁文件。 */
  setPort(port: number): Promise<void>;
  release(): Promise<void>;
}

export async function acquireServiceLock(projectRoot: string): Promise<ServiceLock> {
  const path = join(projectRoot, SERVICE_LOCK_RELATIVE_PATH);
  const info: ServiceLockInfo = { pid: process.pid, port: null, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, 'wx');
      await fh.writeFile(JSON.stringify(info));
      await fh.close();
      return {
        async setPort(port) {
          info.port = port;
          const h = await open(path, 'w');
          await h.writeFile(JSON.stringify(info));
          await h.close();
        },
        async release() {
          const current = await readInfo(path);
          if (current?.pid === process.pid) await rm(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readInfo(path);
      if (holder && holder.pid !== process.pid && isAlive(holder.pid)) throw new ServiceAlreadyRunningError(holder);
      await rm(path, { force: true }); // 陈旧锁
    }
  }
  throw new Error('无法获取服务锁');
}

async function readInfo(path: string): Promise<ServiceLockInfo | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ServiceLockInfo;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
