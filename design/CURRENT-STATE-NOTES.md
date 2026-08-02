# Gian — Web 端实现设计稿（current state, 2026-05-15）

> 这份文档是按 `packages/web/src/` 当前代码反向写的设计稿，目的是在和 Claude Design 对一版新设计图之前，先把"今天产品到底长什么样"完整说清楚。**不是**老 `design/index.html + *.css` mockup —— 那一版和代码已经脱节，新版要从这份文档对齐起。
>
> 全文用类名（`.foo`）+ 文件路径定位，方便设计师/AI 设计师对着源码反查。

---

## 0. 顶层结构

入口：`packages/web/src/App.tsx` → `<App>`。
未登录时整屏渲染 `<LoginView>`，登录后挂 `LocaleProvider` + `.session-app`：

```
.session-app
├── (条件) .ws-disconnect-banner    ← WebSocket 断线时全宽顶警示条
├── <Topbar>                         ← header.topbar，固定顶
├── <SettingsPanel>                  ← 右侧滑出 sheet，覆盖在所有内容之上
├── <CommandPalette>                 ← ⌘K 居中模态
└── .body                            ← 主区，flex row
    ├── <MainNav>                    ← nav.nav，左侧图标导航条
    └── main.stage                   ← 当前 view 的舞台
         ├── <CodingView>            ← view==='coding'
         ├── <FilesView>             ← view==='files'
         ├── <SpacesView>            ← view==='workspaces'
         └── <BotsView>              ← view==='bots'
```

四个 view 互斥；切换由 `MainNav` 的图标按钮决定，由 `App` 的 `view` state 持有。

---

## 1. 设计系统（CSS tokens）

源：`packages/web/src/styles/tokens.css`，由 `index.css` 第一个加载。所有颜色都用 **OKLCH** 写。

### 1.1 主题 — `body[data-theme]`

| theme | 选择器 | 形象 | 主背景 | 主文字 |
|---|---|---|---|---|
| **light** | `body[data-theme="light"]` | 冷调奶白，280h 偏蓝 | `oklch(0.955 0.004 280)` | `oklch(0.22 0.02 280)` |
| **warm** | `body[data-theme="warm"]` | 米白纸感，55–80h 暖调 | `oklch(0.955 0.020 80)` | `oklch(0.30 0.04 55)` |
| **dark** | `body[data-theme="dark"]` | 深蓝墨色，250h，永不纯黑 | `oklch(0.165 0.012 250)` | `oklch(0.93 0.01 250)` |

> **关于"默认"**：tokens.css 的 cascade fallback 是 warm，但运行时 `App.tsx` 用 `loadSettings()` 拉服务端 config，把 `data-theme` 覆写为持久化的值。当前 prod 实例存的是 `light`（截图里看到的就是 light）。设计师对默认外观的预期请以服务端配置为准，不是 CSS fallback。

每套 theme 切换：surface 三层（`--surface` / `--surface-2` / `--surface-3` / `--surface-inset`）、文字三层（`--text` / `--text-2` / `--text-3`）、`--text-inv`、`--border` / `--hairline` / `--hairline-2`、语义色 `--ok` / `--warn` / `--danger`（每个都有 `-soft` 透明度变体）、`--shadow-1` / `--shadow-2`。

### 1.2 强调色 — `body[data-accent]`

| accent | 选择器 | 色相 H | 饱和 C | light 示例 | dark 示例 |
|---|---|---|---|---|---|
| **plum**（默认 init） | `body[data-accent="plum"]` | 310 | 0.13 | `oklch(0.55 0.13 310)` | `oklch(0.72 0.13 310)` |
| **moss** | `body[data-accent="moss"]` | 150 | 0.10 | `oklch(0.55 0.10 150)` | `oklch(0.72 0.10 150)` |
| **ink** | `body[data-accent="ink"]` | 255 | 0.11 | `oklch(0.55 0.11 255)` | `oklch(0.72 0.11 255)` |
| **ember** | `body[data-accent="ember"]` | 30 | 0.13 | `oklch(0.55 0.13 30)` | `oklch(0.72 0.13 30)` |

衍生：`--accent` / `--accent-text` / `--accent-soft`（12–18% α）/ `--accent-ring`（30–40% α，焦点环）。

### 1.3 密度 — `body[data-density]`

| density | `--rail-w` | `--topbar-h` | `--nav-w` |
|---|---|---|---|
| compact | 250 | 38 | 52 |
| **cozy**（默认） | 272 | 42 | 56 |
| roomy | 300 | 48 | 64 |

注意：`--rail-w` 在 CodingView/FilesView/SpacesView/BotsView 里都是被 `useResizableWidth` 在运行时覆盖的（拖拽分隔条），density 只决定初始/CSS fallback。

### 1.4 品牌/平台色（不随主题变）

```css
--codex      oklch(0.62 0.14 270)   /* Codex 紫 */
--claude     oklch(0.70 0.15 36)    /* Claude 橙 */
--discord    oklch(0.58 0.16 280)
--slack      oklch(0.62 0.14 105)
```
每个都有 `-soft`（12–14% α）变体，用作 chip 背景。

### 1.5 字体

```css
--font-sans  "Instrument Sans", ui-sans-serif, system-ui, sans-serif
--font-serif "Instrument Serif", ui-serif, Georgia, serif
--font-mono  "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace
```
启用 `font-feature-settings: "ss01","cv11"`、`-webkit-font-smoothing: antialiased`。
基础字号 13px，line-height 1.5。字号刻度：`--fz-11/12/13/14/16/20/28`。

### 1.6 间距 / 圆角 / 阴影 / 缓动

- 间距：`--sp-1..9`（2/4/6/8/10/12/16/20/24）；窗格缝隙 `--gutter: 3px`
- 圆角：`--r-1: 4` / `--r-2: 7`（按钮、卡） / `--r-3: 10`（rail、岛、popover） / `--r-4: 14` / `--r-pill: 999`
- 阴影：`--shadow-1`（hairline + 微阴影）/ `--shadow-2`（卡片、popover、抽屉）
- 缓动：`--ease: cubic-bezier(.2,.7,.2,1)`

### 1.7 z-index 堆栈（节选，从低到高）

