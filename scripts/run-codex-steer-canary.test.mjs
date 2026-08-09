import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { runCodexSteerCanary } from './run-codex-steer-canary.mjs';

const scriptUrl = new URL('./run-codex-steer-canary.mjs', import.meta.url);

class FakeCodexClient extends EventEmitter {
  static calls = [];

  constructor(options) {
    super();
    this.thread = null;
    FakeCodexClient.calls.push(['construct', options]);
  }

  async ensureStarted() {
    FakeCodexClient.calls.push(['ensureStarted']);
  }

  async startThread(options) {
    FakeCodexClient.calls.push(['startThread', options]);
    this.thread = { id: 'thread-1', turns: [] };
    return {
      thread: { id: this.thread.id },
      configuredPermissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } },
    };
  }

  async startTurn(threadId, input) {
    FakeCodexClient.calls.push(['startTurn', threadId, input]);
    assert.equal(threadId, this.thread.id);
    const turn = { id: 'turn-1', status: 'inProgress', items: [] };
    this.thread.turns.push(turn);
    return { turn };
  }

  async steerTurn(threadId, turnId, input) {
    FakeCodexClient.calls.push(['steerTurn', threadId, turnId, input]);
    assert.equal(threadId, this.thread.id);
    assert.equal(turnId, this.thread.turns[0].id);
    this.thread.turns[0].status = 'completed';
    this.thread.turns[0].items = [{
      id: 'message-1',
      type: 'agentMessage',
      text: 'Acknowledged: GIAN_STEER_CANARY_OK',
    }];
    queueMicrotask(() => {
      this.emit('notification', {
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed' } },
      });
    });
    return { turnId };
  }

  async readThread(threadId) {
    FakeCodexClient.calls.push(['readThread', threadId]);
    assert.equal(threadId, this.thread.id);
    return { thread: this.thread };
  }

  async stop() {
    FakeCodexClient.calls.push(['stop']);
    this.emit('runtimeStopped');
  }
}

test('steer canary refuses before constructing a client without explicit authorization', async () => {
  const previous = process.env.GIAN_ALLOW_REAL_AGENT_TURN;
  delete process.env.GIAN_ALLOW_REAL_AGENT_TURN;
  FakeCodexClient.calls = [];
  try {
    await assert.rejects(
      runCodexSteerCanary({ ClientClass: FakeCodexClient }),
      /Refusing to send a quota-consuming Codex model turn/,
    );
    assert.deepEqual(FakeCodexClient.calls, []);
  } finally {
    if (previous === undefined) delete process.env.GIAN_ALLOW_REAL_AGENT_TURN;
    else process.env.GIAN_ALLOW_REAL_AGENT_TURN = previous;
  }
});

test('authorized steer canary injects into one ephemeral in-flight turn', async () => {
  FakeCodexClient.calls = [];
  const summary = await runCodexSteerCanary({
    allowRealAgentTurn: true,
    ClientClass: FakeCodexClient,
    codexBin: '/fake/codex',
    completionTimeoutMs: 1_000,
  });

  assert.deepEqual(summary, {
    quotaConsuming: true,
    modelTurnSent: true,
    ephemeralThread: true,
    turnId: 'turn-1',
    sameTurnSteered: true,
    steerMarkerObserved: true,
    turnCount: 1,
    completed: true,
    runtimeStopped: true,
    debugLineCount: 0,
  });
  assert.deepEqual(
    FakeCodexClient.calls.map(call => call[0]),
    ['construct', 'ensureStarted', 'startThread', 'startTurn', 'steerTurn', 'readThread', 'stop'],
  );
  assert.equal(FakeCodexClient.calls[2][1].ephemeral, true);
  await assert.rejects(stat(FakeCodexClient.calls[2][1].cwd), { code: 'ENOENT' });
  assert.equal(FakeCodexClient.calls[3][1], FakeCodexClient.calls[4][1]);
  assert.equal(FakeCodexClient.calls[4][2], 'turn-1');
});

test('steer canary source keeps its quota gate and ephemeral-thread contract visible', async () => {
  const source = await readFile(scriptUrl, 'utf8');
  assert.match(source, /GIAN_ALLOW_REAL_AGENT_TURN/);
  assert.match(source, /\.startThread\(\{ cwd: canaryRoot, ephemeral: true \}\)/);
  assert.match(source, /\.startTurn\s*\(/);
  assert.match(source, /\.steerTurn\s*\(/);
});
