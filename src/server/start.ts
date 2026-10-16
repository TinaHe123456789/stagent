/**
 * 启动本地服务（规格 §3）：单实例锁 → 打开账本 → 从 4310 起找空闲端口 → 可选打开浏览器。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { isGitRepo } from '../git/git.js';
import { buildServer } from './http.js';
import { acquireServiceLock, type ServiceLock } from './service-lock.js';
import { StagentService } from './service.js';

export const DEFAULT_PORT = 4310;
const MAX_PORT_TRIES = 20;

export interface StartOptions {
  root: string;
  port?: number;
  host?: string;
  open?: boolean;
  serveWeb?: boolean;
  /** 监听工作区与 HEAD（默认 true）。 */
  watch?: boolean;
}

export interface RunningService {
  url: string;
  port: number;
  service: StagentService;
  app: FastifyInstance;
  close(): Promise<void>;
}

export async function startService(opts: StartOptions): Promise<RunningService> {
  if (!(await isGitRepo(opts.root))) throw new Error('当前目录不是 git 仓库，请先 git init 并运行 stagent init');
  const lock = await acquireServiceLock(opts.root);
  let app: FastifyInstance | null = null;
  let service: StagentService | null = null;
  try {
    service = await StagentService.open(opts.root);
    // 启动时补查：上次关闭后有没有在 Stagent 之外直接 git commit（§5.3）。
    await service.checkHead().catch(() => false);
    if (opts.watch !== false) await service.startWatching();
    app = await buildServer(service, { serveWeb: opts.serveWeb });
    const host = opts.host ?? '127.0.0.1';
    const port = await listenFrom(app, opts.port ?? DEFAULT_PORT, host);
    await lock.setPort(port);
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    if (opts.open) openBrowser(url);
    const running: RunningService = {
      url,
      port,
      service,
      app,
      close: () => shutdown(app!, service!, lock),
    };
    return running;
  } catch (err) {
    await service?.stopWatching();
    await app?.close();
    await lock.release();
    throw err;
  }
}

/** 从 start 起找第一个空闲端口（先用裸 socket 探测，Fastify 实例只 listen 一次）。 */
async function listenFrom(app: FastifyInstance, start: number, host: string): Promise<number> {
  for (let port = start; port < start + MAX_PORT_TRIES; port++) {
    if (await portFree(port, host)) {
      await app.listen({ port, host });
      return port;
    }
  }
  throw new Error(`端口 ${start}–${start + MAX_PORT_TRIES - 1} 都被占用`);
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function shutdown(app: FastifyInstance, service: StagentService, lock: ServiceLock): Promise<void> {
  await service.stopWatching();
  if (service.running) service.cancelRun();
  await service.waitForRun();
  await app.close();
  await lock.release();
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // 没有浏览器也不影响服务
  }
}
