# stagent

Stagent 不写代码。它记住系统由哪些已验收功能组成，每个功能靠哪些锁定的验收例子和系统亲自运行的检查证明仍然成立；每次改动后告诉你哪些还成立、哪些被破坏、哪些只是 AI 声称。

## 开发

需要 Node 20+。

```bash
npm install
npm run check   # 类型检查 + lint
npm test        # vitest
npm run build   # 编译到 dist/
```

## 当前进度

- [x] M1-1 项目脚手架与账本内核（事件链）—— 见 [docs/ledger.md](docs/ledger.md)
- [x] M1-2 检查快照、workTreeHash 与检查执行器 —— 见 [docs/executor.md](docs/executor.md)
- [x] M1-3 状态投影、本地服务、init 与首页结论卡 —— 见 [docs/service.md](docs/service.md)
- [x] M2-1 守卫：PreToolUse 拦截与危险命令规则 —— 见 [docs/guard.md](docs/guard.md)
- [x] M2-2 改动流程：两档、互斥、外部改动识别与状态机 —— 见 [docs/changes.md](docs/changes.md)
- [x] M2-3 授权三段式事务与服务端合并门 —— 见 [docs/auth.md](docs/auth.md)
- [ ] ★ MVP 试用检查点（tasks.md 第 4 节，不写代码）

## CLI

```bash
stagent init                                          # 初始化 .stagent/、账本、config.json 草稿、.gitignore、守卫 hook
stagent [--port 4310] [--host 127.0.0.1] [--no-open]  # 启动本地服务
stagent ledger verify [--root <dir>]                  # 校验事件链：0 完好 / 2 锁定 / 3 版本不符
stagent ledger accept --reason <原因> [--root <dir>]   # 账本被修改时接受当前状态
stagent hook pre-tool-use                             # Claude Code PreToolUse 守卫（由 init 写入 .claude/settings.json）
```

看效果：`npm run demo`（生成示例项目并在 0.0.0.0:4310 启动）。
