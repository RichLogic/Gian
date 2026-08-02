# Three-runtime architecture — Pure TTY 模式 + Structured ↔ TTY 运行时切换

> 这份 plan 的"封装快照"在 `docs/runtime-modes/`（README、context、architecture、findings、references）。新 session 必须先读那个目录再回到这里。

## Context

**Why now**: 2026-06-15 起 Anthropic 把 `claude -p` / Agent SDK 切出订阅 usage limits，单独走 "Agent SDK monthly credit"；interactive `claude` 继续走订阅。Gian cc-proxy 全部建在 `claude -p` 上 → 6/15 后每次互动都消耗 Agent SDK credit。要给订阅用户保留省钱通道，需要把 interactive TTY 接进来。

**Outcome**: 用户在任何 idle 时刻都能给当前 session 切换 Structured ↔ TTY，**不需要建新 session**。Claude/Codex 原生 session id 在两个模式间共享（`--session-id` + `--resume`），历史延续。TTY 模式下 host 通过 HTTP hooks 接收生命周期事件做 notification / 状态 / IM 推送，**不重做结构化卡片**。

---

## Architectural decisions (锁定)

1. **Mode 是 session-scoped 且 mutable**：`sessions.runtime_mode` 列存当前模式，运行时可改。前置条件：session 当前 idle（无 active turn、无 pending approval、TTY 不在等 permission）。否则 RPC 抛 `SWITCH_BLOCKED`
2. **同 session 共享 Claude/Codex 原生 session id**：首次 spawn（任一 mode）`--session-id <uuid>`，后续 spawn（任一 mode）`--resume <uuid>`。无缝跨模式延续
3. **每个 session 一个 dispatcher 实例**：`{ structured: StructuredBackend; tty: TtyBackend | null; active }`。TTY backend 是 lazy 的，首次切 TTY 才实例化；切回 Structured 时 PTY kill + tmp settings 清，dispatcher 不丢
4. **Hooks 通过 `--settings <path>` per-spawn 注入**：每次启动 PTY 生成 `/tmp/gian-claude-<sid>/settings.json`，hooks URL 带一次性 token；spawn 后即可删 tmp
5. **Composer 渲染由 mode 决定，但 sendMessage RPC 永远存在**：Structured 走子进程 spawn；TTY 走 bracketed paste 写 PTY stdin。IM bot / 队列 / Job Mode 同一入口
6. **Codex 没有 Claude-style hooks**：notification 通过 tail `~/.codex/sessions/<id>.jsonl` + cwd fs.watch 凑（路径实施时验证）
7. **新 session 默认 `structured`**：NewSession 表单不加 Runtime 选项；进 session 后用 header toggle 切

---

## Scope — 8 sub-tasks

### B1. DB + runtime_mode plumbing
- 新迁移 `packages/host/migrations/018_runtime_mode.sql`：
  ```sql
  ALTER TABLE sessions ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'structured';
  ```
- `RuntimeMode = 'structured' | 'tty'`（`packages/shared/src/index.ts`）
- `SessionRecord` 加字段
- WS `session:switch-runtime { session_id, target }` 消息类型 + broadcast `session:runtime-switched`

### B2. Runtime dispatcher in cc-proxy
- 现 `ClaudeMcpRuntime` 不改名，作为 `structured backend`
- 新 `packages/proxies/cc-proxy/src/runtime/tty-claude-runtime.ts`，同样 implements `ClaudeRuntime`
- `packages/proxies/cc-proxy/src/core/service.ts` 重构出 dispatcher：
  - `Map<sessionId, { structured: StructuredBackend; tty: TtyBackend | null; active: 'structured' | 'tty' }>`
  - 入参带 `sessionId` 的方法按 `active` delegate
  - 模型发现 / slash probe 独立于 dispatcher（`claude -p --bare`），结果共享
