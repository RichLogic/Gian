import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  runKimiLifecycleCanary,
  sampleProcessGroupRss,
} from './run-kimi-lifecycle-canary.mjs';

class ExplodingClient {
  constructor() {
    throw new Error('client must not be constructed');
  }
}

function configOptions(mode = 'default') {
  return [{
    id: 'mode',
    role: 'approval_mode',
    binding: 'session',
    control: 'select',
    defaultValue: 'default',
    currentValue: mode,
    choices: [
      { value: 'default', displayName: 'Default' },
      { value: 'plan', displayName: 'Plan' },
      { value: 'auto', displayName: 'Auto' },
      { value: 'yolo', displayName: 'YOLO' },
    ],
  }];
}

class FakeKimiLifecycleClient extends EventEmitter {
  static nativeSessions = new Map();
  static nextNative = 1;
  static nextProxy = 1;
  static nextTurn = 1;
  static nextProcessGroup = 9000;

  static reset() {
    this.nativeSessions.clear();
    this.nextNative = 1;
    this.nextProxy = 1;
    this.nextTurn = 1;
    this.nextProcessGroup = 9000;
  }

  constructor() {
    super();
    this.processGroupId = FakeKimiLifecycleClient.nextProcessGroup++;
    this.sessions = new Map();
    this.stopped = false;
  }

  async ensureStarted() {}

  notify(method, params) {
    this.emit('notification', { method, params });
  }

  sessionRecord(session) {
    return {
      id: session.id,
      nativeSession: { id: session.nativeSessionId },
      streamId: session.streamId,
      state: session.activeTurnId ? 'running' : 'idle',
      sessionConfig: { mode: session.mode },
      lastError: null,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    };
  }

  completeTextTurn(session, turnId, marker) {
    const native = FakeKimiLifecycleClient.nativeSessions.get(session.nativeSessionId);
    native.history.push(marker);
    this.notify('content.delta', {
      sessionId: session.id,
      turnId,
      data: { kind: 'text', delta: marker },
    });
    session.activeTurnId = null;
    this.notify('turn.completed', {
      sessionId: session.id,
      turnId,
      data: { stopReason: 'completed' },
    });
  }

  async request(method, params = {}) {
    if (this.stopped) throw new Error('fake Kimi proxy is stopped');
    if (method === 'initialize') {
      return {
        protocol: { name: 'gian.proxy', version: '2.0' },
        plugin: { id: 'kimi', name: 'Kimi Code', version: '0.2.0' },
        process: { scope: 'shared' },
        capabilities: { 'session.replay': 1, interaction: 1 },
      };
    }
    if (method === 'catalog.list') {
      return {
        catalogRevision: 'kimi-fixture-1',
        input: [{ type: 'text' }, { type: 'localFile' }],
        configOptions: configOptions(),
        slashCommands: [],
      };
    }
    if (method === 'session.create') {
      const nativeSessionId = params.nativeSession?.id
        ?? `native-${FakeKimiLifecycleClient.nextNative++}`;
      let native = FakeKimiLifecycleClient.nativeSessions.get(nativeSessionId);
      if (!native) {
        native = { history: [] };
        FakeKimiLifecycleClient.nativeSessions.set(nativeSessionId, native);
      }
      const session = {
        id: params.sessionId ?? `proxy-${FakeKimiLifecycleClient.nextProxy++}`,
        nativeSessionId,
        streamId: `stream-${params.sessionId ?? FakeKimiLifecycleClient.nextProxy}`,
        cwd: params.workspace?.cwd ?? params.cwd,
        mode: params.config?.mode ?? 'default',
        activeTurnId: null,
      };
      this.sessions.set(session.id, session);
      return { session: this.sessionRecord(session) };
    }
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      const error = new Error('session missing');
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    if (method === 'session.get') {
      return { session: this.sessionRecord(session) };
    }
    if (method === 'session.replay') {
      const native = FakeKimiLifecycleClient.nativeSessions.get(session.nativeSessionId);
      return {
        replayStreamId: `replay-${session.id}`,
        events: (native?.history ?? []).map((text, index) => ({
          method: 'content.delta',
          eventId: `replay-${index}`,
          sessionId: session.id,
          replayStreamId: `replay-${session.id}`,
          sequence: index + 1,
          sourceTurnId: `native-${index}`,
          emittedAt: '2026-08-09T00:00:00.000Z',
          data: { kind: 'text', delta: text },
        })),
        nextCursor: null,
      };
    }
    if (method === 'session.close') {
      this.sessions.delete(session.id);
      return { ok: true };
    }
    if (method === 'turn.interrupt') {
      const turnId = params.turnId ?? session.activeTurnId;
      if (!turnId) throw new Error('no active turn');
      session.activeTurnId = null;
      queueMicrotask(() => this.notify('turn.completed', {
        sessionId: session.id,
        turnId,
        data: { stopReason: 'cancelled' },
      }));
      return { accepted: true, turnId };
    }
    if (method === 'turn.start') {
      if (session.activeTurnId) {
        const error = new Error('busy');
        error.code = 'SESSION_BUSY';
        throw error;
      }
      const turnId = params.turnId ?? `turn-${FakeKimiLifecycleClient.nextTurn++}`;
      session.activeTurnId = turnId;
      if (params.config?.mode) session.mode = params.config.mode;
      const text = params.input
        .filter(item => item?.type === 'text')
        .map(item => item.text)
        .join('\n');
      if (text.includes('do not finish until explicitly interrupted')) {
        return { accepted: true, turnId };
      }
      if (text.includes('run_in_background=true')) {
        const fixturePath = text.match(/read (.+?background-agent-fixture\.txt)/)?.[1];
        assert.ok(fixturePath, 'fake could not find background fixture path');
        const marker = (await readFile(fixturePath, 'utf8')).trim();
        queueMicrotask(() => {
          this.notify('activity.updated', {
            sessionId: session.id,
            turnId,
            data: {
              activityId: 'background-tool-1',
              presentation: {
                type: 'agent',
                data: {
                  toolCallId: 'background-tool-1',
                  title: 'Launching coder agent',
                  status: 'completed',
                  rawInput: { subagent_type: 'coder', run_in_background: true },
                  rawOutput: 'task_id: task-1\nagent_id: agent-1\nstatus: running',
                },
              },
            },
          });
          session.activeTurnId = null;
          this.notify('turn.completed', {
            sessionId: session.id,
            turnId,
            data: { stopReason: 'completed' },
          });
          setTimeout(() => {
            FakeKimiLifecycleClient.nativeSessions.get(session.nativeSessionId).history.push(marker);
            this.notify('activity.updated', {
              sessionId: session.id,
              data: {
                activityId: 'background-tool-1',
                presentation: {
                  type: 'agent',
                  data: {
                    toolCallId: 'background-tool-1',
                    title: 'Agent',
                    status: 'completed',
                    rawOutput: `task_id: task-1\nagent_id: agent-1\nstatus: completed\n\n[summary]\n${marker}`,
                  },
                },
              },
            });
          }, 5);
        });
        return { accepted: true, turnId };
      }
      const marker = text.match(/GIAN_KIMI_[A-Z_]+_[0-9a-f-]+/)?.[0] ?? text;
      queueMicrotask(() => this.completeTextTurn(session, turnId, marker));
      return { accepted: true, turnId };
    }
    throw new Error(`unexpected fake method: ${method}`);
  }

