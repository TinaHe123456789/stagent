import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  LEDGER_VERSION,
  Ledger,
  LedgerLockedError,
  LedgerMissingError,
  LedgerVersionError,
  canonicalize,
  lineHash,
  sha256Hex,
  type Event,
  type LedgerLine,
} from '../../src/ledger/index.js';
import { tmpProject } from '../helpers/tmp.js';

const feature = (n: number): Event => ({ type: 'feature.created', featureId: `f${n}`, name: `功能 ${n}`, origin: 'new' });

async function seeded(count = 3): Promise<{ root: string; ledger: Ledger }> {
  const root = await tmpProject();
  const ledger = await Ledger.init(root, { projectId: 'p-test' });
  for (let i = 1; i <= count; i++) await ledger.append(feature(i));
  return { root, ledger };
}

async function readLines(root: string): Promise<string[]> {
  const text = await readFile(Ledger.pathFor(root), 'utf8');
  return text.split('\n').filter((l) => l !== '');
}

async function writeLines(root: string, lines: string[]): Promise<void> {
  await writeFile(Ledger.pathFor(root), lines.map((l) => `${l}\n`).join(''));
}

/** 改写第 seq 行的事件内容，不重算哈希（最常见的手工篡改）。 */
async function tamper(root: string, seq: number): Promise<void> {
  const lines = await readLines(root);
  const line = JSON.parse(lines[seq]!) as LedgerLine;
  (line.event as { name?: string }).name = '被改过的名字';
  lines[seq] = JSON.stringify(line);
  await writeLines(root, lines);
}

describe('账本：创建与追加', () => {
  it('首行是 ledger.meta（ledgerVersion 3），之后每行链接上一行', async () => {
    const { root, ledger } = await seeded(2);
    const lines = (await readLines(root)).map((l) => JSON.parse(l) as LedgerLine);
    expect(lines).toHaveLength(3);
    expect(lines[0]!.event).toMatchObject({ type: 'ledger.meta', ledgerVersion: LEDGER_VERSION, projectId: 'p-test' });
    expect(lines[0]!.prevHash).toBe(GENESIS_HASH);
    lines.forEach((l, i) => {
      expect(l.seq).toBe(i);
      if (i > 0) expect(l.prevHash).toBe(lines[i - 1]!.hash);
    });
    expect(ledger.state).toBe('ok');
    expect(ledger.projectId).toBe('p-test');
  });

  it('hash = sha256(prevHash + JCS({ seq, at, event }))', async () => {
    const { root } = await seeded(1);
    const line = JSON.parse((await readLines(root))[1]!) as LedgerLine;
    expect(line.hash).toBe(sha256Hex(line.prevHash + canonicalize({ seq: line.seq, at: line.at, event: line.event })));
    expect(line.hash).toBe(lineHash(line.prevHash, line.seq, line.at, line.event));
  });

  it('重新打开后状态一致，可继续追加', async () => {
    const { root } = await seeded(2);
    const reopened = await Ledger.open(root);
    expect(reopened.state).toBe('ok');
    expect(reopened.events().map((e) => e.type)).toEqual(['ledger.meta', 'feature.created', 'feature.created']);
    await reopened.append(feature(3));
    expect((await Ledger.open(root)).report.nextSeq).toBe(4);
  });

  it('init 对已有账本是幂等的，不重写 meta', async () => {
    const { root } = await seeded(1);
    const before = await readFile(Ledger.pathFor(root), 'utf8');
    await Ledger.init(root, { projectId: 'another' });
    expect(await readFile(Ledger.pathFor(root), 'utf8')).toBe(before);
  });

  it('不存在的账本打开报 LedgerMissingError', async () => {
    const root = await tmpProject();
    await expect(Ledger.open(root)).rejects.toBeInstanceOf(LedgerMissingError);
  });

  it('meta 与 integrity_override 不能通过 append 写入', async () => {
    const { ledger } = await seeded(0);
    await expect(
      ledger.append({ type: 'ledger.meta', ledgerVersion: 3, projectId: 'x', createdAt: new Date().toISOString() }),
    ).rejects.toThrow(/只能由账本服务自身写入/);
  });

  it('无法规范化的事件（NaN）不会写入半条记录', async () => {
    const { root, ledger } = await seeded(1);
    const before = await readFile(Ledger.pathFor(root), 'utf8');
    await expect(
      ledger.append({ type: 'release.executed', command: 'x', exitCode: NaN, by: 'user' }),
    ).rejects.toThrow();
    expect(await readFile(Ledger.pathFor(root), 'utf8')).toBe(before);
  });
});

