# Session 页面优化 — 设计文档

**日期：** 2026-05-21
**状态：** 头脑风暴已通过 — 待写实施计划
**范围：** 6 个相关的 UI / 体验优化捆绑：字体分区缩放、行布局重做、分组折叠、
workspace 隐藏、theme/accent 改造、Gian 吉祥物。

---

## 1. 背景与动机

6 个独立但紧邻的小改进，都触碰侧栏 / 主题 / 设置 / 行布局 / 主区状态展示
这一片相邻模块。捆绑成一个 spec 是因为：

- 共享同一份 `SystemConfig` 扩展（节省 4 次"加字段 → 迁移 → 改 API"流程）
- 共享同一份 settings UI 改造（"外观"分区接连扩张）
- 共享同一份 CSS token 调整（字号变量改成相对单位、accent 表扩张）
- 行布局和分组样式必须协同（行改了分组的视觉锚才合理）

逐项动机：

1. **字体分区**：单一全局字号不够用。代码 / 终端想小一点节省空间，对话想
   大一点轻松看。
2. **行布局**：当前 row2 是 `Claude · workspace · 3m`，缺 branch。executor
   做成文字浪费宽度，是首位想压缩的对象。
3. **分组折叠**：按 workspace 分组时分组头太弱（10px 灰大写），多 workspace
   时混在一起，需要更结构化的视觉边界。
4. **workspace 隐藏**：有些实验性或一次性 workspace 占着侧栏，需要永久收起
   的能力，但又不能彻底删掉。
5. **theme/accent**：四个 accent 跟三个主题各自独立，没有"开箱即合"的搭配；
   accent 也太少，限制了用户表达。
6. **Gian 吉祥物**：现在 transcript 内"thinking…"文字跟着 stream 闪烁，
   "session 在工作"这个简单状态没有稳定的视觉表征。

---

## 2. 总览

| # | 主题 | 数据模型动？ | 主要文件 |
|---|------|-----------|---------|
| 1 | 字体分区缩放 | 是（3 字段） | `tokens.css`, `SettingsBody.tsx`, `model.ts`, `config.ts` |
| 2 | 行布局（exec 竖条 + branch） | 否 | `gian-v2.css`, `CodingView.tsx` (SessionRow) |
| 3 | 分组折叠 + count | 否（localStorage） | `CodingView.tsx`, `gian-v2.css` |
| 4 | workspace 隐藏 | 是（1 字段 + 迁移） | `model.ts`, workspace API, `SettingsBody.tsx`, sidebar/picker |
| 5 | theme/accent 扩展 + 重置 | 是（重置默认值逻辑） | `tokens.css`, `SettingsBody.tsx`, `App.tsx` |
| 6 | Gian 吉祥物 + 工作动画 | 否 | 新文件 `components/GianMascot.tsx`, `CodingView.tsx` |

---

## 3. 字体分区缩放

### 3.1 三个分区

| 分区 key | 包含什么 | 默认 |
|---------|---------|------|
| `chrome` | topbar / sidebar / inspector / settings / popovers | M |
| `chat` | transcript（消息、事件卡、approval 卡） | M |
| `code` | sheet（代码 / md 预览）、tty / xterm 终端 | M |

### 3.2 档位

```ts
type FontScale = 'sm' | 'md' | 'lg' | 'xl';
```

每档对应一个乘数：

| 档位 | 乘数 |
|------|-----|
| sm | 0.875 |
| md | 1.0 |
| lg | 1.125 |
| xl | 1.25 |

### 3.3 CSS 实现 — 单变量 `--zone-scale`

`tokens.css` 现在有 `--fz-11/12/13/14/16/20/28`（全 px）。改造**只动 token 定义和 3 个 zone container**，不重命名 token、不批量改 selector。

利用 CSS 自定义属性的 lazy evaluation：`var(--zone-scale)` 在使用点（消费 token 的元素）解析，自动按 ancestor 取值。

