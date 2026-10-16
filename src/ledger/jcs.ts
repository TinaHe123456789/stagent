/**
 * JSON Canonicalization Scheme（RFC 8785）。
 *
 * - 对象键按 UTF-16 码元排序（JS 默认字符串比较即为码元序）；
 * - 数字按 ECMAScript Number→String 规则序列化（JSON.stringify 对有限数即是此规则，-0 输出 "0"）；
 * - 字符串只转义 `"`、`\` 和 U+0000–U+001F（JSON.stringify 的行为与 RFC 一致）；
 * - NaN / Infinity、孤立代理项、非普通 JSON 值一律报错，避免同一事件出现两种哈希。
 */

export class CanonicalizationError extends Error {
  override name = 'CanonicalizationError';
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError(`${path}: 非有限数字 ${value} 不能规范化`);
      return JSON.stringify(value);
    case 'string':
      return serializeString(value, path);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item === undefined ? null : item, `${path}[${i}]`)).join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new CanonicalizationError(`${path}: 只能规范化普通对象`);
      }
      return serializeObject(value as Record<string, unknown>, path);
    default:
      throw new CanonicalizationError(`${path}: 不支持的类型 ${typeof value}`);
  }
}

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) throw new CanonicalizationError(`${path}: 字符串含孤立代理项`);
  return JSON.stringify(value);
}

function serializeObject(obj: Record<string, unknown>, path: string): string {
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${serializeString(k, path)}:${serialize(obj[k], `${path}.${k}`)}`);
  return `{${parts.join(',')}}`;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
