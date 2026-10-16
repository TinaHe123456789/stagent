# 状态投影、本地服务、init 与首页（M1-3）

对应规格 §4.2、§9 第 1 步、§11、§12 与 tasks.md 的 M1-3。

## 使用

```bash
cd 你的项目            # 必须是 git 仓库
npx stagent init       # 写 .stagent/、账本 meta 行、config.json 草稿、.gitignore 条目
npx stagent            # 启动服务（127.0.0.1:4310 起，被占用自动递增），打开浏览器
```

想先看效果：在 stagent 仓库里运行 `npm run demo`，它会在临时目录生成示例项目，用一个新功能档改动锁定例子并检查（购物车结算已验证、登录被破坏、支付结果不稳定），然后在 `0.0.0.0:4310` 启动服务。

## 状态投影 `src/projection/projection.ts`

例子级判定表（只看快照 id 等于当前 checkHash 的最近一条非 red_check 结果）：

| 条件 | 状态 |
|---|---|
| failed，run 有效，run 结束时的 workTreeHash / spec 等于当前 | 失败 |
| passed，run 有效，且新鲜 | 已验证 |
| 有 AI 回报（claim），但不满足以上两条 | 未验证 · 仅 AI 声称 |
| 锁定后没有结果 | 未验证 · 未执行 |
| 最近结果所在 run `valid=false` | 未验证 · 证据无效 |
| 最近结果之后工作区变了 | 未验证 · 证据过期 |
| 最近结果 flaky / errored / not_run | 未验证 · 结果不稳定 / 执行异常 / 未执行 |

功能级：任一锁定例子失败 → 被破坏；≥ 1 个锁定例子且全部已验证 → 已验证（N 个例子）；其余（包括没有例子）→ 未验证。覆盖薄弱：锁定例子少于 2 个，或只有外观类例子。

## 结论卡 `src/projection/overview.ts`

| 状态 | 何时 |
|---|---|
| 🔒 账本被修改 | 事件链断裂；写接口返回 423，主操作「我确认，接受当前状态」 |
| ⏳ 检查中 | 有运行进行中；显示 n/N 和当前检查名，可取消 |
| 📒 还没有任何已验证功能 | 账本里没有功能；入口「扫描现有代码」（M4-1 前禁用）和「描述第一个功能」 |
| ⛔ 不能合并 | 有失败或未验证的锁定例子 |
| ✅ 系统完好 | 全部锁定例子已验证 |
| 👀 等你确认 | M2 起（外观确认等） |

原因最多 3 条，按严重度排序：失败 > 仅 AI 声称 > 执行异常 > 证据无效 > 结果不稳定 > 证据过期 > 未执行 > 尚无例子 > 覆盖薄弱。最后两类只提示，不阻止继续。被禁用的按钮都带原因，例如「合并（1 失败 · 2 未验证）」。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 结论卡、统计、进行中的运行、最近的拦截、项目名与分支 |
| GET | `/api/features` · `/api/features/:id` | 功能与例子的证据状态 |
| POST | `/api/runs` | 手动全量回归（异步，202）；运行中 409，账本锁定 423 |
| POST | `/api/runs/current/cancel` | 取消当前运行 |
| POST | `/api/ledger/accept` | `{ reason }`，账本被修改时接受当前状态 |
| POST | `/api/guard/pre-tool-use` | Claude Code hook 的 stdin 原样转发，返回 `{ decision, reason? }`；拒绝时写 `guard.blocked`（M2-1，见 [guard.md](guard.md)） |
| GET | `/api/events/stream` | SSE：`run.started` / `run.progress` / `run.finished` / `run.failed` / `ledger.appended` / `ledger.locked`；支持 `Last-Event-ID` 续传，漏事件时发 `resync` |
| — | `/api/changes…` | 改动流程（M2-2），见 [changes.md](changes.md)；M1 的临时演示入口 `/api/dev/*` 已删除 |

没有任何接口能直接把功能或例子写成已验证（Invariant 2）：已验证只能来自执行器写入的 `run.completed`。`test/invariants/` 会对每个写接口发伪造请求来验证这一点，新增写接口时测试里的接口清单也要一起更新。

## 单实例与端口

- `.stagent/service.lock` 记录 pid 与端口；锁的持有进程还活着时拒绝启动第二个实例，进程已退出的陈旧锁会被接管。
- 端口从 4310（或 `--port`）起逐个探测，最多 20 个。
- 关闭时强制断开 SSE 长连接，取消正在进行的运行。

## 前端 `web/`

React + Vite，`npm run build` 输出到 `web/dist/` 并由服务托管。首页：结论卡、拦截提醒（守卫在 M2-1）、统计、功能表、临时演示入口；点击功能打开 470px 抽屉，显示例子的证据状态与原因。

服务端在 M2-2 起监听工作区；页面在收到 SSE 事件、每 5 秒以及窗口获得焦点时刷新。

## 不在 M1-3

改动流程、授权、抽屉里的档位 / 进度条 / 改了什么（M2）；扫描（M4-1）；hooks（M2-1）；`~/.stagent` 链头（M6-1）。
