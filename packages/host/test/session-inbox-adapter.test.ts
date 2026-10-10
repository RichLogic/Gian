// P3a-2. Main-session question and approval inbox. NOT_RUN.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Executor, ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { ApprovalManager } from '../src/approval/index.js';
import { listUnappliedInboxProjections, recordInboxProjection } from '../src/inbox/projection-facts.js';
import { InboxError, InboxService } from '../src/inbox/service.js';
import { boundedInteractionId } from '../src/inbox/signal.js';
import {
  SessionInboxAdapter,
  sessionInboxMayNotify,
  type SessionInboxStore,
} from '../src/inbox/session-adapter.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type {
  NotificationHandler,
  ProxyClient,
  RespondInteractionParams,
  StartTurnParams,
} from '../src/proxy/types.js';
import { QueueManager } from '../src/queue/index.js';
import { AttentionDispatcher } from '../src/session/attention.js';
import { SessionManager } from '../src/session/manager.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import { saveConfig } from '../src/storage/config.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { EMPTY_CATALOG, stubInitialize, stubSession } from './helpers/protocol-v2-stub.js';

interface StoredInbox {
  status: string;
  generation: number;
  read_at: string | null;
  read_generation: number | null;
  notified_generation: number | null;
  tombstone: number;
  title: string;
  summary: string;
  target_json: string;
  display_json: string;
  source_kind: string;
}

function storedInbox(db: Db): StoredInbox[] {
  return db.prepare(
    `SELECT status, generation, read_at, read_generation, notified_generation, tombstone,
            title, summary, target_json, display_json, source_kind
       FROM inbox_items`,
  ).all() as StoredInbox[];
}

function inboxItem(db: Db, sessionId: string, interactionId: string): StoredInbox | undefined {
  return storedInbox(db).find((row) => {
    const display = JSON.parse(row.display_json) as { interaction_id?: string };
    if (display.interaction_id !== interactionId) return false;
    const target = JSON.parse(row.target_json) as { type?: string; session_id?: string };
    return target.session_id === sessionId || target.type === 'unavailable';
  });
}

function projectionFact(db: Db, eventId: string): {
  turn_id: string;
  user_pending: number;
  applied: number;
  generation: number;
  occurrence_event_id: string;
  direction: string;
  bound: number;
} | undefined {
  return db.prepare(
    `SELECT turn_id, user_pending, applied, generation, occurrence_event_id, direction, bound
       FROM inbox_projection_facts
      WHERE provider_event_id = ?`,
  ).get(eventId) as {
    turn_id: string;
    user_pending: number;
    applied: number;
    generation: number;
    occurrence_event_id: string;
    direction: string;
    bound: number;
  } | undefined;
}

function hostTerminalClose(
  db: Db,
  sessionId: string,
  turnId: string,
  interactionId: string,
): { outcome: string | null; user_source: number; applied: number } | undefined {
  return db.prepare(
    `SELECT outcome, user_source, applied
       FROM inbox_projection_facts
      WHERE session_id = ?
        AND turn_id = ?
        AND interaction_id = ?
        AND direction = 'close'
        AND provider_event_id = ?`,
  ).get(
    sessionId,
    turnId,
    interactionId,
    `gian:turn-terminal:${turnId}:${interactionId}`,
  ) as { outcome: string | null; user_source: number; applied: number } | undefined;
}