```css
/* body 默认 + 三个分区档位 */
body {
  --scale-chrome: 1;
  --scale-chat: 1;
  --scale-code: 1;
  --zone-scale: 1;                       /* fallback，body 内裸用 token 时不挂分区 */
}
body[data-scale-chrome="sm"] { --scale-chrome: 0.875; }
body[data-scale-chrome="lg"] { --scale-chrome: 1.125; }
body[data-scale-chrome="xl"] { --scale-chrome: 1.25;  }
/* chat / code 同理 */

/* token 单次定义，引用 zone scope 内的 --zone-scale */
:root {
  --fz-11: calc(11px * var(--zone-scale, 1));
  --fz-12: calc(12px * var(--zone-scale, 1));
  --fz-13: calc(13px * var(--zone-scale, 1));
  --fz-14: calc(14px * var(--zone-scale, 1));
  --fz-16: calc(16px * var(--zone-scale, 1));
  --fz-20: calc(20px * var(--zone-scale, 1));
  --fz-28: calc(28px * var(--zone-scale, 1));
}

/* 三个 zone container 各自把 --zone-scale 绑到对应的 --scale-* */
.sidebar, .topbar, .inspector, .settings-tab-body {
  --zone-scale: var(--scale-chrome);
}
.transcript, .composer, .composer-wrap, .approval, .evt {
  --zone-scale: var(--scale-chat);
}
.sheet, .tty, .gian-terminal, .sheet-file, .md-preview {
  --zone-scale: var(--scale-code);
}
```

**为什么不用 container `font-size` + `em`**：em 在嵌套 font-size 元素上会复合
（child 的 em 是相对 parent 的 font-size 而不是 zone container 的），导致
小尺寸字号被多次缩放。`var(--zone-scale)` 是简单乘法，不嵌套，不复合。

**XTerm 字号**：xterm 的 fontSize 是 JS option，不能用 CSS。在 Terminal.tsx
的 MutationObserver（line 91）里把 `data-scale-code` 加入监听属性，变化
时调用 `term.options.fontSize = parseInt(getComputedStyle(body).getPropertyValue('--fz-13'))` 后 `fit.fit()`。

### 3.4 SystemConfig

```ts
// 新增
font_scale_chrome: FontScale;
font_scale_chat: FontScale;
font_scale_code: FontScale;
```

默认全 `'md'`。

### 3.5 Settings UI

"Appearance" 分区在 Density 下面追加三组 segmented control：

```
Font · 界面    [SM] [MD] [LG] [XL]
Font · 对话    [SM] [MD] [LG] [XL]
Font · 代码    [SM] [MD] [LG] [XL]
```

### 3.6 切换路径

`App.tsx` 的 useEffect（line 83-87）增加三行：

```ts
document.body.setAttribute('data-scale-chrome', systemConfig.font_scale_chrome);
document.body.setAttribute('data-scale-chat', systemConfig.font_scale_chat);
document.body.setAttribute('data-scale-code', systemConfig.font_scale_code);
```

xterm 实例监听 `body` 的 attribute change（已经有这个 observer，
`Terminal.tsx:91`，加上 `data-scale-code`）然后 refit。

---

## 4. 行布局重做

### 4.1 目标布局

```
┌─────────────────────────────────┐
│┃ Session 名（标题）         [●]│   row1: title + status icon
│┃ ⎇ feat/x · GianDev · 3m       │   row2: branch + workspace + time
└─────────────────────────────────┘
 ↑
 3px executor 竖色条（跨两行）
```

### 4.2 改动点

`SessionRow`（`CodingView.tsx:659-698`）：

- 删除 row2 里 `.ri-exec`（"Claude / Codex" 文字）
- 改成在 `.rail-item` 自身加 `claude` / `codex` class，CSS 用伪元素画竖条
- row2 重排为：`branch (with ⎇ icon) · workspace · age`
- branch 缺失（new session 没分支信息）时整段省略，row2 变成 `workspace · age`

