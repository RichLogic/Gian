import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { CodexProxyService } from '../src/core/service.js';
import { CodexProtocolV1Adapter } from '../src/protocol/v1-adapter.js';
import type { InputItem } from '../src/core/types.js';
import type { CodexRuntime, RuntimeNotification, RuntimeServerRequest } from '../src/runtime/types.js';
import { CODEX_APP_SERVER_V2_COMPACTION } from './fixtures/codex-app-server-v2-compaction.js';
import {
  parseProxyRequest,
  proxyNotificationSchema,
  resultSchemas,
  type ProxyNotification,
} from '@gian/proxy-protocol';

function bindCompactionFixture(
  notification: { method: string; params: Record<string, unknown> },
  threadId: string,
  turnId: string,
): RuntimeNotification {
  return {
    method: notification.method,
    params: { ...notification.params, threadId, turnId },
  };
}

class FakeRuntime extends EventEmitter implements CodexRuntime {
  nextThreadId = 1;
  nextTurnId = 1;
  compactCalls: string[] = [];
  setThreadNameCalls: Array<{ threadId: string; name: string }> = [];
  startTurnCalls: Array<{
    threadId: string;
    input: InputItem[];
    options: NonNullable<Parameters<CodexRuntime['startTurn']>[2]>;
  }> = [];
  readonly responses: Array<{ id: number | string; payload: unknown }> = [];
  readonly threads = new Map<string, unknown>();
  readonly interruptCalls: Array<{ threadId: string; turnId: string }> = [];

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
    return {
      thread: { id: threadId },
      configuredPermissions: {
        approvalPolicy: 'on-request' as const,
        approvalsReviewer: 'user' as const,
        permissions: ':workspace',
      },
    };
  }

  async resumeThread(threadId: string) {
    return {
      thread: { id: threadId },
      configuredPermissions: {
        approvalPolicy: 'on-request' as const,
        approvalsReviewer: 'user' as const,
        permissions: ':workspace',
      },
    };
  }

  async readThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error('thread missing');
    }
    return { thread };
  }

  async startTurn(
    threadId: string,
    _input: InputItem[],
    options: NonNullable<Parameters<CodexRuntime['startTurn']>[2]> = {},
  ) {
    this.startTurnCalls.push({ threadId, input: _input, options });
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

  async interruptTurn(threadId: string, turnId: string) {
    this.interruptCalls.push({ threadId, turnId });
    const thread = this.threads.get(threadId) as {
      turns?: Array<{ id?: string; status?: string }>;
    } | undefined;
    const turn = thread?.turns?.find(entry => entry.id === turnId);
    if (turn) turn.status = 'interrupted';
    return {};
  }

  readonly steerCalls: Array<{ threadId: string; turnId: string; input: InputItem[] }> = [];
  async steerTurn(threadId: string, turnId: string, input: InputItem[]) {
    this.steerCalls.push({ threadId, turnId, input });
    return { turnId };
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

  emitRuntimeStopped() {
    this.emit('runtimeStopped');
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

test('turn.steer forwards input to turn/steer with the active turn id', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'do work' }],
    });
    const result = await harness.service.steerTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'actually focus on tests first' }],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(harness.runtime.steerCalls, [
      {
        threadId: created.session.threadId,
        turnId: started.turn.id,
        input: [{ type: 'text', text: 'actually focus on tests first' }],
      },
    ]);
  } finally {
    await harness.cleanup();
  }
});

test('turn.start forwards a typed skill item unchanged to the Codex runtime', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{
        type: 'skill',
        name: 'project-check',
        path: '/tmp/work/.codex/skills/project-check/SKILL.md',
      }],
    });

    assert.deepEqual(harness.runtime.startTurnCalls[0]?.input, [{
      type: 'skill',
      name: 'project-check',
      path: '/tmp/work/.codex/skills/project-check/SKILL.md',
    }]);
  } finally {
    await harness.cleanup();
  }
});