function requestRows(db: Db, sessionId: string, interactionId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n
       FROM events
      WHERE session_id = ?
        AND call_id = ?
        AND type IN ('interaction.requested', 'approval.requested')`,
  ).get(sessionId, interactionId) as { n: number };
  return row.n;
}

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

class InboxProxyClient implements ProxyClient {
  readonly executor = 'claude' as const;
  readonly notificationHandlers: NotificationHandler[] = [];
  readonly exitHandlers: Array<(code: number | null) => void> = [];
  readonly approvalCalls: RespondInteractionParams[] = [];
  readonly startTurnCalls: StartTurnParams[] = [];
  echoHostTurnId = true;
  failNextRespond = 0;
  closeGate: Promise<void> | null = null;

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
      turn: { id: this.echoHostTurnId ? params.turnId : 'proxy_turn' },
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
  async closeSession() {
    if (this.closeGate) await this.closeGate;
  }
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

class InboxProxyManager {
  readonly clients = new Map<string, InboxProxyClient>();

  clientFor(sessionId: string): InboxProxyClient {
    const existing = this.clients.get(sessionId);
    if (existing) return existing;
    const client = new InboxProxyClient();
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

/** Adapter reads go through here. Coordinator writes stay on the real database. */
class ReadFaultDb {
  failIdentityReads = 0;
  failFactReads = 0;
  failOrphanSelects = 0;

  constructor(private readonly inner: Db) {}

  prepare(sql: string) {
    const statement = this.inner.prepare(sql);
    const fault = this.faultFor(sql);
    return {
      all: (...args: unknown[]) => {
        if (fault && this[fault] > 0) {
          this[fault] -= 1;
          throw new Error(`${fault} failed`);
        }
        return statement.all(...(args as never[]));
      },
      get: (...args: unknown[]) => statement.get(...(args as never[])),
      run: (...args: unknown[]) => statement.run(...(args as never[])),
    };
  }

  private faultFor(sql: string): 'failIdentityReads' | 'failFactReads' | 'failOrphanSelects' | null {
    if (sql.includes('provider_event_id = occurrence_event_id')) return 'failIdentityReads';
    if (sql.includes('ORDER BY rowid') && sql.includes('applied = 0')) return 'failFactReads';
    if (sql.includes('FROM inbox_items') && sql.includes('target_json')) return 'failOrphanSelects';
    return null;
  }
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(message: ServerToClientMessage): void { this.messages.push(message); }
  get size() { return 0; }
}

class FlakyInbox implements SessionInboxStore {
  upsertCalls = 0;
  closeCalls = 0;
  expireCalls = 0;
  failUpserts = 0;
  failCloses = 0;
  failExpires = 0;
  rejectCloses = 0;

  constructor(private readonly inner: InboxService) {}

  upsert(input: unknown) {
    this.upsertCalls += 1;
    if (this.failUpserts > 0) {
      this.failUpserts -= 1;
      throw new Error('inbox upsert failed');
    }
    return this.inner.upsert(input);
  }

  closeExisting(input: unknown) {
    this.closeCalls += 1;
    if (this.rejectCloses > 0) {
      this.rejectCloses -= 1;
      throw new InboxError('INVALID_ARGUMENT', 'close rejected');
    }
    if (this.failCloses > 0) {
      this.failCloses -= 1;
      throw new Error('inbox close failed');
    }
    return this.inner.closeExisting(input);
  }

  expireSession(sessionId: string) {
    this.expireCalls += 1;
    if (this.failExpires > 0) {
      this.failExpires -= 1;
      throw new Error('orphan expire failed');
    }
    return this.inner.expireSession(sessionId);
  }

  storedSessionItem(sessionId: string, interactionId: string) {
    return this.inner.storedSessionItem(sessionId, interactionId);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-inbox-'));
  const db = openDatabase(dir);
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(workspaceId, 'test', dir);
  saveConfig(db, {
    notifications: { enabled: false, session_done: false, approval_needed: false, errors: false },
  });
  let gateCalls = 0;
  const proxy = new InboxProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const attention = new AttentionDispatcher(broadcaster as unknown as WsBroadcaster, () => {
    gateCalls += 1;
    return false;
  });
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const inbox = new InboxService(db, {
    broadcast: message => broadcaster.broadcast(message),
  });
  const sessions = new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    new QueueManager(db),
    dir,
    null,
    undefined,
    attention,
  );
  const adapter = new SessionInboxAdapter(db, inbox);
  sessions.setSessionInbox(adapter);
  approvals.setRespondFn((sessionId, approvalId, decision) => sessions.respondApproval(sessionId, approvalId, decision));
  approvals.setGetModeFn(sessionId => sessions.getSession(sessionId).approval_mode);
  return {
    dir,
    db,
    workspaceId,
    proxy,
    broadcaster,
    approvals,
    inbox,
    sessions,
    adapter,
    gateCalls: () => gateCalls,
  };
}

function finish(context: { dir: string; db: Db; adapter?: { dispose(): void } }): void {
  context.adapter?.dispose();
  context.db.close();
  rmSync(context.dir, { recursive: true, force: true });
}

async function boot(context: ReturnType<typeof setup>, name: string) {
  const session = await context.sessions.createSession({
    workspace_id: context.workspaceId,
    executor: 'claude' as Executor,
    approval_mode: 'ask',
    name,
  });
  await context.sessions.sendMessage(session.id, `start ${name}`);
  const client = context.proxy.clientFor(session.id);
  const turnId = client.startTurnCalls.at(-1)?.turnId;
  assert.ok(turnId);
  return { session, client, turnId };
}

function requested(
  sessionId: string,
  turnId: string,
  interactionId: string,
  eventId: string,
  sequence: number,
  data: Record<string, unknown>,
): ProxyNotification {
  return liveNotification({
    method: 'interaction.requested',
    params: {
      eventId,
      sequence,
      sessionId,
      turnId,
      emittedAt: '2026-08-18T00:00:00.000Z',
      data: { interactionId, inputs: [], ...data },
    },
  });
}

function resolved(
  sessionId: string,
  turnId: string,
  interactionId: string,
  eventId: string,
  sequence: number,
  outcome: string,
  actionId?: string,
): ProxyNotification {
  return liveNotification({
    method: 'interaction.resolved',
    params: {
      eventId,
      sequence,
      sessionId,
      turnId,
      emittedAt: '2026-08-18T00:00:02.000Z',
      data: {
        interactionId,
        outcome,
        ...(actionId ? { actionId } : {}),
      },
    },
  });
}

const ACTIONS = [
  { id: 'allow', label: 'Allow once', style: 'primary' },
  { id: 'deny', label: 'Deny', style: 'danger' },
];

const KINDS = {
  permissionOptionKinds: { allow: 'allow_once', deny: 'reject_once' },
};

test('closeExisting leaves a missing session item absent and does not raise its generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-inbox-close-'));
  const db = openDatabase(dir);
  try {
    const inbox = new InboxService(db);
    assert.equal(inbox.closeExisting({
      kind: 'session.approval.closed',
      interaction_id: 'never-opened',
      session_id: 'sess-close-1',
      generation: 1,
      outcome: 'resolved',
      actor: 'system',
      category: 'command',
    }), null);
    assert.equal(storedInbox(db).length, 0);
    inbox.upsert({
      kind: 'session.approval',
      interaction_id: 'kept-generation',
      session_id: 'sess-close-1',
      turn: 1,
      generation: 1,
      category: 'command',
      title: 'Run tests',
      summary: 'npm test',
    });
    const closed = inbox.closeExisting({
      kind: 'session.approval.closed',
      interaction_id: 'kept-generation',
      session_id: 'sess-close-1',
      generation: 4,
      outcome: 'resolved',
      actor: 'user',
      category: 'command',
    });
    assert.equal(closed?.item?.status, 'resolved');
    assert.equal(closed?.item?.generation, 1);
    const row = inboxItem(db, 'sess-close-1', 'kept-generation');
    assert.equal(row?.generation, 1);
    assert.equal(row?.tombstone, 0);
    assert.equal(row?.title, 'Run tests');
    assert.ok(row?.read_at);
    inbox.upsert({
      kind: 'session.approval',
      interaction_id: 'newer-generation',
      session_id: 'sess-close-1',
      turn: 1,
      generation: 2,
      category: 'command',
      title: 'Newer request',
      summary: 'still waiting',
    });
    assert.equal(inbox.closeExisting({
      kind: 'session.approval.closed',
      interaction_id: 'newer-generation',
      session_id: 'sess-close-1',
      generation: 1,
      outcome: 'resolved',
      actor: 'user',
      category: 'command',
    }), null);
    const newer = inboxItem(db, 'sess-close-1', 'newer-generation');
    assert.equal(newer?.status, 'pending');
    assert.equal(newer?.generation, 2);
    assert.equal(newer?.read_at, null);
    assert.equal(newer?.title, 'Newer request');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main-session questions and approvals mirror pending, user outcome, and category', async () => {
  const context = setup();
  try {
    const first = await boot(context, 'alpha');
    const second = await boot(context, 'beta');
    first.client.fire(requested(first.session.id, first.turnId, 'bash-1', 'bash-event-1', 1, {
      title: 'Run\u0007 tests\nnow',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash', inputPreview: 'npm test' }, ...KINDS },
    }));
    await waitFor(() => context.approvals.getPending('bash-1', first.session.id) !== undefined);
    const pending = inboxItem(context.db, first.session.id, 'bash-1');
    assert.ok(pending);
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.source_kind, 'session.approval');
    assert.equal(pending?.generation, 1);
    const opening = projectionFact(context.db, 'bash-event-1');
    assert.equal(opening?.turn_id, first.turnId);
    assert.equal(opening?.user_pending, 1);
    assert.equal(opening?.applied, 1);
    assert.equal(opening?.generation, 1);
    assert.equal(opening?.occurrence_event_id, 'bash-event-1');
    assert.equal(opening?.direction, 'open');
    assert.equal(requestRows(context.db, first.session.id, 'bash-1'), 1);
    assert.equal(pending?.title, 'Run tests now');
    assert.equal(pending?.summary, 'npm test');
    assert.equal(pending?.read_at, null);
    assert.equal(pending?.notified_generation, null);
    assert.equal(pending?.tombstone, 0);
    const target = JSON.parse(pending?.target_json ?? '{}') as { session_id?: string; turn?: number; interaction_id?: string };
    const display = JSON.parse(pending?.display_json ?? '{}') as { kind?: string; category?: string; interaction_id?: string };
    assert.equal(target.session_id, first.session.id);
    assert.equal(target.interaction_id, 'bash-1');
    assert.equal(target.turn, 1);
    assert.equal(display.kind, 'session.approval');
    assert.equal(display.category, 'command');
    assert.equal(display.interaction_id, 'bash-1');
    const notice = context.adapter.notice(first.session.id, 'bash-1');
    assert.equal(notice?.delivery, 'fresh');
    assert.equal(notice?.generation, 1);
    assert.equal(notice?.joinCount, 0);
    assert.equal(sessionInboxMayNotify(notice), true);
    assert.ok(context.gateCalls() > 0);
    assert.equal(context.broadcaster.messages.some(message => message.type === 'attention'), false);

    first.client.fire(requested(first.session.id, first.turnId, 'write-1', 'write-event-1', 2, {
      title: 'Write file',
      description: 'src/app.ts',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Write' }, ...KINDS },
    }));
    first.client.fire(requested(first.session.id, first.turnId, 'plan-1', 'plan-event-1', 3, {
      title: 'Plan',
      description: 'Review the plan',
      presentation: { kind: 'permission', tone: 'warning' },
      actions: ACTIONS,
      context: { subject: { toolName: 'ExitPlanMode' } },
    }));
    first.client.fire(requested(first.session.id, first.turnId, 'other-1', 'other-event-1', 4, {
      title: 'Unknown tool',
      description: 'No mapped tool',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
    }));
    first.client.fire(requested(first.session.id, first.turnId, 'mcp-1', 'mcp-event-1', 5, {
      title: 'Read the file',
      description: 'MCP tool',
      presentation: { kind: 'permission', tone: 'warning' },
      actions: ACTIONS,
      context: { subject: { toolName: 'mcp__files__read' }, ...KINDS },
    }));
    first.client.fire(requested(first.session.id, first.turnId, 'ask-approval', 'ask-approval-event', 6, {
      title: 'Ask as approval',
      description: 'Tool name is not the semantics',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'AskUserQuestion' }, ...KINDS },
    }));
    await waitFor(() => (
      context.approvals.getPending('write-1', first.session.id) !== undefined
      && context.approvals.getPending('plan-1', first.session.id) !== undefined
      && context.approvals.getPending('other-1', first.session.id) !== undefined
      && context.approvals.getPending('mcp-1', first.session.id) !== undefined
      && context.approvals.getPending('ask-approval', first.session.id) !== undefined
    ));
    assert.equal(JSON.parse(inboxItem(context.db, first.session.id, 'write-1')?.display_json ?? '{}').category, 'permission');
    assert.equal(JSON.parse(inboxItem(context.db, first.session.id, 'plan-1')?.display_json ?? '{}').category, 'plan');
    assert.equal(JSON.parse(inboxItem(context.db, first.session.id, 'other-1')?.display_json ?? '{}').category, 'permission');
    assert.equal(inboxItem(context.db, first.session.id, 'other-1')?.source_kind, 'session.approval');
    assert.equal(JSON.parse(inboxItem(context.db, first.session.id, 'mcp-1')?.display_json ?? '{}').category, 'permission');
    assert.equal(inboxItem(context.db, first.session.id, 'ask-approval')?.source_kind, 'session.approval');
    assert.equal(JSON.parse(inboxItem(context.db, first.session.id, 'ask-approval')?.display_json ?? '{}').category, 'permission');

    second.client.fire(requested(second.session.id, second.turnId, 'bash-1', 'beta-bash-event', 1, {
      title: 'Run tests',
      description: 'other session',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => context.approvals.getPending('bash-1', second.session.id) !== undefined);
    assert.notEqual(
      inboxItem(context.db, first.session.id, 'bash-1')?.target_json,
      inboxItem(context.db, second.session.id, 'bash-1')?.target_json,
    );

    await context.sessions.respondApproval(first.session.id, 'bash-1', 'allow_once', undefined, 'allow');
    first.client.fire(resolved(first.session.id, first.turnId, 'bash-1', 'bash-resolved-1', 7, 'submitted', 'allow'));
    await waitFor(() => context.approvals.getPending('bash-1', first.session.id) === undefined);
    const allowed = inboxItem(context.db, first.session.id, 'bash-1');
    assert.equal(allowed?.status, 'resolved');
    assert.ok(allowed?.read_at);
    assert.equal(allowed?.read_generation, 1);
    assert.equal(allowed?.notified_generation, 1);
    assert.equal(inboxItem(context.db, second.session.id, 'bash-1')?.status, 'pending');
    assert.equal(first.client.approvalCalls.length, 1);
    assert.equal(first.client.approvalCalls[0]?.interactionId, 'bash-1');

    first.client.fire(requested(first.session.id, first.turnId, 'question-1', 'question-event-1', 8, {
      title: 'Which file?',
      description: 'Pick one',
      presentation: { kind: 'question' },
      actions: ACTIONS,
      context: { subject: { toolName: 'AskUserQuestion' }, ...KINDS },
    }));
    await waitFor(() => context.approvals.getPending('question-1', first.session.id) !== undefined);
    assert.equal(inboxItem(context.db, first.session.id, 'question-1')?.source_kind, 'session.question');
    await context.sessions.respondApproval(first.session.id, 'question-1', 'decline', undefined, 'deny');
    first.client.fire(resolved(first.session.id, first.turnId, 'question-1', 'question-resolved-1', 9, 'submitted', 'deny'));
    await waitFor(() => context.approvals.getPending('question-1', first.session.id) === undefined);
    const declinedQuestion = inboxItem(context.db, first.session.id, 'question-1');
    assert.equal(declinedQuestion?.status, 'cancelled');
    assert.ok(declinedQuestion?.read_at);

    await context.sessions.respondApproval(first.session.id, 'write-1', 'decline', undefined, 'deny');
    first.client.fire(resolved(first.session.id, first.turnId, 'write-1', 'write-resolved-1', 10, 'submitted', 'deny'));
    await waitFor(() => context.approvals.getPending('write-1', first.session.id) === undefined);
    const declined = inboxItem(context.db, first.session.id, 'write-1');
    assert.equal(declined?.status, 'rejected');
    assert.ok(declined?.read_at);

    first.client.fire(resolved(first.session.id, first.turnId, 'plan-1', 'plan-auto-resolved', 11, 'cancelled'));
    await waitFor(() => context.approvals.getPending('plan-1', first.session.id) === undefined);
    const autoClosed = inboxItem(context.db, first.session.id, 'plan-1');
    assert.equal(autoClosed?.status, 'cancelled');
    assert.equal(autoClosed?.read_at, null);
    assert.equal(autoClosed?.notified_generation, null);
  } finally {
    finish(context);
  }
});

test('a failed provider response leaves the inbox pending and is not repeated', async () => {
  const context = setup();
  try {
    const active = await boot(context, 'failure');
    active.client.fire(requested(active.session.id, active.turnId, 'bash-fail', 'fail-event-1', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => context.approvals.getPending('bash-fail', active.session.id) !== undefined);
    active.client.failNextRespond = 1;
    await assert.rejects(
      context.sessions.respondApproval(active.session.id, 'bash-fail', 'allow_once', undefined, 'allow'),
      /transport down/,
    );
    assert.equal(active.client.approvalCalls.length, 1);
    assert.ok(context.approvals.getPending('bash-fail', active.session.id));
    assert.equal(inboxItem(context.db, active.session.id, 'bash-fail')?.status, 'pending');
    assert.equal(active.client.approvalCalls.length, 1);
  } finally {
    finish(context);
  }
});

test('auto-approve and a non-user fact stay out of the inbox, including recovery', async () => {
  const context = setup();
  let recovered: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'auto');
    const before = active.client.approvalCalls.length;
    await context.approvals.request({
      sessionId: active.session.id,
      turnId: active.turnId,
      turnNumber: 1,
      category: 'command',
      risk: 'low',
      description: 'npm test',
      title: 'Run tests',
      toolName: 'Bash',
      payload: { approvalId: 'bash-auto' },
    });
    assert.equal(active.client.approvalCalls.length, before + 1);
    assert.equal(context.approvals.getPending('bash-auto', active.session.id), undefined);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-auto'), undefined);

    recordInboxProjection(context.db, {
      sessionId: active.session.id,
      providerEventId: 'auto-fact-1',
      turnId: active.turnId,
      turnNumber: 1,
      origin: 'live',
      method: 'interaction.requested',
      raw: {
        interactionId: 'bash-auto-fact',
        title: 'Run tests',
        description: 'npm test',
      },
      displayType: 'interaction.approval',
      displayData: {
        category: 'command',
        title: 'Run tests',
        description: 'npm test',
        toolName: 'Bash',
      },
      userPending: false,
      userSource: false,
    });
    recovered = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(recovered);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-auto-fact'), undefined);
    assert.equal(projectionFact(context.db, 'auto-fact-1')?.user_pending, 0);
    assert.equal(projectionFact(context.db, 'auto-fact-1')?.applied, 1);
    assert.equal(active.client.approvalCalls.length, before + 1);

    active.client.fire(requested(active.session.id, active.turnId, 'bash-user', 'user-event-1', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-user')?.status === 'pending');
    assert.equal(projectionFact(context.db, 'user-event-1')?.user_pending, 1);
    assert.equal(projectionFact(context.db, 'user-event-1')?.turn_id, active.turnId);
    assert.equal(active.client.approvalCalls.length, before + 1);
  } finally {
    recovered?.dispose();
    finish(context);
  }
});

test('replay and a joined repeat do not raise generation or reset notification state', async () => {
  const context = setup();
  try {
    const active = await boot(context, 'replay');
    const first = requested(active.session.id, active.turnId, 'bash-replay', 'replay-event-1', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    });
    active.client.fire(first);
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-replay') !== undefined);
    active.client.fire(first);
    assert.equal(requestRows(context.db, active.session.id, 'bash-replay'), 1);
    assert.equal(context.adapter.notice(active.session.id, 'bash-replay')?.joinCount, 0);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-replay')?.generation, 1);

    active.client.fire(requested(active.session.id, active.turnId, 'bash-replay', 'replay-event-2', 2, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    assert.equal(requestRows(context.db, active.session.id, 'bash-replay'), 2);
    const notice = context.adapter.notice(active.session.id, 'bash-replay');
    assert.equal(notice?.delivery, 'fresh');
    assert.equal(notice?.generation, 1);
    assert.equal(notice?.joinCount, 1);
    assert.equal(sessionInboxMayNotify(notice), true);
    const row = inboxItem(context.db, active.session.id, 'bash-replay');
    assert.equal(row?.generation, 1);
    assert.equal(row?.status, 'pending');
    assert.equal(row?.notified_generation, null);
    assert.equal(row?.read_at, null);
    assert.equal(storedInbox(context.db).filter(item => {
      const display = JSON.parse(item.display_json) as { interaction_id?: string };
      return display.interaction_id === 'bash-replay';
    }).length, 1);
    assert.equal(projectionFact(context.db, 'replay-event-1')?.generation, 1);
    assert.equal(projectionFact(context.db, 'replay-event-2')?.generation, 1);
    assert.equal(projectionFact(context.db, 'replay-event-2')?.occurrence_event_id, 'replay-event-1');

    const restarted = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(restarted);
    active.client.fire(first);
    active.client.fire(requested(active.session.id, active.turnId, 'bash-replay', 'replay-event-2', 2, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    assert.equal(inboxItem(context.db, active.session.id, 'bash-replay')?.generation, 1);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-replay')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'bash-replay')?.read_at, null);
    assert.equal(sessionInboxMayNotify(restarted.notice(active.session.id, 'bash-replay')), false);
    assert.equal(active.client.approvalCalls.length, 0);
    restarted.dispose();
  } finally {
    finish(context);
  }
});

test('proxy exit closes that occurrence unread and a restart does not reopen it', async () => {
  const context = setup();
  let restarted: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'unknown');
    active.client.fire(requested(active.session.id, active.turnId, 'bash-unknown', 'unknown-event-1', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-unknown')?.status === 'pending');
    active.client.fireExit(1);
    await waitFor(() => context.approvals.getPending('bash-unknown', active.session.id) === undefined);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-unknown')?.status, 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'bash-unknown')?.read_at, null);
    assert.equal(hostTerminalClose(context.db, active.session.id, active.turnId, 'bash-unknown')?.outcome, 'runtime_ended');
    assert.equal(hostTerminalClose(context.db, active.session.id, active.turnId, 'bash-unknown')?.user_source, 0);
    assert.equal(hostTerminalClose(context.db, active.session.id, active.turnId, 'bash-unknown')?.applied, 1);
    assert.equal(active.client.approvalCalls.length, 0);
    assert.ok(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(active.session.id));

    const restartedApprovals = new ApprovalManager(context.broadcaster as unknown as WsBroadcaster);
    restarted = new SessionInboxAdapter(context.db, context.inbox);
    const restartedSessions = new SessionManager(
      context.db,
      context.proxy as unknown as ProxyManager,
      context.broadcaster as unknown as WsBroadcaster,
      restartedApprovals,
      new QueueManager(context.db),
      context.dir,
      null,
    );
    restartedSessions.setSessionInbox(restarted);
    assert.equal(restarted.notice(active.session.id, 'bash-unknown'), undefined);
    assert.equal(sessionInboxMayNotify(restarted.notice(active.session.id, 'bash-unknown')), false);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-unknown')?.status, 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'bash-unknown')?.read_at, null);
    assert.equal(restartedApprovals.listPending().length, 0);
    assert.equal(active.client.approvalCalls.length, 0);
    assert.ok(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(active.session.id));
  } finally {
    restarted?.dispose();
    finish(context);
  }
});

test('local-only clearance closes that inbox row and session delete expires it', async () => {
  const context = setup();
  try {
    const active = await boot(context, 'delete');
    active.client.fire(requested(active.session.id, active.turnId, 'bash-delete', 'delete-event-1', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-delete')?.status === 'pending');
    const other = await context.sessions.createSession({
      workspace_id: context.workspaceId,
      executor: 'claude' as Executor,
      approval_mode: 'ask',
      name: 'local',
    });
    void context.approvals.request({
      sessionId: other.id,
      turnId: 'local-turn',
      turnNumber: 2,
      category: 'browser_capture',
      risk: 'high',
      description: 'Capture the tab',
      payload: { localOnly: true, approvalId: 'local-browser' },
    });
    await waitFor(() => inboxItem(context.db, other.id, 'local-browser')?.status === 'pending');
    assert.equal(inboxItem(context.db, other.id, 'local-browser')?.generation, 1);
    assert.equal(JSON.parse(inboxItem(context.db, other.id, 'local-browser')?.display_json ?? '{}').category, 'browser');
    context.approvals.clearSession(other.id);
    const local = inboxItem(context.db, other.id, 'local-browser');
    assert.equal(local?.status, 'cancelled');
    assert.equal(local?.read_at, null);
    assert.equal(local?.notified_generation, null);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-delete')?.status, 'pending');

    await context.sessions.deleteSession(active.session.id);
    const expired = inboxItem(context.db, active.session.id, 'bash-delete');
    assert.equal(expired?.status, 'expired');
    assert.equal(expired?.read_at, null);
    assert.equal(JSON.parse(expired?.target_json ?? '{}').type, 'unavailable');
    assert.equal(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(active.session.id), undefined);
    assert.equal(inboxItem(context.db, other.id, 'local-browser')?.status, 'cancelled');
  } finally {
    finish(context);
  }
});

test('an inbox storage failure does not change or repeat the provider result', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  const adapter = new SessionInboxAdapter(context.db, flaky);
  context.sessions.setSessionInbox(adapter);
  try {
    const active = await boot(context, 'compensate');
    flaky.failUpserts = 1;
    active.client.fire(requested(active.session.id, active.turnId, 'bash-store', 'store-event-1', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => context.approvals.getPending('bash-store', active.session.id) !== undefined);
    assert.equal(flaky.upsertCalls, 1);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-store'), undefined);
    assert.equal(active.client.approvalCalls.length, 0);
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-store')?.status === 'pending');
    assert.equal(active.client.approvalCalls.length, 0);

    // The live record and the persisted resolved event each try once before the delay.
    flaky.failCloses = 2;
    await context.sessions.respondApproval(active.session.id, 'bash-store', 'decline', undefined, 'deny');
    active.client.fire(resolved(active.session.id, active.turnId, 'bash-store', 'store-resolved-1', 2, 'submitted', 'deny'));
    await waitFor(() => context.approvals.getPending('bash-store', active.session.id) === undefined);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-store')?.status, 'pending');
    assert.equal(active.client.approvalCalls.length, 1);
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-store')?.status === 'rejected');
    assert.equal(active.client.approvalCalls.length, 1);
  } finally {
    adapter.dispose();
    finish(context);
  }
});

test('a stored inbox row closes from a resolved event after the pending map is gone', async () => {
  const context = setup();
  let current = context.adapter;
  try {
    const active = await boot(context, 'restart-close');
    active.client.fire(requested(active.session.id, active.turnId, 'bash-restart', 'restart-event-1', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-restart')?.status === 'pending');
    current = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(current);
    context.approvals.clearSession(active.session.id);
    assert.equal(context.approvals.listPending().length, 0);
    assert.equal(current.notice(active.session.id, 'bash-restart'), undefined);
    assert.equal(sessionInboxMayNotify(current.notice(active.session.id, 'bash-restart')), false);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-restart')?.status, 'pending');
    active.client.fire(resolved(active.session.id, active.turnId, 'bash-restart', 'restart-resolved-1', 2, 'submitted', 'allow'));
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-restart')?.status === 'resolved');
    const closed = inboxItem(context.db, active.session.id, 'bash-restart');
    assert.equal(closed?.generation, 1);
    assert.equal(closed?.tombstone, 0);
    assert.equal(closed?.title, 'Run tests');
    assert.equal(closed?.read_at, null);
    assert.equal(active.client.approvalCalls.length, 0);

    active.client.fire(completed(active.session.id, active.turnId, 'restart-turn-done', 3));
    await context.sessions.sendMessage(active.session.id, 'next occurrence');
    const secondTurnId = active.client.startTurnCalls.at(-1)?.turnId;
    assert.ok(secondTurnId);
    assert.notEqual(secondTurnId, active.turnId);
    active.client.fire(requested(active.session.id, secondTurnId, 'bash-restart', 'restart-event-2', 4, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-restart')?.generation === 2);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-restart')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'bash-restart')?.read_at, null);
    assert.equal(projectionFact(context.db, 'restart-event-2')?.turn_id, secondTurnId);
    assert.equal(projectionFact(context.db, 'restart-event-2')?.generation, 2);

    active.client.fire(resolved(active.session.id, active.turnId, 'bash-restart', 'restart-late-close', 5, 'submitted', 'allow'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(inboxItem(context.db, active.session.id, 'bash-restart')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'bash-restart')?.generation, 2);
    assert.equal(projectionFact(context.db, 'restart-late-close'), undefined);

    await context.sessions.respondApproval(active.session.id, 'bash-restart', 'decline', undefined, 'deny');
    active.client.fire(resolved(active.session.id, secondTurnId, 'bash-restart', 'restart-close-2', 6, 'submitted', 'deny'));
    await waitFor(() => inboxItem(context.db, active.session.id, 'bash-restart')?.status === 'rejected');
    const matched = inboxItem(context.db, active.session.id, 'bash-restart');
    assert.equal(matched?.generation, 2);
    assert.equal(matched?.tombstone, 0);
    assert.equal(matched?.title, 'Run tests');
    assert.ok(matched?.read_at);
    assert.equal(projectionFact(context.db, 'restart-close-2')?.turn_id, secondTurnId);
    assert.equal(projectionFact(context.db, 'restart-close-2')?.generation, 2);
    assert.equal(active.client.approvalCalls.length, 1);
  } finally {
    current.dispose();
    finish(context);
  }
});

test('a failed inbox open is cancelled when the session is deleted before retry', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  const adapter = new SessionInboxAdapter(context.db, flaky);
  context.sessions.setSessionInbox(adapter);
  try {
    const active = await boot(context, 'expire-open');
    flaky.failUpserts = 1;
    active.client.fire(requested(active.session.id, active.turnId, 'bash-expire', 'expire-event-1', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => context.approvals.getPending('bash-expire', active.session.id) !== undefined);
    assert.equal(flaky.upsertCalls, 1);
    assert.equal(inboxItem(context.db, active.session.id, 'bash-expire'), undefined);
    await context.sessions.deleteSession(active.session.id);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(inboxItem(context.db, active.session.id, 'bash-expire'), undefined);
    assert.equal(flaky.upsertCalls, 1);
    assert.equal(active.client.approvalCalls.length, 0);
    assert.equal(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(active.session.id), undefined);
  } finally {
    adapter.dispose();
    finish(context);
  }
});

function completed(
  sessionId: string,
  turnId: string,
  eventId: string,
  sequence: number,
): ProxyNotification {
  return liveNotification({
    method: 'turn.completed',
    params: {
      eventId,
      sequence,
      sessionId,
      turnId,
      emittedAt: '2026-08-18T00:00:03.000Z',
      data: { stopReason: 'completed' },
    },
  });
}

test('a new host turn is the next occurrence and a late old resolved does not close it', async () => {
  const context = setup();
  try {
    const active = await boot(context, 'occurrence');
    const permission = {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    };
    active.client.fire(requested(active.session.id, active.turnId, 'occ-1', 'occ-open-1', 1, permission));
    await waitFor(() => inboxItem(context.db, active.session.id, 'occ-1')?.status === 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.generation, 1);
    assert.equal(sessionInboxMayNotify(context.adapter.notice(active.session.id, 'occ-1')), true);

    await context.sessions.respondApproval(active.session.id, 'occ-1', 'decline', undefined, 'deny');
    active.client.fire(resolved(active.session.id, active.turnId, 'occ-1', 'occ-close-1', 2, 'submitted', 'deny'));
    await waitFor(() => inboxItem(context.db, active.session.id, 'occ-1')?.status === 'rejected');
    assert.ok(inboxItem(context.db, active.session.id, 'occ-1')?.read_at);
    assert.equal(projectionFact(context.db, 'occ-close-1')?.generation, 1);
    assert.equal(projectionFact(context.db, 'occ-close-1')?.user_pending, 0);

    active.client.fire(requested(active.session.id, active.turnId, 'occ-1', 'occ-open-2', 3, permission));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.status, 'rejected');
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.generation, 1);
    assert.equal(context.approvals.getPending('occ-1', active.session.id), undefined);
    assert.equal(projectionFact(context.db, 'occ-open-2')?.generation, 1);
    assert.equal(projectionFact(context.db, 'occ-open-2')?.occurrence_event_id, 'occ-open-1');
    assert.equal(projectionFact(context.db, 'occ-open-2')?.applied, 1);

    active.client.fire(completed(active.session.id, active.turnId, 'occ-turn-done', 4));
    await context.sessions.sendMessage(active.session.id, 'second occurrence');
    const secondTurnId = active.client.startTurnCalls.at(-1)?.turnId;
    assert.ok(secondTurnId);
    assert.notEqual(secondTurnId, active.turnId);
    active.client.fire(requested(active.session.id, secondTurnId, 'occ-1', 'occ-open-3', 5, permission));
    await waitFor(() => inboxItem(context.db, active.session.id, 'occ-1')?.generation === 2);
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.read_at, null);
    assert.ok(context.approvals.getPending('occ-1', active.session.id));
    assert.equal(projectionFact(context.db, 'occ-open-3')?.turn_id, secondTurnId);
    assert.equal(projectionFact(context.db, 'occ-open-3')?.occurrence_event_id, 'occ-open-3');

    context.db.prepare(
      `UPDATE inbox_projection_facts
          SET applied = 0
        WHERE session_id = ?
          AND provider_event_id = 'occ-open-1'
          AND direction = 'open'
          AND provider_event_id = occurrence_event_id`,
    ).run(active.session.id);
    context.adapter.retryDeferred();
    assert.equal(projectionFact(context.db, 'occ-open-1')?.applied, 1);
    assert.equal(projectionFact(context.db, 'occ-close-1')?.applied, 1);
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.generation, 2);
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.read_at, null);
    assert.ok(context.approvals.getPending('occ-1', active.session.id));
    assert.equal(projectionFact(context.db, 'occ-open-3')?.applied, 1);

    const calls = active.client.approvalCalls.length;
    active.client.fire(resolved(active.session.id, active.turnId, 'occ-1', 'occ-late-close', 6, 'submitted', 'allow'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.generation, 2);
    assert.equal(projectionFact(context.db, 'occ-late-close'), undefined);
    assert.equal(active.client.approvalCalls.length, calls);

    await context.sessions.respondApproval(active.session.id, 'occ-1', 'decline', undefined, 'deny');
    active.client.fire(resolved(active.session.id, secondTurnId, 'occ-1', 'occ-close-2', 7, 'submitted', 'deny'));
    await waitFor(() => inboxItem(context.db, active.session.id, 'occ-1')?.status === 'rejected');
    assert.equal(inboxItem(context.db, active.session.id, 'occ-1')?.generation, 2);
    assert.ok(inboxItem(context.db, active.session.id, 'occ-1')?.read_at);
    assert.equal(projectionFact(context.db, 'occ-close-2')?.turn_id, secondTurnId);
    assert.equal(projectionFact(context.db, 'occ-close-2')?.generation, 2);
  } finally {
    finish(context);
  }
});

test('native expired and cancelled stay unread, and a user decline is read', async () => {
  const context = setup();
  try {
    const active = await boot(context, 'outcome');
    const permission = {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    };
    active.client.fire(requested(active.session.id, active.turnId, 'exp-1', 'exp-open', 1, permission));
    await waitFor(() => inboxItem(context.db, active.session.id, 'exp-1')?.status === 'pending');
    active.client.fire(resolved(active.session.id, active.turnId, 'exp-1', 'exp-close', 2, 'expired'));
    await waitFor(() => inboxItem(context.db, active.session.id, 'exp-1')?.status === 'expired');
    assert.equal(inboxItem(context.db, active.session.id, 'exp-1')?.read_at, null);
    assert.equal(projectionFact(context.db, 'exp-close')?.user_pending, 0);
    assert.equal(active.client.approvalCalls.length, 0);

    for (const [outcome, eventId] of [
      ['cancelled', 'cancel-close'],
      ['turn_ended', 'turn-end-close'],
      ['runtime_ended', 'runtime-end-close'],
    ] as const) {
      const interactionId = `end-${outcome}`;
      active.client.fire(requested(active.session.id, active.turnId, interactionId, `${eventId}-open`, 3, permission));
      await waitFor(() => inboxItem(context.db, active.session.id, interactionId)?.status === 'pending');
      active.client.fire(resolved(active.session.id, active.turnId, interactionId, eventId, 4, outcome));
      await waitFor(() => inboxItem(context.db, active.session.id, interactionId)?.status === 'cancelled');
      assert.equal(inboxItem(context.db, active.session.id, interactionId)?.read_at, null);
    }
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    finish(context);
  }
});

test('a busy delete keeps the living session and a committed purge failure still expires it', async () => {
  const context = setup();
  let release = (): void => {};
  try {
    const active = await boot(context, 'delete-commit');
    active.client.fire(requested(active.session.id, active.turnId, 'del-1', 'del-open', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => inboxItem(context.db, active.session.id, 'del-1')?.status === 'pending');
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    active.client.closeGate = gate;
    const pendingDelete = context.sessions.deleteSession(active.session.id);
    let busy = false;
    for (let attempt = 0; attempt < 50 && !busy; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      try {
        await context.sessions.deleteSession(active.session.id);
        release();
        throw new Error('second delete committed while the first was still running');
      } catch (error) {
        if (error instanceof Error && /already in progress/.test(error.message)) {
          busy = true;
          break;
        }
        release();
        throw error;
      }
    }
    assert.equal(busy, true);
    assert.ok(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(active.session.id));
    assert.equal(inboxItem(context.db, active.session.id, 'del-1')?.status, 'pending');
    release();
    await pendingDelete;
    assert.equal(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(active.session.id), undefined);
    assert.equal(inboxItem(context.db, active.session.id, 'del-1')?.status, 'expired');

    const kept = await boot(context, 'purge-fail');
    kept.client.fire(requested(kept.session.id, kept.turnId, 'purge-1', 'purge-open', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => inboxItem(context.db, kept.session.id, 'purge-1')?.status === 'pending');
    context.sessions.setSessionAttachmentPurge(async () => {
      throw new Error('purge failed');
    });
    await assert.rejects(context.sessions.deleteSession(kept.session.id), /purge failed/);
    assert.equal(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(kept.session.id), undefined);
    assert.equal(inboxItem(context.db, kept.session.id, 'purge-1')?.status, 'expired');
  } finally {
    release();
    finish(context);
  }
});

test('replacing the session inbox disposes its retry timer', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  const adapter = new SessionInboxAdapter(context.db, flaky);
  context.sessions.setSessionInbox(adapter);
  try {
    const active = await boot(context, 'dispose-retry');
    flaky.failUpserts = 5;
    active.client.fire(requested(active.session.id, active.turnId, 'retry-1', 'retry-open', 1, {
      title: 'Run tests',
      description: 'npm test',
      presentation: { kind: 'permission', tone: 'danger' },
      actions: ACTIONS,
      context: { subject: { toolName: 'Bash' }, ...KINDS },
    }));
    await waitFor(() => flaky.upsertCalls === 1);
    assert.equal(inboxItem(context.db, active.session.id, 'retry-1'), undefined);
    context.sessions.setSessionInbox(null);
    assert.equal(adapter.isDisposed(), true);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(flaky.upsertCalls, 1);
    assert.equal(active.client.approvalCalls.length, 0);
    const recovered = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(recovered);
    await waitFor(() => inboxItem(context.db, active.session.id, 'retry-1')?.status === 'pending');
    assert.equal(active.client.approvalCalls.length, 0);
    recovered.dispose();
  } finally {
    adapter.dispose();
    finish(context);
  }
});

function pendingInboxChanges(messages: ServerToClientMessage[], interactionId: string): number {
  return messages.filter((message) => {
    if (message.type !== 'inbox:changed') return false;
    const display = message.item.display;
    return message.item.status === 'pending'
      && 'interaction_id' in display
      && display.interaction_id === interactionId;
  }).length;
}

const PERMISSION = {
  title: 'Run tests',
  description: 'npm test',
  presentation: { kind: 'permission', tone: 'danger' },
  actions: ACTIONS,
  context: { subject: { toolName: 'Bash' }, ...KINDS },
};

test('migration 085 loads through openDatabase and does not index rowid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-inbox-085-'));
  const db = openDatabase(dir);
  try {
    const migration = db.prepare(
      'SELECT filename FROM migrations WHERE filename = ?',
    ).get('085_inbox_projection.sql');
    assert.ok(migration);
    const index = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).get('inbox_projection_facts_unapplied') as { sql: string } | undefined;
    assert.ok(index?.sql);
    assert.equal(index.sql.includes('rowid'), false);
    assert.match(index.sql, /\(applied\)/);
    const sessionId = 'sess-index';
    const turnId = 'turn-index';
    const write = (eventId: string, interactionId: string, userPending: boolean) => {
      recordInboxProjection(db, {
        sessionId,
        providerEventId: eventId,
        turnId,
        turnNumber: 1,
        origin: 'live',
        method: 'interaction.requested',
        raw: { interactionId, title: 'Run tests', description: 'npm test' },
        displayType: 'interaction.approval',
        displayData: { category: 'command', title: 'Run tests', description: 'npm test' },
        userPending,
        userSource: false,
      });
    };
    write('event-a', 'id-a', true);
    write('event-b', 'id-b', false);
    write('event-c', 'id-c', true);
    assert.deepEqual(
      listUnappliedInboxProjections(db).map((fact) => fact.providerEventId),
      ['event-a', 'event-c'],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an applied open is expired after the session row disappears, and a living session is kept', async () => {
  const context = setup();
  let recovered: SessionInboxAdapter | undefined;
  try {
    const doomed = await boot(context, 'doomed');
    const living = await boot(context, 'living');
    doomed.client.fire(requested(doomed.session.id, doomed.turnId, 'gone-1', 'gone-open', 1, PERMISSION));
    living.client.fire(requested(living.session.id, living.turnId, 'stay-1', 'stay-open', 1, PERMISSION));
    await waitFor(() => (
      inboxItem(context.db, doomed.session.id, 'gone-1')?.status === 'pending'
      && inboxItem(context.db, living.session.id, 'stay-1')?.status === 'pending'
    ));
    assert.equal(projectionFact(context.db, 'gone-open')?.applied, 1);
    context.db.prepare('DELETE FROM sessions WHERE id = ?').run(doomed.session.id);
    assert.equal(inboxItem(context.db, doomed.session.id, 'gone-1')?.status, 'pending');
    recovered = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(recovered);
    await waitFor(() => inboxItem(context.db, doomed.session.id, 'gone-1')?.status === 'expired');
    assert.equal(JSON.parse(inboxItem(context.db, doomed.session.id, 'gone-1')?.target_json ?? '{}').type, 'unavailable');
    assert.equal(inboxItem(context.db, living.session.id, 'stay-1')?.status, 'pending');
    const again = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(again);
    assert.equal(inboxItem(context.db, doomed.session.id, 'gone-1')?.status, 'expired');
    assert.equal(JSON.parse(inboxItem(context.db, doomed.session.id, 'gone-1')?.target_json ?? '{}').type, 'unavailable');
    assert.equal(inboxItem(context.db, living.session.id, 'stay-1')?.status, 'pending');
    assert.equal(inboxItem(context.db, living.session.id, 'stay-1')?.read_at, null);
    again.dispose();
  } finally {
    recovered?.dispose();
    finish(context);
  }
});

test('a close already stored for the occurrence does not project a pending open', async () => {
  const context = setup();
  try {
    const active = await boot(context, 'close-first');
    const seen = context.broadcaster.messages.length;
    active.client.fire(resolved(active.session.id, active.turnId, 'early-1', 'early-close', 1, 'cancelled'));
    active.client.fire(requested(active.session.id, active.turnId, 'early-1', 'early-open', 2, PERMISSION));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(inboxItem(context.db, active.session.id, 'early-1'), undefined);
    assert.equal(pendingInboxChanges(context.broadcaster.messages.slice(seen), 'early-1'), 0);
    assert.equal(sessionInboxMayNotify(context.adapter.notice(active.session.id, 'early-1')), false);
    assert.equal(projectionFact(context.db, 'early-open')?.applied, 1);
    assert.equal(projectionFact(context.db, 'early-close')?.bound, 1);
    assert.equal(projectionFact(context.db, 'early-close')?.applied, 1);
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    finish(context);
  }
});

test('a failed open followed by a close does not become pending on restart', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  const adapter = new SessionInboxAdapter(context.db, flaky);
  context.sessions.setSessionInbox(adapter);
  let recovered: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'open-then-close');
    flaky.failUpserts = 5;
    active.client.fire(requested(active.session.id, active.turnId, 'fence-1', 'fence-open', 1, PERMISSION));
    await waitFor(() => flaky.upsertCalls === 1);
    assert.equal(inboxItem(context.db, active.session.id, 'fence-1'), undefined);
    assert.equal(projectionFact(context.db, 'fence-open')?.applied, 0);
    context.sessions.setSessionInbox(null);
    active.client.fire(resolved(active.session.id, active.turnId, 'fence-1', 'fence-close', 2, 'cancelled'));
    assert.equal(projectionFact(context.db, 'fence-close')?.applied, 0);
    assert.equal(projectionFact(context.db, 'fence-close')?.bound, 1);
    const seen = context.broadcaster.messages.length;
    recovered = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(recovered);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(inboxItem(context.db, active.session.id, 'fence-1'), undefined);
    assert.equal(pendingInboxChanges(context.broadcaster.messages.slice(seen), 'fence-1'), 0);
    assert.equal(sessionInboxMayNotify(recovered.notice(active.session.id, 'fence-1')), false);
    assert.equal(projectionFact(context.db, 'fence-open')?.applied, 1);
    assert.equal(projectionFact(context.db, 'fence-close')?.applied, 1);
    assert.equal(active.client.approvalCalls.length, 0);
    const repeated = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(repeated);
    assert.equal(inboxItem(context.db, active.session.id, 'fence-1'), undefined);
    repeated.dispose();
  } finally {
    recovered?.dispose();
    adapter.dispose();
    finish(context);
  }
});

test('a failed terminal write stays recoverable and does not broadcast a new pending open', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  const adapter = new SessionInboxAdapter(context.db, flaky);
  context.sessions.setSessionInbox(adapter);
  let recovered: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'close-retry');
    active.client.fire(requested(active.session.id, active.turnId, 'term-1', 'term-open', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'term-1')?.status === 'pending');
    flaky.failCloses = 5;
    active.client.fire(resolved(active.session.id, active.turnId, 'term-1', 'term-close', 2, 'cancelled'));
    await waitFor(() => flaky.closeCalls === 1);
    assert.equal(inboxItem(context.db, active.session.id, 'term-1')?.status, 'pending');
    assert.equal(projectionFact(context.db, 'term-close')?.applied, 0);
    assert.equal(projectionFact(context.db, 'term-open')?.applied, 1);
    context.sessions.setSessionInbox(null);
    const seen = context.broadcaster.messages.length;
    recovered = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(recovered);
    await waitFor(() => inboxItem(context.db, active.session.id, 'term-1')?.status === 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'term-1')?.read_at, null);
    assert.equal(pendingInboxChanges(context.broadcaster.messages.slice(seen), 'term-1'), 0);
    assert.equal(sessionInboxMayNotify(recovered.notice(active.session.id, 'term-1')), false);
    assert.equal(projectionFact(context.db, 'term-close')?.applied, 1);
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    recovered?.dispose();
    adapter.dispose();
    finish(context);
  }
});

test('provider interaction ids keep slash, space, non-ascii, and long values', async () => {
  const context = setup();
  try {
    const slash = 'perm/path#1';
    const spaced = 'ask user 名称';
    const longId = `perm/${'p'.repeat(180)}/tail`;
    assert.ok(longId.length > 128);
    const first = await boot(context, 'ids-a');
    const second = await boot(context, 'ids-b');
    first.client.fire(requested(first.session.id, first.turnId, slash, 'id-slash-a', 1, PERMISSION));
    first.client.fire(requested(first.session.id, first.turnId, spaced, 'id-space-a', 2, PERMISSION));
    first.client.fire(requested(first.session.id, first.turnId, longId, 'id-long-a', 3, PERMISSION));
    second.client.fire(requested(second.session.id, second.turnId, slash, 'id-slash-b', 1, PERMISSION));
    await waitFor(() => (
      inboxItem(context.db, first.session.id, slash)?.status === 'pending'
      && inboxItem(context.db, first.session.id, spaced)?.status === 'pending'
      && inboxItem(context.db, first.session.id, longId)?.status === 'pending'
      && inboxItem(context.db, second.session.id, slash)?.status === 'pending'
    ));
    assert.notEqual(
      inboxItem(context.db, first.session.id, slash)?.target_json,
      inboxItem(context.db, second.session.id, slash)?.target_json,
    );
    assert.equal(JSON.parse(inboxItem(context.db, first.session.id, slash)?.display_json ?? '{}').interaction_id, slash);
    assert.equal(JSON.parse(inboxItem(context.db, first.session.id, spaced)?.display_json ?? '{}').interaction_id, spaced);
    assert.equal(JSON.parse(inboxItem(context.db, first.session.id, longId)?.display_json ?? '{}').interaction_id, longId);

    await context.sessions.respondApproval(first.session.id, slash, 'decline', undefined, 'deny');
    first.client.fire(resolved(first.session.id, first.turnId, slash, 'id-slash-closed', 4, 'submitted', 'deny'));
    await waitFor(() => inboxItem(context.db, first.session.id, slash)?.status === 'rejected');
    assert.ok(inboxItem(context.db, first.session.id, slash)?.read_at);
    assert.equal(inboxItem(context.db, first.session.id, spaced)?.status, 'pending');
    assert.equal(inboxItem(context.db, first.session.id, longId)?.status, 'pending');
    assert.equal(inboxItem(context.db, second.session.id, slash)?.status, 'pending');
    assert.equal(first.client.approvalCalls.length, 1);
    assert.equal(first.client.approvalCalls[0]?.interactionId, slash);
    assert.equal(second.client.approvalCalls.length, 0);
  } finally {
    finish(context);
  }
});

test('a failed facts read schedules a retry and projects without a new provider event', async () => {
  const context = setup();
  const fault = new ReadFaultDb(context.db);
  const adapter = new SessionInboxAdapter(fault as unknown as Db, context.inbox);
  context.sessions.setSessionInbox(adapter);
  try {
    const active = await boot(context, 'facts-read');
    fault.failFactReads = 1;
    active.client.fire(requested(active.session.id, active.turnId, 'facts-1', 'facts-open', 1, PERMISSION));
    assert.equal(fault.failFactReads, 0);
    assert.equal(inboxItem(context.db, active.session.id, 'facts-1'), undefined);
    assert.equal(projectionFact(context.db, 'facts-open')?.applied, 0);
    assert.equal(adapter.retryScheduled(), true);
    assert.equal(requestRows(context.db, active.session.id, 'facts-1'), 1);
    adapter.retryDeferred();
    assert.equal(inboxItem(context.db, active.session.id, 'facts-1')?.status, 'pending');
    assert.equal(projectionFact(context.db, 'facts-open')?.applied, 1);
    assert.equal(adapter.notice(active.session.id, 'facts-1')?.delivery, 'fresh');
    assert.equal(adapter.retryScheduled(), false);
    assert.equal(requestRows(context.db, active.session.id, 'facts-1'), 1);
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    adapter.dispose();
    finish(context);
  }
});

test('a failed fresh-identity read stays non-fresh and retries without a new provider event', async () => {
  const context = setup();
  let adapter: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'identity-read');
    active.client.fire(requested(active.session.id, active.turnId, 'ident-1', '1', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'ident-1')?.status === 'pending');
    assert.equal(context.adapter.notice(active.session.id, 'ident-1')?.delivery, 'fresh');
    context.db.prepare(
      'UPDATE inbox_projection_facts SET applied = 0 WHERE provider_event_id = ?',
    ).run('1');
    const fault = new ReadFaultDb(context.db);
    fault.failIdentityReads = 1;
    adapter = new SessionInboxAdapter(fault as unknown as Db, context.inbox);
    context.sessions.setSessionInbox(adapter);
    assert.equal(fault.failIdentityReads, 0);
    assert.equal(projectionFact(context.db, '1')?.applied, 0);
    assert.equal(inboxItem(context.db, active.session.id, 'ident-1')?.status, 'pending');
    assert.equal(adapter.notice(active.session.id, 'ident-1'), undefined);
    assert.equal(sessionInboxMayNotify(adapter.notice(active.session.id, 'ident-1')), false);
    assert.equal(adapter.retryScheduled(), true);
    adapter.retryDeferred();
    assert.equal(adapter.notice(active.session.id, 'ident-1')?.delivery, 'replay');
    assert.equal(sessionInboxMayNotify(adapter.notice(active.session.id, 'ident-1')), false);
    assert.equal(projectionFact(context.db, '1')?.applied, 1);
    assert.equal(inboxItem(context.db, active.session.id, 'ident-1')?.status, 'pending');
    assert.equal(adapter.retryScheduled(), false);
    assert.equal(requestRows(context.db, active.session.id, 'ident-1'), 1);
  } finally {
    adapter?.dispose();
    finish(context);
  }
});

test('a failed orphan select schedules a retry and expires only the missing session', async () => {
  const context = setup();
  let adapter: SessionInboxAdapter | undefined;
  try {
    const doomed = await boot(context, 'orphan-select-doomed');
    const living = await boot(context, 'orphan-select-living');
    doomed.client.fire(requested(doomed.session.id, doomed.turnId, 'sel-gone', 'sel-gone-open', 1, PERMISSION));
    living.client.fire(requested(living.session.id, living.turnId, 'sel-stay', 'sel-stay-open', 1, PERMISSION));
    await waitFor(() => (
      inboxItem(context.db, doomed.session.id, 'sel-gone')?.status === 'pending'
      && inboxItem(context.db, living.session.id, 'sel-stay')?.status === 'pending'
    ));
    assert.equal(projectionFact(context.db, 'sel-gone-open')?.applied, 1);
    context.db.prepare('DELETE FROM sessions WHERE id = ?').run(doomed.session.id);
    const fault = new ReadFaultDb(context.db);
    fault.failOrphanSelects = 1;
    adapter = new SessionInboxAdapter(fault as unknown as Db, context.inbox);
    context.sessions.setSessionInbox(adapter);
    assert.equal(fault.failOrphanSelects, 0);
    assert.equal(inboxItem(context.db, doomed.session.id, 'sel-gone')?.status, 'pending');
    assert.equal(inboxItem(context.db, living.session.id, 'sel-stay')?.status, 'pending');
    assert.equal(adapter.retryScheduled(), true);
    adapter.retryDeferred();
    assert.equal(inboxItem(context.db, doomed.session.id, 'sel-gone')?.status, 'expired');
    assert.equal(inboxItem(context.db, living.session.id, 'sel-stay')?.status, 'pending');
    assert.equal(adapter.retryScheduled(), false);
    assert.equal(doomed.client.approvalCalls.length, 0);
    assert.equal(living.client.approvalCalls.length, 0);
  } finally {
    adapter?.dispose();
    finish(context);
  }
});

test('a transient orphan expire schedules a retry and expires only the missing session', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  let adapter: SessionInboxAdapter | undefined;
  try {
    const doomed = await boot(context, 'orphan-expire-doomed');
    const living = await boot(context, 'orphan-expire-living');
    doomed.client.fire(requested(doomed.session.id, doomed.turnId, 'exp-gone', 'exp-gone-open', 1, PERMISSION));
    living.client.fire(requested(living.session.id, living.turnId, 'exp-stay', 'exp-stay-open', 1, PERMISSION));
    await waitFor(() => (
      inboxItem(context.db, doomed.session.id, 'exp-gone')?.status === 'pending'
      && inboxItem(context.db, living.session.id, 'exp-stay')?.status === 'pending'
    ));
    assert.equal(projectionFact(context.db, 'exp-gone-open')?.applied, 1);
    context.db.prepare('DELETE FROM sessions WHERE id = ?').run(doomed.session.id);
    flaky.failExpires = 1;
    adapter = new SessionInboxAdapter(context.db, flaky);
    context.sessions.setSessionInbox(adapter);
    assert.equal(flaky.expireCalls, 1);
    assert.equal(flaky.failExpires, 0);
    assert.equal(inboxItem(context.db, doomed.session.id, 'exp-gone')?.status, 'pending');
    assert.equal(inboxItem(context.db, living.session.id, 'exp-stay')?.status, 'pending');
    assert.equal(adapter.retryScheduled(), true);
    adapter.retryDeferred();
    assert.equal(flaky.expireCalls, 2);
    assert.equal(inboxItem(context.db, doomed.session.id, 'exp-gone')?.status, 'expired');
    assert.equal(inboxItem(context.db, living.session.id, 'exp-stay')?.status, 'pending');
    assert.equal(adapter.retryScheduled(), false);
    assert.equal(doomed.client.approvalCalls.length, 0);
  } finally {
    adapter?.dispose();
    finish(context);
  }
});

test('dispose does not schedule or run a projection retry', async () => {
  const context = setup();
  const fault = new ReadFaultDb(context.db);
  const adapter = new SessionInboxAdapter(fault as unknown as Db, context.inbox);
  context.sessions.setSessionInbox(adapter);
  try {
    const active = await boot(context, 'dispose-read');
    fault.failFactReads = 1;
    active.client.fire(requested(active.session.id, active.turnId, 'disp-1', 'disp-open', 1, PERMISSION));
    assert.equal(inboxItem(context.db, active.session.id, 'disp-1'), undefined);
    assert.equal(projectionFact(context.db, 'disp-open')?.applied, 0);
    assert.equal(adapter.retryScheduled(), true);
    fault.failFactReads = 1;
    adapter.dispose();
    assert.equal(adapter.isDisposed(), true);
    assert.equal(adapter.retryScheduled(), false);
    adapter.retryDeferred();
    assert.equal(fault.failFactReads, 1);
    assert.equal(inboxItem(context.db, active.session.id, 'disp-1'), undefined);
    assert.equal(projectionFact(context.db, 'disp-open')?.applied, 0);
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    adapter.dispose();
    finish(context);
  }
});

test('fresh identity is scoped to the session and does not reuse another session event id', async () => {
  const context = setup();
  let restarted: SessionInboxAdapter | undefined;
  try {
    const first = await boot(context, 'scope-a');
    first.client.fire(requested(first.session.id, first.turnId, 'shared-1', '1', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, first.session.id, 'shared-1')?.status === 'pending');
    assert.equal(context.adapter.notice(first.session.id, 'shared-1')?.delivery, 'fresh');
    assert.equal(context.adapter.notice(first.session.id, 'shared-1')?.occurrenceEventId, '1');
    restarted = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(restarted);
    first.client.fire(requested(first.session.id, first.turnId, 'shared-1', '1', 1, PERMISSION));
    assert.equal(sessionInboxMayNotify(restarted.notice(first.session.id, 'shared-1')), false);
    const second = await boot(context, 'scope-b');
    second.client.fire(requested(second.session.id, second.turnId, 'shared-1', '1', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, second.session.id, 'shared-1')?.status === 'pending');
    const replay = restarted.notice(first.session.id, 'shared-1');
    const live = restarted.notice(second.session.id, 'shared-1');
    assert.equal(sessionInboxMayNotify(replay), false);
    assert.equal(live?.delivery, 'fresh');
    assert.equal(live?.occurrenceEventId, '1');
    assert.equal(sessionInboxMayNotify(live), true);
    const rows = context.db.prepare(
      `SELECT session_id, provider_event_id
         FROM inbox_projection_facts
        WHERE provider_event_id = ?
          AND direction = 'open'
          AND provider_event_id = occurrence_event_id`,
    ).all('1') as Array<{ session_id: string; provider_event_id: string }>;
    assert.deepEqual(rows.map((row) => row.provider_event_id), ['1', '1']);
    assert.deepEqual(
      rows.map((row) => row.session_id).sort(),
      [first.session.id, second.session.id].sort(),
    );
    assert.equal(first.client.approvalCalls.length, 0);
    assert.equal(second.client.approvalCalls.length, 0);
  } finally {
    restarted?.dispose();
    finish(context);
  }
});

test('a rejected close stays unapplied and converges on the scheduled retry', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  const adapter = new SessionInboxAdapter(context.db, flaky);
  context.sessions.setSessionInbox(adapter);
  let restarted: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'reject-close');
    active.client.fire(requested(active.session.id, active.turnId, 'once-1', 'once-open', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'once-1')?.status === 'pending');
    flaky.rejectCloses = 1;
    active.client.fire(resolved(active.session.id, active.turnId, 'once-1', 'once-close', 2, 'cancelled'));
    assert.equal(flaky.closeCalls, 1);
    assert.equal(flaky.rejectCloses, 0);
    assert.equal(inboxItem(context.db, active.session.id, 'once-1')?.status, 'pending');
    assert.equal(projectionFact(context.db, 'once-close')?.applied, 0);
    assert.equal(projectionFact(context.db, 'once-open')?.applied, 1);
    assert.equal(adapter.retryScheduled(), true);
    adapter.retryDeferred();
    assert.equal(flaky.closeCalls, 2);
    assert.equal(inboxItem(context.db, active.session.id, 'once-1')?.status, 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'once-1')?.read_at, null);
    assert.equal(projectionFact(context.db, 'once-close')?.applied, 1);
    assert.equal(adapter.retryScheduled(), false);
    adapter.dispose();
    restarted = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(restarted);
    assert.equal(inboxItem(context.db, active.session.id, 'once-1')?.status, 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'once-1')?.read_at, null);
    assert.equal(projectionFact(context.db, 'once-close')?.applied, 1);
    assert.equal(sessionInboxMayNotify(restarted.notice(active.session.id, 'once-1')), false);
    assert.equal(active.client.approvalCalls.length, 0);
    assert.equal(requestRows(context.db, active.session.id, 'once-1'), 1);
  } finally {
    restarted?.dispose();
    adapter.dispose();
    finish(context);
  }
});

test('a rejected close stays recoverable when the adapter restarts', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  const adapter = new SessionInboxAdapter(context.db, flaky);
  context.sessions.setSessionInbox(adapter);
  let restarted: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'reject-restart');
    active.client.fire(requested(active.session.id, active.turnId, 'boot-1', 'boot-open', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'boot-1')?.status === 'pending');
    flaky.rejectCloses = 1;
    active.client.fire(resolved(active.session.id, active.turnId, 'boot-1', 'boot-close', 2, 'cancelled'));
    assert.equal(flaky.closeCalls, 1);
    assert.equal(inboxItem(context.db, active.session.id, 'boot-1')?.status, 'pending');
    assert.equal(projectionFact(context.db, 'boot-close')?.applied, 0);
    assert.equal(projectionFact(context.db, 'boot-open')?.applied, 1);
    assert.equal(adapter.retryScheduled(), true);
    adapter.dispose();
    assert.equal(adapter.retryScheduled(), false);
    adapter.retryDeferred();
    assert.equal(flaky.closeCalls, 1);
    assert.equal(inboxItem(context.db, active.session.id, 'boot-1')?.status, 'pending');
    restarted = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(restarted);
    assert.equal(inboxItem(context.db, active.session.id, 'boot-1')?.status, 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'boot-1')?.read_at, null);
    assert.equal(projectionFact(context.db, 'boot-close')?.applied, 1);
    assert.equal(sessionInboxMayNotify(restarted.notice(active.session.id, 'boot-1')), false);
    assert.equal(active.client.approvalCalls.length, 0);
    assert.equal(requestRows(context.db, active.session.id, 'boot-1'), 1);
  } finally {
    restarted?.dispose();
    adapter.dispose();
    finish(context);
  }
});

test('a completed turn releases that turn and the next same id is a new occurrence', async () => {
  const context = setup();
  try {
    const active = await boot(context, 'turn-ended');
    const otherTurnId = 'other-turn-same-session';
    void context.approvals.request({
      sessionId: active.session.id,
      turnId: 'policy-turn',
      category: 'network',
      risk: 'high',
      description: 'Remember this session',
      payload: { localOnly: true, approvalId: 'policy-card' },
    });
    await context.sessions.respondApproval(active.session.id, 'policy-card', 'allow_session');
    assert.equal(context.approvals.wasAllowedForSession(active.session.id, 'network'), true);
    void context.approvals.request({
      sessionId: active.session.id,
      turnId: otherTurnId,
      turnNumber: 9,
      category: 'browser_capture',
      risk: 'high',
      description: 'Keep this card',
      payload: { localOnly: true, approvalId: 'other-card' },
    });
    await waitFor(() => inboxItem(context.db, active.session.id, 'other-card')?.status === 'pending');
    context.approvals.markResolutionSource('other-card', 'im', active.session.id);

    active.client.fire(requested(active.session.id, active.turnId, 'done-1', 'done-open', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'done-1')?.status === 'pending');
    assert.equal(context.approvals.getPending('done-1', active.session.id)?.turnId, active.turnId);
    context.approvals.markResolutionSource('done-1', 'web', active.session.id);
    const waiter = context.approvals.request({
      sessionId: active.session.id,
      turnId: active.turnId,
      category: 'other',
      risk: 'high',
      description: 'npm test',
      payload: { approvalId: 'done-1' },
      nativeOptions: [{ optionId: 'allow', label: 'Allow once', kind: 'allow_once' }],
    });

    active.client.fire(completed(active.session.id, active.turnId, 'done-turn', 2));
    assert.equal(await waiter, 'decline');
    await waitFor(() => inboxItem(context.db, active.session.id, 'done-1')?.status === 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'done-1')?.read_at, null);
    assert.equal(hostTerminalClose(context.db, active.session.id, active.turnId, 'done-1')?.outcome, 'turn_ended');
    assert.equal(hostTerminalClose(context.db, active.session.id, active.turnId, 'done-1')?.user_source, 0);
    assert.equal(context.approvals.getPending('done-1', active.session.id), undefined);
    assert.equal(context.approvals.peekResolutionSource('done-1', active.session.id), undefined);
    assert.equal(context.approvals.getPending('other-card', active.session.id)?.turnId, otherTurnId);
    assert.equal(context.approvals.peekResolutionSource('other-card', active.session.id), 'im');
    assert.equal(inboxItem(context.db, active.session.id, 'other-card')?.status, 'pending');
    assert.equal(context.approvals.wasAllowedForSession(active.session.id, 'network'), true);
    assert.equal(active.client.approvalCalls.length, 0);
    const declined = context.broadcaster.messages.filter((message): message is Extract<ServerToClientMessage, { type: 'approval:updated' }> => (
      message.type === 'approval:updated' && message.approval.id === 'done-1'
    ));
    assert.equal(declined.length, 1);
    assert.equal(declined[0]?.approval.status, 'declined');
    assert.equal(declined[0]?.approval.resolved_by, 'auto');
    assert.equal(context.broadcaster.messages.some(message => (
      message.type === 'approval:updated' && message.approval.id === 'other-card'
    )), false);

    active.client.fire(completed(active.session.id, active.turnId, 'done-turn-again', 3));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(context.broadcaster.messages.filter(message => (
      message.type === 'approval:updated' && message.approval.id === 'done-1'
    )).length, 1);
    assert.equal(inboxItem(context.db, active.session.id, 'done-1')?.status, 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'done-1')?.read_at, null);
    assert.equal(context.approvals.getPending('other-card', active.session.id)?.turnId, otherTurnId);
    assert.equal(context.approvals.peekResolutionSource('other-card', active.session.id), 'im');
    assert.equal(context.approvals.wasAllowedForSession(active.session.id, 'network'), true);
    assert.equal(active.client.approvalCalls.length, 0);

    await context.sessions.sendMessage(active.session.id, 'next occurrence');
    const secondTurnId = active.client.startTurnCalls.at(-1)?.turnId;
    assert.ok(secondTurnId);
    assert.notEqual(secondTurnId, active.turnId);
    active.client.fire(requested(active.session.id, secondTurnId, 'done-1', 'done-open-2', 4, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'done-1')?.generation === 2);
    assert.equal(inboxItem(context.db, active.session.id, 'done-1')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'done-1')?.read_at, null);
    assert.equal(context.approvals.getPending('done-1', active.session.id)?.turnId, secondTurnId);
    assert.equal(context.approvals.getPending('other-card', active.session.id)?.turnId, otherTurnId);

    await context.sessions.respondApproval(active.session.id, 'done-1', 'decline', undefined, 'deny');
    active.client.fire(resolved(active.session.id, secondTurnId, 'done-1', 'done-close-2', 5, 'submitted', 'deny'));
    await waitFor(() => inboxItem(context.db, active.session.id, 'done-1')?.status === 'rejected');
    assert.equal(inboxItem(context.db, active.session.id, 'done-1')?.generation, 2);
    assert.ok(inboxItem(context.db, active.session.id, 'done-1')?.read_at);
    assert.equal(projectionFact(context.db, 'done-close-2')?.turn_id, secondTurnId);
    assert.equal(projectionFact(context.db, 'done-close-2')?.generation, 2);
    assert.equal(hostTerminalClose(context.db, active.session.id, active.turnId, 'done-1')?.outcome, 'turn_ended');
    assert.equal(hostTerminalClose(context.db, active.session.id, active.turnId, 'done-1')?.user_source, 0);
    assert.equal(active.client.approvalCalls.length, 1);
    assert.equal(active.client.approvalCalls[0]?.interactionId, 'done-1');
    assert.equal(context.approvals.getPending('done-1', active.session.id), undefined);
    assert.equal(context.approvals.getPending('other-card', active.session.id)?.turnId, otherTurnId);
    assert.equal(inboxItem(context.db, active.session.id, 'other-card')?.status, 'pending');
    assert.equal(context.approvals.peekResolutionSource('other-card', active.session.id), 'im');
    assert.equal(context.approvals.wasAllowedForSession(active.session.id, 'network'), true);
  } finally {
    finish(context);
  }
});

test('a later host turn after proxy exit is a new pending occurrence', async () => {
  const context = setup();
  try {
    const active = await boot(context, 'exit-next');
    active.client.fire(requested(active.session.id, active.turnId, 'next-1', 'next-open', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'next-1')?.status === 'pending');
    active.client.fireExit(1);
    await waitFor(() => inboxItem(context.db, active.session.id, 'next-1')?.status === 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'next-1')?.read_at, null);
    assert.equal(hostTerminalClose(context.db, active.session.id, active.turnId, 'next-1')?.outcome, 'runtime_ended');
    assert.equal(active.client.approvalCalls.length, 0);
    await context.sessions.sendMessage(active.session.id, 'next turn');
    const secondTurnId = active.client.startTurnCalls.at(-1)?.turnId;
    assert.ok(secondTurnId);
    assert.notEqual(secondTurnId, active.turnId);
    active.client.fire(requested(active.session.id, secondTurnId, 'next-1', 'next-open-2', 2, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'next-1')?.generation === 2);
    assert.equal(inboxItem(context.db, active.session.id, 'next-1')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'next-1')?.read_at, null);
    assert.equal(context.approvals.getPending('next-1', active.session.id)?.turnId, secondTurnId);
    assert.equal(hostTerminalClose(context.db, active.session.id, secondTurnId, 'next-1'), undefined);
    assert.equal(active.client.approvalCalls.length, 0);
    assert.ok(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(active.session.id));
  } finally {
    finish(context);
  }
});

test('a terminal turn row closes its occurrence and a running turn stays pending', async () => {
  const context = setup();
  let restarted: SessionInboxAdapter | undefined;
  try {
    const ended = await boot(context, 'crash-ended');
    const living = await boot(context, 'crash-living');
    ended.client.fire(requested(ended.session.id, ended.turnId, 'crash-end', 'crash-end-open', 1, PERMISSION));
    living.client.fire(requested(living.session.id, living.turnId, 'crash-stay', 'crash-stay-open', 1, PERMISSION));
    await waitFor(() => (
      inboxItem(context.db, ended.session.id, 'crash-end')?.status === 'pending'
      && inboxItem(context.db, living.session.id, 'crash-stay')?.status === 'pending'
    ));
    context.db.prepare(
      `UPDATE turns SET status = 'error', completed_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), ended.turnId);
    context.sessions.setSessionInbox(null);
    restarted = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(restarted);
    assert.equal(inboxItem(context.db, ended.session.id, 'crash-end')?.status, 'cancelled');
    assert.equal(inboxItem(context.db, ended.session.id, 'crash-end')?.read_at, null);
    assert.equal(hostTerminalClose(context.db, ended.session.id, ended.turnId, 'crash-end')?.outcome, 'runtime_ended');
    assert.equal(hostTerminalClose(context.db, ended.session.id, ended.turnId, 'crash-end')?.user_source, 0);
    assert.equal(hostTerminalClose(context.db, ended.session.id, ended.turnId, 'crash-end')?.applied, 1);
    assert.equal(ended.client.approvalCalls.length, 0);
    assert.ok(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(ended.session.id));
    assert.equal(inboxItem(context.db, living.session.id, 'crash-stay')?.status, 'pending');
    assert.equal(inboxItem(context.db, living.session.id, 'crash-stay')?.read_at, null);
    assert.equal(hostTerminalClose(context.db, living.session.id, living.turnId, 'crash-stay'), undefined);
    assert.equal(context.approvals.getPending('crash-stay', living.session.id)?.turnId, living.turnId);
    assert.equal(sessionInboxMayNotify(restarted.notice(ended.session.id, 'crash-end')), false);
    assert.equal(living.client.approvalCalls.length, 0);
  } finally {
    restarted?.dispose();
    finish(context);
  }
});