`gian-v2.css`：

```css
.rail-item { padding-left: 14px; position: relative; }
.rail-item::before {
  content: ""; position: absolute;
  left: 4px; top: 9px; bottom: 9px;
  width: 3px; border-radius: 2px;
  background: var(--exec-color, var(--text-3));
}
.rail-item.claude { --exec-color: var(--claude); }
.rail-item.codex  { --exec-color: var(--codex); }

.ri-branch {
  color: var(--text-2);
  display: inline-flex; align-items: center; gap: 3px;
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
  max-width: 110px;
}
.ri-branch svg { width: 9px; height: 9px; opacity: 0.7; flex: none; }
```

branch icon 用现有的 git branch SVG（`ICON.branch` 在 CodingView 里已经有，
sidebar 里直接复用）。

### 4.3 状态指示

`.ri-status` 不变（StatusIcon 已经覆盖 running/pending/error/done 四态，
保留），右上角 14px 圆形。

### 4.4 列表里的 branch 数据从哪来

`Session.branch` 是已有字段（`packages/shared/src/model.ts:112`，由 host 维护）。
不用新增 API。

### 4.5 无障碍（颜色 ≠ 唯一区分）

竖色条只是色彩辅助，executor 的语义信息还要有：

- `.rail-item` 加 `title={executor === 'claude' ? 'Claude' : 'Codex'}` 和
  `aria-label`（拼到现有的 session name 后面：`"Refactor session manager — Claude"`)
- row1 标题左侧加一个 1em 高的 mini exec icon（claude 火苗 / codex 方块），
  跟随 `currentColor`：低对比主题下也能识别
- 不引入 hover chip（噪音 vs. 收益不划算）

```html
<div class="ri-row1">
  <span class="ri-exec-mini claude" aria-hidden="true">
    <svg viewBox="0 0 12 12" width="12" height="12">...</svg>
  </span>
  <span class="ri-title">Refactor session manager</span>
</div>
```

```css
.ri-exec-mini { flex: none; color: var(--text-3); opacity: 0.7; }
.ri-exec-mini.claude { color: var(--claude); }
.ri-exec-mini.codex  { color: var(--codex); }
```

---

## 5. 分组样式 — D（折叠 + count，无色）

### 5.1 视觉

```
▾ GianDev                    3
┃ ...session...
┃ ...session...
┃ ...session...
▾ remote-vibe-coding         2
┃ ...session...
┃ ...session...
▸ misc-experiments           1
```

### 5.2 CSS（gian-v2.css）

替换 `.sb-group`：

```css
.sb-group {
  padding: 8px 8px 4px;
  font: 600 11px/1 var(--font-mono);
  color: var(--text-2);
  letter-spacing: 0;     /* 取消大写 + tracking */
  text-transform: none;
  cursor: pointer;
  user-select: none;
  display: flex; align-items: center; gap: 6px;
}
.sb-group .caret {
  color: var(--text-3);
  font-size: 9px;
  width: 9px;            /* 占位固定宽度，避免 expand/collapse 时数字跳动 */
}
.sb-group .count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  background: var(--surface-2);
  border-radius: 3px;
  padding: 1px 5px;
}
```

`.sb-group.needs-you` 保留现有 warn 配色，不可折叠。

### 5.3 折叠状态持久化

每个 `groupBy` 模式 + 每个分组 key 单独记一份。

```ts
// localStorage key: `gian.sidebar.collapsed.${groupBy}` → string[] of collapsed group keys
```

只对 `groupBy === 'workspace'` 默认展开所有；time / status 模式下默认也展开。

### 5.4 CodingView 改动

`renderGroups()`（line 403）每个分组头改成可点击；维护一个
`collapsed: Set<string>`。被折叠的组不渲染子项，只渲染 header。

---

## 6. workspace 隐藏

### 6.1 数据模型

`Workspace`（`packages/shared/src/model.ts:73`）新增字段：

