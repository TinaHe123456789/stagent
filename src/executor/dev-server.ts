/**
 * 开发服务器（规格 §7）：运行前按 config.devServer 启动，健康检查 URL 返回 200 才开始检查，
 * 超时（默认 60 秒）或提前退出则本轮所有检查记为 errored。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { DevServerConfig } from '../config/config.js';
import { killGroup } from './process.js';

export interface DevServerHandle {
  stop(): Promise<void>;
}

export class DevServerError extends Error {
  override name = 'DevServerError';
}

export async function startDevServer(
  config: DevServerConfig,
  opts: { cwd: string; env: NodeJS.ProcessEnv; logPath: string; pollMs?: number; signal?: AbortSignal },
): Promise<DevServerHandle> {
  const log = createWriteStream(opts.logPath, { flags: 'a' });
  log.write(`$ ${config.command}\n`);
  const child = spawn(config.command, {
    cwd: opts.cwd,
    env: opts.env,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  let exited: string | null = null;
  child.on('error', (err) => (exited = `无法启动：${err.message}`));
  child.on('exit', (code, signal) => (exited = `进程提前退出（code ${code}, signal ${signal}）`));

  const handle: DevServerHandle = {
    stop: () => stop(child).finally(() => new Promise<void>((r) => log.end(r))),
  };

  const deadline = Date.now() + config.timeoutMs;
  const pollMs = opts.pollMs ?? 250;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      await handle.stop();
      throw new DevServerError('已取消');
    }
    if (exited) {
      await handle.stop();
      throw new DevServerError(`开发服务器${exited}`);
    }
    if (await healthy(config.url, Math.min(2000, pollMs * 4))) return handle;
    await sleep(pollMs);
  }
  await handle.stop();
  throw new DevServerError(`开发服务器 ${config.timeoutMs}ms 内未就绪（${config.url} 未返回 200）`);
}

async function healthy(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}

function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    killGroup(child);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