5 → tok 菜单 / 响应式 overlay
10 → 拖拽分隔条
30 → 各种下拉
60 → 通用 popover / 模态遮罩
70 → SettingsPanel / SessionMenu
80 → Proto bar
90 → toast
100 → 模型 picker / thinking popover
120 → 顶栏 inbox / runner popover
200 → 设置 overlay / 表单模态

---

## 2. App Shell

> **CSS uppercase 提示**：以下 §2 列出的所有「分区标签 / 节标题 / 平台名 / 状态文案」（HOST / WORKSPACE: / SESSIONS / FILES / SPACES / BOTS · N / DISCORD / SLACK / DISABLED / ENABLED / NATIVE SESSIONS / ADOPTED / LAST ACTIVITY / CREATED / REPOSITORY / WORKSPACE TREES / CONNECTION / ROUTING / MODE BEHAVIOR / READ-ONLY / FULL CONTROL / ACTIVE / ACTIVITY / DANGER ZONE / SESSIONS / FILES / COMMANDS …）i18n 字符串本身**是混合大小写**（"Workspace:"、"Sessions" 等），但 CSS 通过 `text-transform: uppercase` + `letter-spacing` 把它们渲染成大写小标签风格。视觉对齐时请以截图为准。

### 2.1 顶部 Topbar — `header.topbar`

源：`packages/web/src/components/Topbar.tsx`。

水平排列（左→右）：

1. **品牌区** `.brand`
   - 24×24 三横线 + 右下圆点 SVG（`.brand-mark`）
   - "Gian" 文字（`.brand-word`）
   - **行为**：点击不是首页跳转，而是 `window.dispatchEvent('gian.toggle-rail')`，让当前 view 折叠/展开自己的 sidebar。`title="Toggle sidebar"`。

2. **Runner / Host 状态** `.runner-wrap`
   - 灰色小标 `.runner-lbl`：HOST
   - 状态 chip `.runner-chip`，结构：
     - `.runner-dot[data-state]`（ok / warn / bad）
     - `"local"`（i18n: `topbar.runner.local`）
     - `·`
     - 状态文案：`ready` / `auth…` / `Reconnecting (n)` / `offline`
   - **状态 popover**（点击 chip 打开）`.status-popover`
     - 表头 `.status-popover-header`："Connection Status"
     - 列表 `.status-popover-list`，每项 `.status-popover-row`：组件状态点 + 名 (Codex / Claude Code / Discord / Slack) + 详情 + Reconnect 按钮
     - `data-state` 取值：`ok` / `bad` / `none`(unconfigured)

3. **Workspace 面包屑** `.crumbs`
   - 标签 `.crumb-lbl`："Workspace:"
   - 按钮 `.crumb-btn`：当前 workspace 名 + `▾` 小箭头（`.crumb-btn-car`）
   - **workspace popover** `.workspace-popover`：每行 `.workspace-popover-item`，显示 name + 路径（`-active` 类高亮当前项）

4. **弹簧间隔** `.topbar-spacer`

5. **命令面板触发器** `.top-cmd`
   - 放大镜图标 + "Jump to session, file, command…" 文案 + `<kbd>⌘K</kbd>`
   - 普通键盘键入会以该键为 initialQuery 直接打开 palette

6. **Inbox 按钮** `.inbox-btn`
   - 信封图标
   - 有 pending approvals 时右上角红 `.inbox-badge`（>99 显示 `99+`）
   - `data-active="true"` 时强调
   - 弹出 `.inbox-popover`：表头 + 每条 `.inbox-popover-item` 含 `.inbox-popover-cat`（按 category 上色）+ 描述，点击跳到对应 session

7. **头像** `.avatar`
   - 28px 圆形，单字母（"R"），点击打开 SettingsPanel

### 2.2 左侧 MainNav — `nav.nav`

源：`packages/web/src/components/MainNav.tsx`。

固定 4 个按钮，中间一条分隔线（`.nav-rule`）：

| 按钮 | i18n | 图标 | badge |
|---|---|---|---|
| Coding | nav.coding | 角括号+斜线（编辑器感） | `runningCount`（pendingBySession 中 true 的数量）|
| Files | nav.files | 文件夹 | — |
| ─ rule ─ |
| Spaces | nav.spaces | 2×2 方格 | — |
| Bots | nav.bots | 机器人头+天线 | — |

每个按钮：图标 + 文字标签（`<span>`），可选右上角 `.nav-badge`。激活态 `.active`。`title` 与文案一致。**没有 inbox/settings 入口** — 这俩在 topbar。

### 2.3 断线警示条 — `.ws-disconnect-banner`

只在 `wsState` 为 `closed` / `connecting` 时出现在最顶部，role="alert"，文案：

- connecting：`Reconnecting (attempt N)…`
- closed：`Disconnected · Reconnecting…`

左侧带 `.ws-disconnect-icon` 图标。

### 2.4 SettingsPanel（右侧 sheet）

源：`packages/web/src/components/SettingsPanel.tsx`。

`.settings-overlay`（z=200，整屏遮罩）+ `.settings-panel`（右侧滑入面板，stopPropagation）。

头是独立的 `.sheet-head`（**不算 section**）：title "Settings" + saving/saved 指示 + 关闭按钮。

下面是 10 个 `.sheet-section`（验证：DOM 计 `.sheet-section = 10`）：

1. **Account** `.account-card`：圆头像 + 用户名 + "owner · single-user instance" 文案 + Sign out
2. **Theme** `.theme-picker`：3 个 `.theme-chip`（Light/Warm/Dark），每个内含 3 个 `<i>` 色样
3. **Accent** `.accent-picker`：4 个 `.accent-swatch`（Plum/Moss/Ink/Ember），纯色块
4. **System · runner** `.kv-grid`：Listen address / Port（disabled，restart required）/ Workspace root（可编辑）/ Data dir（disabled）
5. **Executors** `.kv-grid`：Codex CLI path（旁注 `GIAN_CODEX_BIN`）/ Codex version / Claude Code path（旁注 `GIAN_CC_BIN`）/ CC version（全 disabled）
6. **Default model**：Claude default model+effort、Codex default model+thinking。空 = 跟随 executor 默认。
7. **Auth** `.kv-grid`：Username / Password（点击展开改密码表单）
8. **Density** `.segm`：Compact / Cozy / Roomy
9. **Language** `.segm`：中文 / English（hint：reload 后生效）
10. **Public access · domain & reverse proxy**：Public URL + Tunnel mode (`.segm`：None / Cloudflare / Tailscale / Reverse proxy) + Tunnel ID + Force HTTPS (`.segm`：On/Off)

