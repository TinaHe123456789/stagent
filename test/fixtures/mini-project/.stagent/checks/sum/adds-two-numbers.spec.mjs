// 情况：两个数字 → 操作：sum(2, 3) → 期望：5
// 检查从快照还原到别的目录执行，所以用 STAGENT_PROJECT_ROOT 定位源码，不用相对路径。
const { sum } = await import(`${process.env.STAGENT_PROJECT_ROOT}/src/sum.mjs`);

test('sum(2, 3) === 5', () => {
  expect(sum(2, 3)).toBe(5);
});
