# Codex CLI runtime mode — 设计文档

**日期：** 2026-05-20
**状态：** S0 验证完成 — 可写实施计划
**范围：** 把 `claude` session 已有的 CLI（pure-TTY）模式镜像到 `codex`
session：用户在 session header 点 CLI tab，host 在 PTY 里跑一份交互式
`codex resume <uuid>`，xterm.js 双向透传，跟 CHAT 模式共享 codex 自身的
thread UUID，历史无缝延续。

---

## 1. 背景与动机

### 1.1 为什么现在做

Anthropic 在 2026-06-15 把 `claude -p` / Agent SDK 切出 Claude 订阅 usage
limits，单独走 Agent SDK monthly credit。Gian 的两个 proxy 都建在子进程化
的 CLI 调用上 —— cc-proxy 走 `claude -p`，codex-proxy 走 `codex
app-server` 协议。订阅用户在 6/15 之后每次交互都会消耗 Agent SDK credit，
对 Claude 侧来说是真实成本爆炸；Codex 这边订阅模型未来类似分叉的可能性也
存在。

`docs/runtime-modes/` 那 5 份文档（context / architecture / findings /
plan / references）是 2026-05-14 决策对话的封装快照，锁定了"三模式 +
mutable 切换"架构。其中 plan 的 **B5 sub-task = Codex TTY runtime**，跟
Claude TTY（B3）当时是孪生立项；但当前 `main` 只落了 Claude CLI 骨架
和 shared `pty:*`/runtime-mode plumbing，Codex 侧还没起步。

### 1.2 用户原话与解读

> "同样的逻辑给 codex 的 session 也实现一版吧，就是也允许 codex resume，OK 吗？"

强调的是 **resume 能力**和 UX 对称，不是通知 / 状态指示对齐。结合 claude
CLI 当前现状（hook 基础设施 ship 了，但 normalizer 还是 v0 generic
broadcast），本设计**只交付 PTY 骨架 + resume**，达到与 claude CLI 今天等
价的水平。Notification normalizer（claude hook events → unified events、
codex JSONL tail → unified events）作为独立的后续 chunk，不在本设计范围
内。

### 1.3 已经存在、本设计**不动**的部分

- `sessions.runtime_mode` 列（migration 021）：`'structured' | 'tty'`，含
  默认值
- WS 协议族 `pty:input / pty:output / pty:resize / pty:replay-request /
  pty:replay`（`packages/shared/src/web.ts`）
- `session:switch-runtime` / `session:runtime-switched` WS 消息
- `<Terminal>` 组件 + `TerminalWire` adapter（`packages/web/src/
  components/Terminal.tsx`），目前主区 CLI 用 `makeSessionWire(ws,
  sessionId)`
- `SessionManager.switchRuntime` 现有 idle 前置校验（active turn /
  pending approval）。本期还要补 server-side terminal/finalized guard；
  不能只依赖前端 disabled
- claude 侧 `TtyManager` / `TtyClaudeRuntime` / `TtyClaudeService` /
  `/internal/hooks/claude/*` 路由族

这些全部复用。Codex CLI 是这套机制的"再用一次"。

---

## 2. 架构

### 2.1 进程拓扑

```
┌──────────────────┐  WS pty:*          ┌──────────────────────────┐
│   web (xterm.js) │ ─────────────────→ │ host                     │
│                  │                    │  ├── TtyManager (claude) │
└──────────────────┘                    │  └── CodexTtyManager     │
                                        └──────────┬───────────────┘
                                                   │ JSON-RPC stdio
                                ┌──────────────────┴──────────────────┐
                                ↓                                     ↓
                  ┌──────────────────────┐               ┌────────────────────────┐
                  │ cc-proxy (per-sess)  │               │ codex-proxy (shared)   │
                  │  TtyClaudeService    │               │  TtyCodexService [新]  │
                  │  TtyClaudeRuntime    │               │  TtyCodexRuntime [新]  │
                  └────────┬─────────────┘               └────────┬───────────────┘
                           │ node-pty                              │ node-pty
                           ↓                                       ↓
                    [ claude PTY ]                          [ codex PTY ]
```

- codex-proxy 已经在 `CLAUDE.md` 里定义为「单进程共享所有 Codex sessions」
  的形态；新 `TtyCodexRuntime` 内部用 `Map<gianSessionId, IPty>` 区分多
  session 的 PTY，跟 host 的 `WorkbenchTerminalManager` 一个模式（参考
  `packages/host/src/term/manager.ts`）
