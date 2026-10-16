/**
 * 子进程执行：shell 运行命令、输出写日志、超时整组杀掉。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';

export interface CommandResult {
  /** 进程退出码；被信号杀死或未能启动时为 null。 */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** 进程未能启动（如 shell 不存在）。 */
  spawnError: Error | null;
  durationMs: number;
}

export interface RunCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 在 shell 中运行命令，stdout/stderr 合并写入 logPath。超时或取消时杀掉整个进程组。 */
export function runCommand(command: string, opts: RunCommandOptions): Promise<CommandResult> {
  const started = Date.now();
  const log = createWriteStream(opts.logPath, { flags: 'a' });
  log.write(`$ ${command}\n`);
  return new Promise((resolve) => {
    let timedOut = false;
    let aborted = false;
    let spawnError: Error | null = null;
    let child: ChildProcess;
    try {
      child = spawn(command, { cwd: opts.cwd, env: opts.env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish(log, () =>
        resolve({ exitCode: null, signal: null, timedOut, aborted, spawnError: err as Error, durationMs: Date.now() - started }),
      );
      return;
    }
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    const timer = setTimeout(() => {
      timedOut = true;
      log.write(`\n[stagent] 超时（${opts.timeoutMs}ms），终止进程\n`);
      killGroup(child);
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      log.write('\n[stagent] 已取消，终止进程\n');
      killGroup(child);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      finish(log, () =>
        resolve({ exitCode: code, signal, timedOut, aborted, spawnError, durationMs: Date.now() - started }),
      );
    });
  });
}

/** 先 SIGTERM 整个进程组，2 秒后仍在则 SIGKILL。 */
export function killGroup(child: ChildProcess, graceMs = 2000): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  signalGroup(pid, 'SIGTERM');
  const t = setTimeout(() => signalGroup(pid, 'SIGKILL'), graceMs);
  t.unref();
  child.once('exit', () => clearTimeout(t));
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // 已退出
    }
  }
}

function finish(log: WriteStream, done: () => void): void {
  log.end(done);
}

/** POSIX shell 单引号转义。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
