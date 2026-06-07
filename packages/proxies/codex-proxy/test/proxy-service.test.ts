import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { CodexProxyService } from '../src/core/service.js';
import type { InputItem } from '../src/core/types.js';
import type { CodexRuntime, RuntimeNotification, RuntimeServerRequest } from '../src/runtime/types.js';

class FakeRuntime extends EventEmitter implements CodexRuntime {
  nextThreadId = 1;
  nextTurnId = 1;
  compactCalls: string[] = [];
  setThreadNameCalls: Array<{ threadId: string; name: string }> = [];
  startTurnCalls: Array<{ threadId: string; input: InputItem[] }> = [];
  readonly responses: Array<{ id: number | string; payload: unknown }> = [];
  readonly threads = new Map<string, unknown>();

  async ensureStarted() {}

  async startThread(options: {
    cwd: string;
    model?: string | null;
    ephemeral?: boolean;
  }) {
    const threadId = `thread-${this.nextThreadId++}`;
    this.threads.set(threadId, {
      id: threadId,
      preview: '',
      cwd: options.cwd,
      turns: [],
    });
    return { thread: { id: threadId } };
  }

  async resumeThread(_threadId: string) {
    return {};
  }

  async readThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error('thread missing');
    }
    return { thread };
  }

  async startTurn(threadId: string, _input: InputItem[]) {
    this.startTurnCalls.push({ threadId, input: _input });
    const turnId = `turn-${this.nextTurnId++}`;
    const thread = this.threads.get(threadId) as { turns: unknown[] };
    thread.turns.push({
      id: turnId,
      status: 'running',
      items: [],
    });
    return { turn: { id: turnId, status: 'running' } };
  }

  async compactThread(threadId: string) {
    this.compactCalls.push(threadId);
    const turnId = `compact-${this.nextTurnId++}`;
    const thread = this.threads.get(threadId) as { turns: unknown[] };
    thread.turns.push({
      id: turnId,
      status: 'running',
      items: [],
    });
    return {};
  }

  async setThreadName(threadId: string, name: string) {
    this.setThreadNameCalls.push({ threadId, name });
    return {};
  }

  async interruptTurn(_threadId: string, _turnId: string) {
    return {};
  }

  async respond(id: number | string, result: unknown) {
    this.responses.push({ id, payload: result });
    return {};
  }

  async listAllModels() {
    return [{
      id: 'gpt-5-codex',
      model: 'gpt-5-codex',
      displayName: 'GPT-5 Codex',
      description: 'test model',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
      ],
    }];
  }

  async listSkills(_cwd?: string) {
    return { data: [] };
  }

  async unsubscribeThread(_threadId: string) {
    return {};
  }

  async stop() {}

  emitNotification(message: RuntimeNotification) {
    this.emit('notification', message);
  }

  emitServerRequest(message: RuntimeServerRequest) {
    this.emit('serverRequest', message);
  }

  setCompletedTurn(threadId: string, turnId: string) {
    const thread = this.threads.get(threadId) as {
      preview: string;
      turns: Array<{ id: string; status: string; items: unknown[] }>;
    };
    const turn = thread.turns.find((entry) => entry.id === turnId);
    if (!turn) {
      throw new Error('turn missing');
    }
    turn.status = 'completed';
    turn.items = [
      {
        type: 'agentMessage',
        id: 'msg-1',
        text: 'done',
      },
      {
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'ls',
        cwd: '/tmp/work',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'file.txt',
      },
      {
        type: 'fileChange',
        id: 'file-1',
        status: 'completed',
        changes: [{
          path: 'file.txt',
          kind: { type: 'update' },
          diff: '@@ -1 +1 @@',
        }],
      },
    ];
    thread.preview = 'done';
  }
}

async function createHarness() {
  const runtime = new FakeRuntime();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const service = new CodexProxyService({
    runtime,
    emitEvent(method, params) {
      events.push({ method, params });
    },
  });
  await service.initialize();
  return {
    runtime,
    service,
    events,
    async cleanup() {
      await service.close();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, 'Timed out waiting for expected condition.');
}

test('session.setName routes to runtime.setThreadName with threadId+name (SESSION-NAME-001)', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });

    await harness.service.setName({ sessionId: created.session.id, name: '  My Session  ' });
    assert.deepEqual(harness.runtime.setThreadNameCalls, [
      { threadId: created.session.threadId, name: 'My Session' },
    ]);

    // Empty / whitespace-only name is a no-op — we never clear an existing name.
    await harness.service.setName({ sessionId: created.session.id, name: '   ' });
    assert.equal(harness.runtime.setThreadNameCalls.length, 1);

    // Control characters (CR/LF/tab) are stripped to spaces.
    await harness.service.setName({ sessionId: created.session.id, name: 'a\nb\tc' });
    assert.equal(harness.runtime.setThreadNameCalls.at(-1)!.name, 'a b c');
  } finally {
    await harness.cleanup();
  }
});