```ts
hidden: 0 | 1;       // SQLite 布尔惯例（同 Session.archived）
```

DB 迁移：新建 `packages/host/migrations/022_workspace_hidden.sql`，
`ALTER TABLE workspaces ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;`

### 6.2 API

复用现有的 workspace 更新接口（`PATCH /api/workspaces/:id`，若没有就加），
接收 `{ hidden: boolean }`。

### 6.3 Sidebar 行为

`Sidebar.filtered`（`CodingView.tsx:378`）追加一条：

```ts
const ws = wsById.get(s.workspace_id);
if (ws?.hidden) return false;
```

`Sidebar.archivedSessions` 同样过滤。

### 6.4 新建 session 下拉行为

`NewSessionView`（line 824 起）的 workspace 选择器（line 540 也有一个简易版
在 filter pop 里 — 那是 filter，不动）：

- 隐藏的 workspace 仍然在 `<option>` 列表里
- 加 `disabled` 属性
- label 加灰色斜体 ` (隐藏)` 后缀
- 默认选中的 workspace 如果是 hidden，回退到第一个非 hidden

### 6.5 Settings 新增分区

在"Appearance"和"Executors"之间，加 "Workspaces" 分区：

```
Workspaces
  ┌────────────────────────────┬────┐
  │ GianDev      ~/Coding/Gian │ 显示│
  │ RVC          ~/Coding/RVC  │ 显示│
  │ misc         ~/Coding/Misc │ 隐藏│
  └────────────────────────────┴────┘
                                ↑ toggle switch / 复选
```

每行一个开关 `显示/隐藏`。点了立即 PATCH。

### 6.6 反悔通路 / 可发现性

侧栏底部（Archived 折叠条**下方**）当 `hiddenWorkspaceCount > 0` 时显示
一条很轻的链接：

```
↳ 3 hidden workspaces · manage
```

- 样式参考 `.sb-archived`（同款灰色 ghost 按钮），点击跳转 Settings →
  Workspaces 分区
- N === 0 时整条不渲染，避免噪音
- 这是隐藏后唯一的**外部**发现入口；新建 session 下拉里的灰色项是次要通路

### 6.7 当前 active session 的 workspace 被隐藏

边角 case：用户 hide 了一个 workspace，但该 workspace 下有 active session
正在主区展示。处理规则：

- active session 在侧栏**照常显示**（不跟着 workspace 一起被过滤）
- session 行右上角加一个小 hidden 图标（眼睛划掉，14px，`text-3` 色），
  title 为 "Workspace 已隐藏 — 在 Settings 里管理"
- 这条规则只对 `s.id === activeSessionId` 生效；其他属于隐藏 workspace 的
  session 仍然被过滤掉

---

## 7. theme / accent 改造

### 7.1 Accent 扩展

`tokens.css` 第 67-71 行替换为：

```css
body                        { --accent-h: 220; --accent-c: 0.13; }  /* fallback = azure */
body[data-accent="azure"]   { --accent-h: 220; --accent-c: 0.13; }
body[data-accent="amber"]   { --accent-h:  50; --accent-c: 0.14; }
body[data-accent="violet"]  { --accent-h: 300; --accent-c: 0.13; }
body[data-accent="teal"]    { --accent-h: 195; --accent-c: 0.10; }
body[data-accent="moss"]    { --accent-h: 150; --accent-c: 0.10; }
body[data-accent="ink"]     { --accent-h: 255; --accent-c: 0.11; }
body[data-accent="plum"]    { --accent-h: 310; --accent-c: 0.13; }
body[data-accent="ember"]   { --accent-h:  30; --accent-c: 0.13; }
```

8 个 accent，三个是 theme 默认（azure / amber / violet），五个备选
（teal / moss / ink / plum / ember）。

### 7.2 theme 默认 accent 映射

```ts
const THEME_DEFAULT_ACCENT: Record<SystemConfig['theme'], string> = {
  light: 'azure',
  warm:  'amber',
  dark:  'violet',
};
```

