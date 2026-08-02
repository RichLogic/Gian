# 设计：聊天主区视图选择（Settings 可配）

- 日期：2026-06-06
- 状态：已与用户对齐，待 spec 评审 → 进入 writing-plans
- 触及敏感区：是（Claude `claude -p` / TTY runtime 选择，见 `docs/runtime-modes/`）

---

## 1. 背景与目标

今天聊天主区的 runtime tab 是**写死**的：

- Claude 会话固定 `Chat`(结构化 `claude -p`) / `Beta`(Claude TTY 面) / `CLI`(原始终端)。
- Codex 会话固定 `Chat`(结构化 codex) / `CLI`。
- 新建 Claude 会话自动切到 TTY、默认选中 `Beta`（`planCreatedSessionFirstMessage`）。

目标：把"聊天主区显示哪些 tab"变成 **Settings 全局可配**：

- **Claude**：单选 `claude -p`(结构化) 还是 `tty`——**二选一，另一个不再作为 tab 出现**；外加一个"要不要显示 CLI"开关。
- **Codex**：聊天恒为结构化（无单选），只有"要不要显示 CLI"开关。
- 默认值等于今天的行为，**不改默认体验**。

计费动机：`claude -p`(Agent SDK，2026-06-15 起单独计 credit) vs 交互 `claude`(订阅)。把它做成全局单选，用户可以一次性把 Claude 钉在 `tty`，结构化面直接消失，避免误用计费面（见 `docs/runtime-modes/context.md`）。

## 2. 锁定的模型

### 2.1 新增 config 字段

加到 `SystemConfig`（`packages/shared/src/model.ts`）：

| 字段 | 类型 | 未设置时默认 | 含义 |
|---|---|---|---|
| `claude_chat_surface` | `'structured' \| 'tty'` | `'tty'` | Claude 聊天主区用 `claude -p` 还是 tty。二选一，另一个不出 tab。 |
| `claude_chat_cli` | `boolean` | `true` | Claude 是否多一个 CLI tab。 |
| `codex_chat_cli` | `boolean` | `false` | Codex 是否多一个 CLI tab。 |

默认值来历：今天新建 Claude → tty/Beta，且 tty 默认带 CLI；Codex → 纯 Chat。所以 `tty` + cli `true` + codex cli `false` 正好复刻现状。

### 2.2 CLI 勾选的"再 seed"语义（用户已定）

切 Claude 单选时，`claude_chat_cli` **每次都重置**为该模式默认：

- 选 `structured` → `claude_chat_cli = false`
- 选 `tty` → `claude_chat_cli = true`

重置后用户仍可手动改 CLI 勾选；直到下次再切单选又被重置。纯函数 `reseedClaudeCli(surface): boolean`（`surface === 'tty'`）封装这条规则，单测覆盖。

> UI 永远把 `claude_chat_surface` 和 `claude_chat_cli` **一起写**（切单选时同一次 patch 带上两个字段），所以持久层这两者始终一致，`loadConfig` 的静态兜底（cli 未设置→`true`）不会产生不一致。

### 2.3 tab 渲染规则

引入纯函数（放 `packages/web/src/session-routing.ts`，和现有 surface 逻辑同源）：

```ts
// codex → 'chat'；claude → tty 配置时 'beta'，否则 'chat'
runtimeChatSurface(executor, cfg): 'chat' | 'beta'

// 主聊天 tab + 可选 CLI tab，按执行器与 config 决定
runtimeTabs(executor, cfg): Array<{ surface: SessionSurface; label: 'chat' | 'cli' }>
```

渲染结果（**只剩 1 个 tab 时整条 tab 栏隐藏**）：

| 执行器 | config | tab 栏 |
|---|---|---|
| Claude | `tty` + cli | `Chat`(surface=`beta`) · `CLI`(surface=`cli`) |
| Claude | `tty`，无 cli | 隐藏栏，仅 `Chat`(surface=`beta`) |
| Claude | `structured` + cli | `Chat`(surface=`chat`) · `CLI`(surface=`cli`) |
| Claude | `structured`，无 cli | 隐藏栏，仅 `Chat`(surface=`chat`) |
| Codex | cli | `Chat`(surface=`chat`) · `CLI`(surface=`cli`) |
| Codex | 无 cli | 隐藏栏，仅 `Chat`(surface=`chat`) |