test('a successful projection pass restores the deferred retry budget', async () => {
  const context = setup();
  const fault = new ReadFaultDb(context.db);
  const adapter = new SessionInboxAdapter(fault as unknown as Db, context.inbox);
  context.sessions.setSessionInbox(adapter);
  try {
    const active = await boot(context, 'retry-budget');
    fault.failFactReads = 10;
    active.client.fire(requested(active.session.id, active.turnId, 'budget-1', 'budget-open-1', 1, PERMISSION));
    assert.equal(adapter.retryScheduled(), true);
    assert.equal(projectionFact(context.db, 'budget-open-1')?.applied, 0);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(adapter.retryScheduled(), true);
    assert.equal(projectionFact(context.db, 'budget-open-1')?.applied, 0);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    assert.equal(adapter.retryScheduled(), true);
    assert.equal(projectionFact(context.db, 'budget-open-1')?.applied, 0);
    await new Promise(resolve => setTimeout(resolve, 6_000));
    assert.equal(adapter.retryScheduled(), false);
    assert.equal(projectionFact(context.db, 'budget-open-1')?.applied, 0);
    fault.failFactReads = 0;
    adapter.retryDeferred();
    assert.equal(inboxItem(context.db, active.session.id, 'budget-1')?.status, 'pending');
    assert.equal(projectionFact(context.db, 'budget-open-1')?.applied, 1);
    assert.equal(adapter.retryScheduled(), false);
    fault.failFactReads = 1;
    active.client.fire(requested(active.session.id, active.turnId, 'budget-2', 'budget-open-2', 2, PERMISSION));
    assert.equal(adapter.retryScheduled(), true);
    assert.equal(projectionFact(context.db, 'budget-open-2')?.applied, 0);
    assert.equal(inboxItem(context.db, active.session.id, 'budget-1')?.status, 'pending');
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    adapter.dispose();
    finish(context);
  }
});