DOM 计数佐证：`.kv-grid = 6`（System / Executors / Defaults×2 / Auth / Public access），`.segm = 4`（Density / Language / Tunnel mode / Force HTTPS），`.segm-item = 11`（3+2+4+2）。

500ms 防抖自动保存，2s 后展示 "Saved" 指示。

### 2.5 CommandPalette（⌘K 模态）

源：`packages/web/src/components/CommandPalette.tsx`。

`.pal-overlay`（点击外圈关闭）→ `.pal-modal` 居中（role=dialog）：

- **Search row** `.pal-search-row`：放大镜 SVG + `.pal-input`（占位 "Search sessions, files, commands…"）+ `<kbd>Esc</kbd>`
- **Results list** `.pal-list`，按段分组：
  - `.pal-section-head`："Sessions" / "Files" / "Commands"
  - `.pal-row`（active 时 `.active`）：`.pal-row-label` + `.pal-row-sub` + `.pal-row-tag`（带分类样式 `.files` / `.cmd`）
  - 空：`.pal-empty` "No results for "{query}""
- **Footer** `.pal-footer`：`<kbd>↑↓</kbd> navigate · <kbd>↵</kbd> select · <kbd>Esc</kbd> close`

数据源：sessions（按 name/id 匹配）、files（changed files 优先，否则 transcript 历史）、commands（当前 executor 的 slash 命令）。键盘 ↑↓ + Enter + Esc。

---

## 3. Coding View（主界面）

源：`packages/web/src/views/CodingView.tsx`。

### 3.1 三栏 + 可选第四栏

```
.view (flex row, 暴露 --rail-w 给 CSS)
├── (条件) aside.sidebar       ← 会话列表/筛选/归档
├── (条件) .view-splitter      ← 左侧分隔条，可拖拽
├── main.main                  ← 当前 session 的工作区
│   ├── .main-head             ← 标题 + 状态 + GitBadge
│   ├── (条件) .session-banner ← worktree merged/discarded 横幅
│   ├── (条件) <JobProgress>   ← auto 模式 turn 进度条
│   ├── .transcript-wrap       ← 滚动容器
│   │   └── .transcript        ← 消息流
│   ├── (条件) <QueueList>     ← 待发送队列
│   ├── (条件) <PlanChip>      ← Plan 状态指示
│   ├── .composer-wrap         ← 输入区
│   └── footer (.tok-strip)    ← 上下文用量 + 会话菜单
└── (条件) <FilePreviewDrawer> ← 第 4 栏：文件 / diff / plan 预览
```

`rail-collapsed` 类应用到 `.view`，会同时去掉 sidebar 和 splitter。监听 `gian.toggle-rail` window 事件（顶栏 brand 触发）。

### 3.2 左侧 sidebar（会话栏）

```
aside.sidebar
├── .sidebar-head     [Sessions]                   [+ new] .sidebar-action
├── .rail-filterbar
│   ├── .rail-fchip   [Group by ▾]   ← time / workspace / status
│   └── .rail-fchip   [Workspace ▾]  ← all / 单个
├── .sidebar-scroll
│   ├── (条件) .sb2-needs-you        ← 高亮"待处理" 块
│   │   ├── .sb2-needs-dot + .sb2-needs-count
│   │   └── .session-list  ← 含 pending/error 的 session
│   ├── .sb2-group * N               ← 按分组键的分组
│   │   ├── .sb2-group-header        ← TODAY / THIS WEEK / 工作区名 / 状态名
│   │   └── .session-list
│   └── .archived-section
│       ├── .archived-toggle [▸ Archived]
│       └── .session-list (折叠)
```

**会话行 `.session-row` (`.rail-item`)**，结构：

```
button.session-row[data-status=running|pending|error|done|new][.archived]
├── .ri-body
│   ├── .ri-row1                ← 标题行
│   │   ├── .ri-title           ← session 名
│   │   └── <StatusPill>        ← 着色小药丸
│   └── .ri-row2                ← 元信息行
│       ├── .ri-exec-name       ← executor badge（带 .claude / .codex 类）
│       ├── .ri-sub             ← workspace 名
│       ├── (条件) .wt-badge[data-state=active|merged|discarded]  ← worktree 分支
│       └── (条件) .ri-turn     ← running 且 turns>1 时的回合计数
├── .ri-age                     ← "2h" 这种相对时间
└── 悬浮才显的 .session-row-kebab ← 三点菜单
```

新会话入口：`.sidebar-action`（"+ new"）打开 `<NewSessionView>` 全屏卡（不是 popover），分为 Workspace / Executor / Approval mode / Mode (regular | worktree) / Name / First message 字段（i18n: `coding.new.*`）。

### 3.3 主区头 `.main-head`

```
.main-head (flex space-between)
├── .main-head-l
│   ├── (编辑态) input.main-title-input   ← 直接改名
│   │  或 (展示态) .main-title-wrap
│   │       ├── .main-title
│   │       └── (条件) .main-title-edit-btn  ← 铅笔图标
│   └── <StatusPill>
└── .main-head-r
    └── <GitBadge>   ← 仅在有 workingTreeId 时
```

GitBadge（`packages/web/src/components/GitBadge.tsx`）：分支名 `.ghb-branch` + worktree 指示 `.ghb-wt` + `+N` / `−M` 文件改动统计；干净时显示 "clean"。点击触发 `onShowChanges` → 跳到 Files view 的 changed 模式。

### 3.4 worktree 终态横幅 `.session-banner`

只在 `session.worktree_outcome` 非空时出现：

- `.session-banner.merged`：文案 "Worktree merged into {base}" + Archive / Delete 按钮
- `.session-banner.discarded`：文案 "Worktree discarded" + 同上

### 3.5 Transcript

源：`packages/web/src/transcript/Transcript.tsx` + `items.tsx`。

```
.transcript-wrap (滚动容器，自动跟到底部)
├── (条件) .transcript-pin   ← 用户消息滚出视口时出现，sticky 上方按钮，点回去
└── .transcript
    ├── (空) "say hi to start the conversation"
    └── 消息流（连续工具调用会被自动折叠成"步骤组"）
```