- 新方法 `switchRuntime(sessionId, target)`：
  - 校验 idle，否则 throw `SWITCH_BLOCKED`
  - 切 TTY：lazy 实例化 + `spawnPty` + active='tty'
  - 切 Structured：`tty.killSession` + 释放 + active='structured'
  - 同步写 DB + emit `runtime.switched`
- `InitializePayload.mode` 不再 hardcode 'spawn'

### B3. Claude TTY backend
- 加 dep：`node-pty` to `packages/proxies/cc-proxy/package.json`
- `TtyClaudeRuntime`：
  - `spawnSession`:
    - 写 `/tmp/gian-claude-<sid>/settings.json`（hooks 块见 B4）
    - `pty.spawn('claude', ['--settings', tmpPath, ...(firstSpawn ? ['--session-id', uuid] : ['--resume', uuid]), '--add-dir', cwd, ...(modelArg)], { name: 'xterm-256color', cols, rows, cwd, env })`
    - PTY output → 服务端 ring buffer（默认 1MB，配置项）
    - PTY output → WebSocket binary push
  - `sendMessage`：bracketed paste（`\x1b[200~` + text + `\x1b[201~` + `\r`）写 stdin
  - `killSession`：`pty.kill('SIGTERM')` + ring buffer 清 + tmp settings 删
  - `respondPermission`：TTY 下 throw（不该被调，approval 在终端里用户自己批）
  - `resetClaudeSessionId`：kill + 新 UUID 重 spawn（`/clear` 的 TTY 版）
- WS 协议：`pty:input`（binary）+ `pty:output`（binary）+ `pty:resize`（json）

### B4. HTTP hook receiver + per-session settings.json
- `packages/host/src/web/app.ts` 新路由族：`POST /internal/hooks/:executor/:gianSessionId/:event`
  - body 是 hook JSON；executor ∈ `claude | codex`；event 是小写化的事件名
- 安全：bind 127.0.0.1 + 一次性 hook token（注入到 settings.json 的 URL query），verify 后转发
- settings.json 模板：
  ```json
  {
    "allowedHttpHookUrls": ["http://127.0.0.1:8990/*"],
    "hooks": {
      "SessionStart":     [{ "hooks": [{ "type": "http", "url": "...?t=<token>", "timeout": 10 }] }],
      "UserPromptSubmit": [{ "hooks": [{ "type": "http", "url": "...?t=<token>", "timeout": 10 }] }],
      "Stop":             [{ "hooks": [{ "type": "http", "url": "...?t=<token>", "timeout": 30 }] }],
      "StopFailure":      [{ "hooks": [{ "type": "http", "url": "...?t=<token>", "timeout": 30 }] }],
      "Notification":     [{ "matcher": "*", "hooks": [{ "type": "http", "url": "...?t=<token>", "timeout": 10 }] }],
      "FileChanged":      [{ "hooks": [{ "type": "http", "url": "...?t=<token>", "timeout": 10 }] }],
      "SessionEnd":       [{ "hooks": [{ "type": "http", "url": "...?t=<token>", "timeout": 10 }] }]
    }
  }
  ```
- 每个 receiver 路径 normalize 到现有 unified event：
  - `SessionStart` → 持久化 `native_session_id` + broadcast `session_started`
  - `UserPromptSubmit` → `turn.started` + session status='running'
  - `Stop` → `turn.completed` + status='idle' + IM ping（last_assistant_message 进 transcript）
  - `StopFailure` → `turn.failed`
  - `Notification`（matcher: notification_type）→ 红点 / 桌面通知 / IM badge
  - `FileChanged` → 复用现有 Files tab 事件路径
  - `SessionEnd` → cleanup（kill PTY、清 tmp、移除 session 映射）

### B5. Codex TTY runtime
- 加 dep：`node-pty` to `packages/proxies/codex-proxy/package.json`
- `packages/proxies/codex-proxy/src/runtime/tty-codex-runtime.ts`：
  - spawn 真实 `codex` 到 PTY（CLI 参数实施时确认）
  - 同样 ring buffer + WS binary
