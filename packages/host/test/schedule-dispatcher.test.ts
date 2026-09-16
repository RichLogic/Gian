// Dispatcher integration for conversation-bound schedules (ADR-0053).
// Exercises the frozen contract against a real SessionManager with a
// deterministic protocol-v2 stub Proxy:
//   F  idle → new Turn in the control conversation with scheduled_task origin
//   G  busy / queued → durable hidden Fork from the last stable Turn
//   H  fork decisions persist; the main conversation never receives fork output
//   I  SCHEDULE_FORK_UNSUPPORTED / SCHEDULE_NO_STABLE_FORK_POINT / SCHEDULE_FORK_FAILED
//   J  lifecycle fail-closed pauses
//   K  unknown runs never replay the prompt; approval → waiting_interaction

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Executor, ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { SessionAgentResolver } from '../src/session/manager.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { CreateSessionParams, NotificationHandler, ProxyClient } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ScheduleService } from '../src/schedule/service.js';
import { ScheduleRunDispatcher } from '../src/schedule/dispatcher.js';
import { ScheduleOrchestrator } from '../src/schedule/orchestrator.js';
import { stubInitialize, stubSession, EMPTY_CATALOG } from './helpers/protocol-v2-stub.js';

const START = Date.parse('2026-09-01T12:00:00.000Z');

class ScheduleStubClient implements ProxyClient {
  readonly executor: Executor = 'claude';
  readonly protocolV2 = true as const;
  stream = 'stream-control';
  forkCapabilities = true;
  failFork: Error | null = null;
  failNextStartTurn: Error | null = null;
  startTurnCalls: Array<{ sessionId: string }> = [];
  forkCalls = 0;
  notificationHandlers: NotificationHandler[] = [];
  children = new Map<string, ScheduleStubClient>();
  currentParentId = 'parent';

  isExited() { return false; }
  async initialize() {
    const base = stubInitialize('claude');
    return this.forkCapabilities
      ? { ...base, capabilities: { 'session.fork': 1, 'session.fork.atTurn': 1 } }
      : base;
  }
  async catalog() {
    return { ...EMPTY_CATALOG, catalogRevision: 'schedule-stub' };
  }
  async createSession(params: CreateSessionParams = {}) {
    const nativeSessionId = params.nativeSessionId ?? `native-${randomUUID()}`;
    return {
      session: stubSession(nativeSessionId, params.cwd ?? '/tmp'),
      nativeSessionId,
    };
  }
  streamId() { return this.stream; }
  hasAttachedSession() { return this.stream != null; }
  runtimeHost() {
    return {
      createSessionClient: (id: string) => {
        const existing = this.children.get(id);
        if (existing) return existing;
        const child = new ScheduleStubClient();
        child.stream = `stream-${id}`;
        this.children.set(id, child);
        return child;
      },
    };
  }
  async forkSession(params: { sessionId: string; anchor: { type: string; turnId?: string; sourceTurnId?: string } }) {
    this.forkCalls += 1;
    if (this.failFork) {
      const error = this.failFork;
      this.failFork = null;
      throw error;
    }
    const child = this.runtimeHost().createSessionClient(params.sessionId);
    return {
      session: {
        id: params.sessionId,
        streamId: `stream-${params.sessionId}`,
        state: 'idle' as const,
        nativeSession: { id: `native-${params.sessionId}` },
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      origin: {
        kind: 'fork' as const,
        sessionId: this.currentParentId,
        turnId: params.anchor.type === 'turn' ? params.anchor.turnId : 'head-turn',
        sourceTurnId: params.anchor.type === 'turn' ? params.anchor.sourceTurnId : 'head-src',
      },
      replayEvents: [],
    };
  }
  async startTurn(params: { sessionId: string }) {
    this.startTurnCalls.push({ sessionId: params.sessionId });
    if (this.failNextStartTurn) {
      const error = this.failNextStartTurn;
      this.failNextStartTurn = null;
      throw error;
    }
    return {
      session: stubSession(this.currentParentId, '/tmp', 'running'),
      turn: { id: `proxy-turn-${this.startTurnCalls.length}` },
    };
  }
  async interruptTurn() {}
  async respondInteraction() {}
  async closeSession() {}
  async deleteNativeSession() {}
  async setName() {}
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter(h => h !== handler);
    };
  }
  onSessionFault() {
    return () => {};
  }
  onExit() {
    return () => {};
  }
  fire(notification: ProxyNotification): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }
}

