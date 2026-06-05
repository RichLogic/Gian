// Coverage for traceability row:
//   CLAUDE-TTY-001 — Host-side coordinator for Claude interactive TTY mode.
//                    Validates billing-safe first-spawn session id discipline
//                    and hook-driven session status updates.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, ServerToClientMessage } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import { CcProxyClient } from '../src/proxy/cc-proxy-client.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { TtyManager, ccPermissionModeToApprovalMode, readLatestModelFromCcJsonl } from '../src/tty/manager.js';
import { writeFileSync } from 'node:fs';

interface StubCallLog {
  ttyStart: Array<Record<string, unknown>>;
  ttyKill: Array<{ sessionId: string }>;
}

function makeStubClient() {
  const calls: StubCallLog = { ttyStart: [], ttyKill: [] };
  const client = Object.assign(Object.create(CcProxyClient.prototype), {
    async ttyStart(params: Record<string, unknown>) {
      calls.ttyStart.push(params);
      return { ok: true as const, replay: ['cmVwbGF5'], alive: true };
    },
    async ttyKill(params: { sessionId: string }) {
      calls.ttyKill.push(params);
      return { ok: true as const };
    },
    async ttyInput() {},
    async ttyResize() {},
    async ttyReplay() {
      return { chunks: ['Y2h1bms='], alive: true };
    },
  }) as CcProxyClient;
  return { client, calls };
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  sent: Array<{ client: unknown; message: ServerToClientMessage }> = [];
  add() {} remove() {}
  send(client: unknown, message: ServerToClientMessage) { this.sent.push({ client, message }); }
  broadcast(msg: ServerToClientMessage) { this.messages.push(msg); }
  get size() { return 0; }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-claude-tty-test-'));
  const db = openDatabase(dir);
  const broadcaster = new CapturingBroadcaster();
  const stub = makeStubClient();
  const proxyMgr = {
    get: (_id: string): unknown => stub.client,
  } as unknown as ProxyManager;
  const mgr = new TtyManager(db, proxyMgr, broadcaster as unknown as WsBroadcaster, 'http://127.0.0.1:8991');
  return { dir, db, broadcaster, mgr, stub };
}