test('session.create binds a session to a thread and returns id + threadId', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });

    assert.match(created.session.id, /^sess[_-]/);
    assert.match(created.session.threadId, /^thread-/);
    assert.equal('sessionKey' in created.session, false);

    // Each call mints a fresh session/thread — no duplicate-key concept.
    const second = await harness.service.createSession({
      cwd: '/tmp/work',
    });
    assert.notEqual(created.session.id, second.session.id);
    assert.notEqual(created.session.threadId, second.session.threadId);
  } finally {
    await harness.cleanup();
  }
});

test('session.create with threadId resumes the existing codex thread', async () => {
  const harness = await createHarness();
  try {
    let resumed: string | null = null;
    harness.runtime.resumeThread = async (threadId: string) => {
      resumed = threadId;
      return {};
    };

    const created = await harness.service.createSession({
      cwd: '/tmp/work',
      threadId: 'thread-existing-42',
    });

    assert.equal(resumed, 'thread-existing-42');
    assert.equal(created.session.threadId, 'thread-existing-42');
  } finally {
    await harness.cleanup();
  }
});

test('Codex native /compact uses app-server thread/compact/start', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });

    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: '/compact' }],
    }, 41);

    assert.equal(harness.runtime.compactCalls.length, 1);
    assert.equal(harness.runtime.compactCalls[0], created.session.threadId);
    assert.equal(harness.runtime.startTurnCalls.length, 0, '/compact must not leak as prompt text');
    assert.equal(started.turn.status, 'running');

    const startedEvent = harness.events.find((entry) => entry.method === 'turn.started');
    assert.equal((startedEvent?.params.data as { command?: string } | undefined)?.command, '/compact');
    assert.equal(harness.service.getSession({ sessionId: created.session.id }).session.status, 'running');
  } finally {
    await harness.cleanup();
  }
});

test('Codex thread/compacted notification completes intercepted /compact turn', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });

    await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: '/compact' }],
    }, 44);

    const compactTurnId = 'compact-1';
    harness.runtime.setCompletedTurn(created.session.threadId, compactTurnId);
    harness.runtime.emitNotification({
      method: 'thread/compacted',
      params: {
        threadId: created.session.threadId,
        turnId: compactTurnId,
      },
    });

    await waitFor(() => harness.events.some((entry) => entry.method === 'turn.completed'));

    const completedEvent = harness.events.find((entry) => entry.method === 'turn.completed');
    assert.equal(completedEvent?.params.turnId, compactTurnId);
    assert.equal((completedEvent?.params.data as { compacted?: boolean } | undefined)?.compacted, true);
    assert.equal(harness.service.getSession({ sessionId: created.session.id }).session.status, 'idle');
  } finally {
    await harness.cleanup();
  }
});

test('Codex native /clear rotates the underlying thread id and completes locally', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });
    const oldThreadId = created.session.threadId;

    const result = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: '/clear' }],
    }, 42);

    assert.equal(result.turn.status, 'completed');
    assert.equal(harness.runtime.startTurnCalls.length, 0, '/clear must not leak as prompt text');

    const current = harness.service.getSession({ sessionId: created.session.id }).session;
    assert.notEqual(current.threadId, oldThreadId);
    const rotated = harness.events.find((entry) => entry.method === 'session.rotated');
    assert.deepEqual(rotated?.params.data, {
      oldNativeSessionId: oldThreadId,
      newNativeSessionId: current.threadId,
    });
    assert.ok(harness.events.some((entry) => entry.method === 'output.text.delta'));
    assert.ok(harness.events.some((entry) => entry.method === 'turn.completed'));
  } finally {
    await harness.cleanup();
  }
});

test('TUI-only Codex native commands complete with a local explanation', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });

    const result = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: '/model gpt-5.4' }],
    }, 43);

    assert.equal(result.turn.status, 'completed');
    assert.equal(harness.runtime.startTurnCalls.length, 0, '/model must not leak as prompt text');
    const output = harness.events.find((entry) => entry.method === 'output.text.delta');
    assert.match(String((output?.params.data as { delta?: unknown } | undefined)?.delta ?? ''), /model selector/);
    assert.equal(harness.service.getSession({ sessionId: created.session.id }).session.status, 'idle');
  } finally {
    await harness.cleanup();
  }
});