describe('账本：篡改检测（验收 #6）', () => {
  it.each([1, 2, 3])('篡改第 %i 行 → 启动锁定', async (seq) => {
    const { root } = await seeded(3);
    await tamper(root, seq);
    const ledger = await Ledger.open(root);
    expect(ledger.state).toBe('locked');
  });

  it('篡改 meta 行（非版本字段）→ 锁定而不是拒绝启动', async () => {
    const { root } = await seeded(1);
    const lines = await readLines(root);
    const meta = JSON.parse(lines[0]!) as LedgerLine;
    (meta.event as { projectId: string }).projectId = 'hijacked';
    lines[0] = JSON.stringify(meta);
    await writeLines(root, lines);
    expect((await Ledger.open(root)).state).toBe('locked');
  });

  it('篡改后重算本行哈希 → 下一行断链，仍然锁定', async () => {
    const { root } = await seeded(3);
    const lines = await readLines(root);
    const line = JSON.parse(lines[2]!) as LedgerLine;
    line.event = feature(99);
    line.hash = lineHash(line.prevHash, line.seq, line.at, line.event);
    lines[2] = JSON.stringify(line);
    await writeLines(root, lines);
    const ledger = await Ledger.open(root);
    expect(ledger.state).toBe('locked');
    expect(ledger.report.brokenLinks).toEqual([{ seq: 3, reason: 'prev_mismatch' }]);
  });

  it('删除中间一行 → 锁定', async () => {
    const { root } = await seeded(3);
    const lines = await readLines(root);
    lines.splice(2, 1);
    await writeLines(root, lines);
    expect((await Ledger.open(root)).state).toBe('locked');
  });

  it('交换两行 → 锁定', async () => {
    const { root } = await seeded(3);
    const lines = await readLines(root);
    [lines[1], lines[2]] = [lines[2]!, lines[1]!];
    await writeLines(root, lines);
    expect((await Ledger.open(root)).state).toBe('locked');
  });

  it('中间插入一行无法解析的内容 → 锁定', async () => {
    const { root } = await seeded(2);
    const lines = await readLines(root);
    lines.splice(1, 0, 'not json');
    await writeLines(root, lines);
    const ledger = await Ledger.open(root);
    expect(ledger.state).toBe('locked');
    expect(ledger.report.brokenLinks.map((b) => b.reason)).toContain('unparseable');
  });

  it('锁定后写入被拒绝，文件不变；断链行仍可只读展示', async () => {
    const { root } = await seeded(2);
    await tamper(root, 2);
    const ledger = await Ledger.open(root);
    const before = await readFile(Ledger.pathFor(root), 'utf8');
    await expect(ledger.append(feature(9))).rejects.toBeInstanceOf(LedgerLockedError);
    expect(await readFile(Ledger.pathFor(root), 'utf8')).toBe(before);
    expect(ledger.lines()).toHaveLength(3);
  });

  it('打开后才被篡改：下一次写入前的校验发现并拒绝', async () => {
    const { root, ledger } = await seeded(2);
    await tamper(root, 1);
    await expect(ledger.append(feature(9))).rejects.toBeInstanceOf(LedgerLockedError);
    expect(ledger.state).toBe('locked');
  });
});