function teardown(ctx: { dir: string; db: Db }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

function seedClaudeSession(db: Db, over: Partial<Session> = {}): Session {
  const sessionId = over.id ?? 'sess-claude-1';
  const wsId = 'ws-1';
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'test', '/tmp/test-ws');
  const now = '2026-06-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO sessions (
      id, name, type, workspace_id, executor, model, approval_mode,
      thinking_effort, turns, active_channel, status, archived,
      worktree_path, branch, base_branch, worktree_outcome,
      native_session_id, runtime_mode, created_at, updated_at
    ) VALUES (?, ?, 'coding', ?, 'claude', ?, 'ask', ?, 1, 'web',
              'new', 0, NULL, NULL, NULL, NULL, ?, 'structured', ?, ?)
  `).run(
    sessionId, over.name ?? 'claude tty test', wsId,
    Object.hasOwn(over, 'model') ? over.model : null,
    Object.hasOwn(over, 'thinking_effort') ? over.thinking_effort : null,
    Object.hasOwn(over, 'native_session_id') ? over.native_session_id : 'claude-native-uuid-xyz',
    now, now,
  );
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session;
}

test('CLAUDE-TTY-001: first TTY spawn for a zero-turn session uses --session-id semantics', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    const result = await ctx.mgr.start(session, '/tmp/work', { cols: 100, rows: 32 });
    assert.deepEqual(result, { replay: ['cmVwbGF5'], alive: true });
    assert.equal(ctx.stub.calls.ttyStart.length, 1);
    assert.equal(ctx.stub.calls.ttyStart[0]!.isResume, false);
    assert.equal(ctx.stub.calls.ttyStart[0]!.claudeSessionId, 'claude-native-uuid-xyz');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-001: TTY spawn resumes once the session has persisted turns', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    ctx.db.prepare(`
      INSERT INTO turns (id, session_id, turn_number, status, created_at)
      VALUES ('turn-1', ?, 1, 'completed', ?)
    `).run(session.id, '2026-06-01T00:01:00.000Z');

    await ctx.mgr.start(session, '/tmp/work', { cols: 100, rows: 32 });
    assert.equal(ctx.stub.calls.ttyStart.length, 1);
    assert.equal(ctx.stub.calls.ttyStart[0]!.isResume, true);
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-001: hook events update session status and broadcast session:updated', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    await ctx.mgr.handleHook(session.id, 'UserPromptSubmit', { prompt: 'hello' });
    let row = ctx.db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as { status: string };
    assert.equal(row.status, 'running');

    await ctx.mgr.handleHook(session.id, 'Stop', { last_assistant_message: 'done' });
    row = ctx.db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as { status: string };
    assert.equal(row.status, 'done');

    const updates = ctx.broadcaster.messages.filter(m => m.type === 'session:updated') as Array<{
      type: 'session:updated';
      session: { status?: string };
    }>;
    assert.deepEqual(updates.map(m => m.session.status).filter(Boolean), ['running', 'done']);
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-003: hook permission_mode + effort sync onto the session row', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db); // seeds approval_mode='ask', effort=null
    // The CLI reports its live state in every hook. A PreToolUse carries both.
    await ctx.mgr.handleHook(session.id, 'PreToolUse', {
      permission_mode: 'plan',
      effort: 'high',
      tool_name: 'Read',
      tool_input: {},
    });
    const row = ctx.db
      .prepare('SELECT approval_mode, thinking_effort FROM sessions WHERE id = ?')
      .get(session.id) as { approval_mode: string; thinking_effort: string | null };
    assert.equal(row.approval_mode, 'plan'); // default→ask, plan→plan, auto→auto
    assert.equal(row.thinking_effort, 'high');

    const updated = ctx.broadcaster.messages.find(
      m => m.type === 'session:updated'
        && ((m as { session: Record<string, unknown> }).session.approval_mode === 'plan'),
    );
    assert.ok(updated, 'expected a session:updated carrying the synced mode');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-003: claude modes with no Gian equivalent leave approval_mode untouched', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db); // approval_mode='ask'
    await ctx.mgr.handleHook(session.id, 'UserPromptSubmit', {
      permission_mode: 'acceptEdits', // no ApprovalMode equivalent
      prompt: 'hi',
    });
    const row = ctx.db.prepare('SELECT approval_mode FROM sessions WHERE id = ?').get(session.id) as { approval_mode: string };
    assert.equal(row.approval_mode, 'ask'); // unchanged, not mismapped
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-003: permission_mode mapping is the reverse of proxyTurnParamsFor', () => {
  assert.equal(ccPermissionModeToApprovalMode('plan'), 'plan');
  assert.equal(ccPermissionModeToApprovalMode('default'), 'ask');
  assert.equal(ccPermissionModeToApprovalMode('auto'), 'auto');
  assert.equal(ccPermissionModeToApprovalMode('acceptEdits'), null);
  assert.equal(ccPermissionModeToApprovalMode('bypassPermissions'), null);
  assert.equal(ccPermissionModeToApprovalMode(''), null);
});

test('CLAUDE-TTY-003: readLatestModelFromCcJsonl returns the last model verbatim (keeps [1m])', () => {
  const ctx = setup();
  try {
    const file = join(ctx.dir, 'sample.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-7' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'hi' }] } }),
      // a later /model switch to the 1M variant — must win, and survive verbatim
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-7[1m]', content: [{ type: 'text', text: 'still here' }] } }),
      '',
    ].join('\n'), 'utf8');
    assert.equal(readLatestModelFromCcJsonl(file), 'claude-opus-4-7[1m]');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-003: readLatestModelFromCcJsonl returns null on a missing/garbage file', () => {
  assert.equal(readLatestModelFromCcJsonl('/no/such/file.jsonl'), null);
});

test('CLAUDE-TTY-001: StopFailure marks the TTY session error', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    await ctx.mgr.handleHook(session.id, 'StopFailure', { error: 'boom' });
    const row = ctx.db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as { status: string };
    assert.equal(row.status, 'error');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-001: Claude TTY lock rejects a second browser window', () => {
  const ctx = setup();
  try {
    const ws1 = { id: 'window-1' };
    const ws2 = { id: 'window-2' };
    assert.equal(ctx.mgr.claim('sess-claude-1', 'client-1', ws1 as never, 'beta'), true);
    assert.equal(ctx.mgr.owns('sess-claude-1', 'client-1'), true);
    assert.equal(ctx.mgr.claim('sess-claude-1', 'client-2', ws2 as never, 'beta'), false);
    assert.equal(ctx.mgr.isLockedByOther('sess-claude-1', 'client-2'), true);

    const denied = ctx.broadcaster.sent.at(-1)?.message as
      | { type: 'tty:lock'; owner: boolean; reason?: string }
      | undefined;
    assert.equal(denied?.type, 'tty:lock');
    assert.equal(denied?.owner, false);
    assert.match(denied?.reason ?? '', /another window/);

    ctx.mgr.releaseClient('client-1');
    assert.equal(ctx.mgr.claim('sess-claude-1', 'client-2', ws2 as never, 'cli'), true);
    assert.equal(ctx.mgr.owns('sess-claude-1', 'client-2'), true);
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-001: Claude TTY lock can be explicitly taken over by another browser window', () => {
  const ctx = setup();
  try {
    const ws1 = { id: 'window-1' };
    const ws2 = { id: 'window-2' };
    assert.equal(ctx.mgr.claim('sess-claude-1', 'client-1', ws1 as never, 'beta'), true);
    assert.equal(ctx.mgr.claim('sess-claude-1', 'client-2', ws2 as never, 'cli', { takeover: true }), true);

    assert.equal(ctx.mgr.owns('sess-claude-1', 'client-1'), false);
    assert.equal(ctx.mgr.owns('sess-claude-1', 'client-2'), true);

    const oldOwnerNotice = ctx.broadcaster.sent.find(s =>
      s.client === ws1 && s.message.type === 'tty:lock' && s.message.owner === false,
    )?.message as { type: 'tty:lock'; owner: boolean; reason?: string } | undefined;
    assert.equal(oldOwnerNotice?.owner, false);
    assert.match(oldOwnerNotice?.reason ?? '', /taken over/);

    const newOwnerNotice = ctx.broadcaster.sent.at(-1)?.message as
      | { type: 'tty:lock'; owner: boolean; surface?: string }
      | undefined;
    assert.equal(newOwnerNotice?.type, 'tty:lock');
    assert.equal(newOwnerNotice?.owner, true);
    assert.equal(newOwnerNotice?.surface, 'cli');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-001: PTY output is sent only to the lock owner', () => {
  const ctx = setup();
  try {
    const ws1 = { id: 'window-1' };
    ctx.mgr.claim('sess-claude-1', 'client-1', ws1 as never, 'cli');
    ctx.mgr.handleProxyNotification({
      method: 'tty.output',
      params: { sessionId: 'sess-claude-1', data: 'aGVsbG8=' },
    });

    assert.equal(ctx.broadcaster.messages.some(m => m.type === 'pty:output'), false);
    const out = ctx.broadcaster.sent.find(s => s.message.type === 'pty:output')?.message as
      | { type: 'pty:output'; session_id: string; data: string }
      | undefined;
    assert.equal(out?.session_id, 'sess-claude-1');
    assert.equal(out?.data, 'aGVsbG8=');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-004: Remote Control status line broadcasts tty:remote-control (with dedup)', () => {
  const ctx = setup();
  try {
    const sid = 'sess-claude-1';
    const emit = (text: string) => ctx.mgr.handleProxyNotification({
      method: 'tty.output',
      params: { sessionId: sid, data: Buffer.from(text, 'utf8').toString('base64') },
    });
    const states = () => ctx.broadcaster.messages
      .filter(m => m.type === 'tty:remote-control')
      .map(m => (m as { state: string }).state);

    emit('\x1b[2m› Remote Control connecting…\x1b[0m');
    emit('Remote Control connected');
    emit('regular PTY output, no status word');  // no broadcast
    emit('Remote Control connected');            // same state → deduped
    emit('Remote Control disconnected.');

    assert.deepEqual(states(), ['connecting', 'connected', 'disconnected']);
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-004: tty.exited resets Remote Control to disconnected', () => {
  const ctx = setup();
  try {
    const sid = 'sess-claude-1';
    ctx.mgr.handleProxyNotification({
      method: 'tty.output',
      params: { sessionId: sid, data: Buffer.from('Remote Control connected', 'utf8').toString('base64') },
    });
    ctx.mgr.handleProxyNotification({ method: 'tty.exited', params: { sessionId: sid, code: 0 } });
    const last = ctx.broadcaster.messages
      .filter(m => m.type === 'tty:remote-control')
      .at(-1) as { type: 'tty:remote-control'; state: string } | undefined;
    assert.equal(last?.state, 'disconnected');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-001: hooks do not duplicate native JSONL transcript events', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    await ctx.mgr.handleHook(session.id, 'UserPromptSubmit', { prompt: 'hello beta' });
    await ctx.mgr.handleHook(session.id, 'Stop', { last_assistant_message: 'done beta' });

    const rows = ctx.db.prepare(`
      SELECT type, data FROM events
      WHERE session_id = ?
      ORDER BY rowid
    `).all(session.id) as Array<{ type: string; data: string }>;
    assert.deepEqual(rows, []);

    const eventTypes = ctx.broadcaster.messages
      .filter(m => m.type === 'event')
      .map(m => (m as { event: string }).event);
    assert.ok(eventTypes.includes('tty.hook.userpromptsubmit'));
    assert.ok(eventTypes.includes('tty.hook.stop'));
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-002: PreToolUse(AskUserQuestion) surfaces a structured question card', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    // The interactive AskUserQuestion selector blocks inside the PTY and is
    // NOT written to JSONL until answered, so the JSONL watcher can never see
    // it. PreToolUse is the only channel that carries the questions struct
    // while the tool is still pending.
    await ctx.mgr.handleHook(session.id, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q1',
      tool_input: {
        questions: [
          {
            header: '周末',
            question: '周末更想怎么过?',
            multiSelect: false,
            options: [
              { label: '宅家躺平', description: '睡到自然醒' },
              { label: '出门浪', description: '爬山逛街' },
            ],
          },
        ],
      },
    });

    const approval = ctx.broadcaster.messages.find(
      m => m.type === 'event' && (m as { event?: string }).event === 'approval_requested',
    ) as { event: string; data: Record<string, unknown> } | undefined;
    assert.ok(approval, 'expected an approval_requested event to be broadcast');
    assert.equal(approval!.data.category, 'question');
    assert.equal(approval!.data.approvalId, 'toolu_q1');
    const questions = approval!.data.questions as Array<{ question: string; options: unknown[] }>;
    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.question, '周末更想怎么过?');
    assert.equal(questions[0]!.options.length, 2);
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-002: tty.exited declines any still-pending AskUserQuestion cards', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    // Two AskUserQuestion calls land while the PTY is alive — both surface as
    // pending question cards in Beta.
    await ctx.mgr.handleHook(session.id, 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q_a',
      tool_input: { questions: [{ question: 'a', options: [{ label: 'x' }] }] },
    });
    await ctx.mgr.handleHook(session.id, 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q_b',
      tool_input: { questions: [{ question: 'b', options: [{ label: 'y' }] }] },
    });

    ctx.broadcaster.messages.length = 0; // clear earlier broadcasts

    // PTY dies (claude crashes / user hard-kills / kernel OOM). With no
    // backing selector left the cards can never be answered, so the manager
    // must decline them rather than stranding them on screen.
    ctx.mgr.handleProxyNotification({
      method: 'tty.exited',
      params: { sessionId: session.id, code: 1, signal: null },
    });

    const resolved = ctx.broadcaster.messages
      .filter(m => m.type === 'event' && (m as { event?: string }).event === 'approval_resolved')
      .map(m => (m as { data: { approvalId: string; decision: string; auto: boolean } }).data);
    assert.equal(resolved.length, 2);
    const ids = resolved.map(r => r.approvalId).sort();
    assert.deepEqual(ids, ['toolu_q_a', 'toolu_q_b']);
    assert.ok(resolved.every(r => r.decision === 'decline'));
    assert.ok(resolved.every(r => r.auto === true));
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-002: SessionEnd declines pending questions and clears the registry', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    await ctx.mgr.handleHook(session.id, 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q_se',
      tool_input: { questions: [{ question: 'q', options: [{ label: 'x' }] }] },
    });
    ctx.broadcaster.messages.length = 0;
    await ctx.mgr.handleHook(session.id, 'SessionEnd', {});

    const resolved = ctx.broadcaster.messages.find(
      m => m.type === 'event' && (m as { event?: string }).event === 'approval_resolved',
    ) as { data: { approvalId: string; decision: string } } | undefined;
    assert.ok(resolved, 'SessionEnd should fire approval_resolved for the stale card');
    assert.equal(resolved!.data.approvalId, 'toolu_q_se');
    assert.equal(resolved!.data.decision, 'decline');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-002: stop() (runtime flip back to structured) declines pending questions', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    await ctx.mgr.handleHook(session.id, 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q_stop',
      tool_input: { questions: [{ question: 'q', options: [{ label: 'x' }] }] },
    });
    ctx.broadcaster.messages.length = 0;
    await ctx.mgr.stop(session);

    const resolved = ctx.broadcaster.messages.find(
      m => m.type === 'event' && (m as { event?: string }).event === 'approval_resolved',
    ) as { data: { approvalId: string; decision: string } } | undefined;
    assert.ok(resolved, 'stop() should fire approval_resolved for the stale card');
    assert.equal(resolved!.data.approvalId, 'toolu_q_stop');
    assert.equal(resolved!.data.decision, 'decline');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-002: clearing pending questions is idempotent on a clean session', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    await ctx.mgr.stop(session);
    const resolved = ctx.broadcaster.messages.filter(
      m => m.type === 'event' && (m as { event?: string }).event === 'approval_resolved',
    );
    assert.equal(resolved.length, 0);
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-002: PostToolUse(answered) drops the pending question so SessionEnd does NOT auto-decline it', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    await ctx.mgr.handleHook(session.id, 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q_ans',
      tool_input: { questions: [{ question: 'q', options: [{ label: 'x' }] }] },
    });
    // The user answered → claude runs the tool → PostToolUse fires with the
    // same tool_use_id. The card is no longer pending.
    await ctx.mgr.handleHook(session.id, 'PostToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q_ans',
      tool_response: {},
    });
    ctx.broadcaster.messages.length = 0;
    await ctx.mgr.handleHook(session.id, 'SessionEnd', {});

    const resolved = ctx.broadcaster.messages.filter(
      m => m.type === 'event' && (m as { event?: string }).event === 'approval_resolved',
    );
    assert.equal(resolved.length, 0, 'an answered question must not be auto-declined on SessionEnd');
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-002: TTY settings wire a PostToolUse hook for AskUserQuestion', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    await ctx.mgr.start(session, '/tmp/work', { cols: 100, rows: 32 });
    const settings = ctx.stub.calls.ttyStart[0]!.hookSettings as {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ url: string }> }>>;
    };
    const postToolUse = settings.hooks?.PostToolUse;
    assert.ok(postToolUse && postToolUse.length > 0, 'expected a PostToolUse hook to be wired');
    assert.ok(
      postToolUse!.some(h => (h.matcher ?? '').includes('AskUserQuestion')),
      'expected the PostToolUse hook to match AskUserQuestion',
    );
    assert.ok(
      postToolUse!.every(h => h.hooks.every(x => x.url.includes('/PostToolUse'))),
      'expected the PostToolUse hook URL to target the PostToolUse receiver',
    );
  } finally { teardown(ctx); }
});

test('CLAUDE-TTY-002: TTY settings wire a PreToolUse hook for AskUserQuestion', async () => {
  const ctx = setup();
  try {
    const session = seedClaudeSession(ctx.db);
    await ctx.mgr.start(session, '/tmp/work', { cols: 100, rows: 32 });
    const settings = ctx.stub.calls.ttyStart[0]!.hookSettings as {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ url: string }> }>>;
    };
    const preToolUse = settings.hooks?.PreToolUse;
    assert.ok(preToolUse && preToolUse.length > 0, 'expected a PreToolUse hook to be wired');
    assert.ok(
      preToolUse!.some(h => (h.matcher ?? '').includes('AskUserQuestion')),
      'expected the PreToolUse hook to match AskUserQuestion',
    );
    assert.ok(
      preToolUse!.every(h => h.hooks.every(x => x.url.includes('/PreToolUse'))),
      'expected the PreToolUse hook URL to target the PreToolUse receiver',
    );
  } finally { teardown(ctx); }
});