class StubProxyManager {
  client: ScheduleStubClient;
  adopted = new Map<string, ProxyClient>();
  parentSessionId: string | null = null;
  constructor(client = new ScheduleStubClient()) {
    this.client = client;
  }
  async getOrCreate(sessionId?: string): Promise<ProxyClient> {
    if (sessionId) {
      this.parentSessionId = sessionId;
      this.client.currentParentId = sessionId;
    }
    return this.client;
  }
  get(sessionId?: string): ProxyClient | undefined {
    if (!sessionId) return this.client;
    if (this.adopted.has(sessionId)) return this.adopted.get(sessionId);
    if (sessionId === this.parentSessionId) return this.client;
    return undefined;
  }
  adoptExisting(sessionId: string, client: ProxyClient): void {
    this.adopted.set(sessionId, client);
  }
  forgetAdopted(sessionId: string): void {
    this.adopted.delete(sessionId);
  }
  async closeAll() {}
}

interface Fixture {
  dir: string;
  db: Db;
  sessions: SessionManager;
  service: ScheduleService;
  dispatcher: ScheduleRunDispatcher;
  stub: ScheduleStubClient;
  broadcaster: CapturingBroadcaster;
  controlSessionId: string;
  clockMs: number;
  queue: QueueManager;
  agentResolver: { requireDeleted: boolean };
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(message: ServerToClientMessage): void { this.messages.push(message); }
  get size() { return 0; }
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-dispatcher-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(wsId, 'test', '/tmp/test-ws');
  const stub = new ScheduleStubClient();
  const proxyMgr = new StubProxyManager(stub);
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const agentResolver = { requireDeleted: false };
  const resolver: SessionAgentResolver = {
    cliPathForKind: () => '/usr/bin/false',
    cliPathForSession: () => '/usr/bin/false',
    requireCliPathForSession: () => {
      if (agentResolver.requireDeleted) {
        throw Object.assign(new Error('Agent was deleted: gone'), { code: 'AGENT_DELETED' });
      }
      return '/usr/bin/false';
    },
    agentRuntime: () => { throw new Error('not in this test'); },
    agentRuntimeProfile: async () => null,
    agentsForKind: () => [],
  };
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    queue,
    dir,
    null,
    undefined,
    undefined,
    resolver,
  );
  const controlSession = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
  const clockMs = START;
  const service = new ScheduleService({
    db,
    broadcaster: broadcaster as unknown as WsBroadcaster,
    assertControlSessionReady: sessionId => sessions.assertReadyForScheduledTurn(sessionId),
    now: () => ({ ms: clockMs, iso: new Date(clockMs).toISOString() }),
  });
  const dispatcher = new ScheduleRunDispatcher(service, sessions, db, {
    now: () => ({ ms: clockMs, iso: new Date(clockMs).toISOString() }),
    broadcaster: broadcaster as unknown as WsBroadcaster,
  });
  return {
    dir,
    db,
    sessions,
    service,
    dispatcher,
    stub,
    broadcaster,
    controlSessionId: controlSession.id,
    clockMs,
    queue,
    agentResolver,
  };
}

async function teardown(fx: Fixture): Promise<void> {
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
}

function createScheduleRow(fx: Fixture): string {
  const schedule = fx.service.createSchedule({
    name: 'Nightly',
    prompt: 'Run the nightly check',
    trigger: { kind: 'cron', expression: '30 9 * * *' },
    timezone: 'UTC',
    controlSessionId: fx.controlSessionId,
    creatorActorId: 'internal-session:actor',
  });
  return schedule.id;
}

function insertRun(fx: Fixture, scheduleId: string, scheduledFor = new Date(fx.clockMs).toISOString()): string {
  const run = fx.service.repository.insertRun({
    scheduleId,
    triggerKind: 'scheduled',
    scheduledFor,
    now: new Date(fx.clockMs).toISOString(),
  });
  return run.id;
}

/** Completes a live Turn through the real provider-notification lifecycle so
 *  memory, canonical rows, and session status all settle exactly like in
 *  production; the provisional provider id makes the Turn a stable boundary. */
