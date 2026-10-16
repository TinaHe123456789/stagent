# 守卫：PreToolUse 拦截与危险命令规则（M2-1）

对应规格 §6「守卫·写时拦截」与 tasks.md 的 M2-1。合并门见 [auth.md](auth.md)（M2-3）；不含 Claude Code 适配器（M3）。

## 做了什么

- `stagent init` 在 `.claude/settings.json` 写入 PreToolUse hook：`npx stagent hook pre-tool-use`，匹配 `Write|Edit|MultiEdit|NotebookEdit|Bash`。合并进已有文件，不动其他键和别的 hook；已装过（任一 hook 命令含 `stagent hook pre-tool-use`）不再重复添加；文件不是合法 JSON 时不覆盖，只给警告。
- Claude Code 每次调用这些工具前把调用 JSON 写到 hook 的 stdin。命中规则 → 拒绝并说明原因，账本追加 `guard.blocked`，首页的拦截提醒（`GuardNotice`，读 `overview.lastGuardBlock`）显示最近一条。
- `stagent init` 同时安装 `.git/hooks/pre-merge-commit` 提醒脚本：绕过 Stagent 直接 `git merge` 时在终端提示"请通过 Stagent 合并"，**永远 exit 0、不阻止合并**。

## 文件工具规则 `src/guard/decide.ts`

| 目标（相对项目根目录） | 判定 | ruleId |
|---|---|---|
| 当前锁定的检查路径（最近一次 `example.locked` 且之后没有 `example.unlocked`） | 拒绝："这是锁定的验收检查，不能修改；如果你认为例子需要改，请在回报里说明，由用户授权修改" | `locked-check` |
| `.stagent/checks/draft/**` | 只对「确认例子」阶段的起草会话放行，其他会话拒绝 | `draft-not-allowed` |
| `.stagent/**` 其余全部（账本、快照、config.json、checks、service.lock…） | 拒绝，按区域给出原因 | `stagent-dir` |
| 项目根目录之外、普通源码、子目录里别的 `.stagent/` | 放行（不输出决定，交给正常权限流程） | — |

- 工具与路径字段：Write / Edit / MultiEdit 用 `tool_input.file_path`，NotebookEdit 用 `tool_input.notebook_path`。
- 路径按 hook 输入的 `cwd` 解析成绝对路径，再相对项目根目录归一化，所以 `../.stagent/...`、`src/../.stagent/...`、绝对路径都能识别。
- 同时检查字面路径与真实路径（跟随符号链接，路径不存在时解析最近的已存在祖先）：`ln -s .stagent x` 后写 `x/ledger/events.jsonl` 也会被拒绝。
- `.stagent` 段按大小写不敏感比较（macOS 默认文件系统上 `.Stagent/` 是同一个目录）。
- 锁定检查优先于草稿放行：锁定的路径即使在 `draft/` 下也拒绝。

## Bash 危险命令规则 `src/guard/rules.ts`

**附录 B 原文不可用**，下表按 §6 的"删除 / 强推 / 删库"三类推断，并补了"shell 写入 `.stagent/`"一类（否则 Write 被拦后换成 `echo > .stagent/...` 就能绕过）。每条规则在 `test/guard/rules.test.ts` 都有正例和反例。