test('after restart (in-memory only), session is unknown until recreated via threadId', async () => {
  // Proxy is now process-memory only. If the proxy restarts, the in-memory
  // sessionsById map is empty and any RPC referencing the prior sessionId
  // gets SESSION_NOT_FOUND. Host's reconnect path then calls
  // session.create({ threadId }) to re-bind the session record to the
  // existing codex thread (via thread/resume).
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });
    const threadId = created.session.threadId;

    // Simulate restart by closing + creating a fresh service against the
    // same runtime (state-store is gone, so nothing to reload from disk).
    await harness.service.close();
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fresh = new CodexProxyService({
      runtime: harness.runtime,
      emitEvent(method, params) {
        events.push({ method, params });
      },
    });
    await fresh.initialize();

    // Old session id is no longer known.
    assert.throws(
      () => fresh.getSession({ sessionId: created.session.id }),
      /not found/,
    );

    // Host's reconnect path: createSession({ threadId }) re-adopts.
    const readopted = await fresh.createSession({
      cwd: '/tmp/work',
      threadId,
    });
    assert.equal(readopted.session.threadId, threadId);
    assert.notEqual(readopted.session.id, created.session.id);
    await fresh.close();
  } finally {
    await harness.cleanup();
  }
});

test('unsafe-agent relays approvals upstream and translates approval responses', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });
    const turn = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'do work' }],
    }, 10);

    harness.runtime.emitServerRequest({
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: created.session.threadId,
        command: 'ls',
      },
    });

    await waitFor(() => harness.events.some((entry) => entry.method === 'approval.requested'));

    const approvalEvent = harness.events.find((entry) => entry.method === 'approval.requested');
    assert.ok(approvalEvent);
    const approvalData = approvalEvent?.params.data as {
      approvalId: string;
      reason: string;
      severity: string;
      risk: string;
    };
    assert.equal(approvalData.approvalId, '99');
    assert.equal(approvalData.reason, 'ls');
    assert.equal(approvalData.severity, 'medium');
    assert.equal(approvalData.risk, 'ls');

    await harness.service.respondApproval({
      sessionId: created.session.id,
      approvalId: '99',
      decision: 'accept',
      scope: 'session',
    });

    assert.deepEqual(harness.runtime.responses.at(-1), {
      id: 99,
      payload: { decision: 'acceptForSession' },
    });
    assert.equal(turn.turn.status, 'running');
  } finally {
    await harness.cleanup();
  }
});

test('approvals are always relayed upstream (mode-driven auto-approval was removed)', async () => {
  // The legacy `safe-agent` mode auto-approved workspace-scoped file changes
  // and network-only permission requests inside the proxy. That behavior was
  // removed in the 4-mode redesign: codex's `auto_review` reviewer handles
  // auto-approval inside codex itself, and host's ApprovalManager handles
  // any approvals that surface up. The proxy itself just relays now.
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });
    await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'fetch docs' }],
    }, 11);

    harness.runtime.emitServerRequest({
      id: 5,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: created.session.threadId,
        permissions: { network: true },
        reason: 'Need docs',
      },
    });

    await waitFor(() => harness.events.some((entry) => entry.method === 'approval.requested'));
    const approvalEvent = harness.events.find((entry) => entry.method === 'approval.requested');
    assert.ok(approvalEvent);
    const data = approvalEvent.params.data as {
      reason: string;
      severity: string;
      permissionsKind?: string;
      risk: string;
    };
    assert.equal(data.reason, 'Need docs');
    assert.equal(data.severity, 'low');
    assert.equal(data.permissionsKind, 'network');
    assert.equal(data.risk, 'Need docs');
  } finally {
    await harness.cleanup();
  }
});

test('turn completion emits a normalized summary with commands and file changes', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });
    const turn = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'finish task' }],
    }, 12);
    harness.runtime.setCompletedTurn(created.session.threadId, turn.turn.id);
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: created.session.threadId,
        turn: {
          id: turn.turn.id,
          status: 'completed',
        },
      },
    });

    await waitFor(() => harness.events.some((entry) => entry.method === 'turn.completed'));

    const completedEvent = harness.events.find((entry) => entry.method === 'turn.completed');
    assert.ok(completedEvent);
    const summary = (completedEvent?.params.data as { summary: { assistantText: string; commands: unknown[]; fileChanges: unknown[] } }).summary;
    assert.equal(summary.assistantText, 'done');
    assert.equal(summary.commands.length, 1);
    assert.equal(summary.fileChanges.length, 1);

    const snapshot = await harness.service.sessionSnapshot({ sessionId: created.session.id });
    assert.equal(typeof (snapshot.thread as { preview?: unknown }).preview, 'string');
  } finally {
    await harness.cleanup();
  }
});