- **三种 id 必须分清**：
  - `gianSessionId`：Gian DB / web WS 使用的 session id
  - `proxySessionId`：codex-proxy 内 `SessionRecord.id`，host
    `CodexProxyHost.sessions` 当前按这个 id 路由 notifications
  - `codexThreadId`：Codex 原生 thread UUID，存到
    `sessions.native_session_id`，CLI 用 `codex resume <codexThreadId>`
- Codex TTY notification 不能只带 `gianSessionId`。共享
  `CodexProxyHost.dispatch()` 会先看 `params.sessionId` 决定投递给哪个
  facade，所以 `tty.output` / `tty.exited` payload 约定为：
  `{ sessionId: proxySessionId, gianSessionId, data/code/signal }`。
  `sessionId` 服务 host facade routing；`gianSessionId` 服务
  `CodexTtyManager` 广播 `pty:*`
- **S0.2 结果（2026-05-20）**：现有
  `packages/host/test/codex-proxy-client.test.ts` 通过，证明
  `CodexProxyHost` 按 `params.sessionId` 路由到对应 facade。实现时还要新增
  `tty.*` 专项测试，pin 住 `params.sessionId = proxySessionId` 且 payload
  保留 `gianSessionId`
- host 侧不复用同一个 `TtyManager` —— Claude 那个绑了 `TtyHookRegistry` /
  `buildSettings` / `handleHook` 等 hook 体系。Codex 没 hooks，硬塞会污染抽
  象。因此新建瘦版 `CodexTtyManager`，公共接口（`start / stop / input /
  resize / replay`）对齐，但不暴露 hook 表面

### 2.2 模块清单

#### 新增

| 文件 | 行数估计 | 内容 |
|---|---|---|
| `packages/proxies/codex-proxy/src/runtime/tty-codex-runtime.ts` | ~180 | `Map<gianSessionId, IPty>` + ring buffer（1 MiB） + `spawnSession` / `writeBytes` / `pasteMessage` / `resize` / `killSession` / `removeSession` / `snapshotBase64` / `isSessionAlive` / `stop`。事件 `output / exited / debug`。可注入的 `PtyFactory` 用于单测（mirror `packages/host/src/term/manager.ts:85` 的接口）|
| `packages/proxies/codex-proxy/src/core/tty-service.ts` | ~120 | JSON-RPC 服务：`tty.start / tty.input / tty.resize / tty.kill / tty.replay`；`tty.start` 入参带 `gianSessionId`、`proxySessionId`、`codexThreadId`；构造时接 `emitEvent` sink，转发 `tty.output / tty.exited / debug` notifications，且 `tty.*` notification 的 `params.sessionId` 必须是 `proxySessionId` |
| `packages/host/src/tty/codex-manager.ts` | ~120 | `CodexTtyManager.start / stop / input / resize / replay / handleProxyNotification / persistMode`。**不带** `buildSettings` / `TtyHookRegistry` / `handleHook` |
| `packages/proxies/codex-proxy/test/tty-codex-runtime.test.ts` | ~140 | fake PtyFactory，覆盖 spawn 参数构造、resize、kill、re-spawn 同 sessionId、ring buffer 边界 |
| `packages/host/test/codex-tty-manager.test.ts` | ~120 | mock `CodexProxyClient`，覆盖 `start`（native id + id routing）/ `stop` / `input` / `resize` / `replay`、`handleProxyNotification` 路由、`persistMode` 写库；如 S0.1 失败，再覆盖 0-turn fallback |

#### 修改