test('turn.steer without an active turn rejects with NO_ACTIVE_TURN', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    await assert.rejects(
      () => harness.service.steerTurn({
        sessionId: created.session.id,
        input: [{ type: 'text', text: 'hi' }],
      }),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, 'NO_ACTIVE_TURN');
        return true;
      },
    );
    assert.equal(harness.runtime.steerCalls.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('runtimeStopped emits one session-scoped turn.failed before clearing an active turn', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'keep working' }],
    }, 73);

    harness.runtime.emitRuntimeStopped();
    await waitFor(() => harness.events.some(event => event.method === 'turn.failed'));

    const failed = harness.events.filter(event => event.method === 'turn.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.params.sessionId, created.session.id);
    assert.equal(failed[0]?.params.turnId, started.turn.id);
    assert.deepEqual(failed[0]?.params.data, {
      turnId: started.turn.id,
      code: 'RUNTIME_STOPPED',
      message: 'Codex runtime stopped while the session had an active turn.',
    });
    const current = harness.service.getSession({ sessionId: created.session.id }).session;
    assert.equal(current.status, 'stale');

    harness.runtime.emitRuntimeStopped();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(
      harness.events.filter(event => event.method === 'turn.failed').length,
      1,
      'a cleared generation must not emit another terminal event',
    );
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

test('capabilities preserve new Codex effort ids from model/list', async () => {
  const harness = await createHarness();
  try {
    harness.runtime.listAllModels = async () => [{
      id: 'gpt-future',
      model: 'gpt-future',
      displayName: 'GPT Future',
      description: 'future effort coverage',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'ultra',
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'max' },
        { reasoningEffort: 'ultra' },
      ],
    }];

    const capabilities = await harness.service.listCapabilities();
    assert.deepEqual(capabilities.models[0]?.supportedThinking, ['medium', 'max', 'ultra']);
    assert.equal(capabilities.models[0]?.defaultThinking, 'ultra');
    assert.deepEqual(capabilities.modes?.map(mode => mode.id), [
      'plan',
      'ask',
      'auto',
      'custom',
      'full-access',
    ]);
  } finally {
    await harness.cleanup();
  }
});

test('Custom permission mode restores the config-derived policy after an explicit preset', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const fullAccessTurn = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'full access turn' }],
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'auto_review',
    });
    assert.deepEqual(harness.runtime.startTurnCalls[0]?.options, {
      model: null,
      thinking: null,
      sandbox: 'danger-full-access',
      sandboxPolicy: null,
      runtimeWorkspaceRoots: ['/tmp/work'],
      permissions: null,
      approvalPolicy: 'never',
      approvalsReviewer: 'auto_review',
      collaborationMode: null,
      reasoningSummary: null,
      serviceTier: null,
    });

    harness.runtime.setCompletedTurn(created.session.threadId, fullAccessTurn.turn.id);
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: created.session.threadId,
        turn: { id: fullAccessTurn.turn.id, status: 'completed' },
      },
    });
    await waitFor(() => harness.events.some(entry => entry.method === 'turn.completed'));

    await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'custom turn' }],
      useConfiguredPermissions: true,
    });
    assert.deepEqual(harness.runtime.startTurnCalls[1]?.options, {
      model: null,
      thinking: null,
      sandbox: null,
      sandboxPolicy: null,
      runtimeWorkspaceRoots: ['/tmp/work'],
      permissions: ':workspace',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      collaborationMode: null,
      reasoningSummary: null,
      serviceTier: null,
    });
  } finally {
    await harness.cleanup();
  }
});

test('turn.start carries attachment directories as runtime workspace roots', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{
        type: 'localFile',
        path: '/tmp/gian/attachments/session/report.pdf',
        name: 'report.pdf',
      }] as unknown as InputItem[],
      additionalWorkspaceRoots: ['/tmp/gian/attachments/session'],
    });

    assert.deepEqual(
      harness.runtime.startTurnCalls[0]?.options.runtimeWorkspaceRoots,
      ['/tmp/work', '/tmp/gian/attachments/session'],
    );
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
      return {
        thread: { id: threadId },
        configuredPermissions: {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          permissions: ':workspace',
        },
      };
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

    const invalidated = harness.events.find((entry) => entry.method === 'token_usage.updated');
    assert.deepEqual(invalidated?.params.data, {
      context: null,
      reason: 'compact_started',
    });
    const startedEvent = harness.events.find((entry) => entry.method === 'turn.started');
    assert.equal((startedEvent?.params.data as { command?: string } | undefined)?.command, '/compact');
    assert.ok(
      harness.events.indexOf(invalidated!) < harness.events.indexOf(startedEvent!),
      'context must invalidate before compact starts',
    );
    assert.equal(harness.service.getSession({ sessionId: created.session.id }).session.status, 'running');
  } finally {
    await harness.cleanup();
  }
});