function completeTurn(fx: Fixture, hostTurnId: string): { turnId: string; sourceTurnId: string } {
  fx.stub.fire({
    jsonrpc: '2.0',
    method: 'turn.completed',
    params: { turnId: hostTurnId, data: { turnId: hostTurnId } },
  } as never);
  const row = fx.db.prepare(
    `SELECT turns.id AS turnId, replay.provider_turn_id AS sourceTurnId, turns.status AS status
       FROM turns
       JOIN proxy_replay_turns replay
         ON replay.turn_id = turns.id AND replay.session_id = turns.session_id
      WHERE turns.id = ?`,
  ).get(hostTurnId) as { turnId: string; sourceTurnId: string; status: string };
  assert.equal(row.status, 'completed');
  assert.ok(row.sourceTurnId);
  return { turnId: row.turnId, sourceTurnId: row.sourceTurnId };
}

test('idle dispatch creates a Turn in the control conversation with scheduled_task origin (contract F)', async () => {
  const fx = await setup();
  try {
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const run = fx.service.repository.runRow(runId)!;
    assert.equal(run.status, 'running');
    assert.equal(run.execution_mode, 'bound_session');
    assert.equal(run.target_session_id, fx.controlSessionId);
    assert.ok(run.turn_id);
    assert.ok(run.resolved_config_json, 'resolved config snapshot is stored');
    // The scheduled prompt entered the canonical transcript with origin metadata.
    const event = fx.db.prepare(
      `SELECT data FROM events WHERE session_id = ? AND type = 'user_message'`,
    ).get(fx.controlSessionId) as { data: string };
    const payload = JSON.parse(event.data) as { scheduled_task?: { schedule_id: string; run_id: string; schedule_name: string } };
    assert.equal(payload.scheduled_task?.schedule_id, scheduleId);
    assert.equal(payload.scheduled_task?.run_id, runId);
    assert.equal(payload.scheduled_task?.schedule_name, 'Nightly');
    // Settling: complete the turn and reconcile → succeeded with a bounded summary.
    fx.db.prepare("UPDATE turns SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(run.turn_id!);
    fx.db.prepare(
      `INSERT INTO events (id, session_id, turn_id, call_id, type, data) VALUES (?, ?, ?, 'c1', 'assistant_text', ?)`,
    ).run(
      randomUUID(),
      fx.controlSessionId,
      run.turn_id,
      JSON.stringify({ display: { type: 'message', data: { text: 'Nightly check passed cleanly.' } } }),
    );
    const sessionRow = { id: fx.controlSessionId, status: 'running' };
    const turnRow = { id: run.turn_id!, status: 'completed' };
    fx.dispatcher.reconcileRunAgainstEvidence(runId, sessionRow, turnRow);
    const settled = fx.service.repository.runRow(runId)!;
    assert.equal(settled.status, 'succeeded');
    assert.equal(settled.summary, 'Nightly check passed cleanly.');
  } finally {
    await teardown(fx);
  }
});

test('busy dispatch forks from the last stable Turn into a durable hidden Fork (contract G/H)', async () => {
  const fx = await setup();
  try {
    // Give the control conversation one completed stable Turn, then open a
    // normal user Turn so it is busy.
    const first = await fx.sessions.sendMessage(fx.controlSessionId, 'regular user message');
    const anchor = completeTurn(fx, first!.turnId);
    await fx.sessions.sendMessage(fx.controlSessionId, 'second user turn still running');

    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);

    const run = fx.service.getRun(runId);
    assert.equal(run.status, 'running');
    assert.equal(run.execution_mode, 'fork');
    assert.notEqual(run.target_session_id, fx.controlSessionId);
    assert.deepEqual(run.fork_anchor, { turn_id: anchor.turnId, source_turn_id: anchor.sourceTurnId });

    // The Fork is a durable real Session row, hidden from every listing.
    const forkRow = fx.db.prepare(
      'SELECT id, hidden, task_id, origin_kind FROM sessions WHERE id = ?',
    ).get(run.target_session_id!) as { id: string; hidden: number; task_id: string | null; origin_kind: string };
    assert.equal(forkRow.hidden, 1);
    assert.equal(forkRow.task_id, null);
    assert.equal(forkRow.origin_kind, 'fork');
    assert.equal(fx.sessions.listSessions().some(s => s.id === forkRow.id), false, 'hidden Fork never enters the rail');
    assert.equal(fx.sessions.listSessions({ includeArchived: true }).some(s => s.id === forkRow.id), false);
    // The durable prompt went to the Fork, with origin metadata.
    const forkEvents = fx.db.prepare(
      `SELECT data FROM events WHERE session_id = ? AND type = 'user_message'`,
    ).all(forkRow.id) as Array<{ data: string }>;
    assert.equal(forkEvents.length, 1);
    assert.equal((JSON.parse(forkEvents[0]!.data) as { scheduled_task?: { run_id: string } }).scheduled_task?.run_id, runId);
    // The busy main conversation never received the scheduled prompt.
    const controlEvents = fx.db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'user_message' AND json_extract(data, '$.scheduled_task.run_id') = ?`,
    ).get(fx.controlSessionId, runId) as { n: number };
    assert.equal(controlEvents.n, 0);
  } finally {
    await teardown(fx);
  }
});

test('a queued ordinary delivery forces the Fork path like a live Turn (contract G)', async () => {
  const fx = await setup();
  try {
    const first = await fx.sessions.sendMessage(fx.controlSessionId, 'first message');
    const anchor = completeTurn(fx, first!.turnId);
    await fx.sessions.sendMessage(fx.controlSessionId, 'running turn');
    // A queued user delivery would claim the next Turn — the schedule must
    // not queue behind it or steal the slot.
    fx.queue.add(fx.controlSessionId, 'queued user delivery');

    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);

    const run = fx.service.getRun(runId);
    assert.equal(run.execution_mode, 'fork');
    assert.deepEqual(run.fork_anchor, { turn_id: anchor.turnId, source_turn_id: anchor.sourceTurnId });
    assert.equal(fx.queue.list(fx.controlSessionId).length, 1, 'queue untouched');
  } finally {
    await teardown(fx);
  }
});

test('a busy race during a bound send escalates the claimed Run to Fork exactly once', async () => {
  const fx = await setup();
  try {
    // Stable anchor exists; the session is idle at claim time, but the proxy
    // rejects the send with the busy desync signal (a real Turn won the race).
    const first = await fx.sessions.sendMessage(fx.controlSessionId, 'message one');
    completeTurn(fx, first!.turnId);
    fx.stub.failNextStartTurn = new Error('claude-cli failed: [SESSION_BUSY] prior turn still alive');

    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);

    const run = fx.service.repository.runRow(runId)!;
    assert.equal(run.status, 'running');
    assert.equal(run.execution_mode, 'fork', 'bound claim escalated to fork');
    assert.notEqual(run.target_session_id, fx.controlSessionId);
    // The rolled-back phantom turn did not land in the main conversation.
    const controlScheduled = fx.db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'user_message' AND json_extract(data, '$.scheduled_task.run_id') = ?`,
    ).get(fx.controlSessionId, runId) as { n: number };
    assert.equal(controlScheduled.n, 0);
  } finally {
    await teardown(fx);
  }
});

