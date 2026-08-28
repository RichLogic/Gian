import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ProxyProtocolError } from '@gian/proxy-protocol';
import type { ServerToClientMessage } from '@gian/shared';
import { ApprovalManager } from '../src/approval/index.js';
import { ProxyManager } from '../src/proxy/manager.js';
import { QueueManager } from '../src/queue/index.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProtocolV2SessionClient } from '../src/proxy/protocol-v2-session-client.js';
import { openDatabase } from '../src/storage/db.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

const FAKE_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-sidechat-fork-proxy.mjs',
);

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(msg: ServerToClientMessage): void {
    this.messages.push(msg);
  }
  get size() { return 0; }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'gian-sidechat-sys-'));
  const db = openDatabase(dir);
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run('ws-sys', 'sys', '/tmp/sidechat-sys');
  const proxy = new ProxyManager({
    dataDir: join(dir, 'proxy-data'),
    hostVersion: '0.5.0-test',
    ccProxyEntry: FAKE_ENTRY,
    claudeProxy: { pluginVersion: '0.2.0', processScope: 'session' },
  });
  const broadcaster = new CapturingBroadcaster();
  const sessions = new SessionManager(
    db,
    proxy,
    broadcaster as unknown as WsBroadcaster,
    new ApprovalManager(broadcaster as unknown as WsBroadcaster),
    new QueueManager(db),
    dir,
  );
  t.after(async () => {
    await proxy.closeAll().catch(() => undefined);
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, db, proxy, sessions, broadcaster };
}

test('Fake Proxy subprocess covers Side Chat create/resume/close and parent isolation', async (t) => {
  const ctx = await setup(t);
  const parent = await ctx.sessions.createSession({
    workspace_id: 'ws-sys',
    executor: 'claude',
    session_config: { execution_mode: 'agent' },
  });
  await ctx.sessions.sendMessage(parent.id, 'parent turn');
  await waitFor(() => ctx.sessions.listEvents(parent.id).length > 0);

  const sidechat = await ctx.sessions.createSidechat(parent.id, 'sc_sys_1');
  assert.equal(sidechat.anchor.type === 'empty' || sidechat.anchor.type === 'turn', true);
  await ctx.sessions.sendMessage(
    sidechat.id,
    'side text',
    undefined,
    undefined,
    undefined,
    [{
      type: 'pastedText', id: 'side-paste', text: 'side context', lineCount: 99, byteSize: 99,
    }],
    {
      version: 1,
      segments: [
        { type: 'text', text: 'side ' },
        { type: 'reference', id: 'side-paste', referenceType: 'context', label: 'context' },
        { type: 'text', text: ' text' },
      ],
    },
  );
  await waitFor(() => (
    ctx.sessions.listSidechats().find((item) => item.id === sidechat.id)?.events.length ?? 0
  ) > 0);
  assert.deepEqual(
    ctx.sessions.listSidechats().find((item) => item.id === sidechat.id)?.user_inputs[0]?.input,
    [{ type: 'text', text: 'side text' }],
  );
  assert.deepEqual(
    ctx.sessions.listSidechats().find((item) => item.id === sidechat.id)?.user_inputs[0]?.context_items,
    [{ type: 'pastedText', id: 'side-paste', text: 'side context', lineCount: 1, byteSize: 12 }],
  );
  assert.deepEqual(
    ctx.sessions.listSidechats().find((item) => item.id === sidechat.id)?.user_inputs[0]?.composer_document,
    {
      version: 1,
      segments: [
        { type: 'text', text: 'side ' },
        { type: 'reference', id: 'side-paste', referenceType: 'context', label: 'context' },
        { type: 'text', text: ' text' },
      ],
    },
  );

  const parentEventCount = ctx.sessions.listEvents(parent.id).length;
  await ctx.sessions.sendMessage(sidechat.id, 'FATAL');
  await waitFor(() => (
    ctx.sessions.listSidechats().find((item) => item.id === sidechat.id)?.status === 'unavailable'
  ));
  assert.equal(ctx.sessions.getSession(parent.id).id, parent.id);
  assert.equal(ctx.sessions.listEvents(parent.id).length, parentEventCount);

  const closed = await ctx.sessions.closeSidechat(sidechat.id);
  assert.equal(closed.ok, true);
  assert.equal(typeof closed.providerDataDeleted, 'boolean');
  assert.equal(ctx.sessions.listSidechats().length, 0);

  const unknown = await ctx.sessions.closeSidechat('sc_unknown');
  assert.deepEqual(unknown, {
    ok: true,
    sidechatId: 'sc_unknown',
    providerDataDeleted: false,
  });
});

