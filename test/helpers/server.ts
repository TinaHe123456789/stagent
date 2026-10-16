import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import type { ChangeView, ChangesProjection } from '../../src/changes/changes.js';
import type { StagentConfig } from '../../src/config/config.js';
import { buildServer } from '../../src/server/http.js';
import { StagentService, type ServiceOptions } from '../../src/server/service.js';
import { gitProject, nodeConfig } from './project.js';

const apps: FastifyInstance[] = [];
const services: StagentService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stopWatching().then(() => s.waitForRun())));
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/** 一个 git 项目 + 服务（检查用 node 直接运行）。 */
export async function serverProject(
  config: StagentConfig = nodeConfig({ flakyRetries: 1 }),
  options: Omit<ServiceOptions, 'config'> = {},
) {
  const { root } = await gitProject({ 'src/app.js': 'export const x = 1;\n', 'README.md': '# app\n' });
  const service = await StagentService.open(root, { config, ...options });
  const app = await buildServer(service, { serveWeb: false, heartbeatMs: 50 });
  apps.push(app);
  services.push(service);

  const call = async <T = unknown>(method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url, payload });
    return { status: res.statusCode, body: res.json() as T };
  };
  const writeCheck = async (path: string, source: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  };
  /**
   * 通过正式的改动流程添加一个锁定例子：没有进行中的改动时建一个新功能档改动，
   * 起草（新功能或已有功能）后立即锁定。返回 { featureId, exampleId, changeId }。
   */
  const lock = async (featureName: string, checkPath: string, source: string, featureId?: string) => {
    await writeCheck(checkPath, source);
    let change = (await call<ChangesProjection>('GET', '/api/changes')).body.active;
    if (!change) {
      change = (await call<ChangeView>('POST', '/api/changes', { description: `新增 ${featureName}`, track: 'feature' })).body;
    } else if (change.track === 'small') {
      await call('POST', `/api/changes/${change.changeId}/track`, { track: 'feature' });
    }
    const d = await call<{ exampleId: string; featureId: string }>('POST', `/api/changes/${change.changeId}/examples`, {
      ...(featureId ? { featureId } : { featureName }),
      given: '情况',
      when: '操作',
      then: `${featureName} 正常`,
      checkPath,
    });
    if (d.status !== 201) throw new Error(JSON.stringify(d.body));
    const l = await call('POST', `/api/changes/${change.changeId}/examples/lock`, { exampleIds: [d.body.exampleId] });
    if (l.status !== 200) throw new Error(JSON.stringify(l.body));
    return { featureId: d.body.featureId, exampleId: d.body.exampleId, changeId: change.changeId };
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
