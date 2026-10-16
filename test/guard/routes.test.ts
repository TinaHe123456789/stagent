import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../../src/ledger/index.js';
import type { Overview } from '../../src/projection/overview.js';
import { PASS, serverProject } from '../helpers/server.js';

function payload(root: string, tool_name: string, tool_input: Record<string, unknown>) {
  return { session_id: 's1', transcript_path: '/t.jsonl', cwd: root, hook_event_name: 'PreToolUse', tool_name, tool_input };
}

describe('POST /api/guard/pre-tool-use', () => {
  it('验收 #2：Claude Code 改锁定检查被拒绝，账本有 guard.blocked，首页显示拦截提醒', async () => {
    const p = await serverProject();
    const { changeId } = await p.lock('登录', '.stagent/checks/login.mjs', PASS);
    const events: string[] = [];
    p.service.bus.subscribe((e) => events.push(e.type));

    const r = await p.call<{ decision: string; reason: string; ruleId: string }>(
      'POST',
      '/api/guard/pre-tool-use',
      payload(p.root, 'Write', { file_path: join(p.root, '.stagent/checks/login.mjs'), content: 'process.exit(0)' }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ decision: 'deny', ruleId: 'locked-check' });
    expect(r.body.reason).toContain('锁定的验收检查');

    const blocked = (await Ledger.open(p.root)).events().filter((e) => e.type === 'guard.blocked');
    expect(blocked).toEqual([
      // guard.blocked 关联当时进行中的改动（M2-2）。
      { type: 'guard.blocked', changeId, path: '.stagent/checks/login.mjs', tool: 'Write', detail: r.body.reason },
    ]);
    expect(events).toContain('ledger.appended');

    const overview = (await p.call<Overview>('GET', '/api/overview')).body;
    expect(overview.lastGuardBlock).toMatchObject({ path: '.stagent/checks/login.mjs', tool: 'Write' });
  });

  it('Bash 危险命令被拒绝并记录；普通调用放行且不写账本', async () => {
    const p = await serverProject();
    const before = (await Ledger.open(p.root)).events().length;
    const ok = await p.call('POST', '/api/guard/pre-tool-use', payload(p.root, 'Edit', { file_path: 'src/app.js' }));
    expect(ok.body).toEqual({ decision: 'allow' });
    expect((await Ledger.open(p.root)).events()).toHaveLength(before);

    const deny = await p.call('POST', '/api/guard/pre-tool-use', payload(p.root, 'Bash', { command: 'git reset --hard' }));
    expect(deny.body).toMatchObject({ decision: 'deny', ruleId: 'git-reset-hard' });
    const last = (await Ledger.open(p.root)).events().at(-1);
    expect(last).toMatchObject({ type: 'guard.blocked', tool: 'Bash', path: 'git reset --hard' });
  });

  it('伪造或残缺的请求体 → 放行，不写任何事件', async () => {
    const p = await serverProject();
    const before = (await Ledger.open(p.root)).events().length;
    for (const body of [{}, { status: 'verified' }, { tool_name: 'Write' }]) {
      expect((await p.call('POST', '/api/guard/pre-tool-use', body)).body).toEqual({ decision: 'allow' });
    }
    expect((await Ledger.open(p.root)).events()).toHaveLength(before);
  });

  it('账本被篡改（🔒）时仍然拒绝 .stagent/ 写入，但不写 guard.blocked，也不报错', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/login.mjs', PASS);
    const path = Ledger.pathFor(p.root);
    await writeFile(path, (await readFile(path, 'utf8')).replace('"name":"登录"', '"name":"注册"'));
    const bytes = await readFile(path, 'utf8');

    const r = await p.call('POST', '/api/guard/pre-tool-use', payload(p.root, 'Edit', { file_path: '.stagent/ledger/events.jsonl' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ decision: 'deny' });
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
});