**关键简化：内部 `SessionSurface` 仍是 `'chat' | 'beta' | 'cli'` 不变。** 选 tty 时主聊天 tab 的 `surface` 仍是 `'beta'`，只是**显示文案叫 `Chat`**（去掉 "Beta" 这个用户可见标签）。这样 `planApprovalResponseDispatch` / `planBetaComposerSend` / claim TTY / QuestionCard dock 等下游逻辑**全部不动**。

### 2.4 runtime 对齐与新会话

- **新建会话**（`planCreatedSessionFirstMessage`，加 `claudeChatSurface` 入参）：
  - Claude + `tty` → `switchToTty:true`（现状不变）。
  - Claude + `structured` → 走结构化分支（`switchToTty:false`、`structuredText:text`、`seedOptimisticEcho`），即与 Codex 同形。
  - Codex → 不变。
- **已存在会话（仅 Claude 需对齐）**：`SessionMain` 挂载 / 切会话时，Claude 的 `surface` 初始化为 `runtimeChatSurface('claude', cfg)`（`'chat'` 或 `'beta'`）；若该面隐含的 runtime 与 `session.runtime_mode` 不符**且会话空闲**（`!pending && !terminal`），调一次既有的 `onSwitchRuntime(target)` 对齐（与点击该 tab 等价）。正在跑的 turn 跑完(空闲)后 effect 重跑再对齐。
  - 由于两模式共享 Claude session id（`--session-id` + `--resume`，见 `docs/runtime-modes/architecture.md`），对齐切换**不丢历史**；被切走的空闲 tty PTY 关闭无损，下次切回 `--resume` 续上。
- **Codex 不做 runtime 自动对齐**：`codex_chat_cli` 只控制 CLI tab 显隐，不强制改 runtime（避免把停在 CLI 的 codex 会话从终端里硬拽出来）。Codex 的**默认选中 surface 仍按今天的 runtime 驱动**：`session.runtime_mode==='tty' && codex_chat_cli ? 'cli' : 'chat'`（即 `runtimeChatSurface` 只负责 Claude 的主聊天面 + tab 列表，Codex 的默认选中另算）。

`runtimeForSurface(surface): RuntimeMode`（`'chat'→'structured'`，`'beta'|'cli'→'tty'`）作为纯函数辅助上面的判断。

### 2.5 改设置后强制刷新（用户已定）

`SettingsBody` 里这 3 个控件改动后：`saveSettings(partial)` 成功 → `window.location.reload()`。

- 只有这 3 个字段触发刷新；主题/密度等普通设置不刷。封装 `patchChatViewAndReload(partial)`，与普通 `patch` 区分。
- 刷新后 tab 栏从新 config 重新渲染——**省掉跨已挂载会话视图的响应式传播**。
- 不丢草稿（composer 草稿存 localStorage）；不碰 host 状态（刷新只重建 WS，TTY 锁像平常刷新一样重新 claim）。
- 多窗口时只有改设置那个窗口刷新，其余窗口下次刷新/导航才生效——本地单用户场景可接受，不加全局广播。

## 3. 受影响文件

### shared
- `packages/shared/src/model.ts` — `SystemConfig` 加 3 字段。

### host
- `packages/host/src/storage/config.ts`
  - `loadConfig`：`claude_chat_surface` 校验 ∈ `{structured,tty}`，否则 `'tty'`；`claude_chat_cli` 兜底 `true`、`codex_chat_cli` 兜底 `false`，布尔按 `=== 'true'` 解析（参照 `force_https`）。
  - `saveConfig`：标量走默认 `String(value)` 分支即可（布尔存成 `"true"`/`"false"`），无需特殊处理。

### web
- `packages/web/src/session-routing.ts`
  - `planCreatedSessionFirstMessage` 加 `claudeChatSurface` 入参。
  - 新增纯函数 `runtimeChatSurface` / `runtimeTabs` / `runtimeForSurface` / `reseedClaudeCli`。
- `packages/web/src/views/CodingView.tsx`（`SessionMain`，约 1356–1521）
  - `defaultSurface` 与 surface-sync effect（1357–1381）改为以 `runtimeChatSurface(executor, cfg)` 为锚。
  - tab 栏 JSX：用 `runtimeTabs(executor, cfg)` map 渲染，单 tab 时隐藏整条；抽出 `handleSelectSurface(surface)` 复用现有 Chat/Beta/CLI 各自的 onClick 行为（含 disabled 规则 `runtimeSwitchDisabled`/`betaDisabled`/`cliDisabled` 不变）。
  - 主聊天 tab 文案统一用 `coding.runtime.chat`（tty 时不再显示 "Beta"）。
  - 新增"空闲时对齐 Claude runtime"的 effect（见 2.4）。
  - 需要把 `claude_chat_surface`/`claude_chat_cli`/`codex_chat_cli`（或整个 `systemConfig`）透传进 `SessionMain`（App 已持有 `systemConfig` 并下传给 Settings/Sheet，沿同一路径补 props）。