test('retryable Codex stream errors preserve the active turn until completion', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'keep working' }],
    }, 42);

    harness.runtime.emitNotification({
      method: 'error',
      params: {
        threadId: created.session.threadId,
        turnId: started.turn.id,
        error: {
          message: 'Reconnecting... 2/5',
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: null },
          },
        },
        willRetry: true,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const duringRetry = harness.service.getSession({ sessionId: created.session.id }).session;
    assert.equal(duringRetry.status, 'running');
    assert.equal(harness.events.some((entry) => entry.method === 'runtime.error'), false);
    await harness.service.steerTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'continue after reconnect' }],
    });
    assert.equal(harness.runtime.steerCalls.at(-1)?.turnId, started.turn.id);

    harness.runtime.setCompletedTurn(created.session.threadId, started.turn.id);
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: created.session.threadId,
        turn: { id: started.turn.id, status: 'completed' },
      },
    });

    await waitFor(() => harness.events.some((entry) => entry.method === 'turn.completed'));
    const afterCompletion = harness.service.getSession({ sessionId: created.session.id }).session;
    assert.equal(afterCompletion.status, 'idle');
  } finally {
    await harness.cleanup();
  }
});

test('non-retryable Codex runtime errors remain terminal', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'fail this turn' }],
    });

    harness.runtime.emitNotification({
      method: 'error',
      params: {
        threadId: created.session.threadId,
        turnId: started.turn.id,
        error: { message: 'request failed' },
        willRetry: false,
      },
    });

    await waitFor(() => harness.events.some((entry) => entry.method === 'runtime.error'));
    const failed = harness.service.getSession({ sessionId: created.session.id }).session;
    assert.equal(failed.status, 'error');
  } finally {
    await harness.cleanup();
  }
});

test('force close interrupts the runtime-owned turn after proxy turn state diverges', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const other = await harness.service.createSession({ cwd: '/tmp/other' });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'keep working' }],
    });
    const thread = harness.runtime.threads.get(created.session.threadId) as {
      turns: Array<{ id: string; status: string; items: unknown[] }>;
    };
    const proxyTurn = thread.turns.find(turn => turn.id === started.turn.id)!;
    proxyTurn.status = 'failed';
    thread.turns.push({
      id: 'native-turn-still-running',
      status: 'inProgress',
      items: [],
    });

    await assert.rejects(
      harness.service.closeSession({ sessionId: created.session.id }),
      (error: unknown) => (
        Boolean(error)
        && typeof error === 'object'
        && (error as { code?: unknown }).code === 'SESSION_BUSY'
      ),
      'ordinary close must keep rejecting an active proxy session',
    );
    await harness.service.closeSession({ sessionId: created.session.id, force: true });

    assert.deepEqual(harness.runtime.interruptCalls, [{
      threadId: created.session.threadId,
      turnId: 'native-turn-still-running',
    }]);
    assert.throws(
      () => harness.service.getSession({ sessionId: created.session.id }),
      /not found/,
    );
    assert.equal(
      harness.service.getSession({ sessionId: other.session.id }).session.threadId,
      other.session.threadId,
      'force close must not detach another session on the shared runtime',
    );

    const recovered = await harness.service.createSession({
      cwd: '/tmp/work',
      threadId: created.session.threadId,
    });
    const next = await harness.service.startTurn({
      sessionId: recovered.session.id,
      input: [{ type: 'text', text: 'continue after recovery' }],
    });
    assert.equal(next.turn.id, 'turn-2');
  } finally {
    await harness.cleanup();
  }
});

