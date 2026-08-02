# Architecture — 三模式 + 运行时切换

## 三模式定义

| 模式 | 内部驱动 | 计费 | UI 主面板 | 这轮做不做 |
|---|---|---|---|---|
| **A. Structured** | `claude -p --output-format stream-json` + MCP approval bridge（**今天的代码**） | Agent SDK credit (6/15+) | Transcript（卡片）+ Composer | 保留不动 |
| **B. Pure TTY** | interactive `claude` 在 PTY 里跑 + xterm.js + HTTP hooks（仅做 notification） | 订阅 quota | xterm 终端 | **这轮重点** |
| **C. Terminal Wrapper（套壳）** | B + Gian 结构化卡片并列 | 订阅 quota | xterm + 卡片 | 推迟 |

> Codex 这次也加 TTY 模式（mode B 对等），但 Codex 没有 hooks，notification 走 session JSONL tail + cwd fs.watch。

## 关键架构决策（plan 里锁定的）

### 1. Mode 是 session-scoped 且 **mutable**

> **原本设计成 immutable 在创建时定，后来用户改主意要 mutable。**

- DB 列：`sessions.runtime_mode TEXT NOT NULL DEFAULT 'structured'`
- 运行时可以切，但前置条件：session 当前 idle（无 active turn、无 pending approval、TTY 不在等 PTY-side permission）
- 不满足条件 → RPC 返回 `SWITCH_BLOCKED` + 原因；前端 toast 给提示

### 2. 同 session 共享 Claude/Codex 原生 session id

两个模式无缝切换的核心：

- 首次 spawn（任一 mode）用 `--session-id <uuid>`（uuid 由 Gian 生成）
- 后续任何一次 spawn（任一 mode）用 `--resume <uuid>`
- Claude / Codex 自身的对话历史天然延续，模式切换不丢上下文

### 3. 每个 session 一个 dispatcher 实例

```
SessionDispatcher
├── structured: StructuredBackend  (一直存在，等价于今天的 ClaudeMcpRuntime)
├── tty: TtyBackend | null          (lazy，切到 TTY 才实例化)
└── active: 'structured' | 'tty'
```

- 入参带 `sessionId` 的所有方法（`sendMessage / killSession / respondPermission / resetClaudeSessionId`）按 `active` delegate
- 切 TTY：if `tty == null` 实例化 + spawn PTY；设 `active = 'tty'`
- 切 Structured：if `tty != null` `tty.killSession()` + 释放（`tty = null`）；设 `active = 'structured'`
- 切完同步写 DB `sessions.runtime_mode` + broadcast `runtime.switched` 事件

### 4. Hooks 通过 `--settings <path>` per-spawn 注入

- 每次启动 PTY 时生成 `/tmp/gian-claude-<sid>/settings.json`
- 内容：hooks 配置 + `allowedHttpHookUrls: ["http://127.0.0.1:8990/*"]`
- 每个 hook URL 带 `?t=<token>`（一次性，每次切到 TTY 新签）
- Spawn `claude --settings <tmpPath> --session-id <uuid> --add-dir <cwd>`
- Settings 加载完即可删 tmp（claude 已读入内存）

### 5. Composer 和 Terminal 互斥

- UI 层：根据 `session.runtime_mode` 渲染 Composer **或** Terminal，不同时存在
- 但 `sendMessage` RPC 永远工作：
  - Structured 模式 → 现在的子进程 spawn 路径
  - TTY 模式 → bracketed paste（`\x1b[200~` + text + `\x1b[201~` + `\r`）写 PTY stdin
- 这保证 IM bot / 队列 / Job Mode 用同一 RPC 入口，UI 隐藏不影响后端能力

### 6. Codex 的 notification 走两条腿

- `~/.codex/sessions/<id>.jsonl` tail（实施时确认实际路径）：新行 append → emit `turn.started / completed`
- cwd 的 `chokidar` watch（gitignore-aware）：emit FileChanged 等价事件
- codex-proxy 内部用 HTTP 把这些事件 POST 到 host 同一个 `/internal/hooks/...` 路径，host 侧路径统一

### 7. 新 session 默认 `structured`

- NewSession 表单**不加** Runtime 选项（保持兼容）
- 用户进 session 之后用 header 上的 toggle 切

## 用户拍板过的几个 UX 细节

来自 2026-05-14 的 AskUserQuestion 回答：

- **Composer 在 TTY 模式**：完全隐藏，只用 xterm 输入
- **Codex TTY 范围**：和 Claude TTY 平起平坐做（不做半套）
- **历史 session 迁移**：不动，用户手动 opt-in TTY
- **Mode 时序**（后续改）：mutable，**任何时候**都能切（不在创建时定死）

## 模式切换边界情况

- **Structured → TTY 时 Composer 文本框有未发送内容**：弹 confirm "未发送内容会丢失"
- **TTY → Structured 时 PTY 正在等审批**（用户没在终端里批）：识别为 busy，禁切
- **任何模式下 turn 进行中**：禁切，按钮短暂禁用 + toast "等当前 turn 完成"