#### 步骤组 `.evt.actions`

连续的工具/命令/文件读会被合并：

- `.evt-head`：caret + "Working" / "Steps" + 数量 + 类目统计（"Explored 3 · Ran 2 · Edited 1"）
- `.evt-body.actions-body`：每个原子步骤
- 一旦后面来了 text/approval reply 就自动折叠

#### 各 item 类型

| item | 类 | 形态 |
|---|---|---|
| 用户消息 | `.msg.user` | 头像 `.msg-av` + `.msg-meta`（时间戳） + `.msg-text.user-text`（纯文本）；连续用户消息加 `.continuation` 隐藏头像 |
| 助手消息 | `.msg` | 同上结构 + ReactMarkdown（GFM）渲染 `.msg-text.md` |
| 工具调用 | `.evt.agent` | 可折叠 `.evt-head`+`.evt-body`，verb=Tool，subject=工具名，args 渲染为 `<dl>` |
| **审批卡** | `.approval` | 见 §9.1 |
| Diff | `.evt.fc.compact` | 紧凑单行（**不内联展开**），verb=Edit，+N/−M 着色 badge，点击进 4 栏 preview |
| 命令 | `.evt.command` | 可折叠，verb=Run，命令字串（mono），状态 running/success/error，body=`<pre>` 输出 + 流式光标 |
| Read | `.evt.inline` | 单行，verb=Read + FileLink 路径 |
| Grep / Glob | `.evt.search` | 可折叠，body 是 `.search-result` 行 |
| Web search | `.evt.web.inline` | 单行：query + 结果数 |
| Agent spawn | `.evt.agent` | 单行，verb=Agent，subject=描述，状态 |
| 错误 | `.approval.declined` 样式 | "Turn failed" + 错误文本 + risk badge="error" |
| Status | `.transcript-empty` 样式 | 纯文本 divider（archived/recovered 等） |
| turn-start/end | — | 设计上不渲染 |

#### Thinking ticker `.ticker`

pending 中且没出助手消息时：渲染一行带头像 + "thinking…" + 三点动画。

### 3.6 Composer

源：`packages/web/src/components/Composer.tsx`。

```
.composer-wrap
└── .composer
    ├── <input type=file hidden>
    ├── .composer-input-wrap
    │   ├── textarea.composer-ta   ← 多行，max-height 160px，auto-grow
    │   │   占位：闲："Message…" / 跑："Turn running — message will be queued…"
    │   └── (条件) .cmp-attach-chips
    │        └── .cmp-attach-chip * N  ← 文件名+大小+×
    └── .composer-bar
        ├── .cmp-model-anchor      ← 当前 model 名 + thinking 指示条
        ├── .composer-mode (segm)  ← Plan | Ask | Auto | Bypass
        │     - .active 高亮当前
        │     - 选 Bypass 给 .composer 加 .is-bypass-pending
        ├── (条件) .bypass-hint    ← "⚠ next turn skips approvals"
        ├── (Codex+plan 模式) .cmode-exit-plan ← Exit Plan Mode 按钮
        ├── 弹簧
        ├── .composer-act.slash-box  ← 框住的 "/" 字形
        ├── .composer-act            ← "+" 附件
        └── .composer-act.primary    ← Send / Stop
            - 闲：箭头 Send（textarea 空则 disabled）
            - 跑：红方块 Stop
```

弹窗（都通过 portal 挂到 body）：

- **Slash popover** `.cmp-slash-pop`：按命令源分组（BUILTIN / PROJECT / USER），键盘 ↑↓/Enter/Esc，按前缀过滤
- **Model picker** `.model-pop`：模型列表（带 ✓） + Reasoning effort 6 档可视化条

底部辅助文：`composer.hint = "Enter send · ⇧Enter newline"`。

### 3.7 Queue panel `<QueueList>`

源：`packages/web/src/components/QueueList.tsx`。仅在有排队消息时出现，位于 composer 上方。

```
.queue-drawer
├── .qd-head
│   ├── .qd-title  "Queued" + .qd-count
│   ├── .qd-sub    "sent serially after current turn"
│   └── .qd-actions  [Send now] [Clear]
└── .qd-body
    └── .qd-item * N
        ├── .qd-idx  1..N
        ├── .qd-text  消息（title 完整 tooltip）
        └── .qd-item-act  ↑ ↓ ×（边界禁用）
```

### 3.8 JobProgress + PlanChip

`<JobProgress>`（`packages/web/src/components/JobProgress.tsx`）：仅 `approval_mode==='auto' && turns>1` 时出现。

```
.job-progress
├── .job-progress-label  "Turn N / M"
├── .job-progress-track
│   └── .job-progress-fill[width=N/M]   ← 完成时加 .done
└── (完成态) .job-progress-status  "complete" / "stopped · error"
```

`<PlanChip>`（`packages/web/src/components/PlanChip.tsx`）：composer 正上方，仅当存在 exit_plan_mode 审批时。

```
button.plan-chip
├── .plan-chip-label  "Plan"
└── .plan-chip-dot[--pending|--accepted|--declined]   ← 黄/绿/红
```

点击把 plan 推到右侧 preview drawer。

### 3.9 Token strip + 会话菜单（footer）

```
.tok-strip
├── label: "Context"
├── value: "Xk / Yk tokens"
├── .tok-bar
│   ├── .tok-bar-fill[width=%]  ← .danger ≥95% / .warn ≥85%
│   └── 90% 处的 mark line (auto-compact 提示)
├── .tok-compact-hint  "compact soon" / "compact 90%"
├── 弹簧
└── .ws-kebab-anchor.ts-kebab
    ├── .ws-kebab-btn  ⋯
    └── .ws-kebab-pop
        ├── (worktree)  Merge to base / Drop worktree   ─divider─
        ├── Archive / Unarchive session   ─divider─
        ├── Force recover
        └── Delete session  (.danger)
```

### 3.10 Inline preview drawer（第 4 栏）

`<FilePreviewDrawer>`（`packages/web/src/components/FilePreviewDrawer.tsx`）。`.preview` 列默认有占位（保持布局），有 `target` 时加 `.open` 类显示。