test('Fake Proxy subprocess covers head/atTurn Fork, restart recovery, and rejected session methods', async (t) => {
  const ctx = await setup(t);
  const parent = await ctx.sessions.createSession({
    workspace_id: 'ws-sys',
    executor: 'claude',
    session_config: { execution_mode: 'agent' },
  });
  await ctx.sessions.sendMessage(parent.id, 'anchor turn');
  await waitFor(() => !!ctx.db.prepare(
    `SELECT turns.id AS turnId
     FROM turns
     JOIN proxy_replay_turns replay ON replay.turn_id = turns.id
     WHERE turns.session_id = ?
       AND turns.status IN ('completed', 'error', 'stopped')
     LIMIT 1`,
  ).get(parent.id));
  const sourceTurn = ctx.db.prepare(
    `SELECT turns.id AS turnId, replay.provider_turn_id AS sourceTurnId
     FROM turns
     JOIN proxy_replay_turns replay ON replay.turn_id = turns.id
     WHERE turns.session_id = ?
     ORDER BY turns.turn_number DESC LIMIT 1`,
  ).get(parent.id) as { turnId: string; sourceTurnId: string };

  const forked = await ctx.sessions.forkSession({
    sourceSessionId: parent.id,
    sessionId: 'fork-sys-1',
    anchor: { type: 'head' },
  });
  assert.equal(forked.origin.session_id, parent.id);
  assert.equal(ctx.sessions.getSession('fork-sys-1').workspace_id, parent.workspace_id);
  assert.equal(ctx.sessions.getSession('fork-sys-1').native_session_id, 'native-fork-sys-1');
  assert.ok(ctx.sessions.listEvents('fork-sys-1').length > 0);

  const atTurn = await ctx.sessions.forkSession({
    sourceSessionId: parent.id,
    sessionId: 'fork-sys-2',
    anchor: { type: 'turn', turnId: sourceTurn.turnId, sourceTurnId: sourceTurn.sourceTurnId },
  });
  assert.equal(atTurn.origin.turn_id, sourceTurn.turnId);

  await assert.rejects(
    ctx.sessions.forkSession({
      sourceSessionId: parent.id,
      sessionId: 'fork-sys-bad',
      anchor: { type: 'turn', turnId: sourceTurn.turnId, sourceTurnId: 'not-the-source' },
    }),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'FORK_BOUNDARY_UNAVAILABLE',
  );

  const forkClient = ctx.proxy.get('fork-sys-1');
  assert.ok(forkClient);
  const forkEventCount = ctx.sessions.listEvents('fork-sys-1').length;
  await ctx.proxy.dispose(parent.id);
  assert.equal(
    ctx.proxy.get('fork-sys-1'),
    forkClient,
    'closing a session-scoped parent must not tear down its persistent Fork child',
  );
  await ctx.sessions.sendMessage('fork-sys-1', 'child survives parent detach');
  await waitFor(() => ctx.sessions.listEvents('fork-sys-1').length > forkEventCount);

  const sidechat = await ctx.sessions.createSidechat(parent.id, 'sc_sys_restart');
  const parentClient = ctx.proxy.get(parent.id) as ProtocolV2SessionClient;
  assert.ok(parentClient?.runtimeHost);
  await assert.rejects(
    parentClient.runtimeHost().request('session.close', {
      sessionId: sidechat.id,
      streamId: sidechat.stream_id,
    }),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'SESSION_NOT_FOUND',
  );
  await assert.rejects(
    parentClient.runtimeHost().request('session.get', { sessionId: sidechat.id }),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'SESSION_NOT_FOUND',
  );

  await ctx.proxy.dispose(parent.id);
  const restarted = new SessionManager(
    ctx.db,
    ctx.proxy,
    ctx.broadcaster as unknown as WsBroadcaster,
    new ApprovalManager(ctx.broadcaster as unknown as WsBroadcaster),
    new QueueManager(ctx.db),
    ctx.dir,
  );
  const recovered = await restarted.resumeSidechat('sc_sys_restart', parent.id);
  assert.ok(recovered.status === 'open' || recovered.status === 'unavailable');
});

test('Fake Proxy can withhold Provider deletion and keep Side Chat out of native list', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gian-sidechat-del-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openDatabase(dir);
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run('ws-sys', 'sys', '/tmp/sidechat-sys');
  const proxy = new ProxyManager({
    dataDir: join(dir, 'proxy-data'),
    hostVersion: '0.5.0-test',
    ccProxyEntry: FAKE_ENTRY,
    claudeProxy: { pluginVersion: '0.2.0', processScope: 'session' },
  });
  t.after(() => proxy.closeAll().catch(() => undefined));
  const broadcaster = new CapturingBroadcaster();
  const sessions = new SessionManager(
    db,
    proxy,
    broadcaster as unknown as WsBroadcaster,
    new ApprovalManager(broadcaster as unknown as WsBroadcaster),
    new QueueManager(db),
    dir,
  );
  const parent = await sessions.createSession({
    workspace_id: 'ws-sys',
    executor: 'claude',
    session_config: { execution_mode: 'agent' },
  });
  const dataDir = join(dir, 'proxy-data', 'proxy', parent.id);
  await writeFile(join(dataDir, 'fake-control.json'), JSON.stringify({ providerDataDeleted: false }));
  const sidechat = await sessions.createSidechat(parent.id, 'sc_keep');
  const closed = await sessions.closeSidechat(sidechat.id);
  assert.equal(closed.providerDataDeleted, false);
  const natives = await sessions.listPluginNativeSessions('claude', '/tmp/sidechat-sys');
  assert.ok(natives === null || natives.every((item) => item.id !== sidechat.id));
});