class SweepSpyDb {
  sweepReads = 0;
  scopedReads = 0;

  constructor(private readonly inner: Db) {}

  prepare(sql: string) {
    const statement = this.inner.prepare(sql);
    const sweep = sql.includes('NOT EXISTS');
    const scoped = sql.includes('f.session_id = @sessionId');
    return {
      all: (...args: unknown[]) => {
        if (sweep) this.sweepReads += 1;
        if (scoped) this.scopedReads += 1;
        return statement.all(...(args as never[]));
      },
      get: (...args: unknown[]) => statement.get(...(args as never[])),
      run: (...args: unknown[]) => statement.run(...(args as never[])),
    };
  }
}

test('migration 086 adds the occurrence lookup index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-inbox-086-'));
  const db = openDatabase(dir);
  try {
    const migration = db.prepare(
      'SELECT filename FROM migrations WHERE filename = ?',
    ).get('086_inbox_projection_occurrence.sql');
    assert.ok(migration);
    const index = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).get('inbox_projection_facts_occurrence') as { sql: string } | undefined;
    assert.ok(index?.sql);
    assert.match(index.sql, /\(session_id, turn_id, interaction_id, direction\)/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh host generation cancels orphaned local pendings; a same-generation swap keeps them', async () => {
  const context = setup();
  let sameGen: SessionInboxAdapter | undefined;
  let freshGen: SessionInboxAdapter | undefined;
  try {
    const writer = new SessionInboxAdapter(context.db, context.inbox, 'proc-a');
    context.sessions.setSessionInbox(writer);
    const active = await boot(context, 'local-ghost');
    void context.approvals.request({
      sessionId: active.session.id,
      turnId: active.turnId,
      turnNumber: 1,
      category: 'browser_capture',
      risk: 'high',
      description: 'Allow this Session to capture Browser tab t1?',
      payload: { localOnly: true, approvalId: 'ghost-1' },
    });
    await waitFor(() => inboxItem(context.db, active.session.id, 'ghost-1')?.status === 'pending');
    // The occurrence is durable and owned by the writing process generation.
    assert.equal(projectionFact(context.db, 'local:proc-a:ghost-1')?.direction, 'open');
    assert.equal(projectionFact(context.db, 'local:proc-a:ghost-1')?.applied, 1);

    // Same-process adapter swap: the live local pending must not be cancelled.
    sameGen = new SessionInboxAdapter(context.db, context.inbox, 'proc-a');
    context.sessions.setSessionInbox(sameGen);
    assert.equal(inboxItem(context.db, active.session.id, 'ghost-1')?.status, 'pending');

    // A recoverable native occurrence on the same running turn is not touched.
    active.client.fire(requested(active.session.id, active.turnId, 'ghost-native', 'ghost-native-open', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'ghost-native')?.status === 'pending');

    // Real crash shape: the DB turn is still running, the session row still
    // exists, and a brand-new Host process starts with an empty ApprovalManager.
    const turnRow = () => context.db.prepare(
      'SELECT status FROM turns WHERE id = ?',
    ).get(active.turnId) as { status: string };
    assert.equal(turnRow().status, 'running');
    freshGen = new SessionInboxAdapter(context.db, context.inbox, 'proc-b');
    context.sessions.setSessionInbox(freshGen);
    assert.equal(inboxItem(context.db, active.session.id, 'ghost-1')?.status, 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'ghost-1')?.read_at, null);
    const close = context.db.prepare(
      `SELECT outcome, user_source, applied
         FROM inbox_projection_facts
        WHERE session_id = ? AND provider_event_id = ?`,
    ).get(active.session.id, 'local:cancelled:ghost-1') as
      { outcome: string; user_source: number; applied: number } | undefined;
    assert.equal(close?.outcome, 'cancelled');
    assert.equal(close?.user_source, 0);
    assert.equal(close?.applied, 1);
    // The turn is not stopped and the local action is never replayed.
    assert.equal(turnRow().status, 'running');
    assert.ok(context.db.prepare('SELECT id FROM sessions WHERE id = ?').get(active.session.id));
    assert.equal(inboxItem(context.db, active.session.id, 'ghost-native')?.status, 'pending');
    assert.equal(active.client.approvalCalls.length, 0);
    writer.dispose();
  } finally {
    sameGen?.dispose();
    freshGen?.dispose();
    finish(context);
  }
});