```
.preview.open
├── .preview-head
│   ├── .preview-path           ← 路径：dirname + .hi 文件名
│   │  或 plan 标题
│   │  或 diff 文件列表 .preview-hunks（+N / −M）
│   └── 关闭按钮
└── .preview-body (滚动)
    ├── (file 模式) .code-ln * N
    │     ├── .code-num  ← 行号
    │     └── .code-txt  ← 内容
    │     请求行加 .active 高亮
    ├── (diff 模式) hunks
    │     ├── .file-head
    │     ├── .hunk-head
    │     └── 行：.add / .del / 普通
    └── (plan 模式) .approval-plan.approval-plan--drawer  ← markdown
```

三种 PreviewTarget 由 transcript 内的 contexts 推送：FileLink、DiffCard、PlanChip。

### 3.11 空状态 / 无 session

`<CodingViewEmpty>`（CodingView.tsx 内）：

```
.main > .files-preview-empty
├── .fpe-icon  (聊天气泡 SVG)
├── .fpe-title  "Pick a session from the left, or click + NEW to start one."
│                  ← i18n: coding.session.empty
└── .fpe-hint   带 <kbd>⌘K</kbd> + " jump to session, file, or command"
```

---

## 4. Files View

源：`packages/web/src/views/FilesView.tsx`。

```
.view (--rail-w)
├── aside.sidebar
│   ├── .sidebar-head           ← "Files"
│   ├── .files-ws-picker
│   │   ├── .files-fchip ▾      ← workspace
│   │   └── .files-fchip ▾      ← worktree (label · branch)
│   ├── .files-mode-toggle    ← 视觉是"下划线 tabs"（active 项底部一条 plum 线），不是 segmented 框
│   │   ├── .files-mode-btn[.active]  Changed
│   │   └── .files-mode-btn[.active]  Tree   ← 默认 active
│   └── .sidebar-scroll
│       ├── (Tree)  .tree → .tree-item.folder / .tree-item
│       │             ├── .tree-caret (▸)
│       │             ├── .tree-ico
│       │             └── .tree-name
│       │             children: .tree-children
│       └── (Changed) .files-changed-summary + .files-changed-row * N
│             └── .files-badge[.add|.del|.mod] + .fcr-path + .fcr-stat (+X −Y)
├── .view-splitter (拖拽，宽度持久化为 files.rail.w)
└── main.main
    ├── (有文件)
    │   ├── .main-head
    │   │   ├── .main-head-l
    │   │   │   ├── .main-title (mono 文件路径)
    │   │   │   ├── (条件) .files-uncommitted-badge
    │   │   │   └── .files-pane-toggle  Content | Diff
    │   │   └── .main-head-r
    │   │       ├── (条件) .files-edit-count
    │   │       ├── .files-lang-badge + 字节数
    │   │       └── .btn.btn-ghost  Open in new tab
    │   ├── .file-meta  (lang · 行数 · edits today · uncommitted dot)
    │   ├── (Content) .hl-wrap
    │   │   └── table.hl-table
    │   │       └── tr  →  td.hl-lnum + td.hl-code
    │   │             token：.hl-comment / .hl-string / .hl-keyword / .hl-number / .hl-builtin
    │   │             支持：TS/JS/Python/JSON/CSS/Shell/Markdown
    │   └── (Diff)  hunks
    │       ├── .files-hunk-header
    │       └── .files-diff-ln[.add|.del|.ctx]
    │             ├── .files-diff-sig  + / − / 空
    │             └── .files-diff-txt
    └── (空) .files-preview-empty  ← .fpe-icon + .fpe-title "Pick a file to view its contents." + .fpe-hint <kbd>⌘K</kbd> "to jump to a file"
```

入口：CodingView 的 GitBadge 点击会以 `'changed'` mode 打开当前 worktree。URL 参数 `?view=files&wt=&path=` 也可深链。

---

## 5. Spaces View

源：`packages/web/src/views/SpacesView.tsx`。

```
.view (--rail-w)[.has-inspector?]
├── aside.sidebar  <SpacesList>
│   ├── .spaces-list-head
│   │   ├── 标题行：Spaces + .btn.sm.primary "New"
│   │   └── 副标题：root: ~/Coding
│   └── .spaces-list-body
│       ├── (条件) 创建 workspace 表单
│       └── .spaces-list-row[.active] * N
│           ├── .spaces-list-row-info
│           │   ├── .spaces-ws-name
│           │   └── .spaces-ws-path
│           ├── .spaces-ws-meta   (sessions count)
│           └── .spaces-list-row-acts  ↑ ↓ (.btn.xs.ghost.icon)
├── .view-splitter
├── main.main  <SpaceDetail>
│   ├── (空) "Select a workspace…"
│   └── (有)
│       ├── .spaces-detail-head
│       │   ├── .spaces-detail-head-l
│       │   │   └── .spaces-detail-name (点改名 → input.spaces-name-input)
│       │   └── .spaces-detail-head-r
│       │       ├── (错误) 红文
│       │       └── .ws-kebab-anchor → .ws-kebab-pop  Rename / Delete
│       ├── <WorkspaceTabs> .ws-tabs
│       │   ├── role=tab  Config
│       │   └── role=tab  Native Sessions  + .ws-tab-count
│       │
│       ├── (Config tab)  <ConfigPane>
│       │   ├── .cfg-stats
│       │   │   └── .cfg-stat × 4   (Native sessions / Adopted / Last activity / Created)
│       │   ├── .cfg-card.full       Repository
│       │   │   ├── .cfg-card-head   "Repository" + (View on GitHub)
│       │   │   └── .cfg-card-body
│       │   │       └── .cfg-kv      Local path / Remote / Default branch / Last commit
│       │   └── .cfg-card.full       Workspace Trees · {n}  + (New worktree)
│       │       └── .cfg-card-body.compact
│       │           └── .cfg-wt-row[.main-tree]
│       │               ├── .cfg-wt-icon  (folder / branch graph)
│       │               ├── .cfg-wt-info
│       │               │   ├── .cfg-wt-branch
│       │               │   └── (主) main tree 标
│       │               ├── .cfg-wt-claude[.empty]   "CLAUDE.md" + 行数 / "+ CLAUDE.md"
│       │               ├── .cfg-wt-state[.clean|.dirty]
│       │               ├── .cfg-wt-session  → 链到 Gian session
│       │               └── .ws-kebab-anchor   Open in Finder / Delete (worktree only)
│       │
│       └── (Native Sessions tab)  <NativeSessionsPane>
│           ├── 副标题
│           ├── .ns-filterbar
│           │   ├── 执行器：All / Claude / Codex (.ns-chip[-claude|-codex])
│           │   ├── 状态：All / Adopted / Available
│           │   └── .ns-count  结果数
│           └── .ns-list
│               └── .ns-row[.adopted]
│                   ├── .ns-executor   (.ns-exec-dot.claude|codex + 名)
│                   ├── .ns-meta       time / turns / size / wt
│                   ├── .ns-preview-row
│                   │   ├── (条件) .ns-branch-chip
│                   │   └── .ns-preview  (firstUserMessage)
│                   └── .ns-actions
│                       ├── (adopted) "✓ Adopted as {name}"
│                       │  或 [Adopt]
│                       └── .ns-row-kebab   Copy native session ID / Delete
│
└── (条件) <ClaudeMdInspector> .spaces-inspector
    ├── .spaces-inspector-head
    │   ├── 标题：CLAUDE.md + workspace 名
    │   └── 关闭按钮
    ├── textarea.input.spaces-claude-md   (全高编辑器)
    └── .spaces-inspector-foot
        ├── 提示："AGENTS.md → soft-link to this file"
        ├── 弹簧
        ├── (条件) Saved 提示
        └── 主按钮 Save (disabled 当未脏 / 保存中)
```

