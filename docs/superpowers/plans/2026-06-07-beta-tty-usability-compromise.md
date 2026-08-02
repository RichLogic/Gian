# Beta TTY 可用性批次（妥协方案 / line C）Implementation Plan

> **For agentic workers:** 用 superpowers:executing-plans 按 task 实现。纯前端（web），不碰 cc-proxy / ScreenModel。线 A（完整闭环驱动）不取消，往后排。

**Goal:** 用最低成本让 Beta(Claude TTY) 现在就好用：① `Ctrl+\`` 一键切 Chat视图↔CLI；② model/effort/mode 在 TTY 下改"展示+点击跳CLI"（去掉点不动的 picker）；③ AskUserQuestion 卡片去掉会卡住的 paste、改成"去 CLI 回答"按钮（CLI 里的原生选择器才是可靠路径）。

**Architecture:** 全部 web 侧。surface 值 `'chat'|'beta'|'cli'`（TTY 聊天面=`'beta'`、终端=`'cli'`，两者同一 TTY、切换瞬时）。toggle 逻辑与问题路由抽成 `session-routing.ts` 纯函数单测；快捷键用 document 捕获阶段监听（先于 xterm，preventDefault+stopPropagation）。

**Tech Stack:** React + vitest；既有 `CodingView` / `Composer` / `ApprovalCard`/`QuestionCard`(items.tsx) / `session-routing.ts`。

来源：本会话妥协方案对齐（model/mode/effort 展示、问题卡跳 CLI、Ctrl+` 快捷键）。

---

## 文件结构

| 文件 | 动作 |
|---|---|
| `packages/web/src/session-routing.ts` | 加纯函数 `toggleTtySurface`；`planApprovalResponseDispatch` 的 claude+tty+question 改返回 `{channel:'cli'}` |
| `packages/web/test/billing-claude-tty-routing.test.ts` | `toggleTtySurface` 单测 + 更新 question→cli 的断言 |
| `packages/web/src/views/CodingView.tsx` | `Ctrl+\`` 捕获监听；`handleTranscriptApprove` 处理 `channel==='cli'`；问题 dock 加"去 CLI 回答"按钮；给 Composer 传 `onJumpToCli` |
| `packages/web/src/components/Composer.tsx` | 加 `onJumpToCli` prop；TTY 下 model/effort/mode 控件点击改跳 CLI |
| `packages/web/src/transcript/items.tsx` | `ApprovalCard`/`QuestionCard` 加 `onAnswerInCli`，TTY 问题渲染"去 CLI 回答"主按钮 |
| `packages/web/src/i18n/en.ts`, `zh.ts` | `coding.tty.toCli` / `transcript.question.answerInCli` |

测试命令：`pnpm --filter @gian/web exec vitest run test/billing-claude-tty-routing.test.ts`；`pnpm --filter @gian/web typecheck`。

---

## Task C1: `toggleTtySurface` 纯函数 + `Ctrl+\`` 快捷键

**Files:** `session-routing.ts`, `billing-claude-tty-routing.test.ts`, `CodingView.tsx`

- [ ] **Step 1: 失败测试**

`billing-claude-tty-routing.test.ts` import 加 `toggleTtySurface`，加：

```ts
describe('toggleTtySurface', () => {
  it('flips cli → beta', () => { expect(toggleTtySurface('cli')).toBe('beta'); });
  it('flips beta → cli', () => { expect(toggleTtySurface('beta')).toBe('cli'); });
});
```

- [ ] **Step 2: 跑测试失败** — `pnpm --filter @gian/web exec vitest run test/billing-claude-tty-routing.test.ts` → `toggleTtySurface is not a function`。

- [ ] **Step 3: 实现纯函数**（`session-routing.ts` 末尾）

```ts
/**
 * Ctrl+` flips between the TTY chat view ('beta') and the raw CLI ('cli').
 * Only meaningful in a TTY session; the caller gates on runtime_mode==='tty'
 * and leaves structured 'chat' alone.
 */
export function toggleTtySurface(current: SessionSurface): SessionSurface {
  return current === 'cli' ? 'beta' : 'cli';
}
```

- [ ] **Step 4: 跑测试通过 + 接快捷键**

`CodingView.tsx` import 加 `toggleTtySurface`；在 `handleSelectSurface` 定义之后加捕获阶段监听（`session`/`surface`/`handleSelectSurface` 均在该组件作用域）：

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    // Ctrl+` toggles TTY chat-view ↔ CLI. Capture phase so xterm never sees
    // it; bare backtick still types in the terminal. claude TTY sessions only.
    if (!e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== '`' && e.code !== 'Backquote') return;
    if (session.executor !== 'claude' || session.runtime_mode !== 'tty') return;
    if (surface !== 'beta' && surface !== 'cli') return;
    e.preventDefault();
    e.stopPropagation();
    handleSelectSurface(toggleTtySurface(surface));
  };
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}, [session.executor, session.runtime_mode, surface, handleSelectSurface]);
```

跑 `vitest run test/billing-claude-tty-routing.test.ts`（PASS）+ `pnpm --filter @gian/web typecheck`（干净）。

- [ ] **Step 5: 提交** — `feat(web): Ctrl+backtick toggles TTY chat view and CLI`

---

## Task C2: AskUserQuestion 改"去 CLI 回答"（去掉会卡的 paste）

**Files:** `session-routing.ts`, `billing-claude-tty-routing.test.ts`, `CodingView.tsx`, `items.tsx`, i18n

- [ ] **Step 1: 失败/更新测试**

`billing-claude-tty-routing.test.ts` 里现有断言 claude+tty+question 走 `{channel:'tty', text:...}` 的用例，改为期望 `{channel:'cli'}`：

```ts
it('routes a TTY claude question answer to the CLI surface (no paste-back)', () => {
  expect(planApprovalResponseDispatch({
    executor: 'claude', runtimeMode: 'tty', surface: 'beta',
    decision: 'allow_once', context: { category: 'question' },
  })).toEqual({ channel: 'cli' });
});
```

- [ ] **Step 2: 跑测试失败**（仍返回 `{channel:'tty', ...}`）。

- [ ] **Step 3: 改 `planApprovalResponseDispatch`**（`session-routing.ts`）

把 `ApprovalResponseDispatchPlan` 的 `| { channel: 'tty'; text: string }` 改为 `| { channel: 'cli' }`，函数体里 claude+tty+question 分支改为：

```ts
  if (input.executor === 'claude' && input.runtimeMode === 'tty' && input.context?.category === 'question') {
    // The interactive selector lives in the PTY; pasting prose can't answer it
    // (it cancels). Send the user to the CLI where Claude's own selector is
    // blocking — JSONL/PostToolUse resolves the card once they pick there.
    return { channel: 'cli' };
  }
