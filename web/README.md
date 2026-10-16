# web/

Stagent 前端（React + Vite）。`npm run build` 会把它构建到 `web/dist/`，由本地服务托管并随 npm 包发布。

开发：先在一个示例项目里运行 `stagent --no-open`（默认 4310 端口），再在本目录运行 `npx vite`，`/api` 会代理到服务。

接口类型直接从 `../src/projection/` 以 `import type` 引入，前后端共用一份定义。