新建 worktree 模态：`.adopt-dialog-backdrop` + `.adopt-dialog`，字段 Base branch / Branch name / Executor segm（Claude Code | Codex）+ Cancel / Create。
认领 native session 模态：同样 `.adopt-dialog`，字段 Source 显示 + Session name + Approval mode segm（Plan/Ask/Auto）+ Cancel / Adopt。

---

## 6. Bots View

源：`packages/web/src/views/BotsView.tsx`。

```
.view (--rail-w)
├── aside.sidebar  <BotListPane>
│   ├── .rail-head   "Bots · {n}" + [+ New]
│   └── .rail-body
│       └── .bot-row[.active]
│           ├── .bot-platform-mark.{discord|slack}   ← 平台首字母色块
│           ├── .bot-row-info
│           │   ├── .bot-row-label
│           │   └── .bot-row-sub        platform · workspace 名 / "unbound"
│           └── .bot-row-meta  .status-dot.{connected|disabled|...}
├── .view-splitter
└── main.main
    ├── (新建)  <NewBotForm>
    │   ├── .bot-new-frame
    │   │   ├── .bot-new-head    标题 + 副标题 + 关闭
    │   │   ├── .bot-new-platform-row  Discord | Slack (.segm)
    │   │   └── .fcard.bot-new-card * 3   ← "01 Identity" / "02 Connection" / "03 Permissions"
    │   │       ├── 01：Label + Workspace select
    │   │       ├── 02：Discord = Bot Token (secret) + App ID  /  Slack = Bot Token + App-level Token + 命令前缀
    │   │       └── 03：模式 Read-only | Full-control + 模式提示文 + Allowed user IDs
    │   └── 底部：(error) + Cancel + Create
    │
    └── (详情)  <BotDetail>
        ├── .detail-head
        │   ├── .detail-head-l
        │   │   ├── .detail-bot-mark   ← 大尺寸平台首字母方块
        │   │   └── .detail-bot-info
        │   │       ├── .detail-bot-name
        │   │       └── .detail-bot-sub
        │   │           ├── .platform-chip   "DISCORD" / "SLACK"（uppercase via CSS）
        │   │           ├── workspace 绑定 / "no workspace"
        │   │           └── "created {Mon DD}"
        │   └── .detail-head-r
        │       ├── .enable-switch[data-on]   ← 拨片开关，左侧文案大写 "DISABLED"/"ENABLED"
        │       └── .btn.primary  Save (disabled 未改)
        └── .detail-body
            ├── (顶部) STATUS 块  ← • disabled + "forwarding paused"
            ├── .bot-detail-grid (二列)
            │   ├── .cfg-card  CONNECTION
            │   │     · head 右侧旁注 "credentials from Discord Developer Portal"
            │   │     · Discord = Label + BOT TOKEN（带 .saved-pill "✓ SAVED" + Show/Hide 切换）+ Application ID（含 Copy 按钮）
            │   │     · Slack   = Label + BOT TOKEN + APP-LEVEL TOKEN + Command Prefix
            │   └── .cfg-card  ROUTING
            │         · head 右侧旁注 "where new sessions land · who can talk"
            │         · Workspace select + Allowed User IDs (comma-separated, 含 hint "Leave empty to allow all users.")
            ├── .mode-behavior
            │   ├── 节标 "MODE BEHAVIOR"
            │   └── .mode-card[.active] × 2
            │         ├── READ-ONLY (eye 图标) + "• ACTIVE" 状态徽章 + "Bot mirrors assistant responses only."
            │         └── FULL CONTROL (check 图标) + "Bot can send prompts and receive full event stream."
            ├── .cfg-card.activity-log  ACTIVITY
            │   ├── head 右侧旁注 "connection state · last events"
            │   ├── .activity-log-row × 2   STATUS (• disabled) / LAST CONNECTED (never)
            │   └── (条件) .activity-log-error
            └── .danger-zone     "DANGER ZONE"
                ├── .danger-zone-info  描述
                └── .danger-zone-actions
                    ├── (确认中) "Are you sure?" + Cancel
                    └── .btn.danger-ghost  🗑 Delete Bot
```

---

## 7. Login View

源：`packages/web/src/views/LoginView.tsx`。

```
.login-shell  (全屏)
└── .login-card
    ├── h1.login-brand  "Gian"
    └── form.login-form
        ├── .login-field  → label "Username" + .login-input (autoFocus)
        ├── .login-field  → label "Password" + .login-input (type=password)
        ├── (错误) .login-error
        └── .login-submit   Sign in / Signing in… (disabled when loading)
```

错误文案：`Invalid username or password.` / `Network error — please try again.`

---

## 8. Coming Soon

`<ComingSoonView>`（保留壳）：`main > .session-pane-empty > p > strong "{label} view is coming soon."`。当前 4 个主 view 都已实现，不在主 nav 里出现，备用。