  async crash() {
    this.stopped = true;
    this.emit('runtimeStopped');
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.emit('runtimeStopped');
  }
}

test('Kimi lifecycle canary refuses before activation or client construction', async () => {
  const previous = process.env.GIAN_ALLOW_REAL_AGENT_TURN;
  delete process.env.GIAN_ALLOW_REAL_AGENT_TURN;
  let activationCalled = false;
  try {
    await assert.rejects(
      runKimiLifecycleCanary({
        binaryPath: process.execPath,
        activationImpl: async () => {
          activationCalled = true;
          return { compatible: true, activationRecorded: true };
        },
        ClientClass: ExplodingClient,
      }),
      /Refusing to send quota-consuming Kimi model turns/,
    );
    assert.equal(activationCalled, false);
  } finally {
    if (previous === undefined) delete process.env.GIAN_ALLOW_REAL_AGENT_TURN;
    else process.env.GIAN_ALLOW_REAL_AGENT_TURN = previous;
  }
});

test('Kimi lifecycle canary fails closed before client construction without store activation', async () => {
  await assert.rejects(
    runKimiLifecycleCanary({
      allowRealAgentTurn: true,
      binaryPath: process.execPath,
      activationImpl: async () => ({ compatible: true, activationRecorded: false }),
      ClientClass: ExplodingClient,
    }),
    /activation was not recorded/,
  );
});

test('Kimi lifecycle RSS sampling totals only the owned process group', async () => {
  const sample = await sampleProcessGroupRss(42, 'fixture', {
    execFileImpl: async () => ({
      stdout: [
        '100 42 12000',
        '101 42 8000',
        '102 99 50000',
        '',
      ].join('\n'),
    }),
  });
  assert.equal(sample.stage, 'fixture');
  assert.equal(sample.processGroupId, 42);
  assert.equal(sample.processCount, 2);
  assert.equal(sample.rssKiB, 20_000);
});

test('Kimi lifecycle canary covers config, stop, concurrency, background drain, crash replay, and RSS', async () => {
  FakeKimiLifecycleClient.reset();
  let rssSequence = 0;
  const summary = await runKimiLifecycleCanary({
    allowRealAgentTurn: true,
    binaryPath: process.execPath,
    activationImpl: async () => ({ compatible: true, activationRecorded: true }),
    ClientClass: FakeKimiLifecycleClient,
    detachedObservationMs: 0,
    timeoutMs: 2_000,
    rssGrowthBudgetMiB: 1,
    rssSampler: async (processGroupId, stage) => ({
      stage,
      processGroupId,
      processCount: 2,
      rssKiB: 10_000 + (rssSequence++ * 100),
      sampledAt: '2026-08-09T00:00:00.000Z',
    }),
  });

  assert.equal(summary.provider, 'kimi');
  assert.equal(summary.modelTurnsSent, 5);
  assert.equal(summary.sessionStoreActivated, true);
  assert.equal(summary.createSendStop, true);
  assert.deepEqual(summary.dynamicConfig, {
    configId: 'mode',
    alternateValue: 'plan',
    restored: true,
  });
  assert.equal(summary.sameSessionBusyRejected, true);
  assert.equal(summary.interruptedTurnCancelled, true);
  assert.equal(summary.dualSessionConcurrent, true);
  assert.equal(summary.backgroundAgent.launched, true);
  assert.equal(summary.backgroundAgent.drainedAfterParentTurn, true);
  assert.equal(summary.crashResume.proxyCrashed, true);
  assert.equal(summary.crashResume.nativeSessionReused, true);
  assert.equal(summary.crashResume.replayObserved, true);
  assert.equal(summary.crashResume.postCrashTurnCompleted, true);
  assert.deepEqual(summary.closeSemantics, {
    nativeClosed: false,
    detached: true,
    survivorSessionRemainedUsable: true,
  });
  assert.equal(summary.rss.samples.length, 7);
  assert.equal(summary.rss.rangeKiB, 600);
  assert.equal(summary.runtimeStopped, true);
});
