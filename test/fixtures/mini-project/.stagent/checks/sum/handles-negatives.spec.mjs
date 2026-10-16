// 情况：负数 → 操作：sum(-2, -3) → 期望：-5
const { sum } = await import(`${process.env.STAGENT_PROJECT_ROOT}/src/sum.mjs`);

test('sum(-2, -3) === -5', () => {
  expect(sum(-2, -3)).toBe(-5);
});
