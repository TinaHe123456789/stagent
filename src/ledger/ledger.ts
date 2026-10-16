/**
 * 账本服务（规格 §4.1）：.stagent/ledger/events.jsonl 只追加写入。
 *
 * - 打开时校验整条链；每次写入前在写锁内重新读盘校验（规格："服务启动时和每次写入前都会校验整条链"）。
 * - 链断裂 → 只读锁定，写入抛 LedgerLockedError；只有 acceptCurrentState() 能写 ledger.integrity_override 解除。
 * - 写锁是进程内互斥锁，transaction() 让 M2-3 的授权三段式在同一把锁内连续追加；事务内调用 append() 可重入。
 *
 * 不在本模块：~/.stagent 链头锚点、head.tmp、TOFU、从 git 恢复（M6-1）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lineHash, sha256Hex } from './hash.js';
import { Mutex } from './mutex.js';
import { GENESIS_HASH, LEDGER_VERSION, type Event, type LedgerLine } from './types.js';
import { verifyLedger, type VerifyReport } from './verify.js';

export const LEDGER_RELATIVE_PATH = join('.stagent', 'ledger', 'events.jsonl');

/** 授权与 override 原因的最短长度（§6：至少 4 个字）。 */
export const MIN_REASON_LENGTH = 4;

export class LedgerLockedError extends Error {
  override name = 'LedgerLockedError';
  constructor(readonly report: VerifyReport) {
    super(`账本被修改（断链行：${report.brokenLinks.map((b) => b.seq).join(', ')}），已进入只读锁定`);
  }
}

export class LedgerMissingError extends Error {
  override name = 'LedgerMissingError';
  constructor(readonly path: string) {
    super(`未找到账本 ${path}，请先运行 stagent init`);
  }
}

export interface LedgerOptions {
  /** 时间来源，测试可注入。 */
  now?: () => Date;
}

/** 事务句柄：在写锁内连续追加。 */
export interface LedgerTx {
  append(event: Event): Promise<LedgerLine>;
  readonly report: VerifyReport;
}

export class Ledger {
  private readonly mutex = new Mutex();
  private readonly txScope = new AsyncLocalStorage<LedgerTx>();
  private readonly now: () => Date;
  private current: VerifyReport;

  private constructor(
    readonly path: string,
    report: VerifyReport,
    options: LedgerOptions,
  ) {
    this.current = report;
    this.now = options.now ?? (() => new Date());
  }

  static pathFor(projectRoot: string): string {
    return join(projectRoot, LEDGER_RELATIVE_PATH);
  }

  /**
   * 创建账本（已存在则直接打开）。首行写入 ledger.meta。
   * 返回的账本可能处于锁定状态（已存在且被篡改时），调用方据 state 判断。
   */
  static async init(projectRoot: string, options: LedgerOptions & { projectId?: string } = {}): Promise<Ledger> {
    const path = Ledger.pathFor(projectRoot);
    await mkdir(dirname(path), { recursive: true });
    const existing = await readIfExists(path);
    if (existing === null || verifyLedger(existing).status === 'empty') {
      const now = options.now ?? (() => new Date());
      const at = now().toISOString();
      const event: Event = {
        type: 'ledger.meta',
        ledgerVersion: LEDGER_VERSION,
        projectId: options.projectId ?? randomUUID(),
        createdAt: at,
      };
      const line = buildLine(0, at, event, GENESIS_HASH);
      // 'wx' 防止并发 init 互相覆盖；空文件（含仅有半行）则截断重写。
      if (existing === null) await writeNew(path, serialize(line));
      else {
        await truncate(path, 0);
        await appendBytes(path, serialize(line));
      }
    }
    return Ledger.open(projectRoot, options);
  }

  /** 打开并校验。版本不符抛 LedgerVersionError；断链不抛错，返回锁定状态的只读账本。 */
  static async open(projectRoot: string, options: LedgerOptions = {}): Promise<Ledger> {
    const path = Ledger.pathFor(projectRoot);
    const bytes = await readIfExists(path);
    if (bytes === null) throw new LedgerMissingError(path);
    return new Ledger(path, verifyLedger(bytes), options);
  }

  get state(): 'ok' | 'locked' {
    return this.current.status === 'locked' ? 'locked' : 'ok';
  }

  /** 最近一次校验的报告（打开、写入或 verify() 时更新）。 */
  get report(): VerifyReport {
    return this.current;
  }

  get projectId(): string | null {
    return this.current.meta?.projectId ?? null;
  }

  /** 已解析的全部行（锁定时只读展示，含断链行）。 */
  lines(): readonly LedgerLine[] {
    return this.current.lines;
  }

  events(): Event[] {
    return this.current.lines.map((l) => l.event);
  }

