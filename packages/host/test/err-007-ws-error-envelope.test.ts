// Coverage for traceability row (host dimension):
//   ERR-007 — Non-busy startTurn failure must roll back AND mark the
//             turn/session as error AND surface the failure to the WS
//             client via an `error` envelope so the UI can render
//             "send failed" instead of a perpetual spinner.
//
// The host-state half is already covered in queue-and-busy.test.ts. This
// file pins the WS error envelope shape that ws-handler emits on
// dispatch failure: type='error', code='MESSAGE_SEND_FAILED',
// session_id echoed, message present. Web UI dimension (App.tsx
// rendering the failed-echo state) is still a separate row.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import { makeWsHandlers } from '../src/web/ws-handler.js';

// ---------------------------------------------------------------------------
// Fake proxy with a tunable failNextStartTurn knob
// ---------------------------------------------------------------------------

class FakeProxyClient implements ProxyClient {
  readonly executor: 'claude' | 'codex' = 'claude';
  notificationHandlers: NotificationHandler[] = [];
  failNextStartTurn: Error | null = null;

  async initialize() { return { mode: 'spawn' as const, protocolVersion: '0.1.0', methods: [] }; }
  async capabilities() { return { protocolVersion: '0.1.0', models: [], slashCommands: [] }; }
  async listSlashCommands() { return { commands: [] }; }
  async createSession(params: { cwd: string; claudeSessionId?: string }) {
    const nativeSessionId = params.claudeSessionId ?? `cc_${randomUUID()}`;
    return {
      session: {
        id: nativeSessionId, cwd: params.cwd, claudeSessionId: nativeSessionId,
        model: null, status: 'idle' as const,
        createdAt: '2026-05-17T00:00:00.000Z', updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }
  async interruptTurn() {}
  async respondApproval() {}
  async startTurn() {
    if (this.failNextStartTurn) {
      const err = this.failNextStartTurn;
      this.failNextStartTurn = null;
      throw err;
    }
    return {
      session: {
        id: 'proxy_x', cwd: '/tmp', model: null, status: 'running' as const,
        createdAt: '2026-05-17T00:00:00.000Z', updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      turn: { id: 'proxy_turn' },
    };
  }
  async closeSession() {}
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => { this.notificationHandlers = this.notificationHandlers.filter(h => h !== handler); };
  }
  onExit() { return () => {}; }
  fire(notification: ProxyNotification): void {
    for (const h of this.notificationHandlers) h(notification);
  }
}

class FakeProxyManager {
  client = new FakeProxyClient();
  async getOrCreate(): Promise<ProxyClient> { return this.client; }
  get(): ProxyClient { return this.client; }
  async closeAll(): Promise<void> {}
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  private sentToWs = new Map<unknown, ServerToClientMessage[]>();
  add() {}
  remove() {}
  send(ws: unknown, msg: ServerToClientMessage) {
    const arr = this.sentToWs.get(ws) ?? [];
    arr.push(msg);
    this.sentToWs.set(ws, arr);
    this.messages.push(msg);
  }
  broadcast(msg: ServerToClientMessage): void { this.messages.push(msg); }
  get size() { return 0; }
  sentTo(ws: unknown): ServerToClientMessage[] { return this.sentToWs.get(ws) ?? []; }
}

// Mock WSContext that records close codes. Hono's WSContext exposes a
// close() method we capture; the ws-handler only uses `ws.close(code, reason)`.
class FakeWsContext {
  closed: { code: number; reason: string } | null = null;
  close(code: number, reason: string): void { this.closed = { code, reason }; }
}

interface SetupResult {
  dir: string;
  db: ReturnType<typeof openDatabase>;
  wsId: string;
  sessions: SessionManager;
  proxyMgr: FakeProxyManager;
  broadcaster: CapturingBroadcaster;
  handlers: ReturnType<typeof makeWsHandlers>;
  ws: FakeWsContext;
}

async function setup(): Promise<SetupResult> {
  const dir = mkdtempSync(join(tmpdir(), 'gian-err007-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'test', '/tmp/test-ws');

  const proxyMgr = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    queue,
    dir,
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);

  const handlers = makeWsHandlers({ sessions, broadcaster: broadcaster as unknown as WsBroadcaster });
  const ws = new FakeWsContext();
  // Open + auth (skip AUTH_REQUIRED for tests; auth check accepts any
  // non-empty token when AUTH_REQUIRED is false).
  handlers.onOpen({} as Event, ws as never);
  await handlers.onMessage(
    { data: JSON.stringify({ type: 'auth', token: 'dev-token' }) } as never,
    ws as never,
  );

  return { dir, db, wsId, sessions, proxyMgr, broadcaster, handlers, ws };
}

function teardown(ctx: { dir: string; db: ReturnType<typeof openDatabase> }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// ERR-007 — message:send dispatch failure
// ---------------------------------------------------------------------------

test('ERR-007: ws dispatch sends type=error with code=MESSAGE_SEND_FAILED when sendMessage rejects', async () => {
  const ctx = await setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', approval_mode: 'ask',
    });
    ctx.proxyMgr.client.failNextStartTurn = new Error('proxy went sideways');
    ctx.broadcaster.messages.length = 0;

    await ctx.handlers.onMessage(
      { data: JSON.stringify({ type: 'message:send', session_id: session.id, text: 'doomed' }) } as never,
      ctx.ws as never,
    );

    const sent = ctx.broadcaster.sentTo(ctx.ws as never);
    const err = sent.find(m => m.type === 'error') as
      | { type: 'error'; code: string; message: string; session_id?: string }
      | undefined;
    assert.ok(err, 'an error envelope must be sent to the originating WS client');
    assert.equal(err!.code, 'MESSAGE_SEND_FAILED',
      'code must be MESSAGE_SEND_FAILED so the UI can render "send failed" with a retry');
    assert.equal(err!.session_id, session.id,
      'session_id must be echoed back so the UI can route the error to the right transcript');
    assert.match(err!.message, /proxy went sideways/,
      'error message must surface the underlying cause (proxy stderr / runtime error)');
  } finally {
    teardown(ctx);
  }
});

test('ERR-007: ws dispatch maps each known message:* type to a stable error code', async () => {
  // approval:resolve → APPROVAL_RESOLVE_FAILED
  // session:create  → SESSION_CREATE_FAILED
  // session:stop    → SESSION_STOP_FAILED
  // (queue:send_now is a no-op on an empty queue and doesn't throw, so the
  //  QUEUE_SEND_NOW_FAILED branch is reachable only when sendMessage
  //  rejects after pop — exercised in queue-and-busy.test.ts.)
  const ctx = await setup();
  try {
    const checks: Array<[Record<string, unknown>, string]> = [
      [
        { type: 'approval:resolve', session_id: 'sess-missing', approval_id: 'missing', decision: 'allow_once' },
        'APPROVAL_RESOLVE_FAILED',
      ],
      [
        { type: 'session:create', workspace_id: 'no-such-ws', executor: 'claude', approval_mode: 'ask' },
        'SESSION_CREATE_FAILED',
      ],
      [
        { type: 'session:stop', session_id: 'sess-missing' },
        'SESSION_STOP_FAILED',
      ],
    ];

    for (const [msg, expectedCode] of checks) {
      const sentBefore = ctx.broadcaster.sentTo(ctx.ws as never).length;
      await ctx.handlers.onMessage(
        { data: JSON.stringify(msg) } as never,
        ctx.ws as never,
      );
      const sentAfter = ctx.broadcaster.sentTo(ctx.ws as never);
      const newMsgs = sentAfter.slice(sentBefore);
      const err = newMsgs.find(m => m.type === 'error') as
        | { type: 'error'; code: string } | undefined;
      assert.ok(err, `error envelope must be sent for ${msg.type}`);
      assert.equal(err!.code, expectedCode,
        `${msg.type} must map to ${expectedCode}, got ${err!.code}`);
    }
  } finally {
    teardown(ctx);
  }
});

test('ERR-007: unknown wire message types map to DISPATCH_FAILED default code', async () => {
  // Sending a known-but-unwired type (e.g. `session:reset` per CONTRACT-001
  // whitelist) goes through the default branch in dispatch — no throw, no
  // error envelope, just a console.log. We can't easily assert the default
  // code without a path that throws AND has no specific mapping. The
  // contract is documented; here we encode it via the dispatchErrorCode
  // mapper directly to prevent silent drift.
  //
  // This is a fast structural assertion against the public contract: any
  // message:* type the host doesn't explicitly recognize maps to
  // DISPATCH_FAILED so the UI can render a generic "command failed".
  const { dispatchErrorCode } = await import('../src/web/ws-handler.js') as unknown as {
    dispatchErrorCode?: (t: string) => string;
  };
  // The mapper is not exported as a named symbol — only its behavior is
  // contracted. We assert via the live dispatch path: emit a real session
  // bound to a real proxy, then send a `session:rename` with an unknown
  // session_id. renameSession does NOT throw on unknown ids (it just
  // updates 0 rows), so we have to use a path that does throw. Use
  // `session:delete` on an unknown id.
  void dispatchErrorCode; // silence unused-warning if the test framework rewrites
  const ctx = await setup();
  try {
    await ctx.handlers.onMessage(
      { data: JSON.stringify({ type: 'session:delete', session_id: 'sess-missing' }) } as never,
      ctx.ws as never,
    );
    const err = ctx.broadcaster.sentTo(ctx.ws as never).find(
      m => m.type === 'error',
    ) as { type: 'error'; code: string } | undefined;
    assert.ok(err, 'session:delete on a missing id must surface an error envelope');
    assert.equal(err!.code, 'DISPATCH_FAILED',
      'session:delete has no specific dispatchErrorCode mapping; the default must be DISPATCH_FAILED');
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// ERR-007 — auth gate (sanity, anchors the error-envelope tests above)
// ---------------------------------------------------------------------------

test('ERR-007: unauthenticated WS messages are closed with 4001 auth_required (not surfaced as error envelope)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-err007-noauth-'));
  const db = openDatabase(dir);
  const proxyMgr = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals, queue, dir,
  );
  const handlers = makeWsHandlers({ sessions, broadcaster: broadcaster as unknown as WsBroadcaster });
  const ws = new FakeWsContext();
  handlers.onOpen({} as Event, ws as never);

  try {
    // Send message:send WITHOUT first sending an auth frame.
    await handlers.onMessage(
      { data: JSON.stringify({ type: 'message:send', session_id: 'whatever', text: 'hi' }) } as never,
      ws as never,
    );
    assert.equal(ws.closed?.code, 4001,
      'pre-auth dispatch must close the WS with 4001 — never surface as `error` envelope');
    assert.equal(ws.closed?.reason, 'auth_required');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