test('a Proxy without session.fork.atTurn fails the Run as SCHEDULE_FORK_UNSUPPORTED (contract I)', async () => {
  const fx = await setup();
  try {
    const first = await fx.sessions.sendMessage(fx.controlSessionId, 'first');
    completeTurn(fx, first!.turnId);
    await fx.sessions.sendMessage(fx.controlSessionId, 'busy turn');
    fx.stub.forkCapabilities = false;

    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const run = fx.service.repository.runRow(runId)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'SCHEDULE_FORK_UNSUPPORTED');
    assert.equal(fx.service.getSchedule(scheduleId).status, 'active', 'capability gaps do not pause the schedule');
  } finally {
    await teardown(fx);
  }
});

test('busy without a stable fork point fails as SCHEDULE_NO_STABLE_FORK_POINT (contract I)', async () => {
  const fx = await setup();
  try {
    // Busy with a running Turn but no terminal Turn exists at all.
    await fx.sessions.sendMessage(fx.controlSessionId, 'first ever turn, still running');
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const run = fx.service.repository.runRow(runId)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'SCHEDULE_NO_STABLE_FORK_POINT');
  } finally {
    await teardown(fx);
  }
});

test('a failing fork provider call fails the Run as SCHEDULE_FORK_FAILED (contract I)', async () => {
  const fx = await setup();
  try {
    const first = await fx.sessions.sendMessage(fx.controlSessionId, 'first');
    completeTurn(fx, first!.turnId);
    await fx.sessions.sendMessage(fx.controlSessionId, 'busy turn');
    fx.stub.failFork = new Error('proxy fork exploded');

    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const run = fx.service.repository.runRow(runId)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'SCHEDULE_FORK_FAILED');
  } finally {
    await teardown(fx);
  }
});

