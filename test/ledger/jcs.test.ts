import { describe, expect, it } from 'vitest';
import { canonicalize, CanonicalizationError } from '../../src/ledger/jcs.js';

/** 按位模式构造 IEEE-754 双精度数（RFC 8785 附录 B 的测试数据以位模式给出）。 */
function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe('JCS（RFC 8785）', () => {
  it('RFC 8785 §3.2.2 综合示例', () => {
    // 原文 JSON："string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/"
    const input =
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
      '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
      '"literals":[null,true,false]}';
    expect(canonicalize(JSON.parse(input))).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  describe('键排序', () => {
    it('按 UTF-16 码元而不是码点排序（RFC 8785 §3.2.3 示例）', () => {
      const input = JSON.parse(String.raw`{
        "€": "Euro Sign",
        "\r": "Carriage Return",
        "דּ": "Hebrew Letter Dalet With Dagesh",
        "1": "One",
        "😀": "Emoji: Grinning Face",
        "\u0080": "Control",
        "ö": "Latin Small Letter O With Diaeresis"
      }`);
      const keys = Object.keys(JSON.parse(canonicalize(input)) as object);
      // 注意：数字样键在 JS 对象里总排最前，所以只比较 canonicalize 输出里的键顺序。
      const out = canonicalize(input);
      const order = ['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'].map((k) => out.indexOf(JSON.stringify(k)));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(keys).toHaveLength(7);
      // 😀（U+1F600，码元 D83D）排在 U+FB33 之前；按码点排序则相反。
      expect(out.indexOf('😀')).toBeLessThan(out.indexOf('דּ'));
    });

    it('递归排序嵌套对象，数组保持原顺序', () => {
      expect(canonicalize({ b: [{ z: 1, a: 2 }, 3], a: { d: true, c: null } })).toBe('{"a":{"c":null,"d":true},"b":[{"a":2,"z":1},3]}');
    });

    it('与插入顺序无关', () => {
      expect(canonicalize({ x: 1, y: 2 })).toBe(canonicalize({ y: 2, x: 1 }));
    });

    it('省略 undefined 字段，数组里的 undefined 序列化为 null（与 JSON.stringify 一致）', () => {
      expect(canonicalize({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
    });
  });

  describe('数字序列化（RFC 8785 附录 B）', () => {
    const cases: Array<[string, string]> = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'], // -0
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ];
    it.each(cases)('0x%s → %s', (bits, expected) => {
      expect(canonicalize(fromBits(bits))).toBe(expected);
    });

    it.each([NaN, Infinity, -Infinity])('%s 拒绝规范化', (n) => {
      expect(() => canonicalize({ n })).toThrow(CanonicalizationError);
    });
  });

  describe('字符串', () => {
    it('只转义引号、反斜杠和控制字符，非 ASCII 原样输出', () => {
      expect(canonicalize('a"b\\c\u0001\u001f\t€/')).toBe('"a\\"b\\\\c\\u0001\\u001f\\t€/"');
    });
    it('孤立代理项报错', () => {
      expect(() => canonicalize('\ud800')).toThrow(CanonicalizationError);
      expect(() => canonicalize({ ['\udc00']: 1 })).toThrow(CanonicalizationError);
    });
  });

  it('拒绝非普通对象', () => {
    expect(() => canonicalize(new Date())).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Map())).toThrow(CanonicalizationError);
    expect(() => canonicalize(1n)).toThrow(CanonicalizationError);
  });
});