test('Codex auto-compaction replaces context only after the compaction item completes', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({
      cwd: '/tmp/work',
    });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'long running turn' }],
    }, 43);

    const bound = (notification: { method: string; params: Record<string, unknown> }) => (
      bindCompactionFixture(notification, created.session.threadId, started.turn.id)
    );
    harness.runtime.emitNotification(bound(CODEX_APP_SERVER_V2_COMPACTION.preBoundaryUsage));
    const beforeFutureBoundary = harness.events.filter(
      entry => entry.method === 'token_usage.updated',
    ).length;
    harness.runtime.emitNotification(bound(CODEX_APP_SERVER_V2_COMPACTION.futureBoundary));
    assert.equal(
      harness.events.filter(entry => entry.method === 'token_usage.updated').length,
      beforeFutureBoundary,
      'an unknown item discriminator must not invalidate current context',
    );

    harness.runtime.emitNotification(bound(CODEX_APP_SERVER_V2_COMPACTION.boundaryStarted));
    const afterInvalidation = harness.events.filter(
      entry => entry.method === 'token_usage.updated',
    );
    assert.deepEqual(afterInvalidation.at(-1)?.params.data, {
      context: null,
      reason: 'compact_started',
    });

    harness.runtime.emitNotification(bound(CODEX_APP_SERVER_V2_COMPACTION.summarizationUsage));
    assert.equal(
      harness.events.filter(entry => entry.method === 'token_usage.updated').length,
      afterInvalidation.length,
      'summarization usage must remain suppressed',
    );

    harness.runtime.emitNotification(bound(CODEX_APP_SERVER_V2_COMPACTION.boundaryCompleted));
    harness.runtime.emitNotification(bound(CODEX_APP_SERVER_V2_COMPACTION.postBoundaryUsage));
    const afterFreshUsage = harness.events.filter(
      entry => entry.method === 'token_usage.updated',
    );
    assert.equal(afterFreshUsage.length, afterInvalidation.length + 1);
    assert.deepEqual(
      (afterFreshUsage.at(-1)?.params.data as { params?: unknown }).params,
      bound(CODEX_APP_SERVER_V2_COMPACTION.postBoundaryUsage).params,
    );
  } finally {
    await harness.cleanup();
  }
});

test('Codex plan snapshots keep the native step statuses as checklist markdown', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'make a plan' }],
    }, 44);

    harness.runtime.emitNotification({
      method: 'turn/plan/updated',
      params: {
        threadId: created.session.threadId,
        turnId: started.turn.id,
        explanation: 'Implementation order',
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Edit', status: 'inProgress' },
          { step: 'Test', status: 'pending' },
        ],
      },
    });
    await waitFor(() => harness.events.some(event => event.method === 'output.plan.final'));

    const plan = harness.events.find(event => event.method === 'output.plan.final');
    assert.equal(
      (plan?.params.data as { text?: unknown }).text,
      'Implementation order\n\n- [x] Inspect\n- [ ] Edit (in progress)\n- [ ] Test',
    );
  } finally {
    await harness.cleanup();
  }
});