describe('账本：接受当前状态（ledger.integrity_override）', () => {
  it('接受后再启动不锁定，可继续写入', async () => {
    const { root } = await seeded(3);
    await tamper(root, 2);
    const locked = await Ledger.open(root);
    const line = await locked.acceptCurrentState('我手动修正了一个错别字');
    expect(line.event).toMatchObject({ type: 'ledger.integrity_override', brokenLinks: [2], by: 'user' });

    const reopened = await Ledger.open(root);
    expect(reopened.state).toBe('ok');
    expect(reopened.report.acceptedLinks).toEqual([2]);
    await reopened.append(feature(4));
    expect((await Ledger.open(root)).state).toBe('ok');
  });

  it('prefixSha256 等于 override 行之前全部字节的 sha256', async () => {
    const { root } = await seeded(2);
    await tamper(root, 1);
    const before = await readFile(Ledger.pathFor(root));
    const line = await (await Ledger.open(root)).acceptCurrentState('接受现状测试');
    expect((line.event as { prefixSha256: string }).prefixSha256).toBe(sha256Hex(before));
  });

  it('接受之后再篡改 override 之前的其它行 → 仍锁定', async () => {
    const { root } = await seeded(3);
    await tamper(root, 2);
    await (await Ledger.open(root)).acceptCurrentState('接受第一次修改');
    await tamper(root, 1);
    expect((await Ledger.open(root)).state).toBe('locked');
  });

  it('接受之后篡改 override 之后的行 → 仍锁定', async () => {
    const { root } = await seeded(3);
    await tamper(root, 2);
    const ledger = await Ledger.open(root);
    await ledger.acceptCurrentState('接受第一次修改');
    await ledger.append(feature(5));
    const seq = ledger.report.nextSeq - 1;
    await tamper(root, seq);
    const reopened = await Ledger.open(root);
    expect(reopened.state).toBe('locked');
    expect(reopened.report.brokenLinks.map((b) => b.seq)).toEqual([seq]);
  });

  it('篡改 override 行本身（扩大接受范围）→ 锁定', async () => {
    const { root } = await seeded(3);
    await tamper(root, 2);
    await (await Ledger.open(root)).acceptCurrentState('接受第一次修改');
    const lines = await readLines(root);
    const last = JSON.parse(lines[lines.length - 1]!) as LedgerLine;
    (last.event as { brokenLinks: number[] }).brokenLinks = [1, 2, 3];
    lines[lines.length - 1] = JSON.stringify(last);
    await writeLines(root, lines);
    expect((await Ledger.open(root)).state).toBe('locked');
  });

  it('最后一行无法解析时也能接受，之后链接到该行原始字节的哈希', async () => {
    const { root } = await seeded(2);
    await appendFile(Ledger.pathFor(root), 'garbage line\n');
    const locked = await Ledger.open(root);
    expect(locked.state).toBe('locked');
    await locked.acceptCurrentState('接受这行垃圾');
    const reopened = await Ledger.open(root);
    expect(reopened.state).toBe('ok');
    await reopened.append(feature(3));
    expect((await Ledger.open(root)).state).toBe('ok');
  });

  it('原因少于 4 个字拒绝；未锁定时拒绝', async () => {
    const { root, ledger } = await seeded(1);
    await expect(ledger.acceptCurrentState('好的')).rejects.toThrow(/至少 4 个字/);
    await expect(ledger.acceptCurrentState('没有被改过')).rejects.toThrow(/无需接受/);
    await tamper(root, 1);
    await expect(ledger.acceptCurrentState('   ab   ')).rejects.toThrow(/至少 4 个字/);
  });
});

describe('账本：末尾半行（规则 2a）', () => {
  it('末尾被截掉的半行不锁定，下次写入前清除', async () => {
    const { root } = await seeded(2);
    const full = await readFile(Ledger.pathFor(root), 'utf8');
    const lastLineStart = full.lastIndexOf('\n', full.length - 2) + 1;
    // 模拟崩溃：最后一行只写了一半，没有换行。
    await writeFile(Ledger.pathFor(root), full.slice(0, lastLineStart + 20));

    const ledger = await Ledger.open(root);
    expect(ledger.state).toBe('ok');
    expect(ledger.report.tornTail).not.toBeNull();
    expect(ledger.report.nextSeq).toBe(2);

    await ledger.append(feature(7));
    const reopened = await Ledger.open(root);
    expect(reopened.state).toBe('ok');
    expect(reopened.report.tornTail).toBeNull();
    expect(reopened.events().map((e) => (e as { featureId?: string }).featureId)).toEqual([undefined, 'f1', 'f7']);
  });

  it('最后一行完整但缺少换行：不锁定，写入前补换行', async () => {
    const { root } = await seeded(1);
    const full = await readFile(Ledger.pathFor(root), 'utf8');
    await writeFile(Ledger.pathFor(root), full.replace(/\n$/, ''));
    const ledger = await Ledger.open(root);
    expect(ledger.state).toBe('ok');
    expect(ledger.report.missingTrailingNewline).toBe(true);
    await ledger.append(feature(2));
    expect((await Ledger.open(root)).report.nextSeq).toBe(3);
  });

  it('中间行被截断（后面还有行）→ 锁定', async () => {
    const { root } = await seeded(3);
    const lines = await readLines(root);
    lines[1] = lines[1]!.slice(0, 30);
    await writeLines(root, lines);
    expect((await Ledger.open(root)).state).toBe('locked');
  });

  it('只有半行 meta 的文件：init 重新写入', async () => {
    const root = await tmpProject();
    await Ledger.init(root);
    const full = await readFile(Ledger.pathFor(root), 'utf8');
    await writeFile(Ledger.pathFor(root), full.slice(0, 15));
    const ledger = await Ledger.init(root, { projectId: 'fresh' });
    expect(ledger.state).toBe('ok');
    expect(ledger.projectId).toBe('fresh');
  });
});

