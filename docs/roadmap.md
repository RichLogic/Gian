# Gian Roadmap

> 路线图 v1 · 2026-05-06
> 目的：把 PRD v0.3 的剩余范围拆成可并行的里程碑，给 team-of-agents 模式提供共识基线。

> **历史里程碑文档（2026-07-31）**：本文不再代表当前产品范围。
> Job Mode、Tunnel/remote access 和所有 session TTY 已从实现中移除；
> 现状以 `docs/architecture.md`、ADR-0008 和
> `docs/quality/traceability.md` 为准。

## 当前状态（基线）

完成端到端最小路径：Web → WS → Host → Proxy（cc / codex）→ Session 创建 → 对话 → 部分事件渲染 → 基础审批。
PRD 范围约 20% 完成，余下 80% 按下面 6 个里程碑推进。

## 里程碑

| M | 主题 | 轨道（可并行） | 阻塞依赖 |
|---|------|--------------|---------|
| **M0** | 基础重构 | ① 拆 `App.tsx` ② 定义 12 种事件归一化 taxonomy + Event Router 骨架 ③ `auth/queue/approval/im` 模块接口骨架 | — |
| **M1** | 核心 Session 体验 | ① 后端归一化 12 种事件 ② 前端补 6 种缺失事件渲染 ③ Approval 工作流（风险等级 / allow_session / Pending 徽标） ④ Composer 完整工具栏（model / approval mode / context bar） ⑤ Message Queue | M0 |
| **M2** | Job Mode + Files | ① Job Mode（多 Turn + 进度条 + Stop） ② Files Tab Changed 视图 + diff + 语法高亮 ③ Slash 命令透传 | M1 |
| **M3** | IM 集成 | ① Discord adapter ② Slack adapter ③ Bot 模式 + 引导式 Slash Commands ④ 前端 Bots 页 | M1 Approval 跨通道 |
| **M4** | Spaces / Settings / Auth / Voice | ① Spaces 页 ② Settings 页 ③ Auth（账密 + cookie + token） ④ 语音输入（STT + LLM 排版） | 各自独立 |
| **M5** | 远程访问 + 全局功能 + 部署 | ① Tunnel + Public URL ② Command Palette ⌘K ③ WS 重连 + 连接状态面板 ④ Daemon 安装脚本 | M4 Auth |
| **M6** | 打磨 + 开源就绪 | i18n / 视觉迁移 / E2E / README / LICENSE | M5 |

预估：每个 M 约 1–2 个工作 session（含整合 + smoke test）。整体 6–10 sessions。

## Team 规则（agent 协议）

**单条轨道流程**：
```
我（主编） → 写 brief（文件清单 + acceptance + 协议依赖 + 坑）
agent     → 实现 + 自查 + 跑 typecheck
我（集成） → typecheck → smoke → commit 或返工
```

**并行约束**（避免互踩）：
- 每个 agent 只能写自己 brief 里列出的文件
- `App.tsx` 顶层装配只允许主编动；agent 只增不删 import
- `shared/src/*` 新增类型由主编先定形，agent 只引用
- 跨 agent 共享类型时通过 `shared/src/` 流转，不直接 import 别 agent 的内部文件
- 单 M 并发上限 ≈ 5 agent

**所有 agent brief 必须包含**：
- `verbatimModuleSyntax: true` → 类型用 `import type`
- import 路径用 `.js` 后缀（bundler 模式）
- 改 proxy 协议前先读 `/Users/you/Coding/acme/{cc,codex}-proxy/`（CLAUDE.md 强制）
- 不写多余注释，遵守仓库 style

## 不变约束

- Host 端口 **8990**，Web 端口 **5190**（CLAUDE.md / AGENTS.md），出现 rvc 保留端口字面量视为 bug
- Proxy 进程模型：codex 单进程多 session、cc 一 session 一进程
- SQLite 单文件，路径 `$GIAN_DATA_DIR/gian.db`
- 12 种事件类型（PRD §一）：`assistant_text / thinking / command_execution / file_change / file_read / file_search / web_search / agent_spawn / approval_requested / approval_resolved / turn_completed / session_error`
- IM 通道强制 auto 审批，不展示审批卡片（PRD §二）

## 当前进行中

