# 账本内核（M1-1）

对应规格 §4.1 与 tasks.md 的 M1-1。代码在 `src/ledger/`。

## 文件格式

`.stagent/ledger/events.jsonl`，每行一个 JSON 对象（信封）：

```json
{"seq":0,"at":"2026-10-16T08:00:00.000Z","event":{"type":"ledger.meta","ledgerVersion":3,"projectId":"…","createdAt":"…"},"prevHash":"000…0","hash":"…"}
```

- `hash = sha256(prevHash + JCS({ seq, at, event }))`，JCS 为 RFC 8785（`src/ledger/jcs.ts`）。`seq` 与 `at` 也受哈希保护。
- 首行 `prevHash` 为 64 个 `0`；首行必须是 `ledger.meta`，`ledgerVersion` 为 3。
- 写入：进程内写锁 → 重新读盘校验整条链 → 追加并 `fsync`。

## 启动校验规则

| 规则 | 内容 | 结果 |
|---|---|---|
| 1 | 每个完整行可解析；`seq` 等于行号；`hash` 可重算；`prevHash` 等于上一行 `hash` | 任一不符 → 该行记为断链 → 🔒 只读锁定 |
| 2 | 首行是哈希完好的 `ledger.meta` 且 `ledgerVersion == 3` | 版本不符 → 拒绝启动（`LedgerVersionError`）；首行缺失/被篡改 → 断链锁定 |
| 2a | 文件末尾没有换行、且无法解析的半行 | 视为崩溃中断的写入，忽略；下次写入前截掉，不锁定 |

无法解析的行没有存储的 `hash`，其后一行应链接到"该行原始字节的 sha256"——所以后一行必然断链（被记录），而用户接受现状后写入的 override 仍能确定地接上。

## 接受当前状态：`ledger.integrity_override`

账本锁定时，用户可以"我确认，接受当前状态"（`Ledger#acceptCurrentState(reason)`，CLI：`stagent ledger accept --reason …`，原因至少 4 个字）。写入：

```ts
{ type: 'ledger.integrity_override', prefixSha256, brokenLinks, reason, by: 'user' }
```

- `prefixSha256`：override 行之前文件全部字节的 sha256；
- `brokenLinks`：当时未被接受的断链行号。

校验时，一条 override 只有在**自身链接完好且 `prefixSha256` 与实际字节一致**时才生效，并且只接受它之前的、列出的断链。因此：接受之后再改前面任何一行（前缀哈希不符）或后面任何一行（新断链）都会再次锁定；改 override 行本身也会锁定。

## 写锁与事务

`Ledger#transaction(fn)` 在同一把进程内互斥锁里执行 `fn`，`fn` 内的追加依次落盘、不被其它写入插队；事务内直接调用 `ledger.append()` 可重入。供 M2-3 的授权三段式（`auth.consumed` → 副作用 → 结果事件 + `auth.settled`）使用。

## 推断与待规格确认

tasks.md 引用的 spec v2.2 未随任务提供，以下细节为本实现的推断，规格补齐后如有出入以规格为准：

- 规则 1 / 2 / 2a 的具体划分与"版本不符拒绝启动、meta 被篡改则锁定"的区分；
- 信封字段（`seq`、`at` 纳入哈希）；
- `ledger.integrity_override` 的字段与"只接受之前的断链"语义；
- v2.2 新增事件（`auth.consumed`、`auth.settled`、`change.files_attributed`、`plan.*`、`example.red_waived` 等）的字段，见 `src/ledger/types.ts`。

## 不在 M1-1

`~/.stagent/projects/<id>/head` 链头锚点、`head.tmp`、TOFU、从 git 历史恢复（M6-1）；任何界面（M1-3）。