---

## 9. 横切组件

### 9.1 Approval 卡

源：`transcript/items.tsx` 内 `ApprovalCard`。

**Pending**（互动态）：

```
.approval[.high|.medium|.low]
├── .approval-top
│   ├── .approval-ico   ← 严重度图标
│   ├── 标题
│   ├── 原因副本
│   └── .approval-risk   ← low / medium / high
├── (命令类) .approval-cmd  ← mono 命令字
│  或 (plan) .approval-plan ← markdown
└── .approval-actions
    ├── Allow once
    ├── Allow session
    └── Decline
       ＋ 键盘快捷键提示
```

**Plan-exit 变体**：三个语义按钮 — "Yes, auto-accept future edits" / "Yes, ask each time" / "No, keep planning"。

**Resolved**（终态）：去掉 actions，换成 `.approval-resolved-note`：图标变 ✓ 或 ×、标签 "Allowed once · running" / "Allowed for session · running" / "Declined · command not run"，带署名 "by web/discord/slack/…"。`.declined` 类作用于声明拒绝。

### 9.2 StatusPill

会话状态药丸，颜色：
- new — 无填充/中性
- running — accent / pulse
- pending — warn 黄
- error — danger 红
- done — ok 绿

### 9.3 Tool / event 卡通用骨架

`.evt[.<kind>]`：

- `.evt-head`：可点击折叠头，左 caret + verb（"Run/Read/Edit/Tool/Grep/Glob/Web/Agent"）+ subject + 状态/统计
- `.evt-body`：折叠内容（命令 stdout / 搜索结果 / 工具 args 等）
- `.compact` / `.inline` 修饰类决定是否能展开

执行状态色：running → 强调色脉冲；success → ok-soft；error → danger-soft。

---

## 10. 给设计师的对照笔记

### 老 mockup 里"已经不存在"的东西

老 `design/index.html` 里有，但代码里**没有**：

- 顶栏 "12ms" 延迟读数（runner-chip 现在显示 ready/auth…/Reconnecting/offline，**不显示延迟**）
- 顶栏 brand 里"sticky 第三栏" 的暗示（现在 brand 点击是 toggle sidebar）
- 老的 `togglePopover` 五件套（runner / inbox / model / grants / slash）—— 代码里只剩下：runner 状态、inbox approvals、workspace、model（在 composer 内部）、slash（也在 composer 内）
- 老的 "tweaks" 浮动面板（在 settings 里了）
- 老的 4 列 nav（含一个非法的多余 `</button>`）—— 现在干净的 4 项 + 一条 rule
- 老的 "+ NEW" 按钮在 sidebar header 上的位置不同 —— 代码里是 `.sidebar-action`，文字 "+ new"
- 老的 grants popover —— 代码里没有这个独立组件，权限通过 approval 卡+设置面板暴露
- 老的 "active_channel = web/im 切换" UI —— 代码暂未渲染

### 代码里有，老 mockup 没有的

- **`.ws-disconnect-banner`** 顶部断线条（很重要的状态）
- **`.session-banner`** 终态 worktree merged/discarded 横幅
- **`<JobProgress>`** auto 模式回合进度条
- **`<PlanChip>`** plan 状态 chip + plan-exit 三按钮 approval 变体
- **`<QueueList>`** 完整的待发队列 UI（含 ↑↓× / Send now / Clear）
- **`.tok-strip`** 上下文 token 用量 + auto-compact 标记（90% mark line）
- **`<FilePreviewDrawer>`** 第 4 栏，三种内容（file / diff / plan）
- **Spaces 视图**整套：worktree 列表、CLAUDE.md inspector、Native Sessions 认领流
- **Bots 视图**整套：3 段创建表单、详情页 Connection/Routing/Mode behavior/Activity log/Danger zone
- **Files 视图**：tree + changed 双模式，syntax-highlight content + 真 diff 视图
- **Login 视图**
- **Settings**：tunnel mode 段（Cloudflare / Tailscale / Reverse proxy / Force HTTPS）
- **CommandPalette**：从老 mockup 的 `top-cmd` 入口指向的真实模态
- **i18n**：中英双语切换（`Language` segm 在 settings 内）

### 已知设计粗糙点（值得 Claude Design 重做时关注）

1. `.evt.actions` 步骤组的折叠/展开手势和文案（Working / Steps）和"折叠时的统计行"在不同 executor 下密度差异大。
2. Approval 卡四个变体（command / network / file write / exit-plan）目前公用同一卡骨架，密度/层级感弱；plan 变体的三按钮和普通的三按钮形状一致但语义不同。
3. Composer mode segmented control 现有 4 项（Plan / Ask / Auto / Bypass），加上 Codex 专用的 Exit Plan Mode 按钮，逻辑上分两层但视觉上挤在一行。
4. Token strip 同时承载用量 + 危险阈值 + auto-compact 提示 + 会话级菜单（kebab），信息密度高但视觉层级单一。
5. Spaces 详情的 `.cfg-card.full` + `.cfg-card-body.compact` + `.cfg-wt-row` 是现在产品里最复杂的复合行，列数多（icon / branch / CLAUDE.md / state / session / kebab）但都是文字感。
6. Sidebar 的"分组规则"目前由筛选 chip 的 `groupBy` + 独立的 "Needs you" + 独立的 "Archived" 三套并存，三种节标头风格不统一。
7. 主题/强调/密度的组合是 3×4×3 = **36 种最终外观**，目前没有统一的 contrast 测试矩阵。

---

## 11. 验证日志（2026-05-15 chromium probe）

为了确认这份文档真的能 1:1 复原现状，用 Playwright + Chromium 1217 对 `localhost:5190`（vite dev → 真实 prod daemon 8990）做了一遍：4 个 view + 设置 + 命令面板 + 顶栏 popovers，总共 14 个截图 + DOM 选择器计数。脚本和报告：

- 探针：`/tmp/gian-verify/probe.mjs`
- 报告：`/tmp/gian-verify/report.json`
- 截图：`/tmp/gian-verify/01-shell.png` 到 `14-inbox-state`

### 验证通过的（DOM + 视觉 双对齐）

