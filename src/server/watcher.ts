/**
 * 工作区监听（§5.3）：chokidar 监听项目目录，最后一次变化后静止 debounceMs（默认 2 秒）才回调；
 * 另外定时轮询 HEAD，发现在 Stagent 之外的 git commit。
 *
 * 这里只负责"有动静"，是否真的算改动由服务端用 workTreeHash 判断（被 .gitignore 忽略的文件不算）。
 */
import { watch, type FSWatcher } from 'chokidar';
import { relative, sep } from 'node:path';

/** 不监听的目录：版本库、依赖、构建产物，以及 stagent 自己写的运行产物与账本。 */
const IGNORED_PREFIXES = ['.git', 'node_modules', '.stagent/runs', '.stagent/ledger', 'dist', '.next', 'coverage'];

export interface WatcherOptions {
  debounceMs: number;
  onSettled: () => Promise<unknown>;
  onHeadPoll?: () => Promise<unknown>;
  headPollMs?: number;
}

export class WorkspaceWatcher {
  private fsw: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly opts: WatcherOptions,
  ) {}

  async start(): Promise<void> {
    this.fsw = watch(this.root, {
      ignoreInitial: true,
      ignored: (path) => isIgnored(this.root, path),
      awaitWriteFinish: false,
    });
    this.fsw.on('all', () => this.bump());
    await new Promise<void>((resolve) => this.fsw!.once('ready', () => resolve()));
    if (this.opts.onHeadPoll) {
      this.poller = setInterval(() => void this.opts.onHeadPoll!().catch(() => undefined), this.opts.headPollMs ?? 3000);
      this.poller.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.poller) clearInterval(this.poller);
    await this.fsw?.close();
    this.fsw = null;
  }

  private bump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.opts.onSettled().catch(() => undefined);
    }, this.opts.debounceMs);
    this.timer.unref();
  }
}

export function isIgnored(root: string, path: string): boolean {
  const rel = relative(root, path).split(sep).join('/');
  if (rel === '' || rel.startsWith('..')) return false;
  return IGNORED_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`));
}