| 文件 | 改动 |
|---|---|
| `packages/proxies/codex-proxy/src/cli/spawn.ts` | 实例化 `TtyCodexService`，注册到 JSON-RPC dispatcher，把 notification sink 接到上游 |
| `packages/host/src/proxy/codex-proxy-client.ts` | 新增 5 个 PTY passthrough：`ttyStart / ttyInput / ttyResize / ttyKill / ttyReplay`。`ttyStart` 需要从 facade 带上当前 `proxySessionId`；如果 facade 尚未 `createSession`，先走现有 `ensureProxySession`。加 notification 钩子让 `tty.output` / `tty.exited` 能被 host 的 `CodexTtyManager.handleProxyNotification` 接住 |
| `packages/host/src/session/manager.ts` | `switchRuntime` 当前只看 `this.ttyMgr`；改成按 `session.executor` 二选一调 claude / codex manager。删掉 `executor !== 'claude'` 的硬拒。Codex 分支必须要求 `native_session_id` 存在（当前 schema 已 NOT NULL），并把 `message:send` 在 `runtime_mode='tty'` 下的行为定义清楚（本期先拒绝，见 §3.4） |
| `packages/host/src/web/ws-handler.ts` | `pty:input / pty:resize / pty:replay-request` 现在直接调 `tty`；改成查 `session.executor` 路由到 `tty` 或 `codexTty` manager |
| `packages/host/src/index.ts` | wire 新 `CodexTtyManager`，传入 `SessionManager` 和 ws-handler |
| `packages/web/src/views/CodingView.tsx:1265` | `ttySupported = session.executor === 'claude' || session.executor === 'codex'`。CLI 按钮的 disabled 逻辑不动 |

#### 零改动 / 复用

- DB migration：无（`runtime_mode` 已经够用）
- WS 协议：无新消息类型（`pty:*` 共用）
- shared types：无新增（`RuntimeMode = 'structured' | 'tty'` 不变）
- `<Terminal>` 组件：完全复用，wire 工厂 `makeSessionWire(ws, sessionId)` 也复用 —— wire 不关心后端是 claude 还是 codex

---

## 3. 数据流

### 3.1 切到 CLI（CHAT → CLI）

```
user 点 CLI tab
   │
   ▼
ws.send({ type: 'session:switch-runtime', target: 'tty' })
   │
   ▼
ws-handler → SessionManager.switchRuntime(sessionId, 'tty')
   │
   ├── 现有 guards: not active turn, no pending approval,
   │                 not finalized worktree, ttyMgr/codexTtyMgr 存在
   │
   ├── ensureProxySession(session)
   │      → 返回 proxySessionId
   │
   ▼
  switch (session.executor)
   │
   ├── 'claude' → ttyMgr.start(...)                          ── 现状，不动
   │
   └── 'codex' → CodexTtyManager.start(session, cwd, geom)
                    │
                    ▼
                  require session.native_session_id
                    │
                    ▼
                  codexThreadId = session.native_session_id
                  proxySessionId = facade proxy session id
                    │
                    ▼
                       codexProxy.ttyStart({
                         gianSessionId: session.id,
                         proxySessionId,
                         codexThreadId,
                         cwd, cols, rows, model
                       })
                                     │
                                     ▼
                 codex-proxy TtyCodexService.start
                                     │
                                     ▼
                 TtyCodexRuntime.spawnSession({...})
                       │
                       ▼
                 pty.spawn('codex', [
                   'resume', codexThreadId,
                   '-C', cwd,
                   '--add-dir', cwd,
                   ...(model ? ['-m', model] : []),
                 ], { TERM: 'xterm-256color', cols, rows, cwd })
                       │
                       ▼
                 ring buffer + PTY output 流回 host
                       │
                       ▼
                 emit tty.output {
                   sessionId: proxySessionId,
                   gianSessionId: session.id,
                   data: <base64>
                 }
                       │
                       ▼
                 host 广播 pty:output → web xterm
                       │
                       ▼
                 DB UPDATE sessions SET runtime_mode='tty', updated_at=NOW()
                       │
                       ▼
                 broadcast session:runtime-switched + session:updated
```

### 3.2 0-turn resume 预检：`thread/start` → `codex resume` 是否可接

Claude 那边可以预先 `--session-id <uuid>` 拿一个我们生成的 UUID 注册新
session；codex CLI **没有这个 flag**。codex 的接口只有：
- `codex` 裸跑（codex 自己生成 UUID，写到 `~/.codex/sessions/<YYYY>/<MM>/<DD>/.../<uuid>.jsonl`）
- `codex resume <已存在UUID>`

当前 Gian 不是在切 CLI 时才 mint Codex thread。`SessionManager.createSession`
已经会先调 codex-proxy `session.create`，拿到 `thread/start` 返回的 thread
UUID，并把它写到 `sessions.native_session_id`；migration 013 之后该列是
NOT NULL。所以真正风险不是 "session 无 native id"，而是：

> **新建但还没有任何 turn 的 Codex thread UUID，能不能立刻被
> `codex resume <uuid>` 找到？**

如果 app-server 只把 thread 放在内存里、要等首条消息才 flush 到
`~/.codex/sessions/...`，那新建 session 立刻切 CLI 会拿到一个已有
`native_session_id`，但 `codex resume <uuid>` 仍然失败。