test('lifecycle fail-closed: archived control conversation pauses the Schedule (contract J)', async () => {
  const fx = await setup();
  try {
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    fx.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(fx.controlSessionId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const run = fx.service.repository.runRow(runId)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'SCHEDULE_CONTROL_SESSION_ARCHIVED');
    const schedule = fx.service.getSchedule(scheduleId);
    assert.equal(schedule.status, 'paused');
    assert.equal(schedule.status_reason, 'lifecycle_blocked');
    assert.equal(schedule.next_run_at, null);
  } finally {
    await teardown(fx);
  }
});

test('lifecycle fail-closed: deleted Agent pauses the Schedule with AGENT_DELETED (contract J)', async () => {
  const fx = await setup();
  try {
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    fx.agentResolver.requireDeleted = true;
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const run = fx.service.repository.runRow(runId)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'AGENT_DELETED');
    assert.equal(fx.service.getSchedule(scheduleId).status, 'paused');
  } finally {
    await teardown(fx);
  }
});

test('non-deterministic send failures become unknown, pause the Schedule, and never replay (contract K)', async () => {
  const fx = await setup();
  try {
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    fx.stub.failNextStartTurn = new Error('provider stream died unexpectedly mid-handshake');
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const run = fx.service.repository.runRow(runId)!;
    assert.equal(run.status, 'unknown');
    assert.equal(run.error_code, 'SCHEDULE_DISPATCH_UNKNOWN');
    assert.equal(run.turn_id, null, 'no Turn was proven to cross — but the run is never retried');
    const schedule = fx.service.getSchedule(scheduleId);
    assert.equal(schedule.status, 'paused');
    assert.equal(schedule.status_reason, 'unknown_run');
    assert.equal(fx.stub.startTurnCalls.length, 1, 'the prompt was sent exactly once');
    // Confirming the risk requires archive + recreate; plain resume is refused.
    await assert.rejects(() => fx.service.resumeSchedule(scheduleId));
  } finally {
    await teardown(fx);
  }
});

test('a pending provider approval surfaces as waiting_interaction on the Run (contract H)', async () => {
  const fx = await setup();
  try {
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const run = fx.service.repository.runRow(runId)!;
    // Provider asks for approval: a pending proxy interaction exists.
    fx.db.prepare(
      `INSERT INTO proxy_interactions (session_id, interaction_id, response_id, outcome, created_at)
       VALUES (?, 'i-1', 'resp-pending', NULL, datetime('now'))`,
    ).run(fx.controlSessionId);
    const sessionRow = fx.db.prepare('SELECT id, status FROM sessions WHERE id = ?').get(fx.controlSessionId) as { id: string; status: string };
    const turnRow = { id: run.turn_id!, status: 'running' };
    assert.equal(fx.dispatcher.reconcileRunAgainstEvidence(runId, sessionRow, turnRow), 'changed');
    assert.equal(fx.service.repository.runRow(runId)!.status, 'waiting_interaction');
    // Resolve the interaction → back to running → completion settles succeeded.
    fx.db.prepare("UPDATE proxy_interactions SET outcome = 'approved', resolved_at = datetime('now') WHERE session_id = ?").run(fx.controlSessionId);
    fx.db.prepare("UPDATE turns SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(run.turn_id!);
    fx.dispatcher.reconcileRunAgainstEvidence(runId, sessionRow, { id: run.turn_id!, status: 'completed' });
    const settled = fx.service.repository.runRow(runId)!;
    assert.equal(settled.status, 'succeeded');
  } finally {
    await teardown(fx);
  }
});

test('same-schedule overlap records skipped_overlap instead of double execution (contract E)', async () => {
  const fx = await setup();
  try {
    // Interval every 5 minutes so occurrences exist inside the test window.
    const schedule = fx.service.createSchedule({
      name: 'Fast lane',
      prompt: 'tick',
      trigger: { kind: 'interval', every_ms: 300_000, anchor_at: new Date(fx.clockMs).toISOString() },
      timezone: 'UTC',
      controlSessionId: fx.controlSessionId,
      creatorActorId: 'internal-session:actor',
    });
    // Start the earlier occurrence (11:55) so it is still blocking at 12:00,
    // keeping (schedule_id, scheduled_for) pairs distinct for the unique index.
    const firstRunId = insertRun(fx, schedule.id, new Date(fx.clockMs - 300_000).toISOString());
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(firstRunId)!);
    assert.equal(fx.service.repository.runRow(firstRunId)!.status, 'running');

    // Force the next occurrence due now: the first Run is still blocking.
    fx.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
      .run(new Date(fx.clockMs).toISOString(), schedule.id);
    const outcomes = fx.service.repository.materializeDueRuns({
      nowMs: fx.clockMs + 60_000,
      nowIso: new Date(fx.clockMs + 60_000).toISOString(),
      graceMs: 60_000,
      maxSchedules: 50,
      enumerationCap: 1_000,
    });
    const relevant = outcomes.filter(o => o.scheduleId === schedule.id);
    assert.equal(relevant.length, 1);
    assert.equal(relevant[0]!.skippedOverlap, true);
    const skippedRun = fx.service.repository.runRow(relevant[0]!.runId!)!;
    assert.equal(skippedRun.status, 'skipped_overlap');
    assert.equal(fx.service.listRuns(schedule.id, {}).runs.length, 2);
    assert.equal(fx.stub.startTurnCalls.length, 1, 'no second execution was started');
  } finally {
    await teardown(fx);
  }
});

