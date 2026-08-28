import type { ClientToServerMessage } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWorkbenchWire } from '../src/components/terminal-wire.js';
import { createOperationDispatcher } from '../src/operations/dispatcher.js';
import '../src/operations/terminal.js';
import { GianWs } from '../src/ws.js';
import { stateSyncFixture } from './fixtures/ws-contract.js';
import { getMockWebSockets, type MockWebSocket } from './setup.js';

async function openSocket(socket: MockWebSocket): Promise<void> {
  socket.fakeOpen();
  // GianWs resolves its token through Promise.resolve inside an async event
  // listener; allow that microtask to emit the auth frame.
  await Promise.resolve();
  await Promise.resolve();
}

function sentTypes(socket: MockWebSocket): string[] {
  return socket.parsedSent<Array<{ type: string }>[number]>().map(frame => frame.type);
}

describe('WS-002: reconnect and state_sync queue contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('applies state_sync before flushing replay-safe offline frames and drops stale mutations/input', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const observed: string[] = [];
    let sentWhenSyncReduced: string[] = [];
    ws.onMessage(message => {
      observed.push(message.type);
      if (message.type === 'state_sync') {
        const sockets = getMockWebSockets();
        sentWhenSyncReduced = sentTypes(sockets[sockets.length - 1]!);
      }
    });

    ws.connect();
    const socket = getMockWebSockets()[0]!;
    expect(ws.send({
      type: 'message:send', session_id: 's1', text: 'do not replay',
    })).toBe('dropped');
    expect(ws.send({ type: 'events:subscribe', session_id: 's1' })).toBe('queued');
    expect(ws.send({
      type: 'term:input', term_id: 'term-1', data: 'rm -rf nope',
    })).toBe('dropped');
    expect(ws.send({ type: 'term:replay-request', term_id: 'term-1' })).toBe('queued');
    expect(ws.send({
      type: 'term:close', term_id: 'term-orphan', request_id: 'close-offline-1',
    })).toBe('queued');

    await openSocket(socket);
    expect(sentTypes(socket)).toEqual(['auth']);
    socket.fakeMessage({ type: 'auth_ok', user: 'dev' });
    // auth_ok confirms identity but is not readiness: no queued frame may
    // race ahead of the authoritative snapshot.
    expect(ws.getState()).toBe('connecting');
    expect(sentTypes(socket)).toEqual(['auth']);

    const malformed = stateSyncFixture() as unknown as Record<string, unknown>;
    malformed.config = { ...stateSyncFixture().config, density: 'invalid' };
    socket.fakeMessage(malformed);
    // The server emits one snapshot per authentication, so a malformed one
    // must retire this socket instead of waiting forever for a second frame.
    expect(ws.getState()).toBe('closed');
    expect(ws.getAttempt()).toBe(1);
    expect(sentTypes(socket)).toEqual(['auth']);

    vi.advanceTimersByTime(1_000);
    const recovered = getMockWebSockets()[1]!;
    await openSocket(recovered);
    recovered.fakeMessage({ type: 'auth_ok', user: 'dev' });
    recovered.fakeMessage(stateSyncFixture());

    expect(observed).toEqual(['auth_ok', 'auth_ok', 'state_sync']);
    expect(sentWhenSyncReduced).toEqual(['auth']);
    expect(sentTypes(recovered)).toEqual([
      'auth', 'events:subscribe', 'term:replay-request', 'term:close',
    ]);
    ws.disconnect();
  });

  it('classifies the sidechat/fork mutations as never-replayable (dropped-and-failed, §10.5/§10.6)', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    ws.connect();
    const socket = getMockWebSockets()[0]!;

    // Offline/unsynced: every new mutation is DROPPED, not queued. Replaying
    // them after reconnect could duplicate side effects; a dropped send fails
    // its operation run and Host-side idempotency (sidechatId / new
    // sessionId) covers the genuinely-unknown case.
    expect(ws.send({ type: 'sidechat:create', parent_session_id: 's1' })).toBe('dropped');
    expect(ws.send({ type: 'sidechat:resume', sidechat_id: 'sc-1' })).toBe('dropped');
    expect(ws.send({ type: 'sidechat:close', sidechat_id: 'sc-1' })).toBe('dropped');
    expect(ws.send({
      type: 'session:fork',
      source_session_id: 's1',
      anchor: { type: 'turn', turn_id: 't1', source_turn_id: 'p1' },
    })).toBe('dropped');

    await openSocket(socket);
    socket.fakeMessage({ type: 'auth_ok', user: 'dev' });
    // The authoritative snapshot may carry the Side Chat read-model set
    // (proposal §10.5.2) — it must survive the deep state_sync validator.
    const sync = stateSyncFixture();
    sync.sidechats = [{
      id: 'sc-1',
      parent_session_id: 's1',
      ordinal: 1,
      name: null,
      stream_id: 'stream-sc-1',
      state: 'idle',
      status: 'open',
      anchor: { type: 'empty' },
      session_config: {},
      last_error: null,
      uncertain_turn_id: null,
      events: [],
      user_inputs: [],
      created_at: '2026-08-20T08:00:00.000Z',
      updated_at: '2026-08-20T08:00:00.000Z',
    }];
    socket.fakeMessage(sync);

    // Nothing from the dropped mutations was retained for replay.
    expect(sentTypes(socket)).toEqual(['auth']);
    expect(ws.getState()).toBe('open');
    ws.disconnect();
  });

  it('ignores late messages and close events from a superseded socket generation', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const observed: string[] = [];
    ws.onMessage(message => observed.push(message.type));

    ws.connect();
    const stale = getMockWebSockets()[0]!;
    await openSocket(stale);
    ws.disconnect();

    ws.connect();
    const current = getMockWebSockets()[1]!;
    await openSocket(current);
    current.fakeMessage({ type: 'auth_ok', user: 'dev' });
    current.fakeMessage(stateSyncFixture());
    expect(ws.getState()).toBe('open');
    expect(observed).toEqual(['auth_ok', 'state_sync']);

    // Model a browser delivering buffered events from the old generation
    // after the replacement socket is already healthy.
    stale.fakeMessage({ type: 'auth_ok', user: 'stale' });
    stale.fakeMessage(stateSyncFixture());
    stale.close(1006, 'late close');

    expect(observed).toEqual(['auth_ok', 'state_sync']);
    expect(ws.getState()).toBe('open');
    expect(ws.getAttempt()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(getMockWebSockets()).toHaveLength(2);
    ws.disconnect();
  });

  it('defers a known-unsent terminal spawn until ready, then replays without respawning', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const dispatcher = createOperationDispatcher({ transport: ws });
    ws.connect();
    const first = getMockWebSockets()[0]!;

    const wire = makeWorkbenchWire(ws, 'term-live', { cwd: '/workspace' }, dispatcher.dispatch);
    const onReplay = vi.fn();
    const off = wire.subscribe({ onChunk: () => {}, onReplay });
    wire.spawn!(80, 24);
    expect(sentTypes(first)).toEqual([]);

    await openSocket(first);
    first.fakeMessage({ type: 'auth_ok', user: 'dev' });
    expect(sentTypes(first)).toEqual(['auth']);
    first.fakeMessage(stateSyncFixture());
    expect(first.parsedSent<ClientToServerMessage>()).toEqual([
      { type: 'auth', token: 'token' },
      expect.objectContaining({
        type: 'term:spawn', term_id: 'term-live', cwd: '/workspace', cols: 80, rows: 24,
      }),
    ]);

    first.close(1006, 'network');
    vi.advanceTimersByTime(1_000);
    const recovered = getMockWebSockets()[1]!;
    await openSocket(recovered);
    recovered.fakeMessage({ type: 'auth_ok', user: 'dev' });
    // The mounted terminal does not race replay ahead of the snapshot.
    expect(sentTypes(recovered)).toEqual(['auth']);
    recovered.fakeMessage(stateSyncFixture());
    expect(sentTypes(recovered)).toEqual(['auth', 'term:replay-request']);
    recovered.fakeMessage({
      type: 'term:replay',
      term_id: 'term-live',
      chunks: [Buffer.from('missed output', 'utf8').toString('base64')],
      alive: false,
      code: 7,
      signal: null,
    });
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(Array.from(onReplay.mock.calls[0]![0][0] as Uint8Array)).toEqual(
      Array.from(new TextEncoder().encode('missed output')),
    );
    expect(onReplay.mock.calls[0]![1]).toEqual({ alive: false, code: 7, signal: null });

    off();
    dispatcher.dispose();
    ws.disconnect();
  });

  it('replays one ack-uncertain terminal close after false ack and retires it only on success', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const dispatcher = createOperationDispatcher({ transport: ws });
    ws.connect();
    const first = getMockWebSockets()[0]!;
    await openSocket(first);
    first.fakeMessage({ type: 'auth_ok', user: 'dev' });
    first.fakeMessage(stateSyncFixture());

    const closeRun = dispatcher.dispatch('term.close', { termId: 'term-closing' });
    const originalClose = first.parsedSent<ClientToServerMessage>()
      .find(frame => frame.type === 'term:close');
    expect(originalClose).toMatchObject({
      type: 'term:close', term_id: 'term-closing', request_id: expect.any(String),
    });
    // An ordinary mutation sent on the same generation remains at-most-once.
    expect(ws.send({
      type: 'message:send', session_id: 's1', text: 'never replay this frame',
    })).toBe('sent');

    // The browser accepted both writes, but the connection died before the
    // terminal close result. Its outcome is unknown to the dispatcher; only
    // the explicitly idempotent close gets a reconnect tombstone.
    first.close(1006, 'ack lost');
    expect(dispatcher.store.getRun(closeRun.id)?.phase).toBe('timed-out');
    vi.advanceTimersByTime(1_000);
    const recovered = getMockWebSockets()[1]!;
    await openSocket(recovered);
    recovered.fakeMessage({ type: 'auth_ok', user: 'dev' });
    recovered.fakeMessage(stateSyncFixture());

    const recoveredFrames = recovered.parsedSent<ClientToServerMessage>();
    expect(recoveredFrames.map(frame => frame.type)).toEqual(['auth', 'term:close']);
    expect(recoveredFrames[1]).toEqual(originalClose);
    expect(recoveredFrames.some(frame => frame.type === 'message:send')).toBe(false);
    expect(recoveredFrames.some(frame => frame.type === 'term:spawn')).toBe(false);

    recovered.fakeMessage({
      type: 'operation:result',
      request_id: originalClose!.request_id!,
      request_type: 'term:close',
      ok: false,
      error: { code: 'TERM_CLOSE_FAILED', message: 'retry teardown after reconnect' },
    });

    // A negative ack proves cleanup did not complete, so the idempotent
    // tombstone remains. It replays exactly once, not once from the old queue
    // plus once from the compensation map.
    recovered.close(1006, 'retry cleanup');
    vi.advanceTimersByTime(1_000);
    const retried = getMockWebSockets()[2]!;
    await openSocket(retried);
    retried.fakeMessage({ type: 'auth_ok', user: 'dev' });
    retried.fakeMessage(stateSyncFixture());
    expect(sentTypes(retried)).toEqual(['auth', 'term:close']);
    expect(retried.parsedSent<ClientToServerMessage>()[1]).toEqual(originalClose);

    retried.fakeMessage({
      type: 'operation:result',
      request_id: originalClose!.request_id!,
      request_type: 'term:close',
      ok: true,
    });

    // Once a positive ack retires the tombstone, a later reconnect must not
    // issue another close (or any other old mutation).
    retried.close(1006, 'later network loss');
    vi.advanceTimersByTime(1_000);
    const healthyAgain = getMockWebSockets()[3]!;
    await openSocket(healthyAgain);
    healthyAgain.fakeMessage({ type: 'auth_ok', user: 'dev' });
    healthyAgain.fakeMessage(stateSyncFixture());
    expect(sentTypes(healthyAgain)).toEqual(['auth']);

    dispatcher.dispose();
    ws.disconnect();
  });

  it('coalesces duplicate terminal closes and bounds offline tombstones', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    ws.connect();
    const socket = getMockWebSockets()[0]!;

    for (let index = 0; index <= 256; index++) {
      expect(ws.send({
        type: 'term:close', term_id: `term-${index}`, request_id: `close-${index}`,
      })).toBe('queued');
    }
    // Same terminal, newer correlation: only the newest tombstone survives.
    expect(ws.send({
      type: 'term:close', term_id: 'term-256', request_id: 'close-256-new',
    })).toBe('queued');

    await openSocket(socket);
    socket.fakeMessage({ type: 'auth_ok', user: 'dev' });
    socket.fakeMessage(stateSyncFixture());
    const closes = socket.parsedSent<ClientToServerMessage>()
      .filter(frame => frame.type === 'term:close');
    expect(closes).toHaveLength(256);
    expect(closes.some(frame => frame.term_id === 'term-0')).toBe(false);
    expect(closes.filter(frame => frame.term_id === 'term-256')).toEqual([{
      type: 'term:close', term_id: 'term-256', request_id: 'close-256-new',
    }]);

    ws.disconnect();
  });

  it('uses capped exponential reconnect delays and resets the attempt only after state_sync', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    ws.connect();
    const first = getMockWebSockets()[0]!;

    first.close(1006, 'network');
    expect(ws.getAttempt()).toBe(1);
    vi.advanceTimersByTime(999);
    expect(getMockWebSockets()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getMockWebSockets()).toHaveLength(2);

    const second = getMockWebSockets()[1]!;
    second.close(1006, 'network again');
    expect(ws.getAttempt()).toBe(2);
    vi.advanceTimersByTime(1_999);
    expect(getMockWebSockets()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(getMockWebSockets()).toHaveLength(3);

    const third = getMockWebSockets()[2]!;
    await openSocket(third);
    third.fakeMessage({ type: 'auth_ok', user: 'dev' });
    expect(ws.getAttempt()).toBe(2);
    expect(ws.getState()).toBe('connecting');
    third.fakeMessage(stateSyncFixture());
    expect(ws.getAttempt()).toBe(0);
    expect(ws.getState()).toBe('open');

    // A healthy sync resets the series: the next reconnect starts at 1 s.
    third.close(1006, 'later network loss');
    expect(ws.getAttempt()).toBe(1);
    vi.advanceTimersByTime(999);
    expect(getMockWebSockets()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(getMockWebSockets()).toHaveLength(4);
    ws.disconnect();
  });
});
