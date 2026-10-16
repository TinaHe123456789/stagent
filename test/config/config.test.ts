import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, resolveConfig } from '../../src/config/config.js';
import { tmpProject } from '../helpers/tmp.js';

describe('config.json', () => {
  it('文件不存在时取默认值', async () => {
    expect(await loadConfig(await tmpProject())).toEqual(DEFAULT_CONFIG);
  });

  it('部分字段覆盖，其余取默认值', async () => {
    const root = await tmpProject();
    await mkdir(join(root, '.stagent'));
    await writeFile(
      join(root, '.stagent/config.json'),
      JSON.stringify({ checkCommand: 'npx vitest run {path}', devServer: { command: 'npm run dev', url: 'http://localhost:3000' } }),
    );
    const c = await loadConfig(root);
    expect(c.checkCommand).toBe('npx vitest run {path}');
    expect(c.devServer).toEqual({ command: 'npm run dev', url: 'http://localhost:3000', timeoutMs: 60_000 });
    expect(c.flakyRetries).toBe(1);
    expect(c.evidence.ignoreGlobs).toEqual(DEFAULT_CONFIG.evidence.ignoreGlobs);
  });

  it.each([
    [{ checkTimeoutMs: -1 }, /checkTimeoutMs/],
    [{ flakyRetries: 1.5 }, /flakyRetries/],
    [{ devServer: { command: 'x' } }, /devServer.url/],
    [{ evidence: { ignoreGlobs: [1] } }, /ignoreGlobs/],
    [[], /顶层/],
  ])('非法配置 %j 报错', (raw, msg) => {
    expect(() => resolveConfig(raw)).toThrow(msg);
    expect(() => resolveConfig(raw)).toThrow(ConfigError);
  });

  it('不是合法 JSON 时报错', async () => {
    const root = await tmpProject();
    await mkdir(join(root, '.stagent'));
    await writeFile(join(root, '.stagent/config.json'), '{');
    await expect(loadConfig(root)).rejects.toBeInstanceOf(ConfigError);
  });
});