**S0 结果（2026-05-20）**：通过。用
`CodexAppServerClient.startThread({ cwd: /Users/rich/Coding/GianDev })`
创建 0-turn thread `019e4541-7ce7-7aa1-9a09-3e626bb4479f`，随后用
`expect` 启动 `env TERM=xterm-256color codex resume <uuid>`，TUI 成功进入
交互界面，未出现 "not found" / "No session" 类错误。

复现实验：

```bash
# 启动 codex app-server
codex app-server &
# 用 websocket client 调 thread/start，记录返回 uuid
# 立刻在另一个终端：
codex resume <返回uuid>
# 看是否能进入交互界面（即便对话内容为空）
```

注意：这次 0-turn thread 没在 `~/.codex/sessions/**/<uuid>.jsonl` 下找到
对应 JSONL；Codex 0.130 看起来还能通过其它本地状态恢复该 thread。因此本期
不要引入 0-turn fallback，也不要把 JSONL/session_index 当成 Codex 0.130 的
唯一 source of truth。

如果未来 Codex 版本让 direct resume 失败，Fallback 二再单独立项：

- 对 **0-turn Codex session**：裸 spawn `codex -C <cwd> --add-dir <cwd>
  [-m <model>]`，用当时版本真实可用的本地索引 / sqlite / rollout 文件发现新
  UUID，再写回 `sessions.native_session_id`
- 对 **已有 turns 的 Codex session**：仍必须走
  `codex resume <native_session_id>`；如果 resume 找不到文件，xterm
  显示错误并退出，不自动 fork 新 thread，避免悄悄断历史
- 需要重新评估持久化格式和 race window，文档化为 P1 风险

如果失败的备选 Fallback 一（spawn 后立刻 paste 一条 noop）会污染用户
transcript，**不采纳**。

### 3.3 切回 CHAT（CLI → CHAT）

```
user 点 Chat tab
   │
   ▼
ws.send({ type: 'session:switch-runtime', target: 'structured' })
   │
   ▼
ws-handler → SessionManager.switchRuntime(sessionId, 'structured')
   │
   ├── 现有 guards
   │
   ▼
  switch (session.executor)
   │
   ├── 'claude' → ttyMgr.stop(...)                  ── 现状
   │
   └── 'codex' → CodexTtyManager.stop(session)
                    │
                    ▼
                 codexProxy.ttyKill({ sessionId })
                    │
                    ▼
                 TtyCodexRuntime.killSession(sessionId)
                    │
                    ▼
                 PTY SIGTERM；ring buffer 保留（下次切 CLI 还能看最后一屏）
                    │
                    ▼
                 DB UPDATE runtime_mode='structured'
                    │
                    ▼
                 broadcast session:runtime-switched + session:updated
```

下一条 CHAT 消息走现有 `CodexAppServerClient.resumeThread(uuid)` 路径，
codex 从同一个 JSONL 接续。**不需要任何额外协调** —— TUI 和 app-server
都读写同一份 `~/.codex/sessions/.../<uuid>.jsonl`，是天然的 single source
of truth。

### 3.4 CLI 模式下 `message:send` 的边界

本期不做 IM / queue / Job Mode → PTY bracketed paste bridge。原因：Codex
CLI 模式的主目标是让用户在 xterm 里直接操作真实 TUI；把后台
`message:send` 同时送进 app-server 会和正在运行的 PTY 竞争同一个 Codex
thread。

因此本期 server-side 规则是：

- `session.runtime_mode === 'structured'`：`message:send` 走现有
  `turn.start`
- `session.runtime_mode === 'tty'`：`message:send` 直接拒绝，错误码沿用
  WS `MESSAGE_SEND_FAILED`，message 建议为
  `"session is in CLI mode; type in the terminal or switch back to Chat"`
- `queue:send_now` / auto-drain 如果目标 session 在 CLI mode，同样不能启动
  structured turn；保持 queued 或返回可解释错误，不能写 phantom turn

后续如果要支持 IM bot 向 CLI mode 发消息，再单独实现
`CodexTtyManager.pasteMessage()` 并把 `message:send` 路由到 PTY stdin。

### 3.5 Spawn 命令完整形态

```bash
codex resume <native_session_id> \
  -C <cwd> \
  --add-dir <cwd> \
  [-m <model>]
```

