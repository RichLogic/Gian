# Review — `2026-05-21-session-ui-polish-design.md`

**评审日期:** 2026-05-21
**评审对象:** `docs/superpowers/specs/2026-05-21-session-ui-polish-design.md`
**结论:** 方向对,可以进 plan;plan 前先定三件事(见末尾)。

---

## 总体

写得扎实,引用准确(行号、token、field 都对得上)。捆绑 6 项的论证(共享
`SystemConfig` 扩展 + 共享 settings UI + 共享 tokens + row/group 协同)成立。

下面按优先级列担心的点。

---

## 🔴 值得在 plan 前先讨论的

### 1. §3.3 字体分区:21 个新 token,改造面比看起来大

提案是为 chrome / chat / code 三族各建一套 `--fz-{zone}-{N}` 变量(7 × 3 = 21
个新 token),然后逐个 selector 改 `var(--fz-13)` → `var(--fz-chrome-13)`。

实际工作量:

- `gian-v2.css` 当前散落着大量 `var(--fz-*)` 引用,改造要逐处分类
- 每个新 selector 加 CSS 都要先想"属于哪个 zone"
- 几乎不可逆——一旦提交,所有未来的 CSS 都得遵循这套 3-zone 心智模型

**轻量替代方案**:不动 `--fz-*` token,改成 zone 容器上设
`font-size: calc(13px * var(--scale-chat))`,内部子元素用 `em` 继承。三个 zone
各一行 CSS,token 表零变动。

代价是要求 zone 内部的 CSS 用 `em`(部分会需要重写)。但范围更小、回滚更便宜。

**建议**:plan 时选一个 zone 做 spike,看哪种方案落得更干净再定。

### 2. §7.3 切 theme 自动重置 accent —— 默认行为可能反感

```ts
onClick={() => patch({ theme: key, accent: THEME_DEFAULT_ACCENT[key] })}
```

用户精心挑了 plum,切到 dark 想看一眼立刻被改成 violet,要再切回来才能恢复。
"还可以再单独改"是补救但不是预防。

更友好的两个选择:

- **A**:不自动重置,在 accent 区上方加个文案"用 [theme] 默认配色"按钮(单击重置)。
- **B**:自动重置 + 显示 toast「已切到 violet · 撤销」。

倾向 A——更克制,且不需要 toast 基础设施。

### 3. §8.5 砍 transcript 内 "thinking…" —— 锚点风险

把"整轮在干活"全交给 main-head 的 Gian,前提是 **main-head sticky**。看了下
`CodingView.tsx:1284` 这块用 `<main>` 包,不像是 sticky/fixed。如果用户已经滚到
transcript 中段在读历史,session 进入新一轮工作,他**看不到任何动效**——因为
cursor blink 是 idle 输入框的,不代表 stream 在跑。

**建议**:先确认 main-head 是 sticky,如果不是要么先做 sticky、要么保留一个轻量
的页内指示(比如 composer 旁边一个 3px 的脉冲点)。

### 4. §4 执行器从文字 → 3px 竖色条 —— 颜色单维度依赖

去掉 "Claude / Codex" 文字,只剩竖条颜色区分。对色弱用户、对比度受损的 theme
(warm 主题下 accent 暖色可能跟 claude 的 amber 撞)都不友好。

**建议**:保留 `title="Claude"`(已有 aria-label 习惯也补一下),或者在 hover/
focus 时 row 浮一个 chip。

---

## 🟡 小修订(建议在写 plan 时一并修)

- **§6.1 迁移编号**:当前 migrations 列表是 `001-015, 017, 020, 021`,缺
  016/018/019。这些是历史合并掉的还是真的丢号?确认一下,如果是真丢号,可能希望
  先补再加新的;如果是合并历史,`022_workspace_hidden.sql` 没问题。
- **§7.1 vs §7.2 默认 accent 不一致**:`tokens.css` body fallback 是 azure,但
  §7.2 theme→accent 映射对 dark 是 violet。如果用户配置里 `accent` 字段缺失
  (老用户从未点过),fallback 应该走 §7.2 映射,不是 body azure。`loadConfig`
  里加一个 sanitize 逻辑(读取后如果不在新枚举里,按 theme 映射回写)更稳。
- **§9 `accent` 改成字面量联合类型**:DB 里存的是任意字符串,反序列化时 TS 类型
  系统不能阻止脏数据。需要在 loadConfig 处加 runtime 校验,不在新表里就 fallback。
  spec §7.4 提到了"理论上不该有",但代码上得真做一下。
- **§3.6 xterm 监听**:确认下,`Terminal.tsx:88-92` 的 `attributeFilter` 现在是
  `['data-theme', 'data-accent']`,需要加 `data-scale-code`,并且 `repaintTheme`
  之外要 trigger `fit + 重设 fontSize`(不只是 theme)。这是个**两步动作**,spec
  现在只说"加上 data-scale-code",写 plan 时把 handler 也明确分开。
- **§5.3 折叠状态 localStorage**:per-browser,换浏览器丢。如果用户介意,以后再
  升级到 SystemConfig。spec 应该把"范围外:多端同步"明确写到 §12。
- **§4.2 branch `max-width: 110px`**:此 repo 实际分支名(`worktree/abc123`、
  `feat/codex-cli-runtime-mode`)110px 截断会很难看。改成 `max-width: 14ch` 之类
  的字符单位更鲁棒,而且 follow font scale。
- **§6.6 workspace 隐藏后无提示**:用户哪天问"我那个 session 哪去了",得自己想到
  去 Settings → Workspaces 里找。可以在 sidebar 底部加一行非常 subtle 的
  `N hidden workspaces`(点击跳到 settings),但仅当 N > 0 时显示。spec 现在的
  "不显示"是一种选择,值得在 plan 阶段写明取舍。

---

## 🟢 可以分批落地

捆绑写在一份 spec 没问题,但 plan 阶段我会按依赖切两到三个 PR:

1. **PR-A:tokens/config 基建**(§3 字体 + §5 accent 扩展 + §7 重置策略 + §9
   SystemConfig 字段)。所有"动数据模型 + 动 tokens"的事一次性来,settings UI
   一次性扩。
2. **PR-B:Sidebar 体验**(§4 row 布局 + §5 分组折叠 + §6 workspace 隐藏 +
   workspace migration)。视觉锚点协同。
3. **PR-C:吉祥物 + thinking 替换**(§8)。独立、可视觉验证、必要时可回滚。

理由:1 是基础设施改动,出问题影响大,单独 review;2 是 sidebar 视觉协调,要
一起调;3 是新组件 + 行为改动,可独立验证不影响其他。

---

## 一句话结论

方案方向对,可以进 plan。**plan 之前定三件事**:

1. 字体分区是 21-token 方案还是 em-继承方案?
2. 切 theme 是否自动重置 accent?
3. main-head 是不是 sticky?(决定 thinking 文字能不能删)
