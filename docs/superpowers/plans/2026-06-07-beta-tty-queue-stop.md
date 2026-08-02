# Beta TTY 队列 + 停止（线 B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Beta（Claude TTY）面恢复消息队列、并让停止按钮真正打断 TTY 回合且状态同步 —— 全部不依赖 line A 的 ScreenModel/闭环驱动。

**Architecture:** 队列与停止都是 host 侧通道分流：①停止——`SessionManager.stopTurn` 按 `runtime_mode` 分支，TTY 走新 `TtyManager.interrupt()` 往 PTY 注 Esc（而非结构化 `interruptTurn`）；②队列排空——`TtyManager` 收到 `Stop` hook 时回调 `SessionManager.drainTtyQueue()`，弹队首并经 `ttyMgr.input({text})` paste 进 PTY；`send_now` 在 TTY 下立刻 paste（不等 Stop）。web 侧把 Beta 的 `disabledSubmitBehavior` 改回 `queue`、并让 Stop 按钮读真实 running 态——两处逻辑抽成 `session-routing.ts` 纯函数单测。

**Tech Stack:** TypeScript；host 用 `node:test`（`--import tsx`）；web 用 vitest；既有 `QueueManager` / `TtyManager` / `SessionManager` / `Composer` / `session-routing.ts`。

来源 spec：`docs/superpowers/specs/2026-06-07-beta-tty-controls-design.md` §7（含 (d) send_now、§7.3 Stop）。

---