放在 `packages/shared/src/model.ts` export 出来（前后端共享）。

### 7.3 切 theme 重置 accent（"每次重置但允许覆盖"）

在 `SettingsBody.tsx` Theme 那 4 个按钮的 onClick 里：

```ts
onClick={() => patch({
  theme: key,
  accent: THEME_DEFAULT_ACCENT[key],     // 总是重置
})}
```

用户切完 theme 之后还可以单独改 accent — 因为 Accent 按钮组只改 `accent`，
不动 theme。

### 7.4 历史数据 / 运行时 sanitize

启动时 `loadConfig` 不主动改用户已有的 accent。只是切 theme 时才重置。
旧的 plum/moss/ink/ember 仍然有效（它们在新表里都还在），不破坏现存配置。

**但是** TypeScript 字面量联合类型只在编译期管用，运行时 `loadConfig`
（`packages/host/src/storage/config.ts:84`）从 SQLite 直接读字符串，DB 里
如果是无效值会漏过去。要在 `loadConfig` 里加 allowlist 兜底：

```ts
const VALID_ACCENTS = new Set(['azure','amber','violet','teal','moss','ink','plum','ember']);
const VALID_SCALES = new Set(['sm','md','lg','xl']);
const VALID_THEMES = new Set(['light','warm','dark']);

const rawAccent = map.get('accent') ?? '';
const theme = (VALID_THEMES.has(map.get('theme') ?? '')
  ? map.get('theme')
  : 'warm') as SystemConfig['theme'];
const accent = VALID_ACCENTS.has(rawAccent)
  ? rawAccent
  : THEME_DEFAULT_ACCENT[theme];
```

同样的 sanitize 用于三个 `font_scale_*` 字段（无效 → `'md'`）。

### 7.5 Settings UI 顺序

把 accent 改成 8 个圆色块，按色相环排序：

```
Accent  ● ● ● ● ● ● ● ●
        em am pl vi in az te mo
```

顺序（暖 → 冷）：**ember · amber · plum · violet · ink · azure · teal · moss**。

`SystemConfig['accent']` 是字符串字面量联合类型，保证选项不会拼错。

---

## 8. Gian 吉祥物 + 工作状态指示

### 8.1 选定概念

**Boombox-G**（mockup 里的第 1 个 — 字母 G 做成 logomark，"嘶吼"气质）。

### 8.2 工作状态来源

数据来源是 `Session.status`：

- `'running'` 或 `'pending'` → 工作中（动画转）
- 其他 → 静止（不显示或显示静态版）

这个状态在 host 层是整轮粒度（`session/manager.ts:667/1374`），稳定可靠，
不会 flicker。

### 8.3 组件

新建 `packages/web/src/components/GianMascot.tsx`：

```tsx
export function GianMascot(props: {
  size: number;            // 像素
  state: 'idle' | 'working';
  title?: string;
}): JSX.Element;
```

实现两个内联 SVG：

- `<GianStatic />` — 字母 G logomark
- `<GianWorking />` — 上面那个 G 加 CSS animation（嘴部 / 声波 / 抖动）

两个 SVG 都按 viewBox `0 0 64 64` 设计，外层 `<svg width={size} height={size}>`
控制尺寸。颜色用 `currentColor` 和 `var(--accent)`，自动跟主题走。

### 8.4 放在哪

替换掉 `MainPane` 的 `main-head` 的 `.session-status`（`CodingView.tsx:1284`
附近）。

- 工作时：左上角放 24-32px `<GianWorking />`，旁边是 session 状态文字（保留 "RUNNING" 标签）
- 空闲时：放静态 G logomark（小，作为 session 区域的品牌锚点 + 状态指示）

侧栏 `StatusIcon`（`CodingView.tsx:703`）**不动** — 还是小 spinner，因为
那是"列表里"，不是"主区"，不需要吉祥物级别的展示。

