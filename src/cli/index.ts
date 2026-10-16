#!/usr/bin/env node
/**
 * stagent CLI 入口（npx stagent）。
 *
 * M1-1 只提供账本相关子命令；init、本地服务（M1-3）与 hook pre-tool-use（M2-1）在后续任务加入。
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, LedgerMissingError, LedgerVersionError, type VerifyReport } from '../ledger/index.js';

export const EXIT = { ok: 0, error: 1, locked: 2, version: 3 } as const;

const HELP = `用法：stagent <命令> [选项]

命令：
  ledger verify                 校验 .stagent/ledger/events.jsonl 的事件链
  ledger accept --reason <原因>  账本被修改时"我确认，接受当前状态"（原因至少 4 个字）

选项：
  --root <目录>   项目根目录（默认当前目录）
  -v, --version   显示版本
  -h, --help      显示帮助
`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const args = [...argv];
  const root = resolve(takeOption(args, '--root') ?? process.cwd());
  const reason = takeOption(args, '--reason');

  if (args.includes('-v') || args.includes('--version')) {
    io.out(version());
    return EXIT.ok;
  }
  const [cmd, sub] = args;
  if (!cmd || cmd === 'help' || args.includes('-h') || args.includes('--help')) {
    io.out(HELP);
    return EXIT.ok;
  }

  try {
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

function version(): string {
  // dist/cli/index.js 与 src/cli/index.ts 都在包根目录下两级。
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
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
