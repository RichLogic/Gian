// Restart / crash recovery matrix for conversation-bound schedules
// (contract K, ADR-0053). Recovery always converges from canonical
// sessions/turns/events rows and never replays a prompt that may have
// reached the Provider.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Executor, ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { CreateSessionParams, NotificationHandler, ProxyClient } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ScheduleService } from '../src/schedule/service.js';
import { ScheduleRunDispatcher } from '../src/schedule/dispatcher.js';
import { selectBootWatcherRows } from '../src/web/watcher-bootstrap.js';
import { ScheduleOrchestrator } from '../src/schedule/orchestrator.js';
import { stubInitialize, stubSession, EMPTY_CATALOG } from './helpers/protocol-v2-stub.js';

const START = Date.parse('2026-09-01T12:00:00.000Z');

class RecoveryStubClient implements ProxyClient {
  readonly executor: Executor = 'claude';
  readonly protocolV2 = true as const;
  stream = 'stream-control';
  startTurnCalls: Array<{ sessionId: string }> = [];
  notificationHandlers: NotificationHandler[] = [];
  children = new Map<string, RecoveryStubClient>();
  currentParentId = 'parent';

  isExited() { return false; }
  async initialize() {
    return { ...stubInitialize('claude'), capabilities: { 'session.fork': 1, 'session.fork.atTurn': 1 } };
  }
  async catalog() {
    return { ...EMPTY_CATALOG, catalogRevision: 'recovery-stub' };
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
        const child = new RecoveryStubClient();
        child.stream = `stream-${id}`;
        this.children.set(id, child);
        return child;
      },
    };
  }
  async forkSession(params: { sessionId: string; anchor: { type: string; turnId?: string; sourceTurnId?: string } }) {
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
  client: RecoveryStubClient;
  adopted = new Map<string, ProxyClient>();
  parentSessionId: string | null = null;
  constructor(client = new RecoveryStubClient()) {
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
  async dispose() {}
}

class FailingProxyManager extends StubProxyManager {
  attempts = 0;

  override async getOrCreate(): Promise<ProxyClient> {
    this.attempts += 1;
    throw new Error('attach refused');
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

interface Fixture {
  dir: string;
  db: Db;
  sessions: SessionManager;
  service: ScheduleService;
  dispatcher: ScheduleRunDispatcher;
  stub: RecoveryStubClient;
  controlSessionId: string;
  clockMs: number;
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-recovery-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(wsId, 'test', '/tmp/test-ws');
  const stub = new RecoveryStubClient();
  const proxyMgr = new StubProxyManager(stub);
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    new QueueManager(db),
    dir,
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
  return { dir, db, sessions, service, dispatcher, stub, controlSessionId: controlSession.id, clockMs };
}

async function teardown(fx: Fixture): Promise<void> {
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
}

/** Completes a live Turn through the provider-notification lifecycle. */
function completeTurn(fx: Fixture, hostTurnId: string): void {
  fx.stub.fire({
    jsonrpc: '2.0',
    method: 'turn.completed',
    params: { turnId: hostTurnId, data: { turnId: hostTurnId } },
  } as never);
  const status = fx.db.prepare('SELECT status FROM turns WHERE id = ?').get(hostTurnId) as { status: string };
  assert.equal(status.status, 'completed');
}

function newSchedule(fx: Fixture): string {
  return fx.service.createSchedule({
    name: 'Recoverable',
    prompt: 'recover prompt',
    trigger: { kind: 'cron', expression: '30 9 * * *' },
    timezone: 'UTC',
    controlSessionId: fx.controlSessionId,
    creatorActorId: 'internal-session:actor',
  }).id;
}

test('a crash before the dispatch decision returns the Run to scheduled', async () => {
  const fx = await setup();
  try {
    const scheduleId = newSchedule(fx);
    const run = fx.service.repository.insertRun({
      scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: new Date(fx.clockMs).toISOString(),
      now: new Date(fx.clockMs).toISOString(),
    });
    fx.service.repository.claimRunForDispatch(
      run.id,
      randomUUID(),
      new Date(fx.clockMs + 30_000).toISOString(),
      new Date(fx.clockMs).toISOString(),
    );
    await fx.dispatcher.recoverRun(fx.service.repository.runRow(run.id)!);
    const recovered = fx.service.repository.runRow(run.id)!;
    assert.equal(recovered.status, 'scheduled', 'phase claimed restarts dispatch from scratch');
    assert.equal(fx.stub.startTurnCalls.length, 0);
  } finally {
    await teardown(fx);
  }
});

test('a crash after the claim but before the send resumes exactly one send (contract K)', async () => {
  const fx = await setup();
  try {
    const scheduleId = newSchedule(fx);
    const run = fx.service.repository.insertRun({
      scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: new Date(fx.clockMs).toISOString(),
      now: new Date(fx.clockMs).toISOString(),
    });
    fx.service.repository.claimRunForDispatch(
      run.id,
      randomUUID(),
      new Date(fx.clockMs + 30_000).toISOString(),
      new Date(fx.clockMs).toISOString(),
    );
    fx.service.repository.resolveRunMode(run.id, 'bound_session', fx.controlSessionId, null, new Date(fx.clockMs).toISOString());
    await fx.dispatcher.recoverRun(fx.service.repository.runRow(run.id)!);
    const recovered = fx.service.repository.runRow(run.id)!;
    assert.equal(recovered.status, 'running');
    assert.equal(fx.stub.startTurnCalls.length, 1, 'exactly one prompt crossed');
  } finally {
    await teardown(fx);
  }
});

test('a crash inside the send window (event persisted, acceptance unrecorded) becomes unknown and never re-sends', async () => {
  const fx = await setup();
  try {
    const scheduleId = newSchedule(fx);
    const runId = fx.service.repository.insertRun({
      scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: new Date(fx.clockMs).toISOString(),
      now: new Date(fx.clockMs).toISOString(),
    }).id;
    // Dispatch normally, then rewind the run into the crash window
    // (starting/resolved, turn unbound). The crash may have happened before
    // startTurn was called OR after the Provider accepted — the Host cannot
    // tell, because the canonical user_message event persists BEFORE startTurn
    // and the acceptance record (markRunDispatched) only lands after it.
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const dispatched = fx.service.repository.runRow(runId)!;
    assert.equal(dispatched.status, 'running');
    const sendsBefore = fx.stub.startTurnCalls.length;
    fx.service.repository.updateRunColumns(runId, {
      status: 'starting',
      turnId: null,
    }, new Date(fx.clockMs + 1_000).toISOString());
    fx.db.prepare(
      `UPDATE schedule_runs SET dispatch_phase = 'resolved', lease_token = 'stale', lease_expires_at = ?
        WHERE id = ?`,
    ).run(new Date(fx.clockMs - 1_000).toISOString(), runId);

    // Expired-lease sweep → recovery finds the local origin event but no
    // recorded acceptance: unknown + paused, prompt never replayed.
    const stale = fx.service.repository.startingRunRowsWithExpiredLease(new Date(fx.clockMs + 2_000).toISOString());
    assert.equal(stale.length, 1);
    await fx.dispatcher.recoverRun(stale[0]!);
    const recovered = fx.service.repository.runRow(runId)!;
    assert.equal(recovered.status, 'unknown');
    assert.equal(recovered.turn_id, null, 'no acceptance means no Turn binding');
    assert.equal(fx.stub.startTurnCalls.length, sendsBefore, 'the prompt was never replayed');
    const schedule = fx.service.getSchedule(scheduleId);
    assert.equal(schedule.status, 'paused');
    assert.equal(schedule.status_reason, 'unknown_run');
  } finally {
    await teardown(fx);
  }
});

test('a claimed fork run whose hidden Fork Session row vanished becomes unknown and pauses', async () => {
  const fx = await setup();
  try {
    const scheduleId = newSchedule(fx);
    const run = fx.service.repository.insertRun({
      scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: new Date(fx.clockMs).toISOString(),
      now: new Date(fx.clockMs).toISOString(),
    });
    const now = new Date(fx.clockMs).toISOString();
    fx.service.repository.claimRunForDispatch(run.id, randomUUID(), new Date(fx.clockMs + 30_000).toISOString(), now);
    // The fork decision persisted but the Fork Session row was lost
    // (host crash between the provider fork and the canonical INSERT).
    fx.service.repository.resolveRunMode(run.id, 'fork', 'missing-fork-session', {
      turn_id: 't',
      source_turn_id: 'src',
    }, now);
    await fx.dispatcher.recoverRun(fx.service.repository.runRow(run.id)!);
    const recovered = fx.service.repository.runRow(run.id)!;
    assert.equal(recovered.status, 'unknown', 'a possible provider-side fork is never re-forked');
    assert.equal(fx.service.getSchedule(scheduleId).status, 'paused');
    assert.equal(fx.service.getSchedule(scheduleId).status_reason, 'unknown_run');
    assert.equal(fx.stub.startTurnCalls.length, 0);
  } finally {
    await teardown(fx);
  }
});

test('a claimed fork run with a published Fork Session resumes the send into the Fork', async () => {
  const fx = await setup();
  try {
    const scheduleId = newSchedule(fx);
    const run = fx.service.repository.insertRun({
      scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: new Date(fx.clockMs).toISOString(),
      now: new Date(fx.clockMs).toISOString(),
    });
    const now = new Date(fx.clockMs).toISOString();
    fx.service.repository.claimRunForDispatch(run.id, randomUUID(), new Date(fx.clockMs + 30_000).toISOString(), now);
    // Publish a real hidden Fork first (needs a stable head Turn), then crash
    // before the send.
    const sent = await fx.sessions.sendMessage(fx.controlSessionId, 'history for the fork anchor');
    fx.stub.fire({
      jsonrpc: '2.0',
      method: 'turn.completed',
      params: { turnId: sent!.turnId, data: { turnId: sent!.turnId } },
    } as never);
    const fork = await fx.sessions.forkSession({
      sourceSessionId: fx.controlSessionId,
      sessionId: randomUUID(),
      anchor: { type: 'turn', turnId: sent!.turnId, sourceTurnId: sent!.turnId },
      hidden: true,
      name: '[Schedule] orphan',
    });
    fx.service.repository.resolveRunMode(run.id, 'fork', fork.sessionId, {
      turn_id: fork.origin.turn_id,
      source_turn_id: fork.origin.source_turn_id,
    }, now);
    await fx.dispatcher.recoverRun(fx.service.repository.runRow(run.id)!);
    const recovered = fx.service.repository.runRow(run.id)!;
    assert.equal(recovered.status, 'running');
    assert.equal(fx.stub.startTurnCalls.length, 1);
    assert.equal(recovered.target_session_id, fork.sessionId);
    // The scheduled prompt landed in the hidden Fork's canonical transcript.
    const forkEvent = fx.db.prepare(
      `SELECT COUNT(*) AS n FROM events
        WHERE session_id = ? AND type = 'user_message'
          AND json_extract(data, '$.scheduled_task.run_id') = ?`,
    ).get(fork.sessionId, run.id) as { n: number };
    assert.equal(forkEvent.n, 1, 'the prompt went to the hidden Fork');
  } finally {
    await teardown(fx);
  }
});

test('an archived Schedule fails its in-flight starting Run at recovery', async () => {
  const fx = await setup();
  try {
    const scheduleId = newSchedule(fx);
    const run = fx.service.repository.insertRun({
      scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: new Date(fx.clockMs).toISOString(),
      now: new Date(fx.clockMs).toISOString(),
    });
    fx.service.repository.claimRunForDispatch(
      run.id,
      randomUUID(),
      new Date(fx.clockMs + 30_000).toISOString(),
      new Date(fx.clockMs).toISOString(),
    );
    fx.service.archiveSchedule(scheduleId);
    await fx.dispatcher.recoverRun(fx.service.repository.runRow(run.id)!);
    const recovered = fx.service.repository.runRow(run.id)!;
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error_code, 'SCHEDULE_ARCHIVED');
  } finally {
    await teardown(fx);
  }
});

test('boot Live Sync selection includes hidden schedule Fork Sessions (P1-3)', async () => {
  const fx = await setup();
  try {
    // Dispatch to fork so a real hidden fork session exists (claude).
    const sent = await fx.sessions.sendMessage(fx.controlSessionId, 'anchor');
    completeTurn(fx, sent!.turnId);
    await fx.sessions.sendMessage(fx.controlSessionId, 'busy');
    const scheduleId = newSchedule(fx);
    const runId = fx.service.repository.insertRun({
      scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: new Date(fx.clockMs).toISOString(),
      now: new Date(fx.clockMs).toISOString(),
    }).id;
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const forkSessionId = fx.service.getRun(runId).target_session_id!;
    const forkRow = fx.db.prepare('SELECT hidden, executor FROM sessions WHERE id = ?')
      .get(forkSessionId) as { hidden: number; executor: string };
    assert.equal(forkRow.hidden, 1);

    const rows = selectBootWatcherRows(fx.db);
    assert.ok(
      rows.some(row => row.id === forkSessionId && row.executor === 'claude'),
      'the hidden fork is selected for Live Sync at boot',
    );
  } finally {
    await teardown(fx);
  }
});

test('Host restart -> persisted running Turn -> reattach restores the generation and a provider terminal settles the Run (P1-3)', async () => {
  const fx = await setup();
  try {
    // A fork Run accepted by the provider and still running when the Host dies.
    const anchor = await fx.sessions.sendMessage(fx.controlSessionId, 'anchor');
    completeTurn(fx, anchor!.turnId);
    await fx.sessions.sendMessage(fx.controlSessionId, 'busy');
    const scheduleId = newSchedule(fx);
    const runId = fx.service.repository.insertRun({
      scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: new Date(fx.clockMs).toISOString(),
      now: new Date(fx.clockMs).toISOString(),
    }).id;
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    assert.equal(fx.service.getRun(runId).status, 'running');

    // Simulate the restart: a fresh SessionManager (no in-memory generations)
    // over the same canonical DB, wired through the real orchestrator.
    const restartedSessions = new SessionManager(
      fx.db,
      new StubProxyManager(fx.stub) as never,
      { broadcast() {}, add() {}, remove() {}, send() {}, size: 0 } as never,
      new ApprovalManager({ broadcast() {}, add() {}, remove() {}, send() {}, size: 0 } as never),
      new QueueManager(fx.db),
      fx.dir,
    );
    const orchestrator = new ScheduleOrchestrator(
      { service: fx.service, dispatcher: fx.dispatcher, broadcaster: { broadcast() {}, add() {}, remove() {}, send() {}, size: 0 } as never, db: fx.db, sessions: restartedSessions },
      { now: () => ({ ms: fx.clockMs, iso: new Date(fx.clockMs).toISOString() }) },
    );
    await orchestrator.reconcileNonTerminalRuns();

    // The provider completes the restored generation: the notification must
    // settle the restored Turn (not be dropped) and settle the Run.
    const boundTurnId = fx.service.getRun(runId).turn_id!;
    const providerTurnId = 'provider-turn-after-restart';
    fx.stub.fire({
      jsonrpc: '2.0',
      method: 'turn.completed',
      params: {
        turnId: boundTurnId,
        sourceTurnId: providerTurnId,
        data: { turnId: boundTurnId },
      },
    } as never);
    // The next pulse's reconcile observes the terminal Turn.
    await orchestrator.reconcileNonTerminalRuns();
    const settled = fx.service.getRun(runId);
    assert.equal(settled.status, 'succeeded', 'restored generation settled the Run');
    const turnRow = fx.db.prepare('SELECT status FROM turns WHERE id = ?').get(boundTurnId) as { status: string };
    assert.equal(turnRow.status, 'completed');
    assert.equal(restartedSessions.getActiveTurn(fx.service.getRun(runId).target_session_id!), null);
  } finally {
    await teardown(fx);
  }
});

test('failed attaches back off instead of retrying every pulse and fail closed after the bound (P1-3)', async () => {
  const fx = await setup();
  try {
    const anchor = await fx.sessions.sendMessage(fx.controlSessionId, 'anchor');
    completeTurn(fx, anchor!.turnId);
    await fx.sessions.sendMessage(fx.controlSessionId, 'busy');
    const scheduleId = newSchedule(fx);
    const runId = fx.service.repository.insertRun({
      scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: new Date(fx.clockMs).toISOString(),
      now: new Date(fx.clockMs).toISOString(),
    }).id;
    await fx.dispatcher.dispatchRun(fx.service.repository.runRow(runId)!);
    const targetSessionId = fx.service.getRun(runId).target_session_id!;

    let backoffUntil = 0;
    const failingProxy = new FailingProxyManager(fx.stub);
    const restartedSessions = new SessionManager(
      fx.db,
      failingProxy as unknown as ProxyManager,
      { broadcast() {}, add() {}, remove() {}, send() {}, size: 0 } as never,
      new ApprovalManager({ broadcast() {}, add() {}, remove() {}, send() {}, size: 0 } as never),
      new QueueManager(fx.db),
      fx.dir,
    );
    const orchestrator = new ScheduleOrchestrator(
      {
        service: fx.service,
        dispatcher: fx.dispatcher,
        broadcaster: { broadcast() {}, add() {}, remove() {}, send() {}, size: 0 } as never,
        db: fx.db,
        sessions: restartedSessions,
      },
      { now: () => ({ ms: fx.clockMs, iso: new Date(fx.clockMs).toISOString() }) },
    );
    // Pulse 1: attempt #1 fails, backoff is scheduled.
    await orchestrator.reconcileNonTerminalRuns(fx.clockMs);
    // Pulse 2 immediately after: inside the backoff window, no new attempt.
    await orchestrator.reconcileNonTerminalRuns(fx.clockMs + 500);
    assert.equal(failingProxy.attempts, 1, 'backoff suppressed the second attempt');
    // Attempts keep failing until the fail-closed bound.
    let clock = fx.clockMs + 2_000;
    while (failingProxy.attempts < 10 && clock < fx.clockMs + 60 * 60_000) {
      backoffUntil = clock;
      await orchestrator.reconcileNonTerminalRuns(clock);
      clock += 120_000; // step past each backoff window (1s..60s cap)
    }
    assert.equal(failingProxy.attempts, 10, 'attach attempts stop at the fail-closed bound');
    const settled = fx.service.getRun(runId);
    assert.equal(settled.status, 'unknown', 'an unattachable target fails closed');
    assert.equal(fx.service.getSchedule(scheduleId).status_reason, 'unknown_run');
    const turn = fx.db.prepare('SELECT status FROM turns WHERE id = ?')
      .get(settled.turn_id!) as { status: string };
    const target = fx.db.prepare('SELECT status FROM sessions WHERE id = ?')
      .get(targetSessionId) as { status: string };
    assert.equal(turn.status, 'stopped', 'the unattachable accepted Turn is no longer left running');
    assert.equal(target.status, 'done', 'the hidden target is no longer left busy');
    assert.equal(restartedSessions.getActiveTurn(targetSessionId), null);
    void backoffUntil;
  } finally {
    await teardown(fx);
  }
});

test('boot recovery completes inside the pulse single-flight barrier', async () => {
  const fx = await setup();
  try {
    let releaseBoot!: () => void;
    let signalBootStarted!: () => void;
    const bootStarted = new Promise<void>(resolve => { signalBootStarted = resolve; });
    const bootGate = new Promise<void>(resolve => { releaseBoot = resolve; });
    let dispatchPasses = 0;
    const dispatcher = {
      async recoverStartingRuns() {
        signalBootStarted();
        await bootGate;
      },
      async dispatchReadyRuns() { dispatchPasses += 1; },
      async recoverRun() {},
      markUnknown() {},
      reconcileRunAgainstEvidence() { return 'unchanged' as const; },
    } as unknown as ScheduleRunDispatcher;
    const timers = {
      setInterval() { return {}; },
      clearInterval() {},
      setTimeout() { return {}; },
      clearTimeout() {},
    };
    const orchestrator = new ScheduleOrchestrator(
      {
        service: fx.service,
        dispatcher,
        broadcaster: { broadcast() {}, add() {}, remove() {}, send() {}, size: 0 } as never,
        db: fx.db,
      },
      { timers },
    );
    orchestrator.start();
    await bootStarted;
    const pulse = orchestrator.runPulse();
    await Promise.resolve();
    assert.equal(dispatchPasses, 0, 'normal dispatch waits for boot recovery');
    releaseBoot();
    await pulse;
    assert.equal(dispatchPasses, 1, 'the queued pulse runs once after boot recovery');
    await orchestrator.stop();
  } finally {
    await teardown(fx);
  }
});
