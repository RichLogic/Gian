// P3a-1. SessionManager response-id scope. NOT_RUN.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Executor, ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { ApprovalManager } from '../src/approval/index.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type {
  NotificationHandler,
  ProxyClient,
  RespondInteractionParams,
  StartTurnParams,
} from '../src/proxy/types.js';
import { QueueManager } from '../src/queue/index.js';
import { SessionManager } from '../src/session/manager.js';
import { openDatabase } from '../src/storage/db.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { EMPTY_CATALOG, stubInitialize, stubSession } from './helpers/protocol-v2-stub.js';

const NATIVE = 'shared-native';

function liveNotification(value: {
  method: string;
  params: Record<string, unknown> & { turnId?: string };
}): ProxyNotification {
  return proxyNotificationSchema.parse({
    jsonrpc: '2.0',
    method: value.method,
    params: {
      streamId: 'stream-1',
      sequence: 1,
      ...(value.params.turnId ? { sourceTurnId: value.params.turnId } : {}),
      ...value.params,
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class ScopedProxyClient implements ProxyClient {
  readonly executor = 'claude' as const;
  readonly notificationHandlers: NotificationHandler[] = [];
  readonly exitHandlers: Array<(code: number | null) => void> = [];
  readonly approvalCalls: RespondInteractionParams[] = [];
  readonly startTurnCalls: StartTurnParams[] = [];
  failNextRespond = 0;

  isExited() { return false; }
  async initialize() { return stubInitialize(this.executor); }
  async catalog() { return EMPTY_CATALOG; }
  async createSession(params: { cwd: string; nativeSessionId?: string | null }) {
    const nativeSessionId = params.nativeSessionId ?? `cc_${randomUUID()}`;
    return { session: stubSession(nativeSessionId, params.cwd), nativeSessionId };
  }
  async startTurn(params: StartTurnParams) {
    this.startTurnCalls.push(params);
    return {
      session: stubSession('proxy_x', '/tmp', 'running'),
      turn: { id: params.turnId ?? 'proxy_turn' },
    };
  }
  async interruptTurn() {}
  async respondInteraction(params: RespondInteractionParams) {
    this.approvalCalls.push(params);
    if (this.failNextRespond > 0) {
      this.failNextRespond -= 1;
      throw new Error('transport down');
    }
  }
  async closeSession() {}
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      const index = this.notificationHandlers.indexOf(handler);
      if (index >= 0) this.notificationHandlers.splice(index, 1);
    };
  }
  onExit(handler: (code: number | null) => void) {
    this.exitHandlers.push(handler);
    return () => {
      const index = this.exitHandlers.indexOf(handler);
      if (index >= 0) this.exitHandlers.splice(index, 1);
    };
  }
  fire(notification: ProxyNotification): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }
  fireExit(code: number | null): void {
    for (const handler of [...this.exitHandlers]) handler(code);
  }
}

class ScopedProxyManager {
  readonly clients = new Map<string, ScopedProxyClient>();

  clientFor(sessionId: string): ScopedProxyClient {
    const existing = this.clients.get(sessionId);
    if (existing) return existing;
    const client = new ScopedProxyClient();
    this.clients.set(sessionId, client);
    return client;
  }

  async getOrCreate(sessionId?: string): Promise<ProxyClient> {
    return this.clientFor(sessionId ?? 'detached');
  }

  get(sessionId?: string): ProxyClient | undefined {
    return sessionId ? this.clients.get(sessionId) : undefined;
  }

  async forceDispose() {}
  async dispose() {}
  async closeAll() {}
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(message: ServerToClientMessage): void { this.messages.push(message); }
  get size() { return 0; }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-approval-response-'));
  const db = openDatabase(dir);
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(workspaceId, 'test', '/tmp/test-ws');
  const proxy = new ScopedProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const sessions = new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    new QueueManager(db),
    dir,
    null,
  );
  approvals.setGetModeFn(sessionId => sessions.getSession(sessionId).approval_mode);
  return { dir, db, workspaceId, proxy, approvals, sessions };
}

