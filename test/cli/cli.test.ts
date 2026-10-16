import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EXIT, main } from '../../src/cli/index.js';
import { Ledger } from '../../src/ledger/index.js';
import { tmpProject } from '../helpers/tmp.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

async function tamperFirstFeature(root: string): Promise<void> {
  const path = Ledger.pathFor(root);
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('"name":"登录"', '"name":"注册"'));
}

describe('stagent CLI', () => {
  it('--version 输出 package.json 版本', async () => {
    const { io, out } = capture();
    expect(await main(['--version'], io)).toBe(EXIT.ok);
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(out).toEqual([pkg.version]);
  });

  it('ledger verify：完好 → 0；篡改 → 2；accept 后 → 0', async () => {
    const root = await tmpProject();
    const ledger = await Ledger.init(root);
    await ledger.append({ type: 'feature.created', featureId: 'f1', name: '登录', origin: 'new' });

    let c = capture();
    expect(await main(['ledger', 'verify', '--root', root], c.io)).toBe(EXIT.ok);
    expect(c.out.join('')).toContain('账本完好');

    await tamperFirstFeature(root);
    c = capture();
    expect(await main(['ledger', 'verify', '--root', root], c.io)).toBe(EXIT.locked);
    expect(c.out.join('')).toContain('账本被修改');

    c = capture();
    expect(await main(['ledger', 'accept', '--root', root, '--reason', '我改了功能名'], c.io)).toBe(EXIT.ok);
    c = capture();
    expect(await main(['ledger', 'verify', '--root', root], c.io)).toBe(EXIT.ok);
    expect(c.out.join('')).toContain('已接受的断链：1');
  });

  it('没有账本 → 1 并提示 init', async () => {
    const c = capture();
    expect(await main(['ledger', 'verify', '--root', await tmpProject()], c.io)).toBe(EXIT.error);
    expect(c.err.join('')).toContain('stagent init');
  });

  it('未知命令 → 1', async () => {
    const c = capture();
    expect(await main(['nope'], c.io)).toBe(EXIT.error);
  });
});