- `codex` 可执行：`process.env.CODEX_BIN ?? (darwin ? '/opt/homebrew/bin/codex' : 'codex')` —— mirror `CodexAppServerClient` 现有的解析
- `cwd`：`session.worktree_path ?? workspace.path`（mirror claude 路径）
- PTY env：`{ ...process.env }`，**不**强制覆盖 TERM —— claude runtime 也
  没覆盖，spawn 选项里直接传 `name: 'xterm-256color'` 由 node-pty 设
- 默认 cols/rows = `120 × 30`，web mount 后 ResizeObserver 立刻 push 真实
  尺寸
- **不带** `-s` / `-a` —— 走用户 `~/.codex/config.toml` 默认；session 级
  sandbox 策略绑定是独立工作
- **不带** `--no-alt-screen` —— xterm.js 支持 alt-screen
- **不带** `--search` / `--oss` / `-c key=value` 等覆盖

---

## 4. 错误处理

| 情况 | 处理 |
|---|---|
| `switchRuntime` idle 校验失败 | 抛 `SWITCH_BLOCKED`（现状），前端 toast |
| finalized worktree session 请求切 runtime | 抛 `SWITCH_BLOCKED`；server guard 必须存在，不能只靠 CLI 按钮 disabled |
| `ensureProxySession` 失败 | 抛原始 error（现状），前端 toast |
| `session.native_session_id` 缺失 | 抛 `SWITCH_BLOCKED`；正常 DB 不应发生（migration 013 后 NOT NULL），这是防御式 guard |
| `ttyStart` RPC 失败 | 抛 `SWITCH_BLOCKED`，DB 不动；ring buffer 不创建 |
| `codex resume <uuid>` 在 codex 进程里失败（比如 session 文件被删） | codex 自己往 stderr 写错误，xterm 显示，ring buffer 留底；host 不重试已有-turn session；0-turn fallback 只在 S0 验证失败后实现 |
| PTY 异常退出（`tty.exited`） | host `handleProxyNotification` 广播 `event` 通知（mirror claude），UI 显示"codex CLI 已退出"，用户可以再次切 CLI 重 spawn |
| switchRuntime 中途 host 进程崩溃 | 重启后 DB `runtime_mode='tty'` 但没真实 PTY；用户重新点 CLI 触发新一次 `start`（runtime 是 idempotent，`spawnSession` 内会先 `killSession`） |
| `ttyInput / ttyResize` 在 PTY 已死的情况下 | runtime 端 `if (!session || session.exited) return` 早退（mirror claude），WS 客户端无感 |
| `message:send` / queue auto-drain 命中 CLI mode session | 本期拒绝 structured turn，不能与 PTY 并发写同一个 Codex thread |

---

## 5. 测试

### 5.1 codex-proxy 单元测

`packages/proxies/codex-proxy/test/tty-codex-runtime.test.ts`：

- spawn 参数构造：默认（resume + uuid + cwd + --add-dir）/ 带 model / 不
  同 cwd 注入。runtime 单测层只看到统一的
  `spawnSession({ codexThreadId, ... })` 入参
- `writeBytes` base64 解码与 stdin 透传
- `pasteMessage` bracketed-paste 序列形态
- `resize` 边界（非有限值 / 负值 跳过）
- `killSession` 幂等 + 标记 exited
- `removeSession` 清表
- 重复 `spawnSession` 同 sessionId 触发先 kill 旧的
- Ring buffer 满 cap 后丢最老 chunk
- `tty.output` / `tty.exited` notification params 使用
  `{ sessionId: proxySessionId, gianSessionId, ... }`，不能把
  `sessionId` 设成 Gian id

### 5.2 host 集成测

`packages/host/test/codex-tty-manager.test.ts`：

- `start`：session 必须已有 `native_session_id` + live proxy facade →
  `ttyStart` 参数包含 `gianSessionId / proxySessionId / codexThreadId`
- `start` 缺 `native_session_id`：抛 `SWITCH_BLOCKED`，DB 不动
- `stop`：调用 `ttyKill`，DB `runtime_mode='structured'` + 广播
- `input` / `resize` / `replay` 转发到 client
- `handleProxyNotification`：`tty.output` → 广播 `pty:output`；`tty.exited`
  → 广播 `event`；使用 `gianSessionId` 广播、使用 `sessionId`
  only for codex-proxy facade routing