### 8.5 砍掉 transcript 里的 "thinking…" 文字（重要）

调研结论：transcript 内 per-card 的 thinking 文字跟着 stream 闪烁是不
稳定的源头。它的角色（per-card "正在生成内容"）已经被以下东西覆盖：

- 卡片里的 streaming 文字本身在动
- Cursor blink（`.cursor` 类）

所以"整轮在干活"这个语义全部交给 main-head 的 Gian。

具体：搜索 `apply.ts` / `Transcript.tsx` 里的 "thinking" 字符串显示，删除/
不渲染。如果是模型 native 的思考块（reasoning content），那是另一种东西，
保留。

### 8.6 大尺寸展示位（可选）

空 session（`session.status === 'new'` 且无消息）的占位区域用 96px 静态
Boombox-G 做品牌展示。这是 mockup 里展示的"showcase"尺寸。

---

## 9. SystemConfig 变更汇总

合并新增字段：

```diff
 export interface SystemConfig {
   /* ...现有字段 */
   theme: 'light' | 'warm' | 'dark';
-  accent: string;
+  accent: 'azure' | 'amber' | 'violet' | 'teal' | 'moss' | 'ink' | 'plum' | 'ember';
   density: 'compact' | 'cozy' | 'roomy';
+  font_scale_chrome: 'sm' | 'md' | 'lg' | 'xl';
+  font_scale_chat: 'sm' | 'md' | 'lg' | 'xl';
+  font_scale_code: 'sm' | 'md' | 'lg' | 'xl';
   /* ... */
 }
```

`Workspace`：

```diff
 export interface Workspace {
   id: string;
   name: string;
   path: string;
   sort_order: number;
+  hidden: 0 | 1;          // SQLite 布尔惯例（同 Session.archived）
   created_at: string;
   updated_at: string;
 }
```

---

## 10. 兼容 / 迁移

- **SystemConfig**：新字段 host 端 `loadConfig` 默认值即可向后兼容；现有
  数据库里没这些 key 就走默认。
- **Workspace.hidden**：单独的 SQL 迁移，`DEFAULT 0`，零侵入。
- **accent**：旧值（plum/moss/ink/ember）在新枚举里都还存在，不破坏。
  如果旧值不在新表里（不该有，但理论上），fallback 到当前 theme 的默认 accent。
- **font scale**：新字段，默认 `'md'`，等于现状。

---

## 11. 测试

### 11.1 单元测试

- `tokens.css` 不写测试（视觉用 mockup 验）
- `SettingsBody` 已有测试（`packages/web/test/settings-external-editors.test.tsx`），
  仿照模式给新分区写：font scales / hidden workspace toggle / accent click
  各一个 happy-path
- `loadConfig` 测试新字段的默认值
- workspace migration：在 host migration 测试套件里跑一遍

### 11.2 视觉 / 交互

- E2E（如果有）：切 theme 验证 accent 重置；隐藏 workspace 验证侧栏过滤
- 手测 checklist 在 plan 阶段补

---

## 12. 范围外

- 自定义字体（用户上传字体文件）
- 自定义 accent（手选任意色相）
- workspace 排序拖拽
- 吉祥物的其他三个概念（保留 mockup 给以后改）
- multi-session 全局吉祥物徽章（在 topbar 显示"N 个 session 在跑"）
- transcript 内 reasoning content 的展示方式（独立话题）

---

## 13. 参考

- mockup（分组）：`docs/mockups/2026-05-21-session-grouping.html`
- mockup（吉祥物）：`docs/mockups/2026-05-21-gian-mascot.html`
- 现状 row 渲染：`packages/web/src/views/CodingView.tsx:659-698`
- 现状 group 渲染：`packages/web/src/views/CodingView.tsx:403-468`
- session 状态翻转：`packages/host/src/session/manager.ts:667, 1374`
- 现状 tokens：`packages/web/src/styles/tokens.css:64-71`（accent）
  / `:12-18`（font sizes）