describe('账本：版本（规则 2）', () => {
  async function ledgerWithVersion(version: number): Promise<string> {
    const root = await tmpProject();
    await Ledger.init(root);
    const at = new Date().toISOString();
    const event: Event = { type: 'ledger.meta', ledgerVersion: version, projectId: 'p', createdAt: at };
    const line: LedgerLine = { seq: 0, at, event, prevHash: GENESIS_HASH, hash: lineHash(GENESIS_HASH, 0, at, event) };
    await writeLines(root, [JSON.stringify(line)]);
    return root;
  }

  it.each([2, 4])('ledgerVersion %i 拒绝启动', async (v) => {
    const root = await ledgerWithVersion(v);
    await expect(Ledger.open(root)).rejects.toBeInstanceOf(LedgerVersionError);
  });

  it('首行不是 ledger.meta → 锁定', async () => {
    const root = await tmpProject();
    await Ledger.init(root);
    const at = new Date().toISOString();
    const event = feature(1);
    const line: LedgerLine = { seq: 0, at, event, prevHash: GENESIS_HASH, hash: lineHash(GENESIS_HASH, 0, at, event) };
    await writeLines(root, [JSON.stringify(line)]);
    const ledger = await Ledger.open(root);
    expect(ledger.state).toBe('locked');
    expect(ledger.report.brokenLinks).toEqual([{ seq: 0, reason: 'missing_meta' }]);
  });
});

describe('账本：写锁与事务', () => {
  it('并发追加串行化：seq 连续、链完好', async () => {
    const { root, ledger } = await seeded(0);
    await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.append(feature(i))));
    const reopened = await Ledger.open(root);
    expect(reopened.state).toBe('ok');
    expect(reopened.report.nextSeq).toBe(21);
  });

  it('事务内连续追加不被其它写入插队，事务内 append 可重入', async () => {
    const { root, ledger } = await seeded(0);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = ledger.transaction(async (t) => {
      await t.append({ type: 'auth.consumed', authId: 'a1', action: 'release' });
      await gate;
      await ledger.append({ type: 'release.executed', command: 'deploy', exitCode: 0, by: 'user', authId: 'a1' });
      await t.append({ type: 'auth.settled', authId: 'a1', ok: true });
    });
    const outside = ledger.append(feature(1));
    release();
    await Promise.all([tx, outside]);
    const types = (await Ledger.open(root)).events().map((e) => e.type);
    expect(types).toEqual(['ledger.meta', 'auth.consumed', 'release.executed', 'auth.settled', 'feature.created']);
  });

  it('事务抛错时已写入的事件保留，锁被释放', async () => {
    const { ledger } = await seeded(0);
    await expect(
      ledger.transaction(async (t) => {
        await t.append(feature(1));
        throw new Error('副作用失败');
      }),
    ).rejects.toThrow('副作用失败');
    await ledger.append(feature(2));
    expect(ledger.report.nextSeq).toBe(3);
  });

  it('事务结束后句柄失效；不支持嵌套事务', async () => {
    const { ledger } = await seeded(0);
    let leaked!: { append: (e: Event) => Promise<unknown> };
    await ledger.transaction(async (t) => {
      leaked = t;
      await expect(ledger.transaction(async () => undefined)).rejects.toThrow(/嵌套/);
    });
    await expect(leaked.append(feature(1))).rejects.toThrow(/已结束/);
  });

  it('锁定时事务体不执行', async () => {
    const { root, ledger } = await seeded(1);
    await tamper(root, 1);
    let ran = false;
    await expect(
      ledger.transaction(async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(LedgerLockedError);
    expect(ran).toBe(false);
  });
});
