// 检查从 .stagent/runs/<runId>/checks/ 下的快照还原后执行，所以 include 指向那里。
// 不 import vitest：夹具复制到临时目录后解析不到它，用 globals 代替。
export default {
  test: {
    globals: true,
    include: ['.stagent/runs/*/checks/**/*.spec.mjs'],
  },
};