## 文件结构（本计划触及）

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/host/src/tty/manager.ts` | TTY 协调器：加 `interrupt()`、加 `Stop`→turn-complete 回调 | Modify |
| `packages/host/src/session/manager.ts` | `stopTurn` 分支、`drainTtyQueue`、`sendQueuedNow` TTY 分支 | Modify |
| `packages/host/src/web/app.ts` | 接线 `tty.setTurnCompleteHandler(... sessions.drainTtyQueue)` | Modify |
| `packages/web/src/session-routing.ts` | 纯函数 `betaComposerSubmitBehavior` / `isTurnRunning` | Modify |
| `packages/web/src/components/Composer.tsx` | 新增 `running` prop，Stop/Send 切换改读 `running` | Modify |
| `packages/web/src/views/CodingView.tsx` | 用上两个纯函数 + 传 `running` | Modify |
| `packages/host/test/tty-manager.test.ts` | interrupt + Stop 回调测试（扩 stub 捕获 ttyInput） | Modify |
| `packages/host/test/beta-tty-queue-stop.test.ts` | stopTurn/drainTtyQueue/sendQueuedNow 自带 fake harness | Create |
| `packages/web/test/billing-claude-tty-routing.test.ts` | 两个纯函数单测 | Modify |

测试命令约定：
- host 单文件：`pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/<file>`
- web 单文件：`pnpm --filter @gian/web exec vitest run test/billing-claude-tty-routing.test.ts`

---

## Task 1: `TtyManager.interrupt()` —— 往 PTY 注 Esc

**Files:**
- Modify: `packages/host/test/tty-manager.test.ts`（扩 stub 捕获 `ttyInput`）
- Modify: `packages/host/src/tty/manager.ts`（`toggleRemoteControl` 附近加 `interrupt`）

- [ ] **Step 1: 扩展 stub 以捕获 `ttyInput`，并写失败测试**

在 `tty-manager.test.ts` 的 `StubCallLog` 接口加一行：

```ts
interface StubCallLog {
  ttyStart: Array<Record<string, unknown>>;
  ttyKill: Array<{ sessionId: string }>;
  ttyInput: Array<{ sessionId: string; data?: string; text?: string }>;
}
```

`makeStubClient()` 里把 `const calls` 初始化补上 `ttyInput: []`，并把 `async ttyInput() {}` 换成捕获版：

```ts
function makeStubClient() {
  const calls: StubCallLog = { ttyStart: [], ttyKill: [], ttyInput: [] };
  const client = Object.assign(Object.create(CcProxyClient.prototype), {
    async ttyStart(params: Record<string, unknown>) {
      calls.ttyStart.push(params);
      return { ok: true as const, replay: ['cmVwbGF5'], alive: true };
    },
    async ttyKill(params: { sessionId: string }) {
      calls.ttyKill.push(params);
      return { ok: true as const };
    },
    async ttyInput(params: { sessionId: string; data?: string; text?: string }) {
      calls.ttyInput.push(params);
    },
    async ttyResize() {},
    async ttyReplay() {
      return { chunks: ['Y2h1bms='], alive: true };
    },
  }) as CcProxyClient;
  return { client, calls };
}
```

在文件末尾加测试：

```ts
test('CLAUDE-TTY-005: interrupt injects Esc into the PTY', async () => {
  const ctx = setup();
  try {
    seedClaudeSession(ctx.db, { runtime_mode: 'tty' });
    await ctx.mgr.interrupt('sess-claude-1');
    assert.equal(ctx.stub.calls.ttyInput.length, 1);
    const sent = ctx.stub.calls.ttyInput[0]!;
    assert.equal(sent.sessionId, 'sess-claude-1');
    assert.equal(Buffer.from(sent.data!, 'base64').toString('utf8'), '\x1b');
  } finally {
    teardown(ctx);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/tty-manager.test.ts`
Expected: FAIL —— `ctx.mgr.interrupt is not a function`。

- [ ] **Step 3: 实现 `interrupt()`**

在 `packages/host/src/tty/manager.ts` 的 `toggleRemoteControl(...)` 方法之后加：

```ts
  /**
   * Interrupt the running turn in a live TTY session by injecting Esc — the
   * key Claude Code's TUI uses to stop the current generation. No-op when
   * there's no PTY for the session. Unlike the structured `interruptTurn`,
   * this actually reaches the interactive `claude` running in the PTY.
   *
   * NOTE: single Esc is the first cut; whether Claude needs double-Esc /
   * Ctrl-C is a line-A spike item (see spec §7.3). Keep the byte here in one
   * place so that tweak is one line.
   */
  async interrupt(sessionId: string): Promise<void> {
    const esc = Buffer.from('\x1b', 'utf8').toString('base64');
    await this.input(sessionId, { data: esc });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/tty-manager.test.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/host/src/tty/manager.ts packages/host/test/tty-manager.test.ts
git commit -m "feat(host): TtyManager.interrupt injects Esc into the PTY"
```

---

## Task 2: `TtyManager` 在 `Stop` hook 触发 turn-complete 回调

**Files:**
- Modify: `packages/host/test/tty-manager.test.ts`
- Modify: `packages/host/src/tty/manager.ts`

- [ ] **Step 1: 写失败测试**

在 `tty-manager.test.ts` 末尾加：

```ts
test('CLAUDE-TTY-006: Stop hook fires the turn-complete handler; SessionEnd does not', async () => {
  const ctx = setup();
  try {
    seedClaudeSession(ctx.db, { runtime_mode: 'tty' });
    const fired: string[] = [];
    ctx.mgr.setTurnCompleteHandler(sid => fired.push(sid));
    await ctx.mgr.handleHook('sess-claude-1', 'Stop', {});
    assert.deepEqual(fired, ['sess-claude-1']);
    // SessionEnd is teardown, not a completed turn — must NOT drain the queue.
    await ctx.mgr.handleHook('sess-claude-1', 'SessionEnd', {});
    assert.deepEqual(fired, ['sess-claude-1']);
  } finally {
    teardown(ctx);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/tty-manager.test.ts`
Expected: FAIL —— `ctx.mgr.setTurnCompleteHandler is not a function`。

- [ ] **Step 3: 实现回调字段 + setter + 在 Stop 触发**

在 `manager.ts` 的 `TtyManager` 类里，`remoteControl` map 声明之后加字段：

```ts
  /** Fired when a TTY turn ends (`Stop` hook). Host wires this to the queue
   *  drain so Beta walks its queue one entry per completed turn. */
  private onTtyTurnComplete: ((sessionId: string) => void) | null = null;
```

在 `claim(...)` 之前（公共方法区）加 setter：

```ts
  /** Wire the host's per-turn queue drain. Set once at startup (app.ts). */
  setTurnCompleteHandler(fn: (sessionId: string) => void): void {
    this.onTtyTurnComplete = fn;
  }
```

在 `handleHook(...)` 内，既有这行：

```ts
    if (event === 'Stop') this.syncModelFromJsonl(sessionId);
```

之后补一行：

```ts
    // Turn ended → let the host drain the next queued Beta message (if any).
    if (event === 'Stop') this.onTtyTurnComplete?.(sessionId);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/tty-manager.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/host/src/tty/manager.ts packages/host/test/tty-manager.test.ts
git commit -m "feat(host): TtyManager fires turn-complete handler on Stop hook"
```

---

## Task 3: 新测试文件 + `SessionManager.drainTtyQueue()`

**Files:**
- Create: `packages/host/test/beta-tty-queue-stop.test.ts`
- Modify: `packages/host/src/session/manager.ts`（加 `drainTtyQueue`）

- [ ] **Step 1: 建带 fake harness 的测试文件，写失败测试**

Create `packages/host/test/beta-tty-queue-stop.test.ts`：

```ts
// Coverage for traceability rows:
//   QUEUE-TTY-001 — Beta queue drains into the PTY on the Stop hook.
//   QUEUE-TTY-002 — send_now pastes immediately in TTY (supplementary message).
//   STOP-TTY-001  — stopTurn interrupts the PTY (Esc), not structured interruptTurn.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, ServerToClientMessage } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { TtyManager } from '../src/tty/manager.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {} remove() {}
  send() {}
  broadcast(msg: ServerToClientMessage) { this.messages.push(msg); }
  get size() { return 0; }
}

function makeFakeTty() {
  const inputCalls: Array<{ sessionId: string; payload: { data?: string; text?: string } }> = [];
  const interruptCalls: string[] = [];
  const fake = {
    async input(sessionId: string, payload: { data?: string; text?: string }) {
      inputCalls.push({ sessionId, payload });
    },
    async interrupt(sessionId: string) { interruptCalls.push(sessionId); },
    async stop() {},
  } as unknown as TtyManager;
  return { fake, inputCalls, interruptCalls };
}

function seedSession(db: Db, over: Partial<Session> = {}): string {
  const sessionId = over.id ?? 'sess-1';
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run('ws-1', 'test', '/tmp/test-ws');
  const now = '2026-06-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO sessions (
      id, name, type, workspace_id, executor, model, approval_mode,
      thinking_effort, turns, active_channel, status, archived,
      worktree_path, branch, base_branch, worktree_outcome,
      native_session_id, runtime_mode, created_at, updated_at
    ) VALUES (?, ?, 'coding', 'ws-1', ?, NULL, 'ask', NULL, 1, 'web',
              ?, 0, NULL, NULL, NULL, NULL, 'nat-1', ?, ?, ?)
  `).run(
    sessionId, 'test',
    over.executor ?? 'claude',
    over.status ?? 'running',
    over.runtime_mode ?? 'tty',
    now, now,
  );
  return sessionId;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-beta-queue-stop-'));
  const db = openDatabase(dir);
  const broadcaster = new CapturingBroadcaster();
  const proxy = { get: (_id: string): unknown => null } as unknown as ProxyManager;
  const queue = new QueueManager();
  const approvals = new ApprovalManager();
  const tty = makeFakeTty();
  const sessions = new SessionManager(
    db, proxy, broadcaster as unknown as WsBroadcaster, approvals, queue, dir,
    null, tty.fake, null,
  );
  return { dir, db, sessions, tty, broadcaster };
}

function teardown(ctx: { dir: string; db: Db }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

test('QUEUE-TTY-001: drainTtyQueue pastes the next queued message in TTY mode', () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'tty', executor: 'claude' });
    ctx.sessions.enqueueMessage(sid, 'first');
    ctx.sessions.enqueueMessage(sid, 'second');
    ctx.sessions.drainTtyQueue(sid);
    assert.deepEqual(ctx.tty.inputCalls, [{ sessionId: sid, payload: { text: 'first' } }]);
    assert.equal(ctx.sessions.getQueueLength(sid), 1);
  } finally {
    teardown(ctx);
  }
});

test('QUEUE-TTY-001: drainTtyQueue no-ops in structured mode', () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'structured', executor: 'claude' });
    ctx.sessions.enqueueMessage(sid, 'x');
    ctx.sessions.drainTtyQueue(sid);
    assert.equal(ctx.tty.inputCalls.length, 0);
    assert.equal(ctx.sessions.getQueueLength(sid), 1);
  } finally {
    teardown(ctx);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/beta-tty-queue-stop.test.ts`
Expected: FAIL —— `ctx.sessions.drainTtyQueue is not a function`。

- [ ] **Step 3: 实现 `drainTtyQueue`**

在 `session/manager.ts` 的队列 facade 区（`clearQueue` 之后、`sendQueuedNow` 之前）加：

```ts
  /**
   * Drain the next queued message into a live Claude TTY. Fired by the
   * TtyManager `Stop` hook — one entry per completed turn, mirroring the
   * structured `maybeAutoSendNext`. Pastes via the TTY input path; no-op when
   * the session left TTY mode (queue is preserved for when it flips back) or
   * the queue is empty.
   */
  drainTtyQueue(sessionId: string): void {
    let session: Session;
    try { session = this.getSession(sessionId); } catch { return; }
    if (session.runtime_mode !== 'tty' || session.executor !== 'claude') return;
    const next = this.queue.popNext(sessionId);
    if (!next) return;
    this.broadcastQueueUpdated(sessionId);
    void this.ttyMgr?.input(sessionId, { text: next.text });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/beta-tty-queue-stop.test.ts`
Expected: PASS（两个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/host/src/session/manager.ts packages/host/test/beta-tty-queue-stop.test.ts
git commit -m "feat(host): drainTtyQueue pastes next queued message into Beta TTY"
```

---

## Task 4: 接线 `Stop` hook → `drainTtyQueue`（app.ts）

**Files:**
- Modify: `packages/host/src/web/app.ts:121`
- Modify: `packages/host/test/beta-tty-queue-stop.test.ts`（端到端：handleHook 触发排空）

- [ ] **Step 1: 写失败测试（用真 TtyManager 串起回调）**

在 `beta-tty-queue-stop.test.ts` 顶部 import 补 `TtyManager` 实体（已 import 了 type；改成值 import）：

```ts
import { TtyManager } from '../src/tty/manager.js';
```

加测试（用真 TtyManager + fake proxy client 的 ttyInput 捕获，验证 `Stop` hook 经回调排空）：

```ts
test('QUEUE-TTY-001(e2e): a Stop hook drains one queued message via the wired handler', async () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'tty', executor: 'claude' });
    // Wire exactly like app.ts does.
    const realTty = new TtyManager(
      ctx.db,
      { get: () => ({ async ttyInput() {} }) } as unknown as ProxyManager,
      ctx.broadcaster as unknown as WsBroadcaster,
      'http://127.0.0.1:8991',
    );
    ctx.sessions.setTtyManager(realTty);
    realTty.setTurnCompleteHandler(s => ctx.sessions.drainTtyQueue(s));

    ctx.sessions.enqueueMessage(sid, 'queued-1');
    await realTty.handleHook(sid, 'Stop', {});
    assert.equal(ctx.sessions.getQueueLength(sid), 0);
  } finally {
    teardown(ctx);
  }
});
```

> 说明：此用例验证"回调链通"，paste 的字节落到 fake proxy 的 `ttyInput`（无副作用）。排空成功的可观察证据是队列长度归零。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/beta-tty-queue-stop.test.ts`
Expected: FAIL —— 队列长度仍为 1（app.ts 真实接线尚未加，但本测试自带接线，故此处实际验证的是 setTurnCompleteHandler 已存在并被调用；若 Task 2 已落则本测试应直接 PASS，此时跳到 Step 3 补 app.ts 接线）。

- [ ] **Step 3: 在 app.ts 加真实接线**

`packages/host/src/web/app.ts` 第 120–121 行现为：

```ts
  const tty = new TtyManager(ctx.db, proxy, broadcaster, hookBaseUrl);
  sessions.setTtyManager(tty);
```

紧随其后加一行：

```ts
  // Beta queue: drain the next queued message into the PTY when a turn ends.
  tty.setTurnCompleteHandler(sid => sessions.drainTtyQueue(sid));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/beta-tty-queue-stop.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/host/src/web/app.ts packages/host/test/beta-tty-queue-stop.test.ts
git commit -m "feat(host): wire Stop hook to Beta queue drain"
```

---

## Task 5: `sendQueuedNow` 在 TTY 下立刻 paste（send_now = 补充消息）

**Files:**
- Modify: `packages/host/src/session/manager.ts:910-928`
- Modify: `packages/host/test/beta-tty-queue-stop.test.ts`

- [ ] **Step 1: 写失败测试**

在 `beta-tty-queue-stop.test.ts` 加：

```ts
test('QUEUE-TTY-002: send_now pastes head into PTY immediately in TTY mode', async () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'tty', executor: 'claude' });
    ctx.sessions.enqueueMessage(sid, 'extra-now');
    await ctx.sessions.sendQueuedNow(sid);
    assert.deepEqual(ctx.tty.inputCalls, [{ sessionId: sid, payload: { text: 'extra-now' } }]);
    assert.equal(ctx.sessions.getQueueLength(sid), 0);
  } finally {
    teardown(ctx);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/beta-tty-queue-stop.test.ts`
Expected: FAIL —— `sendQueuedNow` 现在对 tty 会话 `throw new Error('session is in CLI mode; switch to Chat before draining the queue')`。

- [ ] **Step 3: 加 TTY 分支**

把 `session/manager.ts` 的 `sendQueuedNow` 改为：

```ts
  async sendQueuedNow(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (session.runtime_mode === 'tty') {
      // (d) TTY send_now: paste the head into the PTY immediately. If a turn
      // is still running, Claude's TUI takes it as a supplementary message —
      // we deliberately do NOT wait for the Stop hook (unlike auto-drain).
      if (session.executor !== 'claude') return;
      const next = this.queue.popNext(sessionId);
      if (!next) return;
      this.broadcastQueueUpdated(sessionId);
      await this.ttyMgr?.input(sessionId, { text: next.text });
      return;
    }
    // Pop only the head entry. Awaiting sendMessage just unblocks the proxy's
    // startTurn; `maybeAutoSendNext` walks the rest on turn.completed/failed.
    const next = this.queue.popNext(sessionId);
    if (!next) return;
    this.broadcastQueueUpdated(sessionId);
    await this.sendMessage(sessionId, next.text);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/beta-tty-queue-stop.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/host/src/session/manager.ts packages/host/test/beta-tty-queue-stop.test.ts
git commit -m "feat(host): send_now pastes into PTY immediately in TTY mode"
```

---

## Task 6: `stopTurn` 在 Claude TTY 下走 `interrupt`（不走结构化 interruptTurn）

**Files:**
- Modify: `packages/host/src/session/manager.ts:433-450`
- Modify: `packages/host/test/beta-tty-queue-stop.test.ts`

- [ ] **Step 1: 写失败测试**

在 `beta-tty-queue-stop.test.ts` 加：

```ts
test('STOP-TTY-001: stopTurn in claude TTY mode injects interrupt, not structured interruptTurn', async () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'tty', executor: 'claude' });
    await ctx.sessions.stopTurn(sid);
    assert.deepEqual(ctx.tty.interruptCalls, [sid]);
  } finally {
    teardown(ctx);
  }
});
```

> 结构化路径在本 harness 下会因 `proxySessionIds` 无该会话而抛错；TTY 分支在结构化逻辑之前 return，正好验证"没走结构化"。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/beta-tty-queue-stop.test.ts`
Expected: FAIL —— 现在 `stopTurn` 直接取 `proxySessionId`，对未初始化的会话 `throw new Error('session not initialized: ...')`，`interruptCalls` 为空。

- [ ] **Step 3: 在 `stopTurn` 顶部加 Claude TTY 分支**

把 `session/manager.ts` 的 `stopTurn` 改为（在取 proxySessionId 之前判断）：

```ts
  async stopTurn(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    // Claude TTY: the turn runs inside the PTY, so the structured
    // interruptTurn won't reach it. Inject Esc instead. (codex TTY keeps the
    // existing path for now — out of scope for this line.)
    if (session.runtime_mode === 'tty' && session.executor === 'claude') {
      this.jobs.delete(sessionId);
      await this.ttyMgr?.interrupt(sessionId);
      return;
    }
    const proxySessionId = this.proxySessionIds.get(sessionId);
    if (!proxySessionId) throw new Error(`session not initialized: ${sessionId}`);
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no proxy for session: ${sessionId}`);
    // Clear job state so no continuation fires after the interrupt completes.
    this.jobs.delete(sessionId);
    await client.interruptTurn(proxySessionId);
    if (this.activeTurns.has(sessionId)) {
      this.completeTurn(sessionId, 'stopped');
      this.watcher?.resume(sessionId);
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/beta-tty-queue-stop.test.ts`
Expected: PASS（全 4+ 用例）。

- [ ] **Step 5: 回归既有队列/停止套件**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/queue-and-busy.test.ts test/session-manager.test.ts`
Expected: PASS（结构化 stopTurn 行为未变）。

- [ ] **Step 6: 提交**

```bash
git add packages/host/src/session/manager.ts packages/host/test/beta-tty-queue-stop.test.ts
git commit -m "fix(host): stopTurn interrupts the PTY in claude TTY mode"
```

---

## Task 7: web —— Beta 入队（`betaComposerSubmitBehavior` 纯函数）

**Files:**
- Modify: `packages/web/src/session-routing.ts`
- Modify: `packages/web/test/billing-claude-tty-routing.test.ts`
- Modify: `packages/web/src/views/CodingView.tsx:1630`

- [ ] **Step 1: 写失败测试**

在 `packages/web/test/billing-claude-tty-routing.test.ts` 顶部 import 补 `betaComposerSubmitBehavior`，并加：

```ts
import { betaComposerSubmitBehavior } from '../src/session-routing.js';

describe('betaComposerSubmitBehavior', () => {
  it('Beta with no pending question enqueues', () => {
    expect(betaComposerSubmitBehavior(true, false)).toBe('queue');
  });
  it('Beta with a pending question blocks (answer first)', () => {
    expect(betaComposerSubmitBehavior(true, true)).toBe('block');
  });
  it('non-Beta always queues', () => {
    expect(betaComposerSubmitBehavior(false, false)).toBe('queue');
    expect(betaComposerSubmitBehavior(false, true)).toBe('queue');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @gian/web exec vitest run test/billing-claude-tty-routing.test.ts`
Expected: FAIL —— `betaComposerSubmitBehavior` 未导出。

- [ ] **Step 3: 实现纯函数**

在 `packages/web/src/session-routing.ts` 末尾加：

```ts
/**
 * Submit behavior for the Beta composer's disabled (busy) state. Beta now
 * enqueues Enter-while-busy into the same host queue as Chat (the queue drains
 * into the TTY on the Stop hook). The one exception is a pending
 * AskUserQuestion: block so Enter doesn't stash a message above an unanswered
 * question — the user must answer it first.
 */
export function betaComposerSubmitBehavior(
  isBeta: boolean,
  hasPendingQuestion: boolean,
): 'queue' | 'block' {
  if (isBeta && hasPendingQuestion) return 'block';
  return 'queue';
}
```

- [ ] **Step 4: 在 CodingView 用上它**

`packages/web/src/views/CodingView.tsx`：import 处加 `betaComposerSubmitBehavior`（与现有 `planApprovalResponseDispatch` 同一 import 行）；把第 1630 行：

```tsx
            disabledSubmitBehavior={isBeta ? 'block' : 'queue'}
```

改为：

```tsx
            disabledSubmitBehavior={betaComposerSubmitBehavior(isBeta, !!pendingQuestion)}
```

- [ ] **Step 5: 跑测试 + typecheck 确认通过**

Run: `pnpm --filter @gian/web exec vitest run test/billing-claude-tty-routing.test.ts`
Expected: PASS。
Run: `pnpm --filter @gian/web typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/session-routing.ts packages/web/src/views/CodingView.tsx packages/web/test/billing-claude-tty-routing.test.ts
git commit -m "feat(web): Beta composer enqueues Enter-while-busy (except pending question)"
```

---

## Task 8: web —— 停止按钮读真实 running 态（`isTurnRunning` 纯函数）

**Files:**
- Modify: `packages/web/src/session-routing.ts`
- Modify: `packages/web/test/billing-claude-tty-routing.test.ts`
- Modify: `packages/web/src/components/Composer.tsx`
- Modify: `packages/web/src/views/CodingView.tsx:1620-1638`

- [ ] **Step 1: 写失败测试**

在 `billing-claude-tty-routing.test.ts` 加：

```ts
import { isTurnRunning } from '../src/session-routing.js';

describe('isTurnRunning', () => {
  it('true while a turn runs', () => {
    expect(isTurnRunning('running', false)).toBe(true);
  });
  it('true when the pending flag is set (structured in-flight)', () => {
    expect(isTurnRunning('done', true)).toBe(true);
  });
  it('false when idle / done / merely locked-out', () => {
    expect(isTurnRunning('done', false)).toBe(false);
    expect(isTurnRunning('new', false)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @gian/web exec vitest run test/billing-claude-tty-routing.test.ts`
Expected: FAIL —— `isTurnRunning` 未导出。

- [ ] **Step 3: 实现纯函数**

在 `session-routing.ts` 末尾加（`SessionStatus` 已在该文件类型 import 范围内；若未 import 则在顶部从 `@gian/shared` 补 type）：

```ts
/**
 * Whether the Stop button should show (a turn is actually in flight) — NOT
 * merely because the composer is locked out of another window's TTY or blocked
 * on a pending question. Those were the desync sources for the Beta stop
 * button. Hook-driven `status==='running'` gives this for Beta/TTY; structured
 * turns set status='running' too, and `pending` covers the structured
 * in-flight window.
 */
export function isTurnRunning(status: SessionStatus, pending: boolean): boolean {
  return pending || status === 'running';
}
```

- [ ] **Step 4: Composer 加 `running` prop，Stop/Send 切换改读它**

`packages/web/src/components/Composer.tsx`：
- 解构参数（第 191-200 区）加 `running,`：

```tsx
  onSend, onSendSkill, onStop, onQueueAdd, onSetMode, onSetModel, onSetEffort,
  disabled, running, executor,
```

- props 类型（`disabled: boolean;` 附近）加：

```tsx
  /** A turn is actually in flight — drives the Send→Stop toggle. Distinct
   *  from `disabled`, which also covers lock-out / pending-question. */
  running: boolean;
```

- 第 989-1002 的 Send/Stop 条件从 `disabled ?` 改为 `running ?`：

```tsx
          {/* Send / Stop */}
          {running ? (
            <button
              type="button"
              className="composer-act primary danger"
              onClick={onStop}
              title={t('composer.stop.title')}
              aria-label={t('composer.stop.button')}
            >
              <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <rect x="3" y="3" width="8" height="8" rx="1" />
              </svg>
            </button>
          ) : (
```

- [ ] **Step 5: CodingView 传 `running`**

`packages/web/src/views/CodingView.tsx` 的 `<Composer ...>`（第 1620 区）加一行 prop：

```tsx
            disabled={pending || terminal || ttyLockedOut || (isBeta && !!pendingQuestion)}
            running={isTurnRunning(session.status, pending)}
```

并确保 `isTurnRunning` 已 import。

- [ ] **Step 6: 跑测试 + typecheck**

Run: `pnpm --filter @gian/web exec vitest run test/billing-claude-tty-routing.test.ts`
Expected: PASS。
Run: `pnpm --filter @gian/web typecheck`
Expected: 无错误（若有其它 `<Composer>` 调用点缺 `running`，typecheck 会报——逐个补 `running={isTurnRunning(session.status, false)}`）。

- [ ] **Step 7: 提交**

```bash
git add packages/web/src/session-routing.ts packages/web/src/components/Composer.tsx packages/web/src/views/CodingView.tsx packages/web/test/billing-claude-tty-routing.test.ts
git commit -m "fix(web): Stop button reflects real running state, not lock/pending"
```

---

## Task 9: 全量验证 + 构建

**Files:** 无（仅跑）

- [ ] **Step 1: host 全量测试**

Run: `pnpm --filter @gian/host exec node --test --import tsx --test-reporter spec test/`
Expected: 全 PASS。

- [ ] **Step 2: web 全量测试 + typecheck**

Run: `pnpm --filter @gian/web exec vitest run`
Run: `pnpm --filter @gian/web typecheck`
Expected: 全 PASS、无类型错误。

- [ ] **Step 3: 构建**

Run: `pnpm --filter @gian/shared build && pnpm --filter @gian/host build && pnpm --filter @gian/web build`
Expected: 全部成功。

- [ ] **Step 4: traceability + 行尾检查**

Run: `pnpm run quality:traceability`（按需在 `docs/quality/traceability.md` 补 `QUEUE-TTY-001/002`、`STOP-TTY-001` 行）
Run: `git diff --check`
Expected: 通过。

- [ ] **Step 5: 真机自检（手动，8991）**

重启 GianDev host（`GIAN_PORT=8991`，`CLAUDE_BIN=/Users/rich/.local/bin/claude`），在 Beta 会话里验：
1. 回合运行中输入并回车 → 出 queue chip（不再被 block）。
2. 回合结束 → 队首自动 paste 进 TTY、chip 减一。
3. queue 抽屉「立即发送」→ 立刻 paste（补充消息）。
4. 回合运行中点停止 → claude 真的中断、status→done。
5. 停止按钮只在真运行时出现（lockout / 待答问题时不冒出）。

- [ ] **Step 6: 提交（如有 traceability 改动）**

```bash
git add docs/quality/traceability.md
git commit -m "docs: traceability rows for Beta TTY queue + stop (line B)"
```

---

## Self-Review（plan ↔ spec）

- **spec §7.2 Q1 排空** → Task 2/3/4（Stop hook 回调 + drainTtyQueue + 接线）。✓
- **spec §7.2 Beta composer 入队** → Task 7。✓
- **spec (d) send_now 立刻 paste** → Task 5。✓
- **spec §7.3 停止·通道** → Task 1（interrupt 注 Esc）+ Task 6（stopTurn 分支）。✓
- **spec §7.3 停止·状态同步** → Task 8（isTurnRunning + Composer running prop）。✓
- **场景 F1/F2/F4 + B8/B9** → 分别由 Task 7 / Task 3-4 / Task 5 / Task 8 / Task 1+6 覆盖。✓
- **类型/命名一致性**：`drainTtyQueue` / `setTurnCompleteHandler` / `interrupt` / `betaComposerSubmitBehavior` / `isTurnRunning` 在定义与调用处一致。✓
- **scope**：本 plan 不含 ScreenModel / TuiDriver / 任意 intent（line A，spike 后另出 plan）。codex TTY 的 stop/queue 显式留作后续。✓
- **未决依赖**：中断键是否单 Esc 留待真机自检（Task 9 Step 5）/ line A spike；若 Claude 需双 Esc/Ctrl-C，仅改 Task 1 Step 3 那一行常量。
