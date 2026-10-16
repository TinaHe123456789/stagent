import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import type { StagentConfig } from '../../src/config/config.js';
import { buildServer } from '../../src/server/http.js';
import { StagentService } from '../../src/server/service.js';
import { gitProject, nodeConfig } from './project.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/** 一个 git 项目 + 服务（检查用 node 直接运行）。 */
export async function serverProject(config: StagentConfig = nodeConfig({ flakyRetries: 1 })) {
  const { root } = await gitProject({ 'src/app.js': 'export const x = 1;\n', 'README.md': '# app\n' });
  const service = await StagentService.open(root, { config });
  const app = await buildServer(service, { serveWeb: false, heartbeatMs: 50 });
  apps.push(app);

  const call = async <T = unknown>(method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url, payload });
    return { status: res.statusCode, body: res.json() as T };
  };
  const writeCheck = async (path: string, source: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  };
  /** 添加功能并锁定一个例子，返回 { featureId, exampleId }。 */
  const lock = async (featureName: string, checkPath: string, source: string, featureId?: string) => {
    await writeCheck(checkPath, source);
    const fid = featureId ?? (await call<{ featureId: string }>('POST', '/api/dev/features', { name: featureName })).body.featureId;
    const r = await call<{ exampleId: string }>('POST', `/api/dev/features/${fid}/examples`, {
      given: '情况', when: '操作', then: `${featureName} 正常`, checkPath,
    });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return { featureId: fid, exampleId: r.body.exampleId };
  };
  const runAll = async () => {
    const r = await call('POST', '/api/runs');
    if (r.status !== 202) throw new Error(JSON.stringify(r.body));
    await service.waitForRun();
  };
  return { root, service, app, call, lock, runAll, writeCheck };
}

export const PASS = 'process.exit(0);\n';
export const FAIL = 'process.exit(1);\n';
/** 读项目里的 src/app.js：x === 1 才通过。 */
export const APP_CHECK = `const { x } = await import(process.env.STAGENT_PROJECT_ROOT + '/src/app.js'); process.exit(x === 1 ? 0 : 1);\n`;
