// Coverage for UI Operation Layer Phase 1 (docs/proposals/ui-operation-layer.md
// §4.4): mutating client commands that carry a `request_id` receive exactly
// one `operation:result` on the originating socket, after the canonical
// broadcast; failures additionally annotate the `error` envelope with
// `request_id`. Commands without `request_id` and protocol-exempt types
// ('auth', 'events:subscribe', 'term:input', 'term:resize',
// 'term:replay-request') never produce a result.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { WSContext } from 'hono/ws';
import type { SessionManager } from '../src/session/manager.js';
import type { WorkbenchTerminalManager } from '../src/term/manager.js';

// AUTH_REQUIRED is captured at module load inside auth/middleware.ts; scrub
// inherited env before the (dynamic) import so the fake client can auth with
// any token regardless of the developer shell this suite runs under.
delete process.env.GIAN_AUTH_REQUIRED;
delete process.env.GIAN_DESKTOP_TOKEN;

const { makeWsHandlers } = await import('../src/web/ws-handler.js');
const { WsBroadcaster } = await import('../src/web/ws-broadcast.js');

type Frame = Record<string, unknown> & { type: string };

function fakeClient(sent: Frame[]): WSContext {
  return {
    send: (value: string) => { sent.push(JSON.parse(value) as Frame); },
    close: () => {},
  } as unknown as WSContext;
}

interface Harness {
  ws: WSContext;
  sent: Frame[];
  broadcaster: InstanceType<typeof WsBroadcaster>;
  send: (msg: Record<string, unknown>) => Promise<void>;
}

/**
 * Spin up makeWsHandlers with a stub SessionManager whose mutating methods
 * broadcast synchronously — mirroring the real managers' contract. Auth is
 * completed and the auth_ok frame discarded so `sent` only sees the frames
 * produced by the command under test.
 */
async function setup(overrides?: {
  sessions?: Partial<Record<'renameSession' | 'enqueueMessage', (...args: never[]) => void>>;
  term?: Partial<WorkbenchTerminalManager>;
}): Promise<Harness> {
  const broadcaster = new WsBroadcaster();
  const sent: Frame[] = [];
  const ws = fakeClient(sent);

  const sessions = {
    renameSession(sessionId: string, name: string) {
      broadcaster.broadcast({
        type: 'session:updated',
        session: { id: sessionId, name },
      } as never);
    },
    enqueueMessage(_sessionId: string, _text: string) {
      broadcaster.broadcast({
        type: 'queue:updated',
        session_id: _sessionId,
        queue: [],
      } as never);
    },
    ...overrides?.sessions,
  } as unknown as SessionManager;

  const handlers = makeWsHandlers({
    sessions,
    broadcaster,
    ...(overrides?.term ? { term: overrides.term as WorkbenchTerminalManager } : {}),
  });

  handlers.onOpen(new Event('open'), ws);
  await handlers.onMessage(
    { data: JSON.stringify({ type: 'auth', token: 'test-token' }) },
    ws,
  );
  assert.ok(
    sent.some(f => f.type === 'auth_ok'),
    `auth failed in harness; frames: ${JSON.stringify(sent)}`,
  );
  sent.length = 0;

  return {
    ws,
    sent,
    broadcaster,
    send: (msg) => handlers.onMessage({ data: JSON.stringify(msg) }, ws),
  };
}

function results(sent: Frame[]): Frame[] {
  return sent.filter(f => f.type === 'operation:result');
}

test('mutating command with request_id gets exactly one operation:result ok:true, on the originating socket only', async () => {
  const { sent, broadcaster, send } = await setup();
  const otherSent: Frame[] = [];
  broadcaster.add(fakeClient(otherSent));

  await send({ type: 'session:rename', session_id: 's1', name: 'new name', request_id: 'r-1' });

  assert.equal(results(sent).length, 1);
  assert.deepEqual(results(sent)[0], {
    type: 'operation:result',
    request_id: 'r-1',
    request_type: 'session:rename',
    ok: true,
  });
  // The other connected client sees the canonical broadcast but no result.
  assert.deepEqual(otherSent.map(f => f.type), ['session:updated']);
});

test('canonical broadcast precedes operation:result on the same socket (session:rename → session:updated)', async () => {
  const { sent, send } = await setup();

  await send({ type: 'session:rename', session_id: 's1', name: 'n', request_id: 'r-order' });

  assert.deepEqual(sent.map(f => f.type), ['session:updated', 'operation:result']);
});

test('failing command sends error envelope carrying request_id, then operation:result ok:false with matching code', async () => {
  const boom = Object.assign(new Error('rename blew up'), { code: 'RENAME_EXPLICIT' });
  const { sent, send } = await setup({
    sessions: {
      renameSession() { throw boom; },
    },
  });

  await send({ type: 'session:rename', session_id: 's1', name: 'n', request_id: 'r-fail' });

  assert.deepEqual(sent.map(f => f.type), ['error', 'operation:result']);
  const envelope = sent[0]!;
  assert.equal(envelope.request_id, 'r-fail');
  assert.equal(envelope.request_type, 'session:rename');
  assert.equal(envelope.code, 'RENAME_EXPLICIT');
  assert.equal(envelope.message, 'rename blew up');
  const result = sent[1]!;
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { code: 'RENAME_EXPLICIT', message: 'rename blew up' });
});

test('mutating command without request_id produces no operation:result (success and error paths)', async () => {
  // Success path: broadcast only, no result.
  {
    const { sent, send } = await setup();
    await send({ type: 'session:rename', session_id: 's1', name: 'n' });
    assert.deepEqual(sent.map(f => f.type), ['session:updated']);
  }
  // Error path: plain envelope (no request_id key), no result.
  {
    const { sent, send } = await setup({
      sessions: {
        renameSession() { throw new Error('nope'); },
      },
    });
    await send({ type: 'session:rename', session_id: 's1', name: 'n' });
    assert.deepEqual(sent.map(f => f.type), ['error']);
    assert.ok(!('request_id' in sent[0]!), 'envelope must not carry request_id when absent');
  }
});

test('exempt types (events:subscribe, term:input) produce no operation:result', async () => {
  const { sent, send } = await setup({
    term: { input: () => {} } as Partial<WorkbenchTerminalManager>,
  });

  await send({ type: 'events:subscribe', session_id: 's1' });
  await send({ type: 'term:input', term_id: 't1', data: 'ls\n' });

  assert.equal(results(sent).length, 0);
});

test('two rapid same-type commands with different request_ids each get their own correlated result', async () => {
  const { sent, send } = await setup();

  await send({ type: 'queue:add', session_id: 's1', text: 'first', request_id: 'rid-1' });
  await send({ type: 'queue:add', session_id: 's1', text: 'second', request_id: 'rid-2' });

  assert.deepEqual(sent.map(f => f.type), [
    'queue:updated', 'operation:result',
    'queue:updated', 'operation:result',
  ]);
  const [r1, r2] = results(sent);
  assert.equal(r1!.request_id, 'rid-1');
  assert.equal(r1!.ok, true);
  assert.equal(r2!.request_id, 'rid-2');
  assert.equal(r2!.ok, true);
});
