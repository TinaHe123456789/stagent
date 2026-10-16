#!/usr/bin/env node
/**
 * stagent CLI 入口（npx stagent）。
 *
 * 无参数时在当前目录启动本地服务（§3、D4）；hook pre-tool-use 是 Claude Code 的 PreToolUse 守卫（M2-1）。
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreToolUseHook } from '../guard/hook-cli.js';
import { initProject } from '../init/init.js';
import { Ledger, LedgerMissingError, LedgerVersionError, type VerifyReport } from '../ledger/index.js';
import { ServiceAlreadyRunningError } from '../server/service-lock.js';
import { DEFAULT_PORT, startService } from '../server/start.js';

export const EXIT = { ok: 0, error: 1, locked: 2, version: 3 } as const;

const HELP = `用法：stagent [命令] [选项]

命令：
  （无）/ serve                 启动本地服务并打开浏览器（默认端口 ${DEFAULT_PORT} 起）
  init                          在项目中初始化 .stagent/、账本、config.json 草稿与 .gitignore
  ledger verify                 校验 .stagent/ledger/events.jsonl 的事件链
  ledger accept --reason <原因>  账本被修改时"我确认，接受当前状态"（原因至少 4 个字）
  hook pre-tool-use             Claude Code PreToolUse 守卫：从 stdin 读工具调用，命中规则时输出拒绝（由 init 写入 .claude/settings.json）

选项：
  --root <目录>   项目根目录（默认当前目录）
  --port <端口>   服务起始端口（被占用时自动递增）
  --host <地址>   服务监听地址（默认 127.0.0.1）
  --no-open       启动服务时不打开浏览器
  -v, --version   显示版本
  -h, --help      显示帮助
`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  /** 读取全部标准输入（hook 命令用）；默认读 process.stdin。 */
  readStdin?: () => Promise<string>;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const args = [...argv];
  const rootOption = takeOption(args, '--root');
  const root = resolve(rootOption ?? process.cwd());
  const reason = takeOption(args, '--reason');
  const port = takeOption(args, '--port');
  const host = takeOption(args, '--host');
  const noOpen = takeFlag(args, '--no-open');

  if (args.includes('-v') || args.includes('--version')) {
    io.out(version());
    return EXIT.ok;
  }
  const [cmd, sub] = args;
  if (cmd === 'help' || args.includes('-h') || args.includes('--help')) {
    io.out(HELP);
    return EXIT.ok;
  }

  try {
    if (!cmd || cmd === 'serve') {
      const running = await startService({
        root,
        port: port ? Number(port) : undefined,
        host,
        open: !noOpen,
      });
      io.out(`Stagent 已启动：${running.url}（Ctrl+C 退出）`);
      await new Promise<void>((resolve) => {
        const stop = () => void running.close().then(resolve);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return EXIT.ok;
    }
    if (cmd === 'init') {
      const r = await initProject(root);
      io.out(
        [
          `✅ 已初始化 Stagent（projectId ${r.projectId}）`,
          r.created.length ? `新建：${r.created.join('、')}` : '已存在，未覆盖任何文件',
          r.gitignoreAdded.length ? `.gitignore 新增：${r.gitignoreAdded.join('、')}` : '',
          r.hooksInstalled ? '已写入 Claude Code 守卫 hook（.claude/settings.json）' : '',
          r.preMergeReminder === 'installed' ? '已安装合并提醒 .git/hooks/pre-merge-commit（只提醒，不阻止）' : '',
          r.preMergeReminder === 'removed' ? '已按配置移除合并提醒 .git/hooks/pre-merge-commit' : '',
          `检测到：${r.detected.framework} / ${r.detected.testRunner}；检查命令：${String(r.config.checkCommand)}`,
          ...r.warnings.map((w) => `⚠️ ${w}`),
          '下一步：运行 stagent 启动服务',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return EXIT.ok;
    }
    if (cmd === 'hook' && sub === 'pre-tool-use') {
      const r = await runPreToolUseHook({ stdin: await (io.readStdin ?? readProcessStdin)(), root: rootOption ? root : undefined });
      if (r.stdout) io.out(r.stdout);
      if (r.stderr) io.err(r.stderr);
      return r.exitCode;
    }
    if (cmd === 'ledger' && sub === 'verify') {
      const ledger = await Ledger.open(root);
      io.out(describe(ledger.report));
      return ledger.state === 'locked' ? EXIT.locked : EXIT.ok;
    }
    if (cmd === 'ledger' && sub === 'accept') {
      if (!reason) {
        io.err('缺少 --reason');
        return EXIT.error;
      }
      const ledger = await Ledger.open(root);
      const line = await ledger.acceptCurrentState(reason);
      io.out(`已记录 ledger.integrity_override（第 ${line.seq} 行），账本恢复可写`);
      return EXIT.ok;
    }
  } catch (err) {
    if (err instanceof LedgerVersionError) {
      io.err(err.message);
      return EXIT.version;
    }
    if (err instanceof ServiceAlreadyRunningError) {
      io.err(err.message);
      return EXIT.error;
    }
    if (err instanceof LedgerMissingError) {
      io.err(err.message);
      return EXIT.error;
    }
    io.err(err instanceof Error ? err.message : String(err));
    return EXIT.error;
  }

  io.err(`未知命令：${args.join(' ')}\n\n${HELP}`);
  return EXIT.error;
}

export function describe(report: VerifyReport): string {
  if (report.status === 'locked') {
    const links = report.brokenLinks.map((b) => `  第 ${b.seq} 行：${b.reason}`).join('\n');
    return `🔒 账本被修改，已进入只读锁定\n${links}`;
  }
  const extra: string[] = [];
  if (report.acceptedLinks.length > 0) extra.push(`已接受的断链：${report.acceptedLinks.join(', ')}`);
  if (report.tornTail) extra.push(`末尾有 ${report.tornTail.length} 字节未写完的半行，下次写入时清除`);
  return [`✅ 账本完好：${report.nextSeq} 行`, ...extra].join('\n');
}

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function version(): string {
  // dist/cli/index.js 与 src/cli/index.ts 都在包根目录下两级。
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
  err: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
};

// npx / npm bin 通过符号链接调用，需解析真实路径再比较。
function invokedDirectly(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