- **M0** — ✅ 完成（2026-05-06）
  - Agent A：`packages/web/src/App.tsx` 1381 → 157 行，拆出 14 个文件，typecheck + build 通过
  - Agent B：`shared/src/events.ts`（242 行，12 种事件 + 类型化 envelope）+ `host/src/event/{router,normalize-codex,normalize-cc}.ts` 骨架
  - 主编：`host/src/{approval,queue,auth,im}/` 接口骨架，全部 typecheck 通过
- **M6** — ✅ 完成（2026-05-06）
  - Track A · i18n：`web/src/i18n/{messages,en,zh,index.tsx}`，151 个 key 双语；翻译了 8 个 chrome 文件（Topbar/MainNav/Composer 工具栏/SettingsPanel/LoginView/SpacesView/BotsView/NewSessionForm）；transcript items / CommandPalette / QueueList / FilesView 仍英文（PRD 接受 follow-up）
  - Track B · 视觉迁移：从 `design/` 补 268 行 CSS — Topbar inbox-popover 全套样式（之前没 CSS 只 JSX）、`:focus-visible` ring 全互动元素覆盖、`--border` token 三主题补齐
  - Track C · E2E：Playwright 装好（`@playwright/test ^1.49`）；3 spec 13 测：app-loads / workspace-and-session / command-palette；用 className selector；webServer 双进程 + reuseExistingServer；session 真启动那段因 proxy 没装只验到 WS dispatch
  - Track D · 开源就绪：`README.md`（177 行）+ `LICENSE`（MIT，Year 2026 / "Gian contributors"，可改）+ `CONTRIBUTING.md`；App.tsx 加 `useEffect` 把 `data-theme/data-accent/data-density` 写到 `body`、`lang` 写到 `html` — 跟 `tokens.css` 现有 `body[data-theme="..."]` selector 对齐
  - Track E · Files 收尾 + Reconnect：自写 80 行正则高亮（zero deps，覆盖 ts/js/py/json/css/sh/md）+ `/api/workspaces/:id/file_meta` 端点（git status 检测 uncommitted + events 表 LIKE 查 today edit count，approximation 已 flag）；`POST /api/reconnect/:component` 4 个组件（codex/claude/discord/slack）+ `ProxyManager.closeByExecutor` + IM adapter 重启；Topbar 的 Reconnect 按钮接通；顺手把 i18n agent 误用 .ts 扩展的 JSX 文件改 .tsx
- **M5** — ✅ 完成（2026-05-06）
  - Track A · Tunnel：`TunnelManager` spawn cloudflared（带 3 次重试 + 退避）/ exec tailscale funnel（exec-and-forget，daemon 持有状态）/ none + reverse-proxy no-op；`force_https` 暴露在 `status()` 但 redirect middleware 留给 M6
  - Track B · Command Palette ⌘K：popover 模糊搜 sessions / files (Changed events) / commands；⌘K + Ctrl+K 双绑；选 command 走 `CustomEvent('gian:palette-command')` 派发，Composer 自己接（避免状态上提）
  - Track C · WS 重连 + 状态面板：ws.ts 加 `state` + `onState`，断线 1→2→4→8→16→30s 退避；`auth_ok` 后立即 `state_sync` 灌全量；Topbar 替成可点击 status chip + popover 显示 Codex/Claude/Discord/Slack 状态；Reconnect 按钮按 PRD 渲染但 disabled（M6 接）；断连横幅
  - Track D · Daemon 脚本：`scripts/install/macos/com.gian.host.plist`（launchd LaunchAgents）+ `scripts/install/linux/gian.service`（systemd user）+ `install.sh` / `uninstall.sh`（sed 替换 INSTALL_DIR / NODE_BIN / HOME）+ `scripts/README.md`
  - Track E · 持久化 + tech debt：migration 004/005 加 tokens + queue_entries 表；`TokenManager` 改 SQLite + sha256 哈希；`QueueManager` 改 SQLite；Bot `extra` 字段 AES-256-GCM 加密（`GIAN_SECRET` env 派生 key，未设时 fallback dev key + 一次性 warn）；旧明文行 lazy migration；`setWebTakeover` 接通 ws-handler `message:send`
