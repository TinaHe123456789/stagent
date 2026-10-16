# 检查快照、workTreeHash 与检查执行器（M1-2）

对应规格 §4.1（快照、workTreeHash）、§6（执行器隔离）、§7（检查执行器）与 tasks.md 的 M1-2。

## 检查快照 `src/evidence/snapshots.ts`

- `.stagent/ledger/snapshots/<sha256>`，按内容寻址：`checkSnapshotId == example.locked.checkHash`。
- 写入先写临时文件再 rename；读取时重算 sha256，缺失或不一致抛 `SnapshotIntegrityError`。
- `cleanOrphanSnapshots(root, events)`：删除账本未引用（不在任何 `example.locked.checkHash` 或 `run.completed.snapshots` 里）的快照和残留临时文件。M1-3 的服务启动时调用。

## workTreeHash `src/evidence/worktree-hash.ts`

| 项 | 规则 |
|---|---|
| 文件集合 | `git ls-files -co --exclude-standard`：已跟踪 + 未被 .gitignore 忽略的未跟踪文件；已跟踪但被删除的文件记为 `deleted` |
| 固定排除 | `.stagent/ledger/events.jsonl`、`.stagent/ledger/snapshots/**`、`.stagent/runs/**`、`.stagent/docs/**`、`.stagent/service.lock`（stagent 自己写的文件，验收 #25） |
| 用户豁免 | `config.evidence.ignoreGlobs`，默认 `**/*.md`、`LICENSE*`、`.cursor/rules/**`（验收 #24） |
| 不可豁免 | `.stagent/checks/**`、`.stagent/config.json`，ignoreGlobs 写了也照样参与 |
| entryHash | file：`sha256("file\0" + 644/755 + "\0" + sha256(内容))`；symlink：`sha256("symlink\0" + 目标)`；deleted：`sha256("deleted")`；子模块/嵌套仓库：`sha256("gitlink\0" + HEAD)` |
| workTreeHash | `sha256(spec + "\n" + 按路径排序的 "path\0entryHash\n")` |
| workTreeHashSpec | `sha256(JCS(上述规则本身))`；ignoreGlobs 一变 spec 就变 |

提交本身不改变 workTreeHash；提交变化由 run 的 `startCommit` / `endCommit` 记录。

## 检查执行器 `src/executor/`

`runChecks({ projectRoot, ledger, checks, purpose?, changeId?, config?, signal?, onProgress? })`：

1. 解析快照。锁定例子从快照读取（不读工作区）；`purpose: 'red_check'` 的草稿检查先把草稿写成快照。**任一快照缺失或被篡改 → 整轮拒绝执行，不写 run.completed。**
2. 记录 `startCommit`、`startWorkTreeHash`。
3. 还原到 `.stagent/runs/<runId>/checks/<去掉 .stagent/checks/ 的路径>`；按 `config.devServer` 启动开发服务器，健康检查 URL 返回 200 才继续（默认 60 秒超时）。起不来 → 本轮所有检查 `errored`，日志指向 `dev-server.log`。
4. 逐个执行 `checkCommand`（`{path}` `{checkPath}` `{exampleId}` 占位符，shell 转义），cwd 为项目根目录。每次执行前重算还原文件的哈希。

   | 情况 | 结果 |
   |---|---|
   | 退出码 0 | passed |
   | 非 0 | failed → 同轮复跑 `flakyRetries` 次（默认 1），有一次通过 → **flaky** |
   | 超时（`checkTimeoutMs`）/ 退出码 126、127（命令不存在）/ 被信号杀死 | errored → 自动重试 1 次，以重试结果为准 |
   | 取消（AbortSignal） | not_run |

5. 记录 `endCommit`、`endWorkTreeHash`；任一与起点不同 → `valid=false`。
6. 追加 `run.completed`：四个起止值、`workTreeHashSpec`、`valid`、`snapshots`（exampleId → 快照 id）、`results`（含 `attempts`、`detail`）。`valid=false` 时自动重跑一次，两条都记入账本。

检查运行时的环境变量：`STAGENT_PROJECT_ROOT`、`STAGENT_RUN_ID`、`STAGENT_EXAMPLE_ID`、`STAGENT_ATTEMPT`。

### 写检查时要注意

检查从快照还原到 `.stagent/runs/<runId>/checks/` 下执行，目录层级和原位置不同，**不要用相对路径 import 项目源码**，改用 `STAGENT_PROJECT_ROOT`（见 `test/fixtures/mini-project/.stagent/checks/`）、包名或路径别名。测试框架的 include 规则需要覆盖 `.stagent/runs/*/checks/**`（示例见夹具的 `vitest.checks.config.mjs`）。

## 推断与待规格确认

spec v2.2 未随任务提供，以下为推断：

- 快照被篡改时拒绝**整轮**执行，而不是只把该例子记为 errored；
- errored 重试后通过记为 passed（不算 flaky）；
- 固定排除清单、默认 ignoreGlobs 与 entryHash 的具体格式；
- 还原路径去掉 `.stagent/checks/` 前缀。

## 不在 M1-2

Playwright 截图与 visual 例子（M4-2）；先失败检查的业务流程（M3-2，执行器已支持 `purpose: 'red_check'` 运行草稿）；单次超过 5 分钟的提示（界面，M1-3）。