- `packages/web/src/App.tsx`
  - `session:created` 处理把 `systemConfig.claude_chat_surface` 传给 `planCreatedSessionFirstMessage`；`switchToTty` 仍带 `surface:'beta'`；结构化分支验证对 Claude 同样成立。
- `packages/web/src/components/SettingsBody.tsx`
  - 新增"聊天视图"section：Claude 单选 segmented(`claude -p` / `tty`) + Claude CLI switch + Codex CLI switch；改动走 `patchChatViewAndReload`，Claude 单选 onChange 同时带 `claude_chat_cli: reseedClaudeCli(next)`。
- `packages/web/src/api.ts` — 复用 `saveSettings`，无需改。
- i18n：`packages/web/src/i18n/{en,zh}.ts` 加 `settings.chatview.*`（title / claude 标签 / `claude -p` / `tty` / Claude CLI / Codex CLI + hint）。

## 4. 测试计划

- **web 纯函数**（`session-routing.test.ts` 或新文件）
  - `runtimeTabs`：Claude tty±cli / structured±cli / Codex±cli 六组的 tab 列表与单 tab 隐藏。
  - `runtimeChatSurface` / `runtimeForSurface` / `reseedClaudeCli`。
  - `planCreatedSessionFirstMessage`：Claude+`structured`→结构化计划；Claude+`tty`→switchToTty；Codex 不变（更新既有 2 参调用为 3 参）。
- **host**（`config.test.ts` 或对应文件）
  - 3 个新字段 round-trip；`claude_chat_surface` 非法值→`'tty'`；未设置时默认（tty/true/false）；布尔 `"true"/"false"` 解析。
- **回归**：`billing-claude-tty-routing` / `apr-001-approval-card` 仍绿（验证 surface=`beta` id 与 paste-back 未受 relabel 影响）。

## 5. 边界与已知取舍

- **Claude 自动对齐会关闭空闲 tty PTY**：把停在 tty 的旧 Claude 会话在 `structured` 设置下打开，会切到结构化并关掉空闲 tty。可接受——会话历史经 `--resume` 续，切回无损。这是"全局、隐藏另一面、对已有会话生效"的必然结果。
- **不撒谎窗口**：某 Claude 会话正卡在被隐藏面的 running turn 时，主区临时显示配置的 tab（其结构化 transcript 可能为空/旧），turn 跑完空闲后对齐。罕见、短暂，已接受。
- **Codex 停在 CLI 且关了 CLI 显示**：CLI tab 不出、默认回 `Chat`；不强制改 runtime。用户可在 Settings 重新打开 Codex CLI 取回。记为已知小边界。
- **多窗口刷新不同步**：见 2.5，不加广播。

## 6. 非目标（YAGNI）

- 不做"改设置即强制迁移/重启所有会话 PTY"（方案 C，太重、与 TTY 锁冲突）。
- 不做"两面都保留为可切换 tab"（方案 B，与单选语义矛盾）。
- 不为多窗口加全局 config 变更广播。
- 不给 Codex 加 structured/tty 单选（Codex 聊天恒结构化）。
- 不动 `SessionSurface` 联合类型、不重命名内部 `'beta'` id。

## 7. 验收标准

1. Settings 出现"聊天视图"section：Claude 单选(`claude -p`/`tty`) + Claude CLI 开关 + Codex CLI 开关；改任一项后页面刷新，刷新后 tab 栏按新配置渲染。
2. 切 Claude 单选时，CLI 开关按 2.2 重置（structured→关、tty→开），之后可手改。
3. 各执行器 × config 组合的 tab 栏与 §2.3 表一致，单 tab 时无 tab 栏。
4. 新建 Claude 会话：`tty` 设置→进 tty/聊天；`structured` 设置→留结构化、不自动切 tty。
5. 打开旧 Claude 会话时按设置对齐 runtime（空闲才切），历史不丢。
6. 默认配置（全新安装/未改设置）下行为与改动前一致。
7. web/host 新增测试 + 既有相关测试全绿，typecheck 干净。
