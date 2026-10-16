import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/server/event-bus.js';
import { PASS, serverProject } from '../helpers/server.js';

/** 读 SSE 流直到拿到满足条件的事件或超时。 */
async function readEvents(url: string, headers: Record<string, string>, until: (events: { id?: string; event?: string }[]) => boolean) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: { id?: string; event?: string; data?: string }[] = [];
  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline && !until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const e: Record<string, string> = {};
        for (const line of block.split('\n')) {
          const m = /^(\w+): ?(.*)$/.exec(line);
          if (m) e[m[1]!] = m[2]!;
        }
        if (e.event) events.push(e);
      }
    }
  } finally {
    ac.abort();
  }
  return { res, events };
}

describe('SSE /api/events/stream', () => {
  it('推送运行进度；带 Last-Event-ID 重连时补发之后的事件', async () => {
    const p = await serverProject();
    await p.lock('登录', '.stagent/checks/a.mjs', PASS);
    await p.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(p.app.server.address() as { port: number }).port}/api/events/stream`;

    const live = readEvents(url, {}, (es) => es.some((e) => e.event === 'run.finished'));
    await new Promise((r) => setTimeout(r, 100));
    await p.runAll();
    const { res, events } = await live;
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const types = events.map((e) => e.event);
    expect(types).toContain('run.started');
    expect(types).toContain('run.progress');
    expect(types).toContain('run.finished');

    // 从第一条事件之后续传：应补发其余事件，不重复第一条。
    const firstId = events[0]!.id!;
    const resumed = await readEvents(url, { 'Last-Event-ID': firstId }, (es) => es.some((e) => e.event === 'run.finished'));
    expect(resumed.events[0]!.id).toBe(String(Number(firstId) + 1));
    expect(resumed.events.map((e) => e.event)).toContain('run.finished');
  });
});

describe('EventBus', () => {
  it('缓冲区丢掉了中间的事件或服务重启过 → gap', () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i++) bus.publish('x', i);
    expect(bus.since(4)).toMatchObject({ gap: false, events: [{ id: 5 }] });
    expect(bus.since(2)).toMatchObject({ gap: false });
    expect(bus.since(1).gap).toBe(true);
    expect(bus.since(99).gap).toBe(true);
  });

  it('订阅与退订', () => {
    const bus = new EventBus();
    const got: number[] = [];
    const off = bus.subscribe((e) => got.push(e.id));
    bus.publish('a', null);
    off();
    bus.publish('b', null);
    expect(got).toEqual([1]);
    expect(bus.listenerCount).toBe(0);
  });
});