test('a local approval close that fails to write still converges from its durable fact', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  const adapter = new SessionInboxAdapter(context.db, flaky, 'proc-close');
  context.sessions.setSessionInbox(adapter);
  try {
    const active = await boot(context, 'local-close');
    const waiter = context.approvals.request({
      sessionId: active.session.id,
      turnId: active.turnId,
      turnNumber: 1,
      category: 'browser_capture',
      risk: 'high',
      description: 'Allow this Session to capture Browser tab t2?',
      payload: { localOnly: true, approvalId: 'close-1' },
    });
    await waitFor(() => inboxItem(context.db, active.session.id, 'close-1')?.status === 'pending');
    flaky.failCloses = 1;
    await context.sessions.respondApproval(active.session.id, 'close-1', 'allow_once');
    // The source action succeeded even though the first close write failed.
    assert.equal(await waiter, 'allow_once');
    assert.equal(projectionFact(context.db, 'local:resolved:proc-close:close-1')?.direction, 'close');
    await waitFor(() => inboxItem(context.db, active.session.id, 'close-1')?.status === 'resolved');
    assert.equal(projectionFact(context.db, 'local:resolved:proc-close:close-1')?.applied, 1);
    // A user-handled close keeps the user read marker.
    assert.ok(inboxItem(context.db, active.session.id, 'close-1')?.read_at);
    // Local-only: the provider is never contacted.
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    adapter.dispose();
    finish(context);
  }
});