- **M3** — ✅ 完成（2026-05-06）
  - Phase 1（主编）：装 `discord.js` + `@slack/bolt` 依赖；3 个 stub 文件（`discord.ts` / `slack.ts` / `BotsView.tsx`）+ App.tsx 接 BotsView slot
  - Track A · Discord adapter：discord.js v14 client，DM-only + Channel/Message partials；slash command 用 `deferReply` + `pendingInteractions` map（Track C 通过 `editMessageId=interaction.id` 编辑回复，拿到 15min 窗口）；解决 `PartialGroupDMChannel` 类型分歧；按 1900 字符切分长消息
  - Track B · Slack adapter：@slack/bolt v4 socket-mode；DM-only（`channel_type==='im'`）+ allowed_user_id allowlist；slash 命令前缀化（`/gian-new` 等 5 个），`ack()` 立即调用避免 3s retry；按 3900 字符切分；reactions/typing 在 Slack 上 no-op（PRD 明确）
  - Track C · Bot CRUD + IMRouter + Slash 状态机：`003_bots.sql` 重建 bots 表加 CHECK constraint；`storage/bots.ts` 持 token 为明文（M5 加密）；IMRegistry 实装；`router.ts` 订阅 SessionManager 新增的 `onEvent(fn)` 钩子（轻量回调 vs EventRouter）；5 个 slash 命令全实装（new/switch/alter/stop/status，5min 超时）；按 Bot mode + takeover 通道过滤事件（read-only=只 turn_completed/session_error；full-control 接管时全流，非接管时同 read-only）
  - Track D · BotsView：两栏布局镜像 SpacesView；Config / Permissions / IM Preview / Logs 4 个子页；Token 字段 `type=password` + Show/Hide；platform-specific 表单（Discord token+app_id / Slack bot+app token+prefix）；后端 404 时 graceful 空态
  - 整合：build 全过；agent 之间互相补 bug（discord.ts 类型 / router.ts cast / tokens.ts 字段）
- **M4** — ✅ 完成（2026-05-06）
  - Phase 1（主编）：3 个 stub 文件（SpacesView / SettingsPanel / LoginView）+ App.tsx 接 SpacesView/SettingsPanel/LoginView slot + Topbar 加 onSettingsClick prop
  - Track A · Spaces：4 个 risk 字段加进 `Workspace` model + migration `002_workspace_risks.sql`；新端点 PATCH/DELETE/reorder workspaces；SpacesView 两栏布局（list ↑↓ + detail 含 4 个 risk 下拉 + 关联 sessions）
  - Track B · Settings：`saveConfig` + `GET/PATCH /api/settings`；SettingsPanel 5 段式 slide-over（System/Executor/Voice/Remote/Appearance），draft + Save 按钮 + saved 提示
  - Track C · Auth：`scrypt` 密码哈希（无新依赖）+ in-memory token store + opt-in middleware（`GIAN_AUTH_REQUIRED=true` 启用）；POST /login + /logout + GET /me；LoginView 表单；App.tsx 用 `whoAmI` 探测替代 `useState(true)`；密码哈希存在 config 表 `auth_password_hash` 字段（migration 已有）；首次启动随机生成密码并 log 一次
  - Track D · Voice：Composer mic 按钮 + MediaRecorder hook（`audio/webm;codecs=opus`，红点脉动 + 计时）；POST /api/stt 用原生 fetch 调 OpenAI Whisper；STT API key 从 `OPENAI_API_KEY` env 读；权限拒绝 / key 未配置时按钮禁用 + tooltip
  - 各 track 顺手补 bug：Track B 触发 shared package rebuild；Track D 修了 Track C 的 tokens.ts 缺字段
- **M2** — ✅ 完成（2026-05-06）
  - Track A：Job Mode — SessionManager 加 `jobs` map + `maybeJobContinue` 钩入 `handleLifecycle`；自动发 "continue" prompt；停止启发式：last assistant_text 含 done/complete/finished/all set；`JobProgress.tsx` 从 transcript items 推导进度，无新 WS 消息
  - Track B：Files Tab — `/api/workspaces/:id/{changed,diff}` 端点（`git diff` execFileSync 5s timeout），`FilesView` 加 Changed/Tree 切换 + diff 渲染（端口 apply.ts 的 unified diff 解析）+ "Open in new tab" 按钮；Changed 取当前 Session 的 file_change 事件去重
  - Track C：Composer slash 透传 — `/` 工具栏按钮 + 输入 `/` 自动唤出 popover；hardcoded 命令表（claude 8 个 / codex 4 个）；↑↓ 导航、Enter 选中、ESC 关闭；选中后插入命令到 textarea，用户编辑参数后正常 send
  - 整合：`activeSessionId` + `initialPath` 接到 FilesView；App.tsx 加 mount 时解析 `?ws/path/view=files` 的 useEffect；Track B 顺手修了 Track A `JobProgress.tsx` strict array access 小 bug
