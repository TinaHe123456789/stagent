/**
 * 账本校验（规格 §4.1 启动校验规则 1、2、2a 与 integrity_override 例外）。
 *
 * 纯函数：输入 events.jsonl 的全部字节，输出校验报告，不读写磁盘。
 *
 * - 规则 1：每个完整行都能解析，seq 等于行号，hash 可重算，prevHash 等于上一行 hash（首行为 GENESIS）。
 *   任何一处不符记为该行"断链"，有未被接受的断链即锁定（只读）。
 * - 规则 2：首行必须是 ledger.meta 且 ledgerVersion 等于本程序版本；哈希完好但版本不符时直接拒绝启动
 *   （LedgerVersionError），因为旧/新版本的账本不能用本程序的规则判断。meta 行缺失或被篡改按断链锁定。
 * - 规则 2a：文件末尾没有换行结束、且无法解析的半行，视为崩溃中断的写入，忽略（下次写入前截掉），不锁定。
 * - integrity_override：用户"接受当前状态"时写入，记录此前全部字节的 sha256 与当时的断链行号。
 *   校验时只有 prefixSha256 与实际字节一致，其列出的断链才被接受；之后任何改动（改前面的行使前缀哈希不符，
 *   或改后面的行产生新断链）都会重新锁定。
 */
import { GENESIS_HASH, LEDGER_VERSION, type Event, type LedgerLine, type Sha256Hex } from './types.js';
import { lineHash, sha256Hex } from './hash.js';

export class LedgerVersionError extends Error {
  override name = 'LedgerVersionError';
  constructor(
    readonly found: unknown,
    readonly expected: number = LEDGER_VERSION,
  ) {
    super(`账本版本不符：文件为 ledgerVersion ${String(found)}，本程序需要 ${expected}，拒绝启动`);
  }
}

export type BreakReason = 'unparseable' | 'bad_shape' | 'seq_mismatch' | 'hash_mismatch' | 'prev_mismatch' | 'missing_meta';

export interface BrokenLink {
  seq: number;
  reason: BreakReason;
}

export interface VerifyReport {
  status: 'ok' | 'locked' | 'empty';
  /** 可解析的行（含断链但能解析的行），供只读状态下展示。 */
  lines: LedgerLine[];
  /** 未被接受的断链；非空即锁定。 */
  brokenLinks: BrokenLink[];
  /** 被 integrity_override 接受的断链行号。 */
  acceptedLinks: number[];
  /** 完整行数，即下一行的 seq。 */
  nextSeq: number;
  /** 最后一个完整行存储的 hash，下一行的 prevHash。 */
  lastHash: Sha256Hex;
  /** 最后一个完整行结束处的字节偏移（之后是半行或文件末尾）。 */
  completeBytes: number;
  /** 规则 2a：末尾被截断的半行。 */
  tornTail: { offset: number; length: number } | null;
  /** 最后一行能解析但缺少结尾换行，下次写入前补上。 */
  missingTrailingNewline: boolean;
  meta: Extract<Event, { type: 'ledger.meta' }> | null;
}

interface RawLine {
  seq: number;
  start: number;
  end: number; // 不含换行
  text: string;
  terminated: boolean;
}

