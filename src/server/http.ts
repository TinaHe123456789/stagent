/**
 * 本地 HTTP + SSE 接口（规格 §12，M1-3 范围）。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { LedgerVersionError } from '../ledger/verify.js';
import { HttpError, type StagentService } from './service.js';

/** 打包后的前端（vite build 输出）。src/server 与 dist/server 都在包根目录下两级。 */
export const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export interface BuildServerOptions {
  /** 是否托管前端静态资源（测试里关闭）。 */
  serveWeb?: boolean;
  /** SSE 心跳间隔。 */
  heartbeatMs?: number;
}

const registeredRoutes = new WeakMap<FastifyInstance, { method: string; url: string }[]>();

/** 已注册的全部路由（Invariant 2 的测试据此枚举所有写接口）。 */
export function routesOf(app: FastifyInstance): { method: string; url: string }[] {
  return [...(registeredRoutes.get(app) ?? [])];
}

export async function buildServer(service: StagentService, opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  // 关闭时强制断开 SSE 长连接，否则浏览器开着页面时 Ctrl+C 会一直等。
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const routes: { method: string; url: string }[] = [];
  registeredRoutes.set(app, routes);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof LedgerVersionError) return reply.status(500).send({ error: err.message });
    const status = err.statusCode;
    if (status && status < 500) return reply.status(status).send({ error: err.message });
    return reply.status(500).send({ error: `服务内部错误：${err.message}` });
  });

  app.get('/api/overview', () => service.overview());
  app.get('/api/features', () => service.features());
  app.get<{ Params: { id: string } }>('/api/features/:id', (req) => service.feature(req.params.id));

  app.post('/api/runs', async (_req, reply) => reply.status(202).send(await service.startRegression()));
  app.post('/api/runs/current/cancel', async (_req, reply) => {
    service.cancelRun();
    return reply.status(202).send({ ok: true });
  });

  app.post<{ Body: { reason?: unknown } }>('/api/ledger/accept', async (req) => {
    await service.acceptLedger(typeof req.body?.reason === 'string' ? req.body.reason : '');
    return { ok: true };
  });

  // 改动（§5）
  app.get('/api/changes', () => service.changes());
  app.post<{ Body: { description?: unknown; track?: unknown } }>('/api/changes', async (req, reply) =>
    reply.status(201).send(await service.createChange(req.body ?? {})),
  );
  app.get<{ Params: { id: string } }>('/api/changes/:id', (req) => service.change(req.params.id));
  app.post<{ Params: { id: string }; Body: { track?: unknown; reason?: unknown } }>('/api/changes/:id/track', (req) =>
    service.setTrack(req.params.id, req.body ?? {}),
  );
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/changes/:id/examples', async (req, reply) =>
    reply.status(201).send(await service.draftExample(req.params.id, req.body ?? {})),
  );
  app.post<{ Params: { id: string }; Body: { exampleIds?: unknown } }>('/api/changes/:id/examples/lock', (req) =>
    service.lockExamples(req.params.id, req.body ?? {}),
  );
  app.post<{ Params: { id: string } }>('/api/changes/:id/check', async (req, reply) =>
    reply.status(202).send(await service.startCheck(req.params.id)),
  );

  app.get<{ Querystring: { lastEventId?: string } }>('/api/events/stream', (req, reply) => {
    const header = req.headers['last-event-id'];
    const lastId = Number((Array.isArray(header) ? header[0] : header) ?? req.query.lastEventId ?? NaN);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const send = (e: { id: number; type: string; data: unknown }) =>
      res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);

    if (Number.isFinite(lastId)) {
      const { events, gap } = service.bus.since(lastId);
      if (gap) res.write(`event: resync\ndata: {}\n\n`);
      events.forEach(send);
    }
    const unsubscribe = service.bus.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), opts.heartbeatMs ?? 15_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  if (opts.serveWeb !== false) {
    if (existsSync(WEB_DIST)) {
      await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.status(404).send({ error: '接口不存在' });
        return reply.sendFile('index.html');
      });
    } else {
      app.get('/', (_req, reply) =>
        reply
          .type('text/html; charset=utf-8')
          .send('<p>前端尚未构建：在 stagent 仓库运行 <code>npm run build</code>。接口可用：<a href="/api/overview">/api/overview</a></p>'),
      );
    }
  }

  return app;
}