| ruleId | 拦截 | 不拦（反例） |
|---|---|---|
| `rm-recursive` | `rm -rf /`、`rm -fr src`、`rm -r -f`、`rm -R`、`--recursive`、`xargs rm -rf`、`bash -c "rm -rf …"` | `rm -rf node_modules dist .next coverage`、`rm -rf packages/a/node_modules`、`rm file`、`rm -f file` |
| `find-delete` | `find … -delete`、`find … -exec rm` | 起点全是依赖/构建产物目录（`find node_modules … -delete`）、不删除的 find |
| `git-push-force` | `--force`、`-f`、`--force-with-lease`、`--force-if-includes`、`+refspec` | 普通 push、`HEAD:main` |
| `git-push-delete` | `--delete`、`-d`、`origin :branch`、`--mirror`、`--prune` | 普通 push、`--tags` |
| `git-reset-hard` | `git reset --hard` | `--soft`、`--keep`、`git reset file` |
| `git-clean-force` | `git clean -f` / `-fd` / `-xdf` / `--force` | 带 `-n` / `--dry-run` 的预演 |
| `git-discard-changes` | `git checkout .` / `-- .` / `-f`、`git restore .` / `:/`、`git stash drop` / `clear` | 单个文件的 `git checkout -- f` / `git restore f`、`git restore --staged .`、`git stash` / `pop` |
| `git-branch-force-delete` | `git branch -D`、`--delete --force`、`-df` | `git branch -d`（只删已合并） |
| `sql-drop` | `DROP DATABASE / TABLE / SCHEMA`（含 `psql -c`、`mysql -e`、heredoc 里的 SQL）、`db.dropDatabase()` | `SELECT`、`grep "DROP TABLE"`、`git commit -m "…drop table…"` |
| `sql-truncate` | `TRUNCATE TABLE x`（大小写不限）、大写 `TRUNCATE x` | Unix `truncate -s 0 f`、英文里的 truncate、`rg "TRUNCATE TABLE"` |
| `dropdb` | `dropdb`、`mysqladmin drop` | `createdb`、`mysqladmin status` |
| `prisma-reset` | `prisma migrate reset`、`prisma db push --force-reset` | `migrate dev`、`db push`、`generate` |
| `framework-db-drop` | `rails/rake db:drop / db:reset / db:purge`、`manage.py flush` | `db:migrate`、`db:seed`、`manage.py migrate` |
| `redis-flush` | `FLUSHALL`、`FLUSHDB` | 其他 redis-cli 命令 |
| `stagent-write` | 重定向 `>`/`>>` 到 `.stagent/`、`tee`、`sed -i` / `perl -i`、`cp`/`install`/`rsync`/`ln` 目标在 `.stagent/`、`mv`/`rm`/`touch`/`mkdir`/`chmod`/`truncate` 参数在 `.stagent/`、`dd of=`、`git checkout/restore/rm/mv/clean/apply` 作用于 `.stagent/` | 只读：`cat`、`ls`、`grep`、`cp .stagent/x /tmp/`、`git add/diff .stagent`、`sed -n` |

判定方式：

- 命令先被拆成简单命令（按 `;` `&&` `||` `|` `&` 换行 `$(` 反引号拆分，引号内容合成一个词，`2>`、`2>&1` 正确处理），跳过 `sudo` / `env` / `VAR=…` / `xargs` 等前缀找到真正执行的命令；`bash -c "…"`、`sh -c`、`eval` 的内容递归拆开。
- 结构类规则（rm、find、git、`.stagent/` 写入）看命令名与参数；数据库类规则用正则匹配每个简单命令的文本，但跳过 `grep`/`rg`/`ag`/`ack`/`git` 这些搜索与提交命令。
- `rm -r` 不论带不带 `-f` 都拦（Claude Code 里没有交互确认，`-f` 与否同样危险）；放行名单是依赖与构建产物目录：`node_modules dist build out coverage .next .nuxt .svelte-kit .turbo .cache .parcel-cache .vite __pycache__ .pytest_cache target`。目标含 `..`、绝对路径、`~`、变量或（在这些目录之前的）通配符时一律不算放行。
- 强推一律拒绝，包括 `--force-with-lease`。
- `git checkout -- <单个文件>` / `git restore <单个文件>` 放行：AI 撤销自己改过的文件是常见操作；整体丢弃（`.`、`:/`、`*`、`-f`）才拒绝。
- 起草会话的 Bash 也可以写 `.stagent/checks/draft/`（含 `..` 的路径除外）。

### 扩展：`config.guard.bashRules`

```json
{ "guard": { "bashRules": ["^npm publish", "/deploy\\s+--prod/i"] } }
```

每项是正则源码，或 `/源码/flags` 形式（`g`、`y` 会被去掉），匹配**整条命令原文**；ruleId 为 `config:<下标>`。非法正则被忽略：离线 hook 在 stderr 打印警告，服务端静默忽略。

## hook 约定（Claude Code）

来源：2026-10 抓取的 Claude Code 官方 hooks 文档（`https://code.claude.com/docs/en/hooks`，原 docs.anthropic.com 地址 301 跳转至此）。