async function bootPair(context: ReturnType<typeof setup>) {
  const sessionA = await context.sessions.createSession({
    workspace_id: context.workspaceId,
    executor: 'claude' as Executor,
    approval_mode: 'ask',
  });
  const sessionB = await context.sessions.createSession({
    workspace_id: context.workspaceId,
    executor: 'claude' as Executor,
    approval_mode: 'ask',
  });
  await context.sessions.sendMessage(sessionA.id, 'start a');
  await context.sessions.sendMessage(sessionB.id, 'start b');
  const clientA = context.proxy.clientFor(sessionA.id);
  const clientB = context.proxy.clientFor(sessionB.id);
  void context.approvals.request({
    sessionId: sessionA.id,
    turnId: clientA.startTurnCalls.at(-1)?.turnId ?? 'turn-a',
    category: 'command',
    risk: 'high',
    description: 'from a',
    payload: { approvalId: NATIVE },
  });
  void context.approvals.request({
    sessionId: sessionB.id,
    turnId: clientB.startTurnCalls.at(-1)?.turnId ?? 'turn-b',
    category: 'command',
    risk: 'high',
    description: 'from b',
    payload: { approvalId: NATIVE },
  });
  clientA.failNextRespond = 1;
  clientB.failNextRespond = 1;
  await assert.rejects(context.sessions.respondApproval(sessionA.id, NATIVE, 'allow_once'), /transport down/);
  await assert.rejects(context.sessions.respondApproval(sessionB.id, NATIVE, 'allow_once'), /transport down/);
  const responseA = clientA.approvalCalls[0]?.responseId;
  const responseB = clientB.approvalCalls[0]?.responseId;
  assert.ok(responseA);
  assert.ok(responseB);
  assert.notEqual(responseA, responseB);
  assert.equal(clientA.approvalCalls[0]?.interactionId, NATIVE);
  assert.equal(clientB.approvalCalls[0]?.interactionId, NATIVE);
  const storedB = context.db.prepare(
    'SELECT response_id FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
  ).get(sessionB.id, NATIVE);
  assert.equal(storedB, undefined);
  return { sessionA, sessionB, clientA, clientB, responseA, responseB };
}