test('a failed/unknown Run raises an error attention tied to the control conversation (P2)', async () => {
  const fx = await setup();
  try {
    const first = await fx.sessions.sendMessage(fx.controlSessionId, 'first');
    completeTurn(fx, first!.turnId);
    await fx.sessions.sendMessage(fx.controlSessionId, 'busy turn');
    fx.stub.failFork = new Error('proxy fork exploded');

    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);

    const attention = fx.broadcaster.messages.filter(
      (m): m is Extract<ServerToClientMessage, { type: 'attention' }> => (
        m.type === 'attention' && m.id.startsWith('gian:attention:schedule-run-')
      ),
    );
    assert.equal(attention.length, 1, 'exactly one attention for the failed run');
    assert.equal(attention[0]!.kind, 'error');
    assert.equal(attention[0]!.session_id, fx.controlSessionId);
    assert.equal(attention[0]!.id, `gian:attention:schedule-run-${runId}`);
    assert.equal(attention[0]!.title, 'Scheduled run failed');
    // Clicking the notification opens the Timer detail's run log for THIS
    // run — the body promises the schedule run log, so the target must match.
    assert.deepEqual(attention[0]!.schedule, { schedule_id: scheduleId, run_id: runId });
    // NOTIFY-001: OS notification carries only generic text + the stable
    // code — never the raw error, paths, or the Schedule name.
    assert.ok(attention[0]!.body.includes('SCHEDULE_FORK_FAILED'));
    assert.equal(JSON.stringify(attention[0]!).includes('proxy fork exploded'), false);
    assert.equal(JSON.stringify(attention[0]!).includes('Nightly'), false);
  } finally {
    await teardown(fx);
  }
});

test('an unknown Run raises a distinct unknown-outcome attention with the schedule target (P2)', async () => {
  const fx = await setup();
  try {
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    fx.broadcaster.messages.length = 0;

    fx.dispatcher.markUnknown(runId, 'SCHEDULE_DISPATCH_UNKNOWN', 'canonical Turn evidence contradicts the run state');

    const attention = fx.broadcaster.messages.filter(
      (m): m is Extract<ServerToClientMessage, { type: 'attention' }> => (
        m.type === 'attention' && m.id.startsWith('gian:attention:schedule-run-')
      ),
    );
    assert.equal(attention.length, 1, 'exactly one attention for the unknown run');
    assert.equal(attention[0]!.title, 'Scheduled run outcome unknown');
    assert.ok(attention[0]!.body.includes('unknown outcome'));
    assert.ok(attention[0]!.body.includes('SCHEDULE_DISPATCH_UNKNOWN'));
    assert.ok(attention[0]!.body.includes('Open the schedule run log'));
    assert.deepEqual(attention[0]!.schedule, { schedule_id: scheduleId, run_id: runId });
    // The raw contradiction detail never crosses the OS boundary either.
    assert.equal(JSON.stringify(attention[0]!).includes('contradicts'), false);
  } finally {
    await teardown(fx);
  }
});

