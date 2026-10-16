/**
 * .stagent/config.json（规格 §4.3、§7）。
 *
 * M1-2 只需要读取：检查命令模板、开发服务器、超时、复跑次数与证据豁免。
 * 草稿由 stagent init 生成（M1-3）；缺失的字段一律取默认值。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONFIG_RELATIVE_PATH = join('.stagent', 'config.json');

export interface DevServerConfig {
  /** 启动命令，在项目根目录用 shell 执行。 */
  command: string;
  /** 健康检查 URL，返回 200 视为就绪。 */
  url: string;
  /** 就绪超时，默认 60 秒（§7）。超时则本轮所有检查记为 errored。 */
  timeoutMs: number;
}

export interface StagentConfig {
  /**
   * 检查命令模板（§7）。占位符：
   * {path} 还原后的检查文件（相对项目根目录）、{checkPath} 锁定时的原路径、{exampleId}。
   */
  checkCommand: string;
  /** 单个检查超时，超时记为 errored。 */
  checkTimeoutMs: number;
  /** failed 后同轮复跑次数；复跑通过则记为 flaky（§4.1 v2.2）。 */
  flakyRetries: number;
  devServer: DevServerConfig | null;
  evidence: {
    /** 不参与 workTreeHash 的文件（如文档）。`.stagent/checks/**` 不可豁免。 */
    ignoreGlobs: string[];
  };
  releaseCommand: string | null;
  budget: { perChange: number | null; perDay: number | null };
  guard: {
    /** 额外的 Bash 危险命令规则：正则源码或 `/源码/flags`（M2-1）。 */
    bashRules: string[];
    /** 是否安装 .git/hooks/pre-merge-commit 提醒脚本（只提醒、不阻止），默认 true。 */
    preMergeReminder: boolean;
  };
}

export const DEFAULT_CONFIG: StagentConfig = {
  checkCommand: 'npx playwright test {path}',
  checkTimeoutMs: 120_000,
  flakyRetries: 1,
  devServer: null,
  evidence: { ignoreGlobs: ['**/*.md', 'LICENSE', 'LICENSE.*', '.cursor/rules/**'] },
  releaseCommand: null,
  budget: { perChange: null, perDay: null },
  guard: { bashRules: [], preMergeReminder: true },
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export async function loadConfig(projectRoot: string): Promise<StagentConfig> {
  let text: string;
  try {
    text = await readFile(join(projectRoot, CONFIG_RELATIVE_PATH), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${CONFIG_RELATIVE_PATH} 不是合法 JSON：${(err as Error).message}`);
  }
  return resolveConfig(raw);
}

/** 用默认值补齐并校验一份原始配置。 */
export function resolveConfig(raw: unknown): StagentConfig {
  if (!isObject(raw)) throw new ConfigError('config.json 顶层必须是对象');
  const d = DEFAULT_CONFIG;
  const devServer = raw.devServer;
  const evidence = isObject(raw.evidence) ? raw.evidence : {};
  const budget = isObject(raw.budget) ? raw.budget : {};
  const guard = isObject(raw.guard) ? raw.guard : {};
  return {
    checkCommand: str(raw.checkCommand, 'checkCommand') ?? d.checkCommand,
    checkTimeoutMs: positive(raw.checkTimeoutMs, 'checkTimeoutMs') ?? d.checkTimeoutMs,
    flakyRetries: nonNegativeInt(raw.flakyRetries, 'flakyRetries') ?? d.flakyRetries,
    devServer:
      devServer === undefined || devServer === null
        ? null
        : isObject(devServer)
          ? {
              command: required(str(devServer.command, 'devServer.command'), 'devServer.command'),
              url: required(str(devServer.url, 'devServer.url'), 'devServer.url'),
              timeoutMs: positive(devServer.timeoutMs, 'devServer.timeoutMs') ?? 60_000,
            }
          : fail('devServer 必须是对象或 null'),
    evidence: { ignoreGlobs: strArray(evidence.ignoreGlobs, 'evidence.ignoreGlobs') ?? [...d.evidence.ignoreGlobs] },
    releaseCommand: str(raw.releaseCommand, 'releaseCommand') ?? null,
    budget: {
      perChange: positive(budget.perChange, 'budget.perChange') ?? null,
      perDay: positive(budget.perDay, 'budget.perDay') ?? null,
    },
    guard: {
      bashRules: strArray(guard.bashRules, 'guard.bashRules') ?? [],
      preMergeReminder: bool(guard.preMergeReminder, 'guard.preMergeReminder') ?? d.guard.preMergeReminder,
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function required<T>(v: T | undefined, name: string): T {
  return v === undefined ? fail(`缺少 ${name}`) : v;
}

function str(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.trim() === '') fail(`${name} 必须是非空字符串`);
  return v;
}

function positive(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`${name} 必须是正数`);
  return v;
}

function nonNegativeInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || (v as number) < 0) fail(`${name} 必须是非负整数`);
  return v as number;
}

function bool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') fail(`${name} 必须是 true 或 false`);
  return v;
}

function strArray(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(`${name} 必须是字符串数组`);
  return v as string[];
}