- stdin：`{ session_id, transcript_path, cwd, hook_event_name: "PreToolUse", tool_name, tool_input, … }`；Bash 的 `tool_input.command`。
- 拒绝：stdout 只打印 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Stagent 守卫：…"}}`，exit 0。原因会给到 Claude。
- 放行：exit 0、不输出任何内容（不强制 allow，交给正常权限流程）。
- 输入不是合法 JSON、不是 PreToolUse 事件 → 放行，不崩溃。
- 注意：hook 进程非 0/2 退出或超时时 Claude Code 默认**放行**，所以 `runPreToolUseHook` 内部吞掉所有异常，退化为不读账本的默认规则判定，保证始终 exit 0 并给出结论。

## 在线 / 离线 `src/guard/hook-cli.ts`

项目根目录 = 从输入的 `cwd` 向上第一个含 `.stagent/` 的目录（其次 `$CLAUDE_PROJECT_DIR`，再其次进程 cwd）。

| 情况 | 判定 | 写 guard.blocked |
|---|---|---|
| `.stagent/service.lock` 的 pid 活着且有端口 | POST 原始 stdin 到 `http://127.0.0.1:<port>/api/guard/pre-tool-use`（3 秒超时），以服务结论为准 | 服务写（服务是账本唯一写入者），并推送 SSE `ledger.appended` |
| 服务锁的进程活着但请求失败 / 超时 | 本地判定（`draftAllowed=false`，`.stagent/` 照样拒绝） | **不写**，避免两个进程同时写同一条事件链 |
| 没有服务（无锁或陈旧锁） | 只读打开账本算锁定路径，本地判定（`draftAllowed=false`） | hook 直接追加（账本未锁定时） |
| 账本锁定（🔒） | 照常判定，`.stagent/` 内写入一律拒绝 | 不写 |

服务端接口 `POST /api/guard/pre-tool-use`（`src/server/guard-routes.ts`）：请求体就是 hook 的 stdin，返回 `{ decision: 'allow' | 'deny', reason?, ruleId? }`；拒绝时写 `guard.blocked { changeId?, path, tool, detail }`，`changeId` 取 `GuardHost.activeChangeId()`。文件工具的 `path` 是相对项目根目录的路径，Bash 的 `path` 是命令原文（截断到 200 字），`detail` 是给 AI 的原因。这个接口只可能写 `guard.blocked`，不可能产生已验证（`test/invariants/` 的伪造请求循环覆盖它）。

`GuardHost` 由 `StagentService` 实现：`activeChangeId()` 暂时恒为 `null`（M2-2 接上改动流程），`isDraftingSession()` 暂时恒为 `false`（M3-2 接上起草会话），所以现阶段草稿目录对所有会话都关闭。

## pre-merge-commit 提醒

- 只在 `.git/hooks/` 存在时安装；脚本带 `# stagent pre-merge-commit reminder` 标记，重复 init 幂等。
- 已有不带标记的同名钩子 → 跳过并警告，不覆盖。
- 关闭：`.stagent/config.json` 设 `"guard": { "preMergeReminder": false }` 后重新运行 `stagent init`，会删除自己装的脚本。
- 环境变量 `STAGENT_MERGE` 非空时不提醒：M2-3 的合并门提交时会设置它。
- `git merge --ff-only` 等不产生合并提交的情况 git 不会调用这个钩子。

## 假设与局限

- **附录 B 缺失**：规则表是推断的，规格补齐后以规格为准（规则 id 稳定，可增删）。
- **SDK spike 未做**：Claude Code Agent SDK 下 hook 的实际行为（如 MultiEdit / NotebookEdit 字段、子代理是否触发）尚未实测，字段以官方文档为准，M3 适配器接入时验证。
- Bash 规则是静态的尽力检查：变量展开、别名、脚本文件、`python -c` / `node -e` 里的写文件、`cd .stagent && echo > x` 这类先切目录再写的写法都看不到。`.stagent/` 的最终防线仍是账本哈希链与检查快照：改了锁定检查的文件也不会被当作证据（执行器只跑快照，Invariant 4）。
- hook 命令是 `npx stagent …`，要求项目能解析到 stagent（本地依赖或全局安装）；`npx` 首次下载的输出走 stderr，不影响 stdout 的 JSON。
- `.stagent` 大小写不敏感比较在大小写敏感的文件系统上会多拦 `.Stagent/` 之类的路径，可接受。