- **M1** — ✅ 完成（2026-05-06）
  - Phase 1（主编）：SessionManager 注入 ApprovalManager + QueueManager，handleNotification 重构成 lifecycle/normalize/legacy 三段；新增 setApprovalMode / setModel / 队列 facade；ws-handler 加 7 个新 dispatch；App.tsx + CodingView + Composer 预接 prop 接口；QueueList 占位
  - Track A：codex（8 种映射）+ cc（10 种映射）的 normalizer 实装。token_usage / debug 走 legacy passthrough。codex web_search 暂跳过（无活事件），cc Write 默认 `kind:'create'`（proxy 限制）
  - Track B：5 个新事件类型渲染（command_execution / file_read / file_search / web_search / agent_spawn），含 streaming 输出。apply.ts 同时支持 unified + legacy 名字
  - Track C：ApprovalManager 实装 — auto/default 模式 + 风险等级 + allow_session 记忆；Topbar 加 Pending 徽标 + popover；用 setter 注入 SessionManager 回调避免循环依赖
  - Track D：Composer 完整工具栏 — model picker（hardcoded 列表）、approval mode 切换 + turns、context bar 含 token compact 进度
  - Track E：QueueManager.sendNow + SessionManager.sendQueuedNow + WS handler；QueueList UI（编号、↑↓ 重排、移除、Send now / Clear）
  - 整合：onQueueSendNow 接通；清掉 SessionMain stale void 块；typecheck + build 全过
- **M2** — 待启动

## M0 / M1 已落地的决策

- **任何 proxy 没有的事件直接跳过**（不在 taxonomy 里占位）。已据此从 12 种降为 11 种 — 移除了 `thinking`（codex 不支持，cc 暴露的是 `effort` 模型设置而非思考内容）。
- **Codex `web_search` 缺活事件** → 跳过，cc-only。
- **CC 没有 `allow_session` scope** → Host 层用 `ApprovalManager.wasAllowedForSession` 模拟记忆。
- **`approval.resolved` 字段名分歧**（cc 用 `behavior`、codex 用 `decision`）→ M1 normalizer 按字段存在性区分。
- **上游 proxy 路径** → `~/Coding/{cc,codex}-proxy`，`host/src/index.ts` 用 `os.homedir()` 拼。
- **`token_usage.updated` 不进 unified taxonomy**：是 session 元数据（compact 指示器），暂走 legacy passthrough。M2/M5 改成 `session:updated` 字段。
- **CC `Write` 默认 `kind:'create'`**：cc-proxy 不区分 create/overwrite。前端按需用文件存在性推断。
- **ApprovalStatus 没有 `approved-once`**：M1-C 把 `allow_once` 映射为 shared 的 `'approved'`。如果以后要区分 once vs session，扩 shared model。
- **ApprovalManager 解依赖**：通过 `setRespondFn` / `setGetModeFn` setter 注入 SessionManager 回调，避免循环 import。
- **Composer 模型列表 hardcode**：M4 Settings 加 backend models API 后再驱动。
- **QueueManager 仍是 in-memory**：M5 加 SQLite 持久化（重连不丢队列）。
- **Job Mode 用 "continue" prompt + 关键词停止启发式**：足够 M2 用，未来可换成 executor 显式信号或更细的判断。
- **Files Tab Changed 范围 = 当前 Session 的 file_change 事件**（PRD 待确认项 #3 收敛）。Git uncommitted 视图不做。
- **Job Mode 排队消息行为未定**：用户在 Job 进行中往队列加消息，当前是队列优先（下个 turn 发队列消息），可能和 Job 意图冲突。M3+ 决策。
- **Files Tab 语法高亮 / "今日编辑次数" / uncommitted 徽标** 全部推 M6（polish）。
- **Slash 命令列表 hardcode**：M4 Settings 配套 Backend models / commands API 时再驱动。