export function verifyLedger(bytes: Uint8Array): VerifyReport {
  const raw = splitLines(bytes);

  let tornTail: VerifyReport['tornTail'] = null;
  let missingTrailingNewline = false;
  const last = raw[raw.length - 1];
  if (last && !last.terminated) {
    if (tryParse(last.text) === undefined) {
      tornTail = { offset: last.start, length: last.end - last.start };
      raw.pop();
    } else {
      missingTrailingNewline = true;
    }
  }

  const lines: LedgerLine[] = [];
  const broken: BrokenLink[] = [];
  const accepted = new Set<number>();
  let meta: VerifyReport['meta'] = null;
  // 下一行应当链接到的哈希。无法解析的行没有存储的 hash，用其原始字节的 sha256 代替，
  // 这样它后面的行必然断链（被记录），而用户接受现状后写入的 override 仍能确定地链接上去。
  let prevStoredHash: Sha256Hex = GENESIS_HASH;

  for (const r of raw) {
    const parsed = tryParse(r.text);
    if (parsed === undefined) {
      broken.push({ seq: r.seq, reason: 'unparseable' });
      prevStoredHash = sha256Hex(bytes.subarray(r.start, r.end));
      continue;
    }
    if (!isLedgerLine(parsed)) {
      broken.push({ seq: r.seq, reason: 'bad_shape' });
      prevStoredHash = sha256Hex(bytes.subarray(r.start, r.end));
      continue;
    }
    const line = parsed;
    lines.push(line);

    const reason = linkProblem(line, r.seq, prevStoredHash);
    if (r.seq === 0) {
      if (line.event.type !== 'ledger.meta') {
        broken.push({ seq: 0, reason: 'missing_meta' });
      } else {
        // 只有哈希完好的 meta 行才代表真实版本；被篡改的 meta 行按断链锁定处理。
        if (!reason && line.event.ledgerVersion !== LEDGER_VERSION) {
          throw new LedgerVersionError(line.event.ledgerVersion);
        }
        meta = line.event;
      }
    }

    if (reason) broken.push({ seq: r.seq, reason });
    else if (line.event.type === 'ledger.integrity_override') {
      // override 本身链接完好时才生效，且只接受它之前的断链。
      const prefix = sha256Hex(bytes.subarray(0, r.start));
      if (prefix === line.event.prefixSha256) {
        for (const seq of line.event.brokenLinks) if (seq < r.seq) accepted.add(seq);
      }
    }
    prevStoredHash = line.hash;
  }

  const brokenLinks = broken.filter((b) => !accepted.has(b.seq));
  const lastRaw = raw[raw.length - 1];
  return {
    status: raw.length === 0 ? 'empty' : brokenLinks.length > 0 ? 'locked' : 'ok',
    lines,
    brokenLinks,
    acceptedLinks: [...accepted].sort((a, b) => a - b),
    nextSeq: raw.length,
    lastHash: prevStoredHash,
    completeBytes: lastRaw ? (lastRaw.terminated ? lastRaw.end + 1 : lastRaw.end) : 0,
    tornTail,
    missingTrailingNewline,
    meta,
  };
}

function linkProblem(line: LedgerLine, seq: number, prevStoredHash: Sha256Hex): BreakReason | null {
  if (line.seq !== seq) return 'seq_mismatch';
  let expected: Sha256Hex;
  try {
    expected = lineHash(line.prevHash, line.seq, line.at, line.event);
  } catch {
    return 'bad_shape';
  }
  if (expected !== line.hash) return 'hash_mismatch';
  if (line.prevHash !== prevStoredHash) return 'prev_mismatch';
  return null;
}

function splitLines(bytes: Uint8Array): RawLine[] {
  const out: RawLine[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      out.push({ seq: out.length, start, end: i, text: decoder.decode(bytes.subarray(start, i)), terminated: true });
      start = i + 1;
    }
  }
  if (start < bytes.length) {
    out.push({
      seq: out.length,
      start,
      end: bytes.length,
      text: decoder.decode(bytes.subarray(start)),
      terminated: false,
    });
  }
  return out;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

function isLedgerLine(v: unknown): v is LedgerLine {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const ev = o.event as Record<string, unknown> | null | undefined;
  return (
    Number.isInteger(o.seq) &&
    typeof o.at === 'string' &&
    typeof o.prevHash === 'string' &&
    HEX64.test(o.prevHash) &&
    typeof o.hash === 'string' &&
    HEX64.test(o.hash) &&
    typeof ev === 'object' &&
    ev !== null &&
    !Array.isArray(ev) &&
    typeof ev.type === 'string'
  );
}