- Notification surface（两条腿）：
  - `packages/proxies/codex-proxy/src/runtime/codex-session-tailer.ts`：tail codex session JSONL（路径实施时定位）；新行 → emit `turn.started/completed`
  - cwd fs.watch（用 `chokidar`，gitignore-aware）→ FileChanged
- codex-proxy 内部 HTTP POST 到 host 同一路由（`/internal/hooks/codex/...`），保持路径统一

### B6. Web UI: Terminal panel + 模式联动
- 加 dep：`@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` to `packages/web/package.json`
- 新组件 `packages/web/src/components/Terminal.tsx`：
  - 订阅 `pty:output` (binary)
  - keystroke → `pty:input`
  - resize observer → `pty:resize`
  - 连接 / 切到 TTY 时拉 ring buffer replay
- `packages/web/src/views/CodingView.tsx`:
  - `session.runtime_mode === 'structured'` → 渲染 Transcript + Composer（现状）
  - `session.runtime_mode === 'tty'` → 渲染 Terminal，**不渲染 Composer**
  - 切换瞬间 fade transition
  - status pill 状态由各自模式的事件驱动

### B7. Runtime mode toggle UI
- session 头部状态栏（现有 Approval Mode picker 旁边）新增 Runtime toggle：
  - 两段式按钮：`Structured` / `TTY`
  - 当前 mode 高亮
  - 点未激活段 → 发 `session:switch-runtime` WS 消息
- 切换失败（`SWITCH_BLOCKED`）→ 顶部 toast 提示原因
- 切换成功 → 主面板自动切（B6 联动）
- NewSession 表单**不加** Runtime 选项

### B8. Bootstrap / docs / validation
- README + CLAUDE.md：三种模式 + 计费边界 + TTY 安全（127.0.0.1 only, token 鉴权）
- 不写自动化 e2e（PTY+xterm 测起来复杂），用 manual 验证清单

---

## Critical files

新增：
- `packages/host/migrations/018_runtime_mode.sql`
- `packages/proxies/cc-proxy/src/runtime/tty-claude-runtime.ts`
- `packages/proxies/codex-proxy/src/runtime/tty-codex-runtime.ts`
- `packages/proxies/codex-proxy/src/runtime/codex-session-tailer.ts`
- `packages/web/src/components/Terminal.tsx`

改动：
- `packages/shared/src/index.ts` — `RuntimeMode`、SessionRecord 加字段
- `packages/shared/src/web.ts` — 新 WS messages：`pty:input` / `pty:output` / `pty:resize` / `session:switch-runtime` / `session:runtime-switched`
- `packages/host/src/session/manager.ts` — 新方法 `switchRuntime(sessionId, target)` + idle 校验
- `packages/host/src/proxy/types.ts` — SessionRecord 扩字段
- `packages/host/src/web/ws-handler.ts` — 接 `session:switch-runtime` 路由
- `packages/host/src/web/app.ts` — 新 `/internal/hooks/:executor/:sid/:event` 路由族
- `packages/host/src/event/normalize-cc.ts` — hook event → unified event normalizer
- `packages/host/src/event/normalize-codex.ts` — codex tailer event → unified
- `packages/proxies/cc-proxy/src/core/service.ts` — dispatcher + `switchRuntime`
- `packages/proxies/cc-proxy/src/runtime/types.ts` — `respondPermission` doc 注明 TTY backend throws
- `packages/proxies/cc-proxy/package.json` — `node-pty`
- `packages/proxies/codex-proxy/package.json` — `node-pty`
- `packages/web/package.json` — `@xterm/xterm` family
- `packages/web/src/views/CodingView.tsx` — mode-aware layout
- `packages/web/src/components/SessionHeader.tsx`（或现有 header 文件）— Runtime toggle
- `packages/web/src/components/Composer.tsx` — render gate (mode === 'structured')
- `README.md`、`CLAUDE.md` — 文档