test('two sessions keep distinct response ids after one interaction.resolved', async () => {
  const context = setup();
  try {
    const { sessionA, sessionB, clientA, clientB, responseB } = await bootPair(context);
    const turnId = clientA.startTurnCalls.at(-1)?.turnId;
    assert.ok(turnId);
    clientA.fire(liveNotification({
      method: 'interaction.resolved',
      params: {
        eventId: 'interaction-resolved-a',
        sequence: 2,
        sessionId: sessionA.id,
        turnId,
        emittedAt: '2026-08-18T00:00:01.000Z',
        data: { interactionId: NATIVE, outcome: 'submitted', actionId: 'allow_once' },
      },
    }));
    await waitFor(() => context.approvals.getPending(NATIVE, sessionA.id) === undefined);
    assert.equal(context.approvals.getPending(NATIVE, sessionB.id)?.sessionId, sessionB.id);

    await context.sessions.respondApproval(sessionB.id, NATIVE, 'allow_once');
    assert.equal(clientB.approvalCalls.at(-1)?.responseId, responseB);
    assert.equal(clientB.approvalCalls.at(-1)?.interactionId, NATIVE);
    assert.equal(clientA.approvalCalls.length, 1);
  } finally {
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('clearing one session does not drop the other session response id', async () => {
  const context = setup();
  try {
    const { sessionA, sessionB, clientA, clientB, responseB } = await bootPair(context);
    clientA.fireExit(1);
    await waitFor(() => context.approvals.getPending(NATIVE, sessionA.id) === undefined);
    assert.equal(context.approvals.getPending(NATIVE, sessionB.id)?.id, NATIVE);

    await context.sessions.respondApproval(sessionB.id, NATIVE, 'allow_once');
    assert.equal(clientB.approvalCalls.at(-1)?.responseId, responseB);
    assert.equal(clientB.approvalCalls.at(-1)?.interactionId, NATIVE);
  } finally {
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('a new host turn with the same native id mints a new response id; same-occurrence retries keep it', async () => {
  const context = setup();
  try {
    const session = await context.sessions.createSession({
      workspace_id: context.workspaceId,
      executor: 'claude' as Executor,
      approval_mode: 'ask',
    });
    await context.sessions.sendMessage(session.id, 'turn one');
    const client = context.proxy.clientFor(session.id);
    const turnOne = client.startTurnCalls.at(-1)?.turnId;
    assert.ok(turnOne);
    void context.approvals.request({
      sessionId: session.id,
      turnId: turnOne,
      category: 'command',
      risk: 'high',
      description: 'first occurrence',
      payload: { approvalId: NATIVE },
    });
    await context.sessions.respondApproval(session.id, NATIVE, 'allow_once');
    const firstResponse = client.approvalCalls.at(-1)?.responseId;
    assert.ok(firstResponse);
    assert.equal(client.approvalCalls.at(-1)?.actionId, 'allow_once');
    const storedOne = context.db.prepare(
      'SELECT response_id, turn_id FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
    ).get(session.id, NATIVE) as { response_id: string; turn_id: string };
    assert.equal(storedOne.response_id, firstResponse);
    assert.equal(storedOne.turn_id, turnOne);
    client.fire(liveNotification({
      method: 'interaction.resolved',
      params: {
        eventId: 'resolved-turn-one',
        sequence: 2,
        sessionId: session.id,
        turnId: turnOne,
        emittedAt: '2026-08-18T00:00:01.000Z',
        data: { interactionId: NATIVE, outcome: 'submitted', actionId: 'allow_once' },
      },
    }));
    await waitFor(() => context.approvals.getPending(NATIVE, session.id) === undefined);
    // The native resolved event only stamps outcome/resolved_at; the old row stays.
    const afterResolved = context.db.prepare(
      'SELECT response_id, turn_id, outcome FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
    ).get(session.id, NATIVE) as { response_id: string; turn_id: string; outcome: string };
    assert.equal(afterResolved.response_id, firstResponse);

    client.fire(liveNotification({
      method: 'turn.completed',
      params: {
        eventId: 'completed-turn-one',
        sequence: 3,
        sessionId: session.id,
        turnId: turnOne,
        emittedAt: '2026-08-18T00:00:01.500Z',
        data: { stopReason: 'completed' },
      },
    }));
    await waitFor(() => context.sessions.getSession(session.id).status === 'done');

    await context.sessions.sendMessage(session.id, 'turn two');
    const turnTwo = client.startTurnCalls.at(-1)?.turnId;
    assert.ok(turnTwo);
    assert.notEqual(turnTwo, turnOne);
    void context.approvals.request({
      sessionId: session.id,
      turnId: turnTwo,
      category: 'command',
      risk: 'high',
      description: 'second occurrence',
      payload: { approvalId: NATIVE },
    });
    // The old turn's answered row must not block or supply this response.
    await context.sessions.respondApproval(session.id, NATIVE, 'decline');
    const secondResponse = client.approvalCalls.at(-1)?.responseId;
    assert.ok(secondResponse);
    assert.notEqual(secondResponse, firstResponse);
    assert.equal(client.approvalCalls.at(-1)?.actionId, 'decline');
    const storedTwo = context.db.prepare(
      'SELECT response_id, turn_id FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
    ).get(session.id, NATIVE) as { response_id: string; turn_id: string };
    assert.equal(storedTwo.response_id, secondResponse);
    assert.equal(storedTwo.turn_id, turnTwo);
    client.fire(liveNotification({
      method: 'interaction.resolved',
      params: {
        eventId: 'resolved-turn-two',
        sequence: 3,
        sessionId: session.id,
        turnId: turnTwo,
        emittedAt: '2026-08-18T00:00:02.000Z',
        data: { interactionId: NATIVE, outcome: 'submitted', actionId: 'decline' },
      },
    }));
    await waitFor(() => context.approvals.getPending(NATIVE, session.id) === undefined);

    // A repeated request of the same (second) occurrence resubmits the same
    // response id, which the proxy response ledger absorbs without re-executing.
    const callsBefore = client.approvalCalls.length;
    await context.sessions.respondApproval(session.id, NATIVE, 'decline');
    assert.equal(client.approvalCalls.length, callsBefore + 1);
    assert.equal(client.approvalCalls.at(-1)?.responseId, secondResponse);
    assert.equal(client.approvalCalls.at(-1)?.actionId, 'decline');
  } finally {
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});