test('terminal closes scope to the finished turn and the recovery sweep batches only unconverged opens', async () => {
  const context = setup();
  let adapter: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'sweep-scope');
    const now = new Date().toISOString();
    const insertTurn = context.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertFact = context.db.prepare(
      `INSERT INTO inbox_projection_facts (
         session_id, provider_event_id, turn_id, interaction_id, direction,
         occurrence_event_id, generation, bound, origin, projected, outcome,
         decision, action_id, title, description, subject, category, tool_name,
         turn_number, user_pending, user_source, applied
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', 'approval', NULL, NULL, NULL,
                 't', 'd', NULL, 'command', NULL, 1, ?, 0, ?)`,
    );
    // Fixed-scale terminated history: 250 occurrences, each already closed.
    for (let i = 0; i < 250; i += 1) {
      const turnId = randomUUID();
      insertTurn.run(turnId, active.session.id, 1000 + i, 'completed', now, now);
      insertFact.run(active.session.id, `hist-open-${i}`, turnId, `hist-id-${i}`, 'open', `hist-open-${i}`, 1, 1, 1, 1);
      insertFact.run(active.session.id, `hist-close-${i}`, turnId, `hist-id-${i}`, 'close', `hist-open-${i}`, 1, 1, 0, 1);
    }
    // One terminated occurrence that never converged.
    const looseTurn = randomUUID();
    insertTurn.run(looseTurn, active.session.id, 2000, 'error', now, now);
    insertFact.run(active.session.id, 'loose-open', looseTurn, 'loose-id', 'open', 'loose-open', 1, 1, 1, 1);

    const spy = new SweepSpyDb(context.db);
    adapter = new SessionInboxAdapter(spy as unknown as Db, context.inbox);
    context.sessions.setSessionInbox(adapter);
    // Startup: exactly one batched sweep over the unconverged set. The 250
    // closed occurrences are not re-walked into new terminal facts.
    assert.equal(spy.sweepReads, 1);
    const terminalFactCount = () => (context.db.prepare(
      `SELECT COUNT(*) AS n FROM inbox_projection_facts
        WHERE provider_event_id LIKE 'gian:turn-terminal:%'`,
    ).get() as { n: number }).n;
    assert.equal(terminalFactCount(), 1);
    assert.equal(hostTerminalClose(context.db, active.session.id, looseTurn, 'loose-id')?.outcome, 'runtime_ended');
    assert.equal(hostTerminalClose(context.db, active.session.id, looseTurn, 'loose-id')?.applied, 1);

    // Hot path: a finished turn drains by identity; the sweep is not re-run.
    active.client.fire(requested(active.session.id, active.turnId, 'scoped-1', 'scoped-open', 1, PERMISSION));
    await waitFor(() => inboxItem(context.db, active.session.id, 'scoped-1')?.status === 'pending');
    active.client.fire(completed(active.session.id, active.turnId, 'scoped-done', 2));
    await waitFor(() => inboxItem(context.db, active.session.id, 'scoped-1')?.status === 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'scoped-1')?.read_at, null);
    assert.equal(spy.sweepReads, 1);
    assert.ok(spy.scopedReads >= 1);
    assert.equal(terminalFactCount(), 2);
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    adapter?.dispose();
    finish(context);
  }
});