```

（`formatBetaQuestionResponse`/`formatBetaQuestionAnswers` 暂留，后续 line A 在-chat 闭环时复用；不再被 question 路径调用。）

- [ ] **Step 4: `handleTranscriptApprove` 处理 cli 通道**（`CodingView.tsx`，第 ~1481）

把现有 `if (plan.channel === 'tty') { onBetaSend(plan.text); onLocalApprovalResolve(...); return; }` 改为：

```tsx
    if (plan.channel === 'cli') {
      // Don't paste / don't locally resolve — jump to the CLI where the real
      // selector waits; the JSONL watcher resolves the card on the real pick.
      handleSelectSurface('cli');
      return;
    }
```

- [ ] **Step 5: 卡片"去 CLI 回答"按钮**（`items.tsx`）

`ApprovalCard` / `QuestionCard` 加可选 `onAnswerInCli?: () => void`。`QuestionCard` 在 `onAnswerInCli` 存在时，于 Submit/Cancel 行前插一个主按钮：

```tsx
{onAnswerInCli && (
  <button className="btn primary sm" onClick={onAnswerInCli}>
    {t('transcript.question.answerInCli')}
  </button>
)}
```

`ApprovalCard` 把 `onAnswerInCli` 透传给 `QuestionCard`。

- [ ] **Step 6: CodingView 传 `onAnswerInCli`**

两处 `ApprovalCard`/Transcript 渲染（内联 transcript 第 ~1607、dock 第 ~1619）传 `onAnswerInCli={() => handleSelectSurface('cli')}`（仅 claude TTY 时有意义，非 TTY 传 undefined）。

- [ ] **Step 7: i18n** — en `transcript.question.answerInCli: 'Answer in CLI'`；zh `'去 CLI 回答'`。

- [ ] **Step 8: 测试 + typecheck + 提交** — `fix(web): TTY AskUserQuestion routes to CLI instead of broken paste-back`

---

## Task C3: model / effort / mode 在 TTY 下改展示 + 点击跳 CLI

**Files:** `Composer.tsx`, `CodingView.tsx`

- [ ] **Step 1: Composer 加 `onJumpToCli` prop**

解构加 `onJumpToCli`；类型加 `onJumpToCli?: () => void;`。计算 `const ttyDisplayOnly = session.runtime_mode === 'tty';`

- [ ] **Step 2: model/effort 控件 TTY 下跳 CLI**

model 触发按钮（第 ~761）`onClick` 改为：

```tsx
onClick={() => { if (ttyDisplayOnly) { onJumpToCli?.(); return; } setModelPopOpen(v => !v); }}
```

TTY 下 title 改成"在 CLI 中修改 model/effort"。（effort 在同一弹层，弹层不开即覆盖；chip 上的 `ThinkBars` 仍展示当前 effort。）

- [ ] **Step 3: mode 控件 TTY 下跳 CLI**

定位 Composer 里 mode 控件（`onSetMode` 的触发按钮，grep `composer.mode`/permission 按钮），同样 `if (ttyDisplayOnly) onJumpToCli?.()`。若 mode 用快捷循环按钮，TTY 下点击改跳 CLI。

- [ ] **Step 4: CodingView 传 `onJumpToCli`**

`<Composer ... onJumpToCli={() => handleSelectSurface('cli')} />`。

- [ ] **Step 5: typecheck + 既有 Composer 相关测试 + 提交** — `feat(web): model/effort/mode are display-only in TTY, click jumps to CLI`

---

## Task C4: 全量验证

- [ ] web 全量 `pnpm --filter @gian/web exec vitest run`、`pnpm --filter @gian/web typecheck`、`pnpm --filter @gian/web build` 全过。
- [ ] traceability 加一行 `BETA-TTY-USABILITY-001`（GAP，待真机）。
- [ ] `git diff --check` 干净。
- [ ] 真机自检（8991）：`Ctrl+\`` 切 Chat↔CLI（终端聚焦时也生效、裸反引号仍能输入）；TTY 下点 model/effort/mode 跳 CLI；Claude 问问题时卡片出"去 CLI 回答"、点了跳 CLI、在 CLI 选完卡片消解。

---

## Self-Review
- A 快捷键（C1）/ B 展示跳转（C3）/ C 问题卡跳 CLI（C2）三件都覆盖。
- 纯前端、不碰 cc-proxy；不删 `formatBetaQuestion*`（line A 复用）。
- `planApprovalResponseDispatch` 的 `tty` 通道改 `cli`：更新 billing 测试断言；`onBetaSend`/`onLocalApprovalResolve` 不再被 question 走（composer 普通发送仍用 `onBetaSend`，不动）。