| 区块 | 关键 DOM 计数（probe → 实际） | 结果 |
|---|---|---|
| 顶栏 7 件套 | brand=1 / runner-wrap=1 / crumbs=1 / top-cmd=1 / inbox-btn=1 / avatar=1 / topbar-spacer=1 | ✅ |
| MainNav | 4 nav-btn (Coding/Files/Spaces/Bots) + 1 nav-rule，title 与 label 一致 | ✅ |
| CodingView 3+1 栏 | sidebar=1 / view-splitter=1 / main=1 / preview=1（默认无 .open）| ✅ |
| Sidebar 头/筛选/列表/归档 | sidebar-head + 2 rail-fchip + sb2-group + archived-section + N×session-row | ✅ |
| Transcript 多类型 | 实测一个 session 出现 msg=15 / evt=33 / evt.actions=8 / evt.command=15 / evt.fc.compact=6 / evt.search=1 / approval=1 | ✅ |
| Composer 4 个模式 | composer_modes = `["Plan","Ask","Auto","Bypass"]` | ✅ |
| FilesView 三栏 | sidebar / view-splitter / main / 默认 Tree mode active | ✅ |
| SpacesView 列表+详情+tabs | spaces-list-row=2 / ws-tabs[Config 默认 active, Native Sessions+count=2] / cfg-stats=1 内 cfg-stat=4 / cfg-card.full=2 (Repository + Workspace Trees) | ✅ |
| SpacesView Native sessions 子页 | ns-filterbar 含 6 ns-chip + ns-count，ns-row 列表 | ✅ |
| BotsView 列表+详情 | bot-row=6 / bot-detail-grid + mode-card=2 + activity-log + danger-zone | ✅ |
| Bot 新建表单 | bot-new-frame + 3×fcard.bot-new-card + Discord/Slack 切换 | ✅ |
| SettingsPanel | 10 sheet-section / 3 theme-chip / 4 accent-swatch / 6 kv-grid / 4 segm / 11 segm-item | ✅ |
| CommandPalette | pal-overlay + pal-modal + 3 pal-section-head (Sessions/Files/Commands) + 13 pal-row + pal-footer | ✅ |
| Runner status popover | 4 status-popover-row = `["Codex","Claude Code","Discord","Slack"]` + 各自 reconnect 按钮 | ✅ |
| Workspace popover | 2 workspace-popover-item，含 name + path | ✅ |

### 探针发现并已在本次提交里改正的偏差

1. §3.11 CodingView 空状态 fpe-title 文案改为 `"Pick a session from the left, or click + NEW to start one."`（旧值"Start a new session"是早期想象）。
2. §4 FilesView 空状态 fpe-title 改为 `"Pick a file to view its contents."`，hint 改为 `<kbd>⌘K</kbd> "to jump to a file"`。
3. §1.1 themes 表里删掉了"warm（默认）"的硬断言，加注：默认外观以服务端 systemConfig 为准（当前 prod 是 `light`，不是 `warm`）。
4. §2.4 SettingsPanel：把"Header"从 sections 列表里挪出（它是 `.sheet-head`，不是 `.sheet-section`）；改成 10 个 section 并补 DOM 计数佐证（kv-grid=6, segm=4, segm-item=11）。
5. §6 BotsView 详情：补全顶部 STATUS 块、CONNECTION/ROUTING 卡的右侧旁注、SAVED 徽章 + Show 切换 + Copy 按钮、ACTIVITY 卡的旁注，并把 enable-switch 文案标为大写"DISABLED/ENABLED"。
6. §4 FilesView：mode-toggle 标注为"下划线 tabs"视觉（不是 segmented 框），并标注 Tree 是默认 active。
7. §2 顶端加了一段「CSS uppercase 提示」：所有大写感的小标签都是 i18n 混大小写 + CSS `text-transform: uppercase` 渲染出来的，避免设计师把 i18n 字符串误写成大写。

### 没法在静态环境里验证的部分（建议人工二次抽检）

- `.ws-disconnect-banner` —— 只在 ws 断线时出现；当前 vite proxy + prod daemon 始终连通，没机会触发。
- `.session-banner.merged` / `.discarded` —— 需要一个 worktree 已合并/丢弃的 session 在列表里。
- `<JobProgress>` —— 需要 auto 模式跑多 turn 中。
- `<PlanChip>` 三态 + Plan-exit approval 三按钮变体 —— 需要 plan 流程 in-flight。
- `<QueueList>` —— 当前没排队消息。
- `.transcript-pin` —— 需要滚动出用户消息后才 sticky。
- `.bypass-hint` / `.cmode-exit-plan` —— 仅当 mode 切到 Bypass / Plan 时显示。
- `.ticker` (thinking…) —— pending 中且无助手消息时一闪。
- `.cmp-attach-chips` —— 需要附件粘贴/拖入。
- Slash popover / Model picker popover —— 需要在 composer 内输 `/` 或点 model anchor。
- `.spaces-inspector` (CLAUDE.md 编辑器) —— 需要点开 `.cfg-wt-claude` 按钮。
- `.adopt-dialog-backdrop` 两种弹窗 —— 需要点 "+ NEW WORKTREE" 或 "Adopt" 触发。
- `.activity-log-error` —— 需要 bot 出错过。
- 暗色 / 紧凑 / Roomy 主题视觉 —— 当前实例固定 light + cozy + plum。
- 中文 i18n 视觉 —— 当前实例 lang=en。

这些条件分支在 §3–§9 都已写出预期形态，但没有 1:1 的截图佐证，新设计稿落地前最好开发起一个能复现这些状态的 fixture session，再补一轮快照。

---

## 12. 一句话索引（给 Claude Design 看）

> 全屏单页 React app：左侧 56–64px 图标导航条，顶部一条贯通 topbar（品牌 + 主机状态 + 工作区面包屑 + ⌘K 命令面板入口 + 审批信箱 + 头像）。主区按图标切 4 个 view —— Coding（三/四栏：会话栏 / transcript+composer / 可选预览抽屉）、Files（工作树+树/改动 + 高亮内容/diff）、Spaces（工作区列表 + 详情含 worktree 管理 + CLAUDE.md inspector + 认领 native session）、Bots（IM 机器人列表 + 连接配置 + 权限）。整套使用 OKLCH，3 主题 × 4 强调 × 3 密度 = 36 种外观，所有控件都从 token 派生。