test('failure attention passes through the same user-level gate as session attention (P2)', async () => {
  const fx = await setup();
  try {
    const gated = new ScheduleRunDispatcher(fx.service, fx.sessions, fx.db, {
      now: () => ({ ms: fx.clockMs, iso: new Date(fx.clockMs).toISOString() }),
      broadcaster: fx.broadcaster as unknown as WsBroadcaster,
      attentionGate: () => false,
    });
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    fx.broadcaster.messages.length = 0;

    gated.markUnknown(runId, 'SCHEDULE_DISPATCH_UNKNOWN', undefined);

    const attention = fx.broadcaster.messages.filter(
      (m): m is Extract<ServerToClientMessage, { type: 'attention' }> => (
        m.type === 'attention' && m.id.startsWith('gian:attention:schedule-run-')
      ),
    );
    assert.equal(attention.length, 0, 'master/kind gate off → no failure attention');
  } finally {
    await teardown(fx);
  }
});

test('a successful dispatch broadcasts schedule:changed run_updated (P2)', async () => {
  const fx = await setup();
  try {
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    fx.broadcaster.messages.length = 0;
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const updates = fx.broadcaster.messages.filter(
      (m): m is Extract<ServerToClientMessage, { type: 'schedule:changed' }> => (
        m.type === 'schedule:changed' && m.reason === 'run_updated'
      ),
    );
    assert.ok(updates.length >= 1, 'run_updated invalidation after the Turn was accepted');
    assert.equal(updates.at(-1)!.run_id, runId);
  } finally {
    await teardown(fx);
  }
});

test('fail-closed landing still applies to a manually paused schedule (P1-4)', async () => {
  const fx = await setup();
  try {
    const schedule = fx.service.createSchedule({
      name: 'Paused then broken',
      prompt: 'p',
      trigger: { kind: 'cron', expression: '30 9 * * *' },
      timezone: 'UTC',
      controlSessionId: fx.controlSessionId,
      creatorActorId: 'internal-session:actor',
    });
    fx.service.pauseSchedule(schedule.id);
    const run = fx.service.runNow({ schedule_id: schedule.id });
    // The control conversation is now unusable (completed).
    fx.db.prepare("UPDATE sessions SET completed_at = datetime('now') WHERE id = ?")
      .run(fx.controlSessionId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(run.id)!);
    const settled = fx.service.repository.runRow(run.id)!;
    assert.equal(settled.status, 'failed');
    assert.equal(settled.error_code, 'SCHEDULE_CONTROL_SESSION_BLOCKED');
    const row = fx.service.getSchedule(schedule.id);
    assert.equal(row.status, 'paused');
    assert.equal(row.status_reason, 'lifecycle_blocked', 'lifecycle pause also lands on paused schedules');
  } finally {
    await teardown(fx);
  }
});

test('reconcile reattaches a detached target session so a running Run cannot stall (P1-3)', async () => {
  const fx = await setup();
  try {
    const sent = await fx.sessions.sendMessage(fx.controlSessionId, 'anchor');
    completeTurn(fx, sent!.turnId);
    await fx.sessions.sendMessage(fx.controlSessionId, 'busy');
    const scheduleId = createScheduleRow(fx);
    const runId = insertRun(fx, scheduleId);
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const run = fx.service.getRun(runId);
    assert.equal(run.execution_mode, 'fork');

    const attached: string[] = [];
    const orchestrator = new ScheduleOrchestrator(
      {
        service: fx.service,
        dispatcher: fx.dispatcher,
        broadcaster: fx.broadcaster as unknown as WsBroadcaster,
        db: fx.db,
        sessions: {
          ensureProxyAttached: async (sessionId: string) => {
            attached.push(sessionId);
          },
        } as never,
      },
      { now: () => ({ ms: fx.clockMs, iso: new Date(fx.clockMs).toISOString() }) },
    );
    await orchestrator.reconcileNonTerminalRuns();
    assert.ok(attached.includes(run.target_session_id!), 'the hidden fork target was reattached');
    assert.equal(fx.service.getRun(runId).status, 'running', 'still running until provider evidence arrives');
  } finally {
    await teardown(fx);
  }
});
