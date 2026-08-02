# Gian 技术架构

> 版本 0.3 · 2026-07-31

## 系统概览

Gian 由独立 Host、三个 executor proxy、React Web 和可选 Electron
壳组成。Host 是唯一状态持有者；Web、Desktop 和 IM 都不持有业务真相。

```text
Claude / Codex / Kimi
          |
          v
Proxy subprocesses <--- stdio NDJSON ---> Host <--- WebSocket ---> Web
                                             |                    ^
                                             |                    |
                                             +--> Discord/Slack   +-- Electron shell
```

所有 AI session 都只走结构化 runtime：

- Claude：每个 session 一个 cc-proxy，底层为 `claude -p`
- Codex：共享 codex-proxy，底层为 Codex app-server
- Kimi：共享 kimi-proxy，底层为 ACP

Session TTY 已按 ADR-0008 全部移除。Workbench Terminal 是独立的 workspace
shell，使用 `term:*` WebSocket 协议，是 Gian 唯一保留的 PTY；它不参与
session runtime、消息队列或 transcript。

## Monorepo 模块

| Package | 职责 |
|---|---|
| `packages/shared` | 纯 TypeScript 协议和数据类型；无业务逻辑、无运行时副作用 |
| `packages/host` | HTTP/WS、session/task/workspace、审批、队列、事件、存储、原生会话 replay、IM、Workbench Terminal |
| `packages/web` | React SPA；Coding、Tasks、Spaces、Files、Bots、Settings、Workbench |
| `packages/desktop` | 薄 Electron 壳；加载独立 Host 提供的 UI |
| `packages/proxies/cc-proxy` | Claude `claude -p` 适配，逐 session 进程 |
| `packages/proxies/codex-proxy` | Codex app-server 适配，共享进程 |
| `packages/proxies/kimi-proxy` | Kimi ACP 适配，共享进程 |

## Host 子系统

| 目录 | 职责 |
|---|---|
| `proxy/` | 启动、监控并路由三个 proxy |
| `session/` | Session 编排；repository、history store、turn runtime 与 lifecycle service 分离，manager 只协调跨子系统流程 |
| `task/` | Manager/Subtask 协作、action 协议、handoff 和摘要 |
| `workspace/` | Workspace、git/worktree 与文件操作 |
| `approval/` | default/auto 审批策略和待决请求 |
| `queue/` | Session 忙碌时的 FIFO 消息队列 |
| `event/` | 保留三个 provider 原生事件，并投影到页面展示分类 |
| `events/` | 冷 transcript 清理与 native JSONL 惰性重建 |
| `native/` | 原生 session 扫描、定位、adopt 和 replay |
| `im/` | Discord/Slack transport；共享 session context/presentation/command flow，不复制 Gian session 状态 |
| `term/` | Workbench Terminal 的 node-pty 生命周期 |
| `web/` | Hono REST、静态资源和 WebSocket dispatch |
| `auth/` | 单用户密码登录、临时 session token 与 HTTP/WS 鉴权 |
| `storage/` | SQLite 初始化、迁移和持久化访问 |

不存在独立 Event Router 对象。`SessionManager` 发出 provider-native
`ChatEvent`，Host 直接广播给 Web 和已启用的 IM 平台；Web/IM 只依赖其
可选 `display`，不把三套 CLI 的原生事件名互相归一化。

Discord/Slack 不是第二套 session runtime。平台仓储只保存 bot 配置、
inbound dedupe 和 outbox；选中的 `session_id` 指向 Gian 的 canonical
`sessions`。见 ADR-0009。

## Web 边界

`App.tsx` 是 shell coordinator，不再承载所有实现：

- `controllers/use-app-auth.ts` 在任何 WS/业务请求之前完成登录判定；
- `controllers/use-session-commands.ts` 封装 session command dispatch；
- `components/sheet-model.ts` 与 `terminal-wire.ts` 是无 React 重组件依赖的
  model/wire 边界；
- `SessionMain`、session list status 与 workspace create 已拆成独立 view；
- Coding、Spaces、Bots、Files、Sheet、Terminal、CommandPalette 和登录页按
  route/capability 懒加载。

认证失败时只渲染 `LoginView`，不启动 WS 或加载业务数据。见 ADR-0010。

## 边界协议

| 边界 | 通道 | 契约 |
|---|---|---|
| Proxy ↔ Host | stdio NDJSON | JSON-RPC 风格方法、响应和异步通知；见 `protocol-proxy.md` |
| Host ↔ Web | WebSocket JSON | `packages/shared/src/web.ts`；契约测试要求发送端/接收端零漂移 |
| Host ↔ IM | 进程内 TypeScript API | 平台 adapter 只翻译，不拥有 session 状态 |
| Desktop ↔ Host | HTTP/WebSocket | Electron 只校验和加载允许的本地 origin |

修改 proxy 方法、通知或 WebSocket 消息时，必须同时检查：

1. `packages/shared` 的类型；
2. 实际发送方和接收方；
3. `CONTRACT-001` 到 `CONTRACT-004` 测试；
4. `docs/quality/traceability.md`。

## 数据与事件

SQLite 默认位于 `$GIAN_DATA_DIR/gian.db`。Session、Task、Workspace、
Queue、Approval 和配置是持久业务状态；`turns/events` 是可从 provider
原生历史重建的 transcript hot cache。

三个 provider 的通知以原生 method/payload 落库并通过 WebSocket 发送。
provider adapter 只生成 `packages/shared/src/events.ts` 定义的 UI display
projection；未知原生事件可以没有 projection，但不会因缺少统一事件名而丢失。
旧数据库中的统一事件名只在 history 读取边界兼容。详见
[`chat-event-display.md`](chat-event-display.md)。

历史数据库仍可能包含 `runtime_mode`、`turns` 和 `tty_turn_seq` 列。
migration 038 会将其归一为兼容值；应用模型不再读取或写入这些列。

IM 的 duplicated session/turn/queue tables 已由 migration 039 删除。运行中
的消息队列是 `queue_entries`；平台 outbox 直接引用 canonical session。
早期 `bots` 表只作为旧安装的一次性迁移输入。未使用的 `tokens` 和旧
`queue` 表由 migration 041 删除。

## 关键决策

| 主题 | 当前决定 |
|---|---|
| 状态所有权 | Host 唯一持有，其他界面均为消费端 |
| Session runtime | 结构化 proxy only；无 session TTY |
| PTY | 只保留 Workbench Terminal `term:*` |
| Claude | `claude -p`，每 session 一个 cc-proxy |
| Codex | app-server，共享 codex-proxy |
| Kimi | ACP，共享 kimi-proxy，保留原生配置语义 |
| IM | 共享 Host session 状态；平台仅拥有 transport 状态 |
| 登录 | HTTP `whoAmI` 先于 WebSocket 和业务数据加载 |
| Desktop | 独立 daemon 上的薄 Electron 壳 |
| 持久化 | SQLite + 顺序迁移 |
| 实时通信 | Host/Web 使用 WebSocket |
| 包管理 | pnpm workspace |

主要 ADR：

- `ADR-0003`：Desktop 是独立 daemon 上的薄壳
- `ADR-0004`：Kimi ACP 与原生 CLI 语义
- `ADR-0005`：Composer 保留原生 CLI 选项
- `ADR-0006`：provider-authoritative context usage
- `ADR-0008`：移除所有 session TTY，仅保留 Workbench Terminal
- `ADR-0009`：IM 使用 Host canonical session 状态
- `ADR-0010`：Web shell 受登录边界保护
- `ADR-0011`：Manager create-subtask 统一走 Host action 协议
