# Proposal: 解耦 session 与 worktree（对话可中途切换/新建 worktree）

> 2026-07-31 调研快照。方向由用户拍板：**在 Gian 层面把对话和 worktree 拆开**
> ——"在一个对话里开个新 worktree 完全是合理操作，创建时锁死不合理"。
> 本文件记录各 executor 的硬约束、host 侧的 mutation surface、以及待用户
> 决策的模型选项。尚未实施；定下模型后应写 ADR supersede 相关结论。

## 现状（为什么现在锁死）

`sessions.worktree_path` 在创建时写入（`packages/host/src/session/manager.ts:444-458`），
是 session 的执行 cwd：proxy bring-up（`manager.ts:702`）、Workbench 终端 cwd、
文件/diff/stage 全部 `/api/working_trees/wt:<sid>/*` API、Claude 原生 JSONL
watcher 都消费它。唯一的 mutation 是终态 merge/drop（置 NULL + archive）。

## 各 executor 的 resume × cwd 约束（硬事实）

### Claude（cc-proxy，每 turn 新 spawn `claude -p`）—— 最硬的约束

- 续聊 = `--resume <uuid>`（`claude-mcp-runtime.ts:954-955`）；cwd 固定在
  proxy `SessionRecord.cwd`（`service.ts:220,236`），协议无 per-turn cwd。
- transcript 在磁盘上按 cwd 分目录：`~/.claude/projects/<cwd 编码>/<uuid>.jsonl`
  （`packages/host/src/native/locate-jsonl.ts:32-40`）。换 cwd 后 `--resume`
  在新 project dir 找不到 transcript。
- **最坏的失败模式**：resume 失败时 cc-proxy 静默 rotate 成新 session
  （`service.ts:777-808`）——跨 cwd 切换会"无报错丢历史"。
- repo 自己的 fork 逻辑就依赖这个不变量（fork 继承父 cwd，
  `manager.ts:404-417`）。repo 内没有任何 JSONL 搬迁/复制代码。

### Codex（app-server）

- `thread/resume { threadId }` 无 cwd 参数；`thread/start { cwd, … }` 创建时
  锁定；`turn/start` 只有 `runtimeWorkspaceRoots`（扩大可写沙箱，不改 cwd）。
- rollout 按 id 定位、**不**按 cwd 分目录（`locate-jsonl.ts:48-85`）——
  transcript 可移植，但被 resume 的 thread 仍在创建时的 cwd 执行。
- 结论：换 cwd ≈ 新 thread（resume 无法 retarget），或接受 Gian 视角与
  Codex 实际执行目录的背离。

### Kimi（ACP）

- `session/load` / `session/resume` 每次都带 `{ sessionId, cwd, mcpServers }`
  （`kimi-proxy/src/core/service.ts:276-286`）——**唯一原生支持 resume 时
  重新指定 cwd 的 executor**。agent 端是否认账（vs 报错/忽略）未验证，
  值得做一次 live probe。

## Host 侧 mutation surface（如果 cwd 可变）

大部分路径每次现读 DB（working-tree API、`cwdForSession`、merge/drop/delete），
是安全的。三个缓存必须失效：

1. proxy client + `proxySessionIds` 映射（否则活 proxy 继续用旧 cwd）；
2. cc-proxy `SessionRecord.cwd`；
3. JSONL watcher 的 `filePath`（`watcher.ts:69-90`，start 是 no-op）。

现有模板：`teardownProxy`（`manager.ts:2256-2265`）+ `session.rotated` 的
watcher 重启块（`manager.ts:2758-2772`）正好演示了这两种失效模式。
运行中的 turn 不受中途变更影响（进程已用旧 cwd spawn），下一个 turn 生效。

相关测试 pin：`wt-001-worktree-lifecycle.test.ts:180-181`（proxy 必须用
worktree cwd）、cc-proxy `service.test.ts:720-738`（resume 形状）、
`session-manager.test.ts:576-674`（fork 继承父 cwd）。

## 待决策的模型选项

- **A. 视图级先行（已落地 2026-07-31）**：面包屑 worktree 下拉只切
  "看哪棵树"（`wtView`/`viewedWorkingTreeId`，按 session 隔离），执行不变。
  这是零风险的第一步，但不是用户要的真解耦。
- **B. 真解耦，按 executor 分策**：
  - Kimi：直接 re-attach 新 cwd（先 probe）。
  - Codex：换 worktree = 新 thread（接受上下文靠 Codex 自身 compaction/
    handoff，或显式告诉用户"切树开新线程"）。
  - Claude：要么搬迁/软链 JSONL 到新 project dir（新代码，需处理
    custom-title 等 in-place 写入），要么每次切树开新 native session
    （接受上下文断裂，或先发一段 handoff 摘要）。
- **C. 数据模型**：session 从"一个 worktree_path"变成"一组 working trees
  （主树 + N worktree）+ 当前活动树"。merge/drop 生命周期、`wt:<sid>` API
  id 方案（也许变成 `wt:<tree-id>`）、删除级联都要跟着改。

## 开放问题

1. Claude 的 JSONL 搬迁是否可行/值得（vs 切树即新 native session）？
2. Codex app-server 是否有未文档化的 resume cwd override？（repo 内不可证）
3. 切换时正在运行的 turn：允许排队"turn 结束后生效"，还是直接禁止？
4. UI 入口：面包屑下拉升级为"切换执行树"？"在对话里新建 worktree"放哪？