可复用：
- `EventEnvelope` + WS broadcast 链路（`packages/host/src/web/ws-broadcast.ts`）
- `ApprovalManager`、`SessionManager.afterUnified` — TTY 不走 approval 链路，但 turn 事件路径复用
- 现有 P0~P3 ExitPlanMode / AskUserQuestion / PlanChip — 仅 Structured 模式生效，不动
- `--session-id <UUID>` / `-r <id>` resume 在 TTY 一样工作（CLI reference 已确认）

---

## 实施顺序（依赖图）

```
B1 (DB + types) ─┬─→ B2 (dispatcher) ─→ B3 (Claude TTY)  ─┐
                 │                                         ├─→ B6 (UI) ─→ B7 (toggle) ─→ B8 (docs/validate)
                 └─→ B4 (hook receiver) ───────────────────┤
                                                           │
                              B5 (Codex TTY + tailer) ─────┘
```

B1 阻塞性前置。B2 / B3 / B4 是 Claude TTY 主链路。B5 是 Codex 子项（可并行）。B6~B8 收尾。

---

## Verification

每段做完都得过：

**B1** — 跑迁移，老数据 `runtime_mode='structured'`；新 session DB 看到默认值

**B2 + B3 (Claude TTY)** — 新 TTY session：xterm 看到 `claude` 启动；多行 paste OK；resize 生效；刷新页面 ring buffer replay 拿回最近 1MB；同时另开 Structured session，确保 P0~P3 plan-mode 没回归；`pnpm -F @gian/cc-proxy test:unit` 通过

**B4 (hooks)** — TTY session 启动后 `host.out` 看到 SessionStart 命中；调一个 Bash tool，Stop hook 触发后 status pill 翻 idle；关浏览器再开，Stop 事件已持久化、重 broadcast；curl 错 token → 401，正确 → 200

**B5 (Codex TTY)** — codex TTY xterm 跑起来；session-tailer emit `turn.started/completed`；cwd 改文件 → FileChanged 事件到 host

**B6 (UI)** — TTY session 看不到 Composer，Files tab 还能看；Structured session 看不到 Terminal

**B7 (toggle)** — Structured session header 看到 toggle，默认高亮 `Structured`；点 `TTY` → 主面板换 xterm + Composer 隐藏；再点 `Structured` → PTY kill + Composer 回；继续发消息 Claude 历史延续（`--resume`）；turn 进行中点 toggle → toast "等当前 turn 完成"；pending approval 时点 toggle → toast "先处理 approval"；刷新后状态保持

**Cross-cutting** — `pnpm -r typecheck` 全工作区干净；`~/Coding/Gian` curated push 链路正常

---

## Open risks / 不确定项

1. **Codex CLI 实际接口**：session JSONL 路径、PTY 启动参数、退出码语义需要 B5 阶段验证
2. **Hook payload 大小**：`Stop` 带 `last_assistant_message` 可能很大，30s 超时风险；handler 异步落库 + broadcast，hook 响应快返
3. **xterm.js bundle**：约 150KB；考虑 dynamic import
4. **PTY 跨平台**：node-pty 在 macOS 编译 OK（v22）；Linux 暂不管
5. **TTY 版 `/clear`**：现有 `/clear` 在 cc-proxy 拦截 + 轮换 claudeSessionId；TTY 模式得 kill PTY + 新 UUID 重 spawn，UX 略不同，B3 文档化
6. **IM bot 入 TTY**：sendMessage RPC 转 PTY stdin 可工作；但 IM bot 看不到 Stop hook 之外的中间过程，体验降级（已接受）
7. **Structured → TTY 切换时 Composer 有未发送文本**：前端弹 confirm "未发送内容会丢失"
8. **TTY → Structured 时 PTY 在等审批**：识别为 busy，禁切；hook 状态机里加 `awaiting_permission_in_tty` 字段