test('Codex collabAgentToolCall items preserve child thread identity and lifecycle', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'delegate review' }],
    }, 45);

    harness.runtime.emitNotification({
      method: 'item/started',
      params: {
        threadId: created.session.threadId,
        turnId: started.turn.id,
        item: {
          type: 'collabAgentToolCall',
          id: 'collab-call-1',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: created.session.threadId,
          receiverThreadIds: ['child-thread-1'],
          prompt: 'Review the event reducer',
          model: 'gpt-5.6',
          reasoningEffort: 'medium',
          agentsStates: {
            'child-thread-1': { status: 'running', message: null },
          },
        },
      },
    });
    await waitFor(() => harness.events.some(event => event.method === 'codex.agent'));

    harness.runtime.emitNotification({
      method: 'item/completed',
      params: {
        threadId: created.session.threadId,
        turnId: started.turn.id,
        item: {
          type: 'collabAgentToolCall',
          id: 'collab-wait-1',
          tool: 'wait',
          status: 'completed',
          senderThreadId: created.session.threadId,
          receiverThreadIds: ['child-thread-1'],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {
            'child-thread-1': {
              status: 'completed',
              message: 'Reducer review complete.',
            },
          },
        },
      },
    });
    await waitFor(() => (
      harness.events.filter(event => event.method === 'codex.agent').length === 2
    ));

    const updates = harness.events
      .filter(event => event.method === 'codex.agent')
      .map(event => (event.params.data as { updates: unknown }).updates);
    assert.deepEqual(updates[0], [{
      agentId: 'child-thread-1',
      description: 'Review the event reducer',
      status: 'running',
      model: 'gpt-5.6',
    }]);
    assert.deepEqual(updates[1], [{
      agentId: 'child-thread-1',
      description: '',
      status: 'done',
      output: 'Reducer review complete.',
    }]);
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
    harness.runtime.emitNotification(bindCompactionFixture(
      CODEX_APP_SERVER_V2_COMPACTION.threadCompacted,
      created.session.threadId,
      compactTurnId,
    ));

    await waitFor(() => harness.events.some((entry) => entry.method === 'turn.completed'));

    const completedEvent = harness.events.find((entry) => entry.method === 'turn.completed');
    assert.equal(completedEvent?.params.turnId, compactTurnId);
    assert.equal((completedEvent?.params.data as { compacted?: boolean } | undefined)?.compacted, true);
    assert.equal(harness.service.getSession({ sessionId: created.session.id }).session.status, 'idle');

    const usageCountAfterCompact = harness.events.filter(
      entry => entry.method === 'token_usage.updated',
    ).length;
    harness.runtime.emitNotification(bindCompactionFixture(
      CODEX_APP_SERVER_V2_COMPACTION.summarizationUsage,
      created.session.threadId,
      compactTurnId,
    ));
    assert.equal(
      harness.events.filter(entry => entry.method === 'token_usage.updated').length,
      usageCountAfterCompact,
      'late compact usage must not refill the invalidated context',
    );

    const next = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'next turn' }],
    }, 45);
    harness.runtime.emitNotification(bindCompactionFixture(
      CODEX_APP_SERVER_V2_COMPACTION.postBoundaryUsage,
      created.session.threadId,
      next.turn.id,
    ));
    assert.equal(
      harness.events.filter(entry => entry.method === 'token_usage.updated').length,
      usageCountAfterCompact + 1,
      'the next ordinary turn supplies the first authoritative context sample',
    );
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