- 非 codex executor 的 session 不走 codex manager（在 ws-handler 路由层
  测，或者 codex manager 在 start 时 sanity check）

### 5.3 switchRuntime 集成测

扩展 `packages/host/test/session-switch-runtime.test.ts`（如不存在则新建）：

- codex executor + `target='tty'` → 走 `CodexTtyManager.start`
- codex executor + `target='structured'` → 调 `CodexTtyManager.stop`
- claude executor 不回归（原有断言通过）
- active turn / pending approval / finalized worktree 都阻止 runtime switch

### 5.4 message:send 边界测试

- `SessionManager.sendMessage` 命中 `runtime_mode='tty'` → 不插入 turn /
  event，不调 codex `turn.start`，抛可解释错误
- queue auto-drain / `sendQueuedNow` 命中 CLI mode → 不启动 structured turn
  （保持 queued 或返回可解释错误，按现有 queue 语义落测试）

### 5.5 手工冒烟

`docs/superpowers/plans/2026-05-20-codex-cli-runtime.md` 的 verification
section（实施 plan 阶段写）会列出：

- 新建 codex session、立刻切 CLI（0-turn resume path）→ xterm 出现
  codex 启动画面
- 走 CHAT 几轮 → 切 CLI（已有-turn resume path）→ codex 知道历史
- CLI 里聊几句 → 切回 CHAT → CHAT 继续聊，codex 知道刚才在 CLI 说的
- 切换期间 turn 进行中点 toggle → toast "等当前 turn 完成"
- 关浏览器、重连 → ring buffer replay 拿回最近 ~1 MiB
- 不动 claude session 流程 / Files tab / git status / worktree 操作

### 5.6 Contract / traceability

`tty.*` 目前在 CONTRACT-003 / CONTRACT-004 里是 deferred/out-of-scope
白名单。本期落 Codex CLI 时必须同步更新：

- CONTRACT-003：codex-proxy 如果开始 advertise `tty.start` 等方法，CLI
  dispatch、host client wrapper、shared/deferred 白名单三方要一致。可以选
  择继续让 `tty.*` 作为 concrete-client-only 例外，但白名单理由必须从
  "TTY runtime switching pruned" 改成真实理由，不能保留过期注释
- CONTRACT-004：`tty.output` / `tty.exited` 仍然不走 unified normalizer，
  但 deferred 理由要说明它们由 `TtyManager` / `CodexTtyManager` 直接路由；
  不能说 TTY out-of-scope
- `docs/quality/traceability.md` 加 1 行，初始状态建议是 `GAP`，因为
  "真实 codex resume 历史延续" 需要手工 smoke 或后续更重的 integration
  harness；fake PTY 只能证明 spawn 参数和 routing

```
CODEX-TTY-001 | codex CLI runtime + resume | codex-tty-manager.test +
tty-codex-runtime.test + manual smoke | GAP
```

---

## 6. 实施顺序

```
S0: 两个前置验证
    1. app-server `thread/start` 返回的 0-turn thread UUID 能否立刻
       `codex resume <uuid>`（2026-05-20 已通过）
    2. codex-proxy shared-host notification routing 采用
       `{ sessionId: proxySessionId, gianSessionId }` 后能否投递到正确
       facade（baseline 已由 codex-proxy-client.test 证明，实施时加
       tty.* 专项断言）
       │
       ▼
S1: TtyCodexRuntime（codex-proxy 内）+ TtyCodexService + spawn.ts wiring
       │
       ▼
S2: codex-proxy-client.ts —— 5 个 PTY passthrough + proxySessionId 暴露
       │
       ▼
S3: CodexTtyManager（host 内）
       │
       ▼
S4: SessionManager.switchRuntime 按 executor 分发
    + ws-handler 路由 + CodingView ttySupported gate
    + CLI mode 下 message:send / queue structured-turn guard
       │
       ▼
S5: 0-turn fallback 不做
    S0.1 已通过；保留 codex resume 主路径
       │
       ▼
S6: contract 白名单/registry 更新 + traceability
       │
       ▼
S7: 手工冒烟 + 跑全量测试套件
       │
       ▼
S8: STATE.md / SESSION_LOG / 一条 ADR（"Codex CLI 选 codex resume 路径"）
```

每段 ~50-150 LOC。S0.1 已经通过，因此实施计划不需要 0-turn fallback 分支。

---

## 7. 开放风险