test('over-1024 and NUL provider interaction ids open, close, and stay isolated', async () => {
  const context = setup();
  try {
    const overLong = `perm/${'x'.repeat(1200)}`;
    assert.ok(overLong.length > 1024);
    const nulOne = 'perm\0one';
    const nulTwo = 'perm\0two';
    const active = await boot(context, 'opaque-ids');
    active.client.fire(requested(active.session.id, active.turnId, overLong, 'oid-long', 1, PERMISSION));
    active.client.fire(requested(active.session.id, active.turnId, nulOne, 'oid-nul-1', 2, PERMISSION));
    active.client.fire(requested(active.session.id, active.turnId, nulTwo, 'oid-nul-2', 3, PERMISSION));
    await waitFor(() => (
      inboxItem(context.db, active.session.id, overLong)?.status === 'pending'
      && inboxItem(context.db, active.session.id, nulOne)?.status === 'pending'
      && inboxItem(context.db, active.session.id, nulTwo)?.status === 'pending'
    ));
    assert.equal(JSON.parse(inboxItem(context.db, active.session.id, overLong)?.display_json ?? '{}').interaction_id, overLong);
    assert.equal(JSON.parse(inboxItem(context.db, active.session.id, nulOne)?.display_json ?? '{}').interaction_id, nulOne);

    await context.sessions.respondApproval(active.session.id, nulOne, 'decline', undefined, 'deny');
    active.client.fire(resolved(active.session.id, active.turnId, nulOne, 'oid-nul-close', 4, 'submitted', 'deny'));
    await waitFor(() => inboxItem(context.db, active.session.id, nulOne)?.status === 'rejected');
    assert.ok(inboxItem(context.db, active.session.id, nulOne)?.read_at);
    // Ids that share a prefix up to the NUL stay isolated; the original id
    // reaches the provider unchanged.
    assert.equal(inboxItem(context.db, active.session.id, nulTwo)?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, overLong)?.status, 'pending');
    assert.equal(active.client.approvalCalls.length, 1);
    assert.equal(active.client.approvalCalls[0]?.interactionId, nulOne);

    assert.equal(boundedInteractionId(overLong), overLong);
    assert.equal(boundedInteractionId('a\0b'), 'a\0b');
    assert.equal(boundedInteractionId(''), null);
    assert.equal(boundedInteractionId(undefined), null);
  } finally {
    finish(context);
  }
});

async function waitForSlow(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class FactFaultDb {
  failFactInserts = 0;

  constructor(private readonly inner: Db) {}

  prepare(sql: string) {
    const statement = this.inner.prepare(sql);
    const insert = sql.includes('INSERT INTO inbox_projection_facts');
    return {
      all: (...args: unknown[]) => statement.all(...(args as never[])),
      get: (...args: unknown[]) => statement.get(...(args as never[])),
      run: (...args: unknown[]) => {
        if (insert && this.failFactInserts > 0) {
          this.failFactInserts -= 1;
          throw new Error('fact insert failed');
        }
        return statement.run(...(args as never[]));
      },
    };
  }
}

test('a local pending waits for its durable open fact, and a local decision releases only after its durable close fact', async () => {
  const context = setup();
  const fault = new FactFaultDb(context.db);
  const adapter = new SessionInboxAdapter(fault as unknown as Db, context.inbox, 'proc-gate');
  context.sessions.setSessionInbox(adapter);
  try {
    const active = await boot(context, 'local-durable');
    fault.failFactInserts = 2;
    const waiter = context.approvals.request({
      sessionId: active.session.id,
      turnId: active.turnId,
      turnNumber: 1,
      category: 'browser_capture',
      risk: 'high',
      description: 'Allow this Session to capture Browser tab t3?',
      payload: { localOnly: true, approvalId: 'durable-1' },
    });
    let settled = false;
    void waiter.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    // The failed open-fact write exposes no unrecoverable pending row.
    assert.equal(inboxItem(context.db, active.session.id, 'durable-1'), undefined);
    assert.equal(projectionFact(context.db, 'local:proc-gate:durable-1'), undefined);
    assert.equal(adapter.retryScheduled(), true);
    adapter.retryDeferred();
    assert.equal(inboxItem(context.db, active.session.id, 'durable-1')?.status, 'pending');
    assert.equal(projectionFact(context.db, 'local:proc-gate:durable-1')?.applied, 1);

    // The durable close fact keeps failing: the decision is not released, the
    // pending record and the waiter stay, and the caller gets a retryable error.
    fault.failFactInserts = 10;
    await assert.rejects(
      context.sessions.respondApproval(active.session.id, 'durable-1', 'allow_once'),
      (error: unknown) => (error as { code?: unknown }).code === 'INBOX_WRITE_FAILED',
    );
    assert.equal(context.approvals.getPending('durable-1', active.session.id)?.turnId, active.turnId);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    assert.equal(projectionFact(context.db, 'local:resolved:proc-gate:durable-1'), undefined);
    assert.equal(inboxItem(context.db, active.session.id, 'durable-1')?.status, 'pending');

    // The database recovers: the same decision is released exactly once.
    fault.failFactInserts = 0;
    await context.sessions.respondApproval(active.session.id, 'durable-1', 'allow_once');
    assert.equal(await waiter, 'allow_once');
    assert.equal(settled, true);
    assert.equal(inboxItem(context.db, active.session.id, 'durable-1')?.status, 'resolved');
    assert.ok(inboxItem(context.db, active.session.id, 'durable-1')?.read_at);
    assert.equal(projectionFact(context.db, 'local:resolved:proc-gate:durable-1')?.direction, 'close');
    await waitFor(() => projectionFact(context.db, 'local:resolved:proc-gate:durable-1')?.applied === 1);
    // A repeated resolve after the release is a no-op: no second settle or broadcast.
    const approvalBroadcasts = () => context.broadcaster.messages.filter(message => (
      message.type === 'approval:updated' && message.approval.id === 'durable-1'
    )).length;
    const seenBroadcasts = approvalBroadcasts();
    context.approvals.resolve('durable-1', 'allow_once', 'web', active.session.id);
    assert.equal(approvalBroadcasts(), seenBroadcasts);
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    adapter.dispose();
    finish(context);
  }
});

test('a large terminal backlog drains in continuation batches without error budget, events, or renotification', async () => {
  const context = setup();
  let adapter: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'sweep-backlog');
    const now = new Date().toISOString();
    const insertTurn = context.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertFact = context.db.prepare(
      `INSERT INTO inbox_projection_facts (
         session_id, provider_event_id, turn_id, interaction_id, direction,
         occurrence_event_id, generation, bound, origin, projected, outcome,
         decision, action_id, title, description, subject, category, tool_name,
         turn_number, user_pending, user_source, applied
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', 'approval', NULL, NULL, NULL,
                 't', 'd', NULL, 'command', NULL, 1, ?, 0, ?)`,
    );
    context.db.transaction(() => {
      for (let i = 0; i < 1001; i += 1) {
        const turnId = randomUUID();
        insertTurn.run(turnId, active.session.id, 3000 + i, 'completed', now, now);
        insertFact.run(active.session.id, `bk-open-${i}`, turnId, `bk-id-${i}`, 'open', `bk-open-${i}`, 1, 1, 1, 1);
      }
    })();
    const terminalFactCount = () => (context.db.prepare(
      `SELECT COUNT(*) AS n FROM inbox_projection_facts
        WHERE provider_event_id LIKE 'gian:turn-terminal:%'`,
    ).get() as { n: number }).n;
    const unappliedFactCount = () => (context.db.prepare(
      'SELECT COUNT(*) AS n FROM inbox_projection_facts WHERE applied = 0',
    ).get() as { n: number }).n;

    adapter = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(adapter);
    // The first batch is synchronous; continuation runs on its own schedule
    // without consuming the bounded error budget and without any new event.
    assert.equal(terminalFactCount(), 200);
    assert.equal(adapter.sweepScheduled(), true);
    assert.equal(adapter.retryScheduled(), false);
    await waitForSlow(() => terminalFactCount() === 1001);
    await waitForSlow(() => unappliedFactCount() === 0);
    assert.equal(adapter.sweepScheduled(), false);
    assert.equal(adapter.retryScheduled(), false);
    // Recovery is not a fresh delivery: no notices, no attention broadcasts.
    assert.equal(adapter.notice(active.session.id, 'bk-id-0'), undefined);
    assert.equal(
      context.broadcaster.messages.filter(message => message.type === 'attention').length,
      0,
    );
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    adapter?.dispose();
    finish(context);
  }
});