test('gian.proxy/1 adapter owns Host ids, validates events, and deduplicates turns', async () => {
  const harness = await createHarness();
  const notifications: ProxyNotification[] = [];
  const adapter = new CodexProtocolV1Adapter(
    harness.service,
    '0.1.0',
    notification => notifications.push(proxyNotificationSchema.parse(notification)),
  );
  try {
    const initialize = await adapter.handle(parseProxyRequest({
      id: 1,
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['1.0'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    }));
    resultSchemas.initialize.parse(initialize);
    resultSchemas['catalog.list'].parse(await adapter.handle(parseProxyRequest({
      id: 2,
      method: 'catalog.list',
      params: {},
    })));

    const created = resultSchemas['session.create'].parse(await adapter.handle(parseProxyRequest({
      id: 3,
      method: 'session.create',
      params: {
        sessionId: 'host-session-1',
        cwd: '/tmp/work',
        workspaceRoots: ['/tmp/work'],
        model: 'gpt-5-codex',
        mode: 'ask',
        config: {},
      },
    })));
    assert.equal(created.session.id, 'host-session-1');
    assert.equal(created.session.nativeSession?.id, 'thread-1');

    const startRequest = {
      id: 4,
      method: 'turn.start',
      params: {
        sessionId: 'host-session-1',
        streamId: created.session.streamId,
        turnId: 'host-turn-1',
        input: [{ type: 'text', text: 'hello' }],
        policy: {
          workspaceRoots: ['/tmp/work'],
          approval: 'relay',
          network: 'ask',
        },
        config: { mode: 'ask', native: {} },
      },
    } as const;
    resultSchemas['turn.start'].parse(await adapter.handle(parseProxyRequest(startRequest)));
    assert.equal(harness.runtime.startTurnCalls.length, 1);
    assert.deepEqual(notifications.map(value => [
      value.method,
      'sessionId' in value.params ? value.params.sessionId : null,
      'turnId' in value.params ? value.params.turnId : null,
    ]), [['turn.started', 'host-session-1', 'host-turn-1']]);

    harness.runtime.emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'message-1',
        delta: 'hello',
      },
    });
    harness.runtime.setCompletedTurn('thread-1', 'turn-1');
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await waitFor(() => notifications.some(value => value.method === 'turn.completed'));
    assert.deepEqual(notifications.map(value => value.method), [
      'turn.started',
      'content.delta',
      'turn.completed',
    ]);
    assert.deepEqual(notifications.map(value => (
      'sequence' in value.params ? value.params.sequence : null
    )), [1, 2, 3]);

    resultSchemas['turn.start'].parse(await adapter.handle(parseProxyRequest(startRequest)));
    assert.equal(harness.runtime.startTurnCalls.length, 1, 'same Host turn must not execute twice');
    await assert.rejects(
      adapter.handle(parseProxyRequest({
        ...startRequest,
        id: 5,
        params: { ...startRequest.params, input: [{ type: 'text', text: 'changed' }] },
      })),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT',
    );

    await adapter.handle(parseProxyRequest({
      ...startRequest,
      id: 6,
      params: {
        ...startRequest.params,
        turnId: 'host-turn-clear',
        input: [{ type: 'text', text: '/clear' }],
      },
    }));
    const rotationIndex = notifications.findIndex(value => (
      value.method === 'session.updated'
      && value.params.data.reason === 'native-session-rotated'
    ));
    assert.ok(rotationIndex >= 0);
    const reset = notifications[rotationIndex + 1];
    assert.equal(reset?.method, 'usage.updated');
    assert.deepEqual(reset?.params.data, {
      context: null,
      conversation: { mode: 'reset' },
      reason: 'session_reset',
    });
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/1 adapter resolves approval before an interrupted turn terminates', async () => {
  const harness = await createHarness();
  const notifications: ProxyNotification[] = [];
  const adapter = new CodexProtocolV1Adapter(
    harness.service,
    '0.1.0',
    notification => notifications.push(notification),
  );
  try {
    await adapter.handle(parseProxyRequest({
      id: 1,
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['1.0'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    }));
    const created = resultSchemas['session.create'].parse(await adapter.handle(parseProxyRequest({
      id: 2,
      method: 'session.create',
      params: {
        sessionId: 'host-session-2',
        cwd: '/tmp/work',
        workspaceRoots: ['/tmp/work'],
        config: {},
      },
    })));
    await adapter.handle(parseProxyRequest({
      id: 3,
      method: 'turn.start',
      params: {
        sessionId: 'host-session-2',
        streamId: created.session.streamId,
        turnId: 'host-turn-2',
        input: [{ type: 'text', text: 'needs approval' }],
        policy: {
          workspaceRoots: ['/tmp/work'],
          approval: 'relay',
          network: 'ask',
        },
        config: { native: {} },
      },
    }));
    harness.runtime.emitServerRequest({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'echo hello' },
    });
    await waitFor(() => notifications.some(value => value.method === 'approval.requested'));
    await adapter.handle(parseProxyRequest({
      id: 4,
      method: 'turn.interrupt',
      params: {
        sessionId: 'host-session-2',
        streamId: created.session.streamId,
        turnId: 'host-turn-2',
      },
    }));
    harness.runtime.setCompletedTurn('thread-1', 'turn-1');
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
    });
    await waitFor(() => notifications.some(value => value.method === 'turn.completed'));

    const methods = notifications.map(value => value.method);
    assert.ok(methods.indexOf('approval.resolved') > methods.indexOf('approval.requested'));
    assert.ok(methods.indexOf('approval.resolved') < methods.indexOf('turn.completed'));
    const completed = notifications.find(value => value.method === 'turn.completed');
    assert.equal(completed?.params.data.stopReason, 'interrupted');
  } finally {
    await harness.cleanup();
  }
});
