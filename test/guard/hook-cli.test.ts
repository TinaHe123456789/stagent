import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { runPreToolUseHook } from '../../src/guard/hook-cli.js';
import { Ledger } from '../../src/ledger/index.js';
import { SERVICE_LOCK_RELATIVE_PATH } from '../../src/server/service-lock.js';
import { gitProject, lockExample } from '../helpers/project.js';
import { PASS, serverProject } from '../helpers/server.js';

function stdin(cwd: string, tool_name: string, tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ session_id: 's1', transcript_path: '/t.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra });
}

function parseDeny(stdout: string) {
  return JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
}

async function offlineProject() {
  const { root, ledger } = await gitProject();
  await mkdir(join(root, '.stagent/checks'), { recursive: true });
  await writeFile(join(root, '.stagent/checks/a.mjs'), PASS);
  await ledger.append({ type: 'feature.created', featureId: 'f', name: '登录', origin: 'new' });
  await lockExample(root, ledger, 'e1', '.stagent/checks/a.mjs');
  return { root };
}

describe('stagent hook pre-tool-use：离线模式（没有服务）', () => {
  it('写锁定检查 → 输出 deny JSON、exit 0，并直接写 guard.blocked', async () => {
    const { root } = await offlineProject();
    const r = await runPreToolUseHook({ stdin: stdin(join(root, 'src'), 'Edit', { file_path: '../.stagent/checks/a.mjs' }) });
    expect(r).toMatchObject({ exitCode: 0, mode: 'offline', decision: 'deny' });
    const out = parseDeny(r.stdout);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('锁定的验收检查');
    const last = (await Ledger.open(root)).events().at(-1);
    expect(last).toMatchObject({ type: 'guard.blocked', path: '.stagent/checks/a.mjs', tool: 'Edit' });
  });

  it('普通写入放行：无输出、exit 0、不写账本', async () => {
    const { root } = await offlineProject();
    const before = (await Ledger.open(root)).events().length;
    const r = await runPreToolUseHook({ stdin: stdin(root, 'Write', { file_path: 'src/app.js', content: 'x' }) });
    expect(r).toMatchObject({ stdout: '', exitCode: 0, decision: 'allow' });
    expect((await Ledger.open(root)).events()).toHaveLength(before);
  });

  it('读取 config.guard.bashRules；非法正则给出警告但不影响判定', async () => {
    const { root } = await offlineProject();
    await writeFile(join(root, '.stagent/config.json'), JSON.stringify({ guard: { bashRules: ['^npm publish', '(bad'] } }));
    const r = await runPreToolUseHook({ stdin: stdin(root, 'Bash', { command: 'npm publish' }) });
    expect(r.decision).toBe('deny');
    expect(r.stderr).toContain('bashRules[1]');
  });

  it('垃圾输入、非 PreToolUse 事件 → 放行且不崩溃', async () => {
    for (const s of ['', 'not json', '[]', 'null', JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} })]) {
      expect(await runPreToolUseHook({ stdin: s })).toMatchObject({ stdout: '', exitCode: 0, decision: 'allow', mode: 'ignored' });
    }
  });

  it('没有 .stagent/ 的目录仍按默认 Bash 规则拦截', async () => {
    const r = await runPreToolUseHook({ stdin: stdin('/', 'Bash', { command: 'rm -rf /' }), root: '/nonexistent-stagent-root' });
    expect(r.decision).toBe('deny');
  });

  it('CLI：stagent hook pre-tool-use 从 stdin 读取并输出', async () => {
    const { root } = await offlineProject();
    const out: string[] = [];
    const code = await main(['hook', 'pre-tool-use'], {
      out: (s) => out.push(s),
      err: () => {},
      readStdin: async () => stdin(root, 'Write', { file_path: '.stagent/ledger/events.jsonl', content: '' }),
    });
    expect(code).toBe(0);
    expect(parseDeny(out.join('')).hookSpecificOutput.permissionDecision).toBe('deny');

    const allowOut: string[] = [];
    expect(await main(['hook', 'pre-tool-use'], { out: (s) => allowOut.push(s), err: () => {}, readStdin: async () => 'garbage' })).toBe(0);
    expect(allowOut).toEqual([]);
  });
});

describe('stagent hook pre-tool-use：在线模式（服务在运行）', () => {
  it('转发给服务：服务判定并写 guard.blocked，hook 输出 deny', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/login.mjs', PASS);
    await p.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (p.app.server.address() as { port: number }).port;
    await writeFile(join(p.root, SERVICE_LOCK_RELATIVE_PATH), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));

    const r = await runPreToolUseHook({ stdin: stdin(p.root, 'Write', { file_path: '.stagent/checks/login.mjs', content: 'x' }) });
    expect(r).toMatchObject({ mode: 'online', decision: 'deny', exitCode: 0 });
    expect(parseDeny(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('锁定的验收检查');
    const blocked = (await Ledger.open(p.root)).events().filter((e) => e.type === 'guard.blocked');
    expect(blocked).toHaveLength(1);

    const ok = await runPreToolUseHook({ stdin: stdin(p.root, 'Write', { file_path: 'src/app.js', content: 'x' }) });
    expect(ok).toMatchObject({ mode: 'online', decision: 'allow', stdout: '' });
  });

  it('服务进程活着但请求失败 → 本地判定（.stagent/ 仍被拒绝），不写账本', async () => {
    const { root } = await offlineProject();
    await writeFile(join(root, SERVICE_LOCK_RELATIVE_PATH), JSON.stringify({ pid: process.pid, port: 1, startedAt: '' }));
    const before = (await Ledger.open(root)).events().length;
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await runPreToolUseHook({ stdin: stdin(root, 'Write', { file_path: '.stagent/checks/a.mjs' }), fetchImpl: failingFetch });
    expect(r).toMatchObject({ mode: 'offline', decision: 'deny' });
    expect(r.stderr).toContain('未响应');
    expect((await Ledger.open(root)).events()).toHaveLength(before);
  });

  it('陈旧的服务锁（进程已退出）→ 离线模式并写账本', async () => {
    const { root } = await offlineProject();
    await writeFile(join(root, SERVICE_LOCK_RELATIVE_PATH), JSON.stringify({ pid: 2 ** 22 + 12345, port: 1, startedAt: '' }));
    const r = await runPreToolUseHook({ stdin: stdin(root, 'Bash', { command: 'git push -f' }) });
    expect(r).toMatchObject({ mode: 'offline', decision: 'deny' });
    expect((await Ledger.open(root)).events().at(-1)).toMatchObject({ type: 'guard.blocked', tool: 'Bash' });
  });
});