test('migration 087 persists fact source and owner generation with a source-scoped key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-inbox-087-'));
  const db = openDatabase(dir);
  try {
    const migration = db.prepare(
      'SELECT filename FROM migrations WHERE filename = ?',
    ).get('087_inbox_projection_source.sql');
    assert.ok(migration);
    const columns = db.prepare(
      'PRAGMA table_info(inbox_projection_facts)',
    ).all() as Array<{ name: string; pk: number }>;
    const names = columns.map(column => column.name);
    assert.ok(names.includes('source'));
    assert.ok(names.includes('owner_generation'));
    assert.ok(names.includes('writer'));
    const pk = columns
      .filter(column => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map(column => column.name);
    assert.deepEqual(pk, ['session_id', 'source', 'writer', 'provider_event_id']);
    // A native fact and a local fact may share one provider event id.
    recordInboxProjection(db, {
      sessionId: 'sess-087',
      providerEventId: 'local:shared-087',
      turnId: 'turn-087',
      turnNumber: 1,
      origin: 'live',
      method: 'interaction.requested',
      raw: { interactionId: 'native-087', title: 'Run tests', description: 'npm test' },
      displayType: 'interaction.approval',
      displayData: { category: 'command', title: 'Run tests', description: 'npm test' },
      userPending: true,
      userSource: false,
    });
    recordInboxProjection(db, {
      sessionId: 'sess-087',
      providerEventId: 'local:shared-087',
      turnId: 'turn-087',
      turnNumber: 1,
      origin: 'live',
      source: 'local',
      ownerGeneration: 'proc-087',
      method: 'interaction.requested',
      raw: { interactionId: 'local-087' },
      displayType: 'interaction.approval',
      displayData: { category: 'browser_capture', title: 'Capture', description: 'Capture tab' },
      userPending: true,
      userSource: false,
    });
    const rows = db.prepare(
      `SELECT source, owner_generation AS owner
         FROM inbox_projection_facts
        WHERE session_id = ? AND provider_event_id = ?
        ORDER BY source`,
    ).all('sess-087', 'local:shared-087') as Array<{ source: string; owner: string | null }>;
    assert.deepEqual(rows, [
      { source: 'local', owner: 'proc-087' },
      { source: 'native', owner: null },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a native event id that mimics the local namespace is not deduplicated or cancelled as local', async () => {
  const context = setup();
  let fresh: SessionInboxAdapter | undefined;
  try {
    const writer = new SessionInboxAdapter(context.db, context.inbox, 'proc-old');
    context.sessions.setSessionInbox(writer);
    const active = await boot(context, 'ns-mimic');
    void context.approvals.request({
      sessionId: active.session.id,
      turnId: active.turnId,
      turnNumber: 1,
      category: 'browser_capture',
      risk: 'high',
      description: 'Allow this Session to capture Browser tab t4?',
      payload: { localOnly: true, approvalId: 'mimic-local' },
    });
    await waitFor(() => inboxItem(context.db, active.session.id, 'mimic-local')?.status === 'pending');

    // A native event id identical to the local fact id, and one that merely
    // carries a local-looking prefix. Both stay native and both project.
    active.client.fire(requested(active.session.id, active.turnId, 'native-mimic', 'local:proc-old:mimic-local', 1, PERMISSION));
    active.client.fire(requested(active.session.id, active.turnId, 'native-prefixed', 'local:anything', 2, PERMISSION));
    await waitFor(() => (
      inboxItem(context.db, active.session.id, 'native-mimic')?.status === 'pending'
      && inboxItem(context.db, active.session.id, 'native-prefixed')?.status === 'pending'
    ));
    const sources = (eventId: string) => (context.db.prepare(
      `SELECT source FROM inbox_projection_facts
        WHERE session_id = ? AND provider_event_id = ? ORDER BY source`,
    ).all(active.session.id, eventId) as Array<{ source: string }>).map(row => row.source);
    assert.deepEqual(sources('local:proc-old:mimic-local'), ['local', 'native']);
    assert.deepEqual(sources('local:anything'), ['native']);

    fresh = new SessionInboxAdapter(context.db, context.inbox, 'proc-new');
    context.sessions.setSessionInbox(fresh);
    // Only the genuinely local, dead-generation occurrence is cancelled.
    assert.equal(inboxItem(context.db, active.session.id, 'mimic-local')?.status, 'cancelled');
    assert.equal(inboxItem(context.db, active.session.id, 'native-mimic')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'native-prefixed')?.status, 'pending');
    assert.equal(active.client.approvalCalls.length, 0);
    writer.dispose();
  } finally {
    fresh?.dispose();
    finish(context);
  }
});

test('a durable local decision converges with its user read state after a fresh host starts', async () => {
  const context = setup();
  let fresh: SessionInboxAdapter | undefined;
  try {
    const writer = new SessionInboxAdapter(context.db, context.inbox, 'proc-x');
    context.sessions.setSessionInbox(writer);
    const active = await boot(context, 'local-crash');
    const waiter = context.approvals.request({
      sessionId: active.session.id,
      turnId: active.turnId,
      turnNumber: 1,
      category: 'browser_capture',
      risk: 'high',
      description: 'Allow this Session to capture Browser tab t5?',
      payload: { localOnly: true, approvalId: 'crash-1' },
    });
    await waitFor(() => inboxItem(context.db, active.session.id, 'crash-1')?.status === 'pending');
    await context.sessions.respondApproval(active.session.id, 'crash-1', 'allow_once');
    assert.equal(await waiter, 'allow_once');
    assert.equal(inboxItem(context.db, active.session.id, 'crash-1')?.status, 'resolved');

    // Crash after the decision was durable but before the inbox row applied it.
    context.db.prepare(
      'UPDATE inbox_projection_facts SET applied = 0 WHERE provider_event_id = ?',
    ).run('local:resolved:proc-x:crash-1');
    context.db.prepare(
      `UPDATE inbox_items
          SET status = 'pending', read_at = NULL, read_generation = NULL,
              notified_generation = NULL, closed_at = NULL
        WHERE source_key LIKE '%crash-1%'`,
    ).run();
    writer.dispose();

    fresh = new SessionInboxAdapter(context.db, context.inbox, 'proc-y');
    context.sessions.setSessionInbox(fresh);
    assert.equal(inboxItem(context.db, active.session.id, 'crash-1')?.status, 'resolved');
    assert.ok(inboxItem(context.db, active.session.id, 'crash-1')?.read_at);
    assert.equal(projectionFact(context.db, 'local:resolved:proc-x:crash-1')?.applied, 1);
    // The resolved occurrence is not cancelled as a dead-generation orphan.
    assert.equal(
      context.db.prepare(
        `SELECT 1 AS ok FROM inbox_projection_facts WHERE provider_event_id = 'local:cancelled:crash-1'`,
      ).get(),
      undefined,
    );
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    fresh?.dispose();
    finish(context);
  }
});

const TEST_DIRNAME = dirname(fileURLToPath(import.meta.url));

test('migration 087 keeps pre-upgrade rows native even when their event id looks local', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-inbox-087-upgrade-'));
  const db = new Database(join(dir, 'upgrade.db'));
  try {
    const migrationsDir = join(TEST_DIRNAME, '..', 'migrations');
    db.exec(readFileSync(join(migrationsDir, '085_inbox_projection.sql'), 'utf8'));
    const insert = db.prepare(
      `INSERT INTO inbox_projection_facts (
         session_id, provider_event_id, turn_id, interaction_id, direction,
         occurrence_event_id, generation, bound, origin, projected, outcome,
         decision, action_id, title, description, subject, category, tool_name,
         turn_number, user_pending, user_source, applied
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', NULL, NULL, NULL, NULL,
                 't', 'd', NULL, 'command', NULL, 1, ?, 0, ?)`,
    );
    // A legitimate native provider event whose id merely looks like a local one.
    insert.run('sess-up', 'local:foo', 'turn-up-1', 'native-foo', 'open', 'local:foo', 1, 1, 1, 1);
    // A draft-round local row; it carries no trustworthy source evidence either.
    insert.run('sess-up', 'local:proc-old:bar', 'turn-up-2', 'local-bar', 'open', 'local:proc-old:bar', 1, 1, 1, 1);
    db.exec(readFileSync(join(migrationsDir, '087_inbox_projection_source.sql'), 'utf8'));
    const rows = db.prepare(
      `SELECT provider_event_id AS id, source, owner_generation AS owner, writer
         FROM inbox_projection_facts
        ORDER BY rowid`,
    ).all() as Array<{ id: string; source: string; owner: string | null; writer: string }>;
    // No string inference: neither row is claimed as local, so neither can be
    // ghost-cancelled by a later generation sweep (which only reads
    // source='local' rows; see the namespace regression below).
    assert.deepEqual(rows, [
      { id: 'local:foo', source: 'native', owner: null, writer: 'provider' },
      { id: 'local:proc-old:bar', source: 'native', owner: null, writer: 'provider' },
    ]);
    const pk = (db.prepare('PRAGMA table_info(inbox_projection_facts)').all() as Array<{ name: string; pk: number }>)
      .filter(column => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map(column => column.name);
    assert.deepEqual(pk, ['session_id', 'source', 'writer', 'provider_event_id']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a colliding native event id survives a local close failure and a restart', async () => {
  const context = setup();
  const flaky = new FlakyInbox(context.inbox);
  let fresh: SessionInboxAdapter | undefined;
  try {
    const writer = new SessionInboxAdapter(context.db, flaky, 'proc-old');
    context.sessions.setSessionInbox(writer);
    const active = await boot(context, 'collision');
    const waiter = context.approvals.request({
      sessionId: active.session.id,
      turnId: active.turnId,
      turnNumber: 1,
      category: 'browser_capture',
      risk: 'high',
      description: 'Allow this Session to capture Browser tab t6?',
      payload: { localOnly: true, approvalId: 'col-1' },
    });
    await waitFor(() => inboxItem(context.db, active.session.id, 'col-1')?.status === 'pending');

    // The local close keeps failing through the pass that also drains the
    // colliding native open below (direct mirror, first drain, second drain).
    flaky.failCloses = 4;
    await context.sessions.respondApproval(active.session.id, 'col-1', 'allow_once');
    assert.equal(await waiter, 'allow_once');
    assert.equal(inboxItem(context.db, active.session.id, 'col-1')?.status, 'pending');

    // A native occurrence whose event id is identical to the local open's id.
    // Its occurrence key differs only by source: the failed local close must
    // not block, consume, or fence it.
    active.client.fire(requested(active.session.id, active.turnId, 'col-native', 'local:proc-old:col-1', 1, PERMISSION));
    assert.equal(inboxItem(context.db, active.session.id, 'col-native')?.status, 'pending');
    const factsOf = (eventId: string) => context.db.prepare(
      `SELECT source, direction, applied
         FROM inbox_projection_facts
        WHERE session_id = ? AND provider_event_id = ?
        ORDER BY source`,
    ).all(active.session.id, eventId) as Array<{ source: string; direction: string; applied: number }>;
    assert.deepEqual(factsOf('local:proc-old:col-1'), [
      { source: 'local', direction: 'open', applied: 1 },
      { source: 'native', direction: 'open', applied: 1 },
    ]);

    // The local close converges on the bounded retry; only its own source row
    // is marked applied.
    await waitFor(() => inboxItem(context.db, active.session.id, 'col-1')?.status === 'resolved');
    assert.ok(inboxItem(context.db, active.session.id, 'col-1')?.read_at);
    assert.equal(inboxItem(context.db, active.session.id, 'col-native')?.status, 'pending');

    // A fresh generation cancels nothing here: the local open has a bound
    // close, and the native occurrence is not a local fact at all.
    writer.dispose();
    fresh = new SessionInboxAdapter(context.db, context.inbox, 'proc-new');
    context.sessions.setSessionInbox(fresh);
    assert.equal(inboxItem(context.db, active.session.id, 'col-native')?.status, 'pending');
    assert.equal(inboxItem(context.db, active.session.id, 'col-1')?.status, 'resolved');

    // The native occurrence still closes on its own identity afterwards.
    await context.sessions.respondApproval(active.session.id, 'col-native', 'decline', undefined, 'deny');
    active.client.fire(resolved(active.session.id, active.turnId, 'col-native', 'col-native-close', 2, 'submitted', 'deny'));
    await waitFor(() => inboxItem(context.db, active.session.id, 'col-native')?.status === 'rejected');
    assert.ok(inboxItem(context.db, active.session.id, 'col-native')?.read_at);
    assert.equal(active.client.approvalCalls.length, 1);
    assert.equal(active.client.approvalCalls[0]?.interactionId, 'col-native');
  } finally {
    fresh?.dispose();
    finish(context);
  }
});

test('a native event id equal to the host terminal synthesis still closes once and stays idempotent', async () => {
  const context = setup();
  let fresh: SessionInboxAdapter | undefined;
  try {
    const active = await boot(context, 'terminal-collision');
    const synthetic = (interactionId: string) => `gian:turn-terminal:${active.turnId}:${interactionId}`;
    // The opening's own provider event id equals the Host synthesis, and a
    // normal occurrence on the same turn must still close as well.
    active.client.fire(requested(active.session.id, active.turnId, 'tt-1', synthetic('tt-1'), 1, PERMISSION));
    active.client.fire(requested(active.session.id, active.turnId, 'tt-2', 'open-tt-2', 2, PERMISSION));
    await waitFor(() => (
      inboxItem(context.db, active.session.id, 'tt-1')?.status === 'pending'
      && inboxItem(context.db, active.session.id, 'tt-2')?.status === 'pending'
    ));
    active.client.fire(completed(active.session.id, active.turnId, 'tt-done', 3));
    await waitFor(() => (
      inboxItem(context.db, active.session.id, 'tt-1')?.status === 'cancelled'
      && inboxItem(context.db, active.session.id, 'tt-2')?.status === 'cancelled'
    ));
    assert.equal(inboxItem(context.db, active.session.id, 'tt-1')?.read_at, null);
    const rows = context.db.prepare(
      `SELECT source, writer, direction, applied
         FROM inbox_projection_facts
        WHERE session_id = ? AND provider_event_id = ?
        ORDER BY writer`,
    ).all(active.session.id, synthetic('tt-1')) as Array<{
      source: string;
      writer: string;
      direction: string;
      applied: number;
    }>;
    // The provider opening and the Host close share the id string, not identity.
    assert.deepEqual(rows, [
      { source: 'native', writer: 'host', direction: 'close', applied: 1 },
      { source: 'native', writer: 'provider', direction: 'open', applied: 1 },
    ]);
    assert.equal(active.client.approvalCalls.length, 0);

    // Restart: the sweep neither re-inserts nor re-notifies, and it terminates.
    context.sessions.setSessionInbox(null);
    fresh = new SessionInboxAdapter(context.db, context.inbox);
    context.sessions.setSessionInbox(fresh);
    assert.equal(fresh.sweepScheduled(), false);
    assert.equal(inboxItem(context.db, active.session.id, 'tt-1')?.status, 'cancelled');
    const hostCloses = (context.db.prepare(
      `SELECT COUNT(*) AS n FROM inbox_projection_facts
        WHERE session_id = ? AND provider_event_id = ? AND writer = 'host'`,
    ).get(active.session.id, synthetic('tt-1')) as { n: number }).n;
    assert.equal(hostCloses, 1);
    assert.equal(fresh.notice(active.session.id, 'tt-1'), undefined);
    assert.equal(active.client.approvalCalls.length, 0);
  } finally {
    fresh?.dispose();
    finish(context);
  }
});