| # | 风险 | 概率 | 影响 | Mitigation |
|---|---|---|---|---|
| 1 | 未来 Codex 版本可能改变 0-turn resume 持久化行为 | 低 | 中（要切 0-turn fallback） | 2026-05-20 在 codex-cli 0.130.0 上 S0.1 已通过；如未来失败，fallback 只允许 0-turn 裸 spawn + 捕获新 UUID，已有-turn 不自动 fork |
| 2 | codex TUI 在 xterm.js 里的渲染异常（特殊控制字符 / mouse 协议） | 低 | 中 | 手工冒烟 S7 必跑；codex 0.130 用标准 alt-screen，xterm.js 支持完整 |
| 3 | codex-proxy shared-host notification routing 吞掉 `tty.output` | 中 | 高（阻塞） | payload 明确 `{ sessionId: proxySessionId, gianSessionId }`；S0.2 写最小 routing proof |
| 4 | `~/.codex/config.toml` 里用户自定义 sandbox = `read-only`，CLI 模式下意外只读 | 中 | 低 | 不在本范围内；用户已经在 config 里选了就是预期 |
| 5 | 用户在 CLI 模式下用 codex 的 `/clear` 之类命令切走 thread | 中 | 中 | codex 自己处理；host 不知情。下次切回 CHAT 时 `thread/resume <旧uuid>` 行为取决于 codex —— 实施 S7 时实测确认。**列为已知 quirk，不阻塞 ship** |
| 6 | CLI mode 下 web/IM/queue 仍走 structured `turn.start`，和 PTY 并发写同一 thread | 中 | 高 | 本期 server-side 直接拒绝 CLI mode `message:send` / queue turn start；paste bridge 单独后续做 |

风险 #1 / #3 已经在 §6 实施顺序里被拆成 S0（前置探查），目的是把不确定性
关到 critical path 最开头。

---

## 8. 不做的事（YAGNI）

明确**不在**本设计范围：

- `~/.codex/sessions/<uuid>.jsonl` tail → unified events 通知 normalizer
  （plan B5 后半段；与 claude hook normalizer 一起做）
- cwd `chokidar` fs.watch → FileChanged 等价事件（plan B5 后半段）
- codex-proxy 内部 HTTP POST 到 host `/internal/hooks/codex/...` 路由族
  （plan B4 的 codex 镜像；与上一项捆绑）
- session 级 sandbox / approval-policy 配置 UI（独立工作）
- CLI 模式下的 IM bot / web composer / queue `sendMessage` 转 PTY paste
  （本期 server-side 先拒绝 structured turn；paste bridge 单独后续做）
- 主区 CLI tab 在 codex executor 下显示不同图标 / 文案（按钮共用，文案
  "CLI" 通用）

这些都可作为独立 chunk 的后续工作，本设计**不预留 hook 抽象**为它们让路
—— 加抽象的成本比将来加这些功能时按需重构更高。

---

## 9. 决策记录预告

实施完成后写一条 ADR `docs/adr/NNNN-codex-cli-runtime.md`：

- **决策**：codex CLI 模式用 `codex resume <native_session_id>`；0-turn
  thread direct resume 已在 codex-cli 0.130.0 上验证通过
- **替代方案**：裸 spawn + tail session_index.jsonl 读 UUID
- **理由**：复用 codex-proxy 现有 app-server 链路，避免引入 chokidar +
  race window 维护成本
- **超越**：如果未来 Codex 版本让 0-turn direct resume 失败，再写新 ADR
  记录 fallback（裸 spawn + 捕获新 UUID）以及为什么不对已有-turn session
  自动 fallback

---

## 10. 用户 review checklist

落到代码前，请确认：

- [ ] 范围（A 方案，仅 PTY 骨架 + resume，不含 normalizer）OK
- [ ] §2.2 模块清单覆盖你预期的改动量
- [ ] §2.1 的三种 id 约定（`gianSessionId` / `proxySessionId` /
      `codexThreadId`）OK
- [ ] §3.2 0-turn direct resume 已通过，本期不做 fallback OK
- [ ] §3.4 CLI mode 下 `message:send` 本期先拒绝 OK
- [ ] §6 实施顺序（S0 作为 go/no-go 检查点）OK
- [ ] §8 "不做的事"清单没有遗漏你期望本期交付的东西

OK 之后生成具体的实施 plan
（`docs/superpowers/plans/2026-05-20-codex-cli-runtime.md`），里面带 step-by-step
任务 + 每步的 verification 命令。