  /** 重新读盘校验整条链。 */
  async verify(): Promise<VerifyReport> {
    return this.mutex.runExclusive(() => this.reload());
  }

  /** 追加一个事件。锁定时抛 LedgerLockedError。 */
  async append(event: Event): Promise<LedgerLine> {
    const tx = this.txScope.getStore();
    if (tx) return tx.append(event);
    return this.transaction((t) => t.append(event));
  }

  /**
   * 在写锁内执行 fn；fn 内的 append 依次落盘。
   * 进入时校验整条链，锁定则不执行 fn 直接抛 LedgerLockedError。
   */
  async transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    if (this.txScope.getStore()) throw new Error('账本事务不支持嵌套');
    return this.mutex.runExclusive(async () => {
      const report = await this.reload();
      if (report.status === 'locked') throw new LedgerLockedError(report);
      if (report.meta === null) throw new LedgerMissingError(this.path);
      await this.repairTail(report);
      let open = true;
      const tx: LedgerTx = {
        append: async (event) => {
          if (!open) throw new Error('账本事务已结束，不能再追加');
          return this.writeEvent(event);
        },
        get report() {
          return report;
        },
      };
      try {
        return await this.txScope.run(tx, () => fn(tx));
      } finally {
        open = false;
      }
    });
  }

  /**
   * "我确认，接受当前状态"：在锁定账本末尾写入 ledger.integrity_override，
   * 记录此前全部字节的 sha256 与当前断链行号。账本未锁定时报错（没有可接受的断链）。
   */
  async acceptCurrentState(reason: string): Promise<LedgerLine> {
    assertReason(reason);
    if (this.txScope.getStore()) throw new Error('不能在账本事务内接受当前状态');
    return this.mutex.runExclusive(async () => {
      const report = await this.reload();
      if (report.status !== 'locked') throw new Error('账本未被修改，无需接受当前状态');
      await this.repairTail(report);
      const prefix = await readFile(this.path);
      const event: Event = {
        type: 'ledger.integrity_override',
        prefixSha256: sha256Hex(prefix),
        brokenLinks: report.brokenLinks.map((b) => b.seq),
        reason: reason.trim(),
        by: 'user',
      };
      const line = buildLine(report.nextSeq, this.now().toISOString(), event, report.lastHash);
      await appendBytes(this.path, serialize(line));
      return this.afterWrite(line, await this.reload());
    });
  }

  // ---- 内部 ----

  private async reload(): Promise<VerifyReport> {
    const bytes = await readIfExists(this.path);
    if (bytes === null) throw new LedgerMissingError(this.path);
    this.current = verifyLedger(bytes);
    return this.current;
  }

  /** 规则 2a：截掉崩溃留下的半行；最后一行缺换行则补上。 */
  private async repairTail(report: VerifyReport): Promise<void> {
    if (report.tornTail) {
      await truncate(this.path, report.tornTail.offset);
      this.current = { ...report, tornTail: null, completeBytes: report.tornTail.offset };
    }
    if (report.missingTrailingNewline) {
      await appendBytes(this.path, '\n');
      this.current = { ...this.current, missingTrailingNewline: false, completeBytes: report.completeBytes + 1 };
    }
  }

  private async writeEvent(event: Event): Promise<LedgerLine> {
    if (event.type === 'ledger.meta' || event.type === 'ledger.integrity_override') {
      throw new Error(`${event.type} 只能由账本服务自身写入`);
    }
    const report = this.current;
    const line = buildLine(report.nextSeq, this.now().toISOString(), event, report.lastHash);
    const text = serialize(line);
    await appendBytes(this.path, text);
    return this.afterWrite(line, {
      ...report,
      lines: [...report.lines, line],
      nextSeq: report.nextSeq + 1,
      lastHash: line.hash,
      completeBytes: report.completeBytes + Buffer.byteLength(text),
    });
  }

  private afterWrite(line: LedgerLine, report: VerifyReport): LedgerLine {
    this.current = report;
    return line;
  }
}

export function assertReason(reason: string): void {
  if (typeof reason !== 'string' || [...reason.trim()].length < MIN_REASON_LENGTH) {
    throw new Error(`原因至少 ${MIN_REASON_LENGTH} 个字`);
  }
}

function buildLine(seq: number, at: string, event: Event, prevHash: string): LedgerLine {
  return { seq, at, event, prevHash, hash: lineHash(prevHash, seq, at, event) };
}

function serialize(line: LedgerLine): string {
  return JSON.stringify(line) + '\n';
}

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeNew(path: string, text: string): Promise<void> {
  const fh = await open(path, 'wx');
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function appendBytes(path: string, text: string): Promise<void> {
  const fh = await open(path, 'a');
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}
