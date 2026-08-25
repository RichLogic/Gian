import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { CodexProxyService } from '../src/core/service.js';
import {
  CodexProtocolV2Adapter,
  validateCatalogConfig,
  type CatalogOption,
  type WireRequest,
} from '../src/protocol/v2-adapter.js';
import type { InputItem } from '../src/core/types.js';
import type {
  CodexNativeThreadSummary,
  CodexRuntime,
  RuntimeNotification,
  RuntimeServerRequest,
} from '../src/runtime/types.js';
import { CODEX_APP_SERVER_V2_COMPACTION } from './fixtures/codex-app-server-v2-compaction.js';
import {
  proxyNotificationSchema,
  resultSchemas,
} from '@gian/proxy-protocol';

function v2Request(id: string, method: string, params: Record<string, unknown> = {}): WireRequest {
  return { id, method, params };
}

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
  readonly forkCalls: Array<{ threadId: string; lastTurnId?: string; cwd?: string }> = [];
  readonly archiveCalls: string[] = [];
  nativeThreads: CodexNativeThreadSummary[] = [];
  readonly listNativeThreadsCalls: Array<string | undefined> = [];

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

  async forkThread(threadId: string, options: { lastTurnId?: string; cwd?: string } = {}) {
    this.forkCalls.push({ threadId, ...options });
    const source = this.threads.get(threadId) as { cwd?: string; turns?: unknown[] } | undefined;
    if (!source) throw new Error('thread missing');
    const forkedId = `thread-${this.nextThreadId++}`;
    const turns = [...(source.turns ?? [])];
    const boundary = options.lastTurnId
      ? turns.findIndex((turn) => (turn as { id?: string }).id === options.lastTurnId)
      : turns.length - 1;
    this.threads.set(forkedId, {
      id: forkedId,
      preview: '',
      cwd: options.cwd ?? source.cwd,
      turns: boundary < 0 ? [] : turns.slice(0, boundary + 1),
    });
    return {
      thread: { id: forkedId },
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

  async listAllModels(): Promise<unknown[]> {
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
      serviceTiers: [{
        id: 'fast',
        name: 'Fast',
        description: 'Faster responses.',
      }],
    }];
  }

  async listSkills(_cwd?: string) {
    return { data: [] };
  }

  async listNativeThreads(cwd?: string) {
    this.listNativeThreadsCalls.push(cwd);
    return this.nativeThreads;
  }

  async unsubscribeThread(_threadId: string) {
    return {};
  }

  async archiveThread(threadId: string) {
    this.archiveCalls.push(threadId);
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

test('gian.proxy/2 config validation enforces binding, choices, constraints, required, visible, and enabled', () => {
  const options: CatalogOption[] = [
    {
      id: 'gate',
      displayName: 'Gate',
      binding: 'turn',
      control: 'boolean',
      required: false,
      defaultValue: false,
    },
    {
      id: 'detail',
      displayName: 'Detail',
      binding: 'turn',
      control: 'text',
      required: true,
      defaultValue: null,
      constraints: { minimumLength: 2, maximumLength: 5 },
      visibleWhen: [{ optionId: 'gate', oneOf: [true] }],
      enabledWhen: [{ optionId: 'gate', oneOf: [true] }],
    },
    {
      id: 'count',
      displayName: 'Count',
      binding: 'turn',
      control: 'number',
      required: false,
      defaultValue: 0,
      constraints: { minimum: 0, maximum: 4, step: 2 },
    },
    {
      id: 'choice',
      displayName: 'Choice',
      binding: 'turn',
      control: 'select',
      required: false,
      defaultValue: 'a',
      choices: [{ value: 'a', displayName: 'A' }, { value: 'b', displayName: 'B' }],
    },
  ];
  const domainCode = (expected: string) => (error: unknown) => (
    error instanceof Error && 'domainCode' in error && error.domainCode === expected
  );

  assert.throws(() => validateCatalogConfig(options, { gate: true }, 'session'), domainCode('CONFIG_BINDING_INVALID'));
  assert.throws(() => validateCatalogConfig(options, { choice: 'c' }, 'turn'), domainCode('CONFIG_VALUE_INVALID'));
  assert.throws(() => validateCatalogConfig(options, { count: 3 }, 'turn'), domainCode('CONFIG_VALUE_INVALID'));
  assert.throws(() => validateCatalogConfig(options, { gate: false, detail: 'ok' }, 'turn'), domainCode('CONFIG_VALUE_INVALID'));
  assert.throws(() => validateCatalogConfig(options, { gate: true }, 'turn'), domainCode('CONFIG_REQUIRED'));
  assert.throws(() => validateCatalogConfig(options, { gate: true, detail: 'too long' }, 'turn'), domainCode('CONFIG_VALUE_INVALID'));
  assert.deepEqual(validateCatalogConfig(options, { count: null }, 'turn'), { count: null });
  assert.deepEqual(
    validateCatalogConfig(options, { gate: true, detail: 'okay', count: 4, choice: 'b' }, 'turn'),
    { gate: true, detail: 'okay', count: 4, choice: 'b' },
  );
});

test('gian.proxy/2 rejects turn-bound config before creating a Provider session', async () => {
  const harness = await createHarness();
  const adapter = new CodexProtocolV2Adapter(harness.service, '0.2.1', () => undefined);
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    await assert.rejects(
      adapter.handle(v2Request('2', 'session.create', {
        sessionId: 'invalid-config-session',
        workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
        config: { model: 'gpt-5-codex' },
      })),
      (error: unknown) => error instanceof Error
        && 'domainCode' in error
        && error.domainCode === 'CONFIG_BINDING_INVALID',
    );
    assert.equal(harness.runtime.threads.size, 0);
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 exposes four approval presets and maps them inside Codex Proxy', async () => {
  const harness = await createHarness();
  const adapter = new CodexProtocolV2Adapter(harness.service, '0.2.1', () => undefined);
  try {
    await adapter.handle(v2Request('preset-initialize', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const catalog = resultSchemas['catalog.list'].parse(
      await adapter.handle(v2Request('preset-catalog', 'catalog.list')),
    );
    const approval = catalog.configOptions.find(option => option.id === 'approval_mode');
    assert.deepEqual(
      approval?.choices?.map(choice => [choice.value, choice.displayName]),
      [
        ['ask', 'Ask for approval'],
        ['auto', 'Approve for me'],
        ['full-access', 'Full access'],
        ['custom', 'Custom (config.toml)'],
      ],
    );
    assert.equal(approval?.defaultValue, 'ask');
    assert.deepEqual(
      catalog.configOptions.filter(option => [
        'approval_policy',
        'sandbox',
        'approvals_reviewer',
        'collaboration_mode',
      ].includes(option.id)),
      [],
    );

    for (const [index, mode] of ['ask', 'auto', 'full-access', 'custom'].entries()) {
      const sessionId = `preset-session-${mode}`;
      const created = resultSchemas['session.create'].parse(
        await adapter.handle(v2Request(`preset-create-${index}`, 'session.create', {
          sessionId,
          workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
          config: {},
        })),
      );
      await adapter.handle(v2Request(`preset-turn-${index}`, 'turn.start', {
        sessionId,
        streamId: created.session.streamId,
        turnId: `preset-host-turn-${index}`,
        input: [{ type: 'text', text: `test ${mode}` }],
        config: { approval_mode: mode },
      }));
    }

    assert.deepEqual(
      harness.runtime.startTurnCalls.map(call => ({
        sandbox: call.options.sandbox,
        permissions: call.options.permissions,
        approvalPolicy: call.options.approvalPolicy,
        approvalsReviewer: call.options.approvalsReviewer,
      })),
      [
        {
          sandbox: 'workspace-write',
          permissions: null,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
        },
        {
          sandbox: 'workspace-write',
          permissions: null,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
        },
        {
          sandbox: 'danger-full-access',
          permissions: null,
          approvalPolicy: 'never',
          approvalsReviewer: 'auto_review',
        },
        {
          sandbox: null,
          permissions: ':workspace',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
        },
      ],
    );
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 session.create is idempotent only for an identical parameter fingerprint', async () => {
  const harness = await createHarness();
  const adapter = new CodexProtocolV2Adapter(harness.service, '0.2.1', () => undefined);
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const createParams = {
      sessionId: 'idempotent-session',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    };
    const first = resultSchemas['session.create'].parse(
      await adapter.handle(v2Request('2', 'session.create', createParams)),
    );
    const duplicate = resultSchemas['session.create'].parse(
      await adapter.handle(v2Request('3', 'session.create', {
        ...createParams,
        workspace: { roots: ['/tmp/work'], cwd: '/tmp/work' },
      })),
    );
    assert.deepEqual(duplicate, first);
    assert.equal(harness.runtime.threads.size, 1);

    const changedParams = [
      { ...createParams, workspace: { cwd: '/tmp/other', roots: ['/tmp/other'] } },
      { ...createParams, nativeSession: { id: 'thread-other', history: 'none' } },
      { ...createParams, config: { model: 'gpt-5-codex' } },
      { ...createParams, hostServices: [] },
    ];
    for (const [index, params] of changedParams.entries()) {
      await assert.rejects(
        adapter.handle(v2Request(`conflict-${index}`, 'session.create', params)),
        (error: unknown) => error instanceof Error
          && 'domainCode' in error
          && error.domainCode === 'CONFLICT',
      );
    }
    assert.equal(harness.runtime.threads.size, 1, 'conflicts must not create Provider threads');
  } finally {
    await harness.cleanup();
  }
});

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

test('unknown visible runtime events remain observable while their session is idle', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    harness.runtime.emitNotification({
      method: 'thread/futureVisible',
      params: { threadId: created.session.threadId, detail: 'future event' },
    });
    await waitFor(() => harness.events.some(event => event.method === 'codex.unknown'));
    const unknown = harness.events.find(event => event.method === 'codex.unknown');
    assert.equal(unknown?.params.sessionId, created.session.id);
    assert.equal('turnId' in (unknown?.params ?? {}), false);
    assert.deepEqual(unknown?.params.data, {
      method: 'thread/futureVisible',
      payload: { threadId: created.session.threadId, detail: 'future event' },
    });
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
      'ask',
      'auto',
      'full-access',
      'custom',
    ]);
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 catalog advertises Fast only for models that expose the service tier', async () => {
  const harness = await createHarness();
  const adapter = new CodexProtocolV2Adapter(harness.service, '0.2.2', () => undefined);
  try {
    harness.runtime.listAllModels = async () => [{
      id: 'gpt-fast',
      model: 'gpt-fast',
      displayName: 'GPT Fast',
      description: 'Fast-capable model',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Faster responses.' }],
      additionalSpeedTiers: [],
    }, {
      id: 'gpt-standard',
      model: 'gpt-standard',
      displayName: 'GPT Standard',
      description: 'Standard-only model',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      serviceTiers: [],
      additionalSpeedTiers: [],
    }];
    await adapter.handle(v2Request('fast-initialize', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const catalog = resultSchemas['catalog.list'].parse(
      await adapter.handle(v2Request('fast-catalog', 'catalog.list')),
    );
    const fast = catalog.configOptions.find((option) => option.role === 'fast');
    assert.deepEqual(fast, {
      id: 'service_tier',
      displayName: 'Fast',
      description: 'Faster responses.',
      binding: 'turn',
      role: 'fast',
      control: 'boolean',
      required: false,
      defaultValue: false,
      enabledWhen: [{ optionId: 'model', oneOf: ['gpt-fast'] }],
    });
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 catalog omits Fast when model/list advertises no Fast tier', async () => {
  const harness = await createHarness();
  const adapter = new CodexProtocolV2Adapter(harness.service, '0.2.2', () => undefined);
  try {
    harness.runtime.listAllModels = async () => [{
      id: 'gpt-standard',
      model: 'gpt-standard',
      displayName: 'GPT Standard',
      description: 'Standard-only model',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      serviceTiers: [],
      additionalSpeedTiers: [],
    }];
    await adapter.handle(v2Request('standard-initialize', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const catalog = resultSchemas['catalog.list'].parse(
      await adapter.handle(v2Request('standard-catalog', 'catalog.list')),
    );
    assert.equal(catalog.configOptions.some((option) => option.role === 'fast'), false);
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

test('gian.proxy/2 emits compact turn.started before its turn-scoped usage reset', async () => {
  const harness = await createHarness();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.1',
    (method, params) => {
      notifications.push({ method, params });
      proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
    },
  );
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const created = resultSchemas['session.create'].parse(await adapter.handle(v2Request('2', 'session.create', {
      sessionId: 'compact-host-session',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    })));

    await adapter.handle(v2Request('3', 'turn.start', {
      sessionId: 'compact-host-session',
      streamId: created.session.streamId,
      turnId: 'compact-host-turn',
      input: [{ type: 'text', text: '/compact' }],
      config: {},
    }));

    assert.deepEqual(
      notifications.filter(event => event.method !== 'catalog.changed').map(event => event.method),
      ['turn.started', 'usage.updated'],
    );
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

test('interrupt uses the active turn context when the session snapshot briefly diverges', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'keep working' }],
    });
    const internals = harness.service as unknown as {
      sessionsById: Map<string, { activeTurnId: string | null }>;
    };
    internals.sessionsById.get(created.session.id)!.activeTurnId = null;

    await harness.service.interruptTurn({ sessionId: created.session.id });

    assert.deepEqual(harness.runtime.interruptCalls, [{
      threadId: created.session.threadId,
      turnId: started.turn.id,
    }]);
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
      description: 'Agent',
      status: 'done',
      output: 'Reducer review complete.',
    }]);
  } finally {
    await harness.cleanup();
  }
});

test('Codex subAgentActivity always supplies a non-empty activity description', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.service.createSession({ cwd: '/tmp/work' });
    const started = await harness.service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'delegate review' }],
    }, 46);

    harness.runtime.emitNotification({
      method: 'item/started',
      params: {
        threadId: created.session.threadId,
        turnId: started.turn.id,
        item: {
          type: 'subAgentActivity',
          agentThreadId: 'child-thread-without-path',
          kind: 'spawned',
        },
      },
    });
    await waitFor(() => harness.events.some(event => event.method === 'codex.agent'));

    const update = (harness.events.find(event => event.method === 'codex.agent')?.params.data as {
      updates?: Array<{ description?: unknown }>;
    }).updates?.[0];
    assert.equal(update?.description, 'Agent');
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

test('gian.proxy/2 adapter owns Host ids, validates events, and deduplicates turns', async () => {
  const harness = await createHarness();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.1',
    (method, params) => {
      notifications.push({ method, params });
      proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
    },
  );
  try {
    const initialize = await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    resultSchemas.initialize.parse(initialize);
    resultSchemas['catalog.list'].parse(await adapter.handle(v2Request('2', 'catalog.list')));

    const created = resultSchemas['session.create'].parse(await adapter.handle(v2Request('3', 'session.create', {
      sessionId: 'host-session-1',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    })));
    assert.equal(created.session.id, 'host-session-1');
    assert.equal(created.session.nativeSession?.id, 'thread-1');
    assert.equal(created.session.state, 'idle');

    const startParams = {
      sessionId: 'host-session-1',
      streamId: created.session.streamId,
      turnId: 'host-turn-1',
      input: [{ type: 'text', text: 'hello' }],
      config: {
        model: 'gpt-5-codex',
        effort: 'medium',
        approval_mode: 'auto',
        service_tier: true,
      },
    };
    resultSchemas['turn.start'].parse(await adapter.handle(v2Request('4', 'turn.start', startParams)));
    assert.equal(harness.runtime.startTurnCalls.length, 1);
    assert.deepEqual(
      {
        model: harness.runtime.startTurnCalls[0]?.options.model,
        thinking: harness.runtime.startTurnCalls[0]?.options.thinking,
        approvalPolicy: harness.runtime.startTurnCalls[0]?.options.approvalPolicy,
        sandbox: harness.runtime.startTurnCalls[0]?.options.sandbox,
        approvalsReviewer: harness.runtime.startTurnCalls[0]?.options.approvalsReviewer,
        collaborationMode: harness.runtime.startTurnCalls[0]?.options.collaborationMode,
        serviceTier: harness.runtime.startTurnCalls[0]?.options.serviceTier,
      },
      {
        model: 'gpt-5-codex',
        thinking: 'medium',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        approvalsReviewer: 'auto_review',
        collaborationMode: null,
        serviceTier: 'fast',
      },
    );

    const turnEvents = notifications.filter((value) => value.method !== 'catalog.changed');
    assert.deepEqual(turnEvents.map((value) => [
      value.method,
      value.params.sessionId ?? null,
      value.params.turnId ?? null,
    ]), [['turn.started', 'host-session-1', 'host-turn-1']]);
    assert.equal(turnEvents[0]?.params.sourceTurnId, 'turn-1');

    const duplicateStartup = {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'node_repl',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    };
    harness.runtime.emitNotification(duplicateStartup);
    harness.runtime.emitNotification(duplicateStartup);
    harness.runtime.emitNotification({
      method: 'item/autoApprovalReview/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1' },
    });
    harness.runtime.emitNotification({
      method: 'item/autoApprovalReview/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1' },
    });
    harness.runtime.emitNotification({
      method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: { type: 'active' } },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(
      notifications.filter((value) => (
        value.method === 'activity.updated'
        && (value.params.data as { kind?: unknown }).kind === 'mcpServer/startupStatus/updated'
      )).length,
      0,
      'internal app-server status must not become a conversation activity',
    );

    const commandItem = {
      type: 'commandExecution',
      id: 'command-1',
      pluginId: null,
      scriptPath: null,
      command: 'git status --short',
      cwd: '/tmp/work',
      processId: null,
      source: 'agent',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    harness.runtime.emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1_000,
        item: { ...commandItem, status: 'inProgress' },
      },
    });
    harness.runtime.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1_250,
        item: {
          ...commandItem,
          status: 'completed',
          aggregatedOutput: 'clean',
          exitCode: 0,
          durationMs: 250,
        },
      },
    });
    await waitFor(() => notifications.filter(value => value.method === 'activity.updated').length === 2);
    assert.deepEqual(
      notifications.filter(value => value.method === 'activity.updated').map(value => {
        const item = value.params.data as { activityId?: unknown; status?: unknown };
        return { activityId: item.activityId, status: item.status };
      }),
      [
        { activityId: 'command-1', status: 'running' },
        { activityId: 'command-1', status: 'succeeded' },
      ],
      'one native item must update one stable activity lifecycle',
    );

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
    await waitFor(() => notifications.some((value) => value.method === 'turn.completed'));
    assert.deepEqual(
      notifications.filter((value) => value.method !== 'catalog.changed').map((value) => value.method),
      [
        'turn.started',
        'activity.updated',
        'activity.updated',
        'content.delta',
        'content.completed',
        'turn.completed',
        'session.updated',
      ],
    );
    assert.deepEqual(
      notifications.filter((value) => value.method !== 'catalog.changed').map((value) => value.params.sequence ?? null),
      [1, 2, 3, 4, 5, 6, 7],
    );
    const completedContent = notifications.find((value) => value.method === 'content.completed');
    assert.deepEqual(
      completedContent?.params.data,
      {
        contentId: 'text:1',
        kind: 'text',
        format: 'plain',
        content: 'hello',
      },
      'content.completed must preserve the stream kind and format declared by its deltas',
    );
    const completedTurn = notifications.find((value) => value.method === 'turn.completed');
    assert.match(
      String(completedTurn?.params.eventId),
      /^provider-event-[0-9a-f]{24}$/,
      'live Provider event IDs must use the same hash width as native replay',
    );

    resultSchemas['turn.start'].parse(await adapter.handle(v2Request('4b', 'turn.start', startParams)));
    assert.equal(harness.runtime.startTurnCalls.length, 1, 'same Host turn must not execute twice');
    await assert.rejects(
      adapter.handle(v2Request('5', 'turn.start', {
        ...startParams,
        input: [{ type: 'text', text: 'changed' }],
      })),
      (error: unknown) => error instanceof Error
        && 'domainCode' in error
        && error.domainCode === 'CONFLICT',
    );

    await adapter.handle(v2Request('6', 'turn.start', {
      ...startParams,
      turnId: 'host-turn-clear',
      input: [{ type: 'text', text: '/clear' }],
    }));
    const rotationIndex = notifications.findIndex((value) => (
      value.method === 'session.updated'
      && Boolean((value.params.data as { nativeSession?: { id?: string } } | undefined)?.nativeSession?.id)
    ));
    assert.ok(rotationIndex >= 0);
    assert.equal(
      (notifications[rotationIndex]?.params.data as { reason?: unknown } | undefined)?.reason,
      undefined,
    );
    const reset = notifications[rotationIndex + 1];
    assert.equal(reset?.method, 'usage.updated');
    assert.deepEqual(reset?.params.data, {
      context: null,
      conversation: { mode: 'reset' },
    });
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 Codex adapter implements durable Side Chat and exact native forks', async () => {
  const harness = await createHarness();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.2',
    (method, params) => notifications.push({ method, params }),
  );
  try {
    const initialized = resultSchemas.initialize.parse(await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    })));
    assert.equal(initialized.capabilities.sidechat, 1);
    assert.equal(initialized.capabilities['session.fork'], 1);
    assert.equal(initialized.capabilities['session.fork.atTurn'], 1);
    const catalog = resultSchemas['catalog.list'].parse(await adapter.handle(v2Request('2', 'catalog.list')));
    assert.deepEqual(catalog.actions, [
      { id: 'sidechat.create', supported: true },
      { id: 'session.fork', supported: true },
      { id: 'session.fork.atTurn', supported: true },
    ]);

    const parent = resultSchemas['session.create'].parse(await adapter.handle(v2Request('3', 'session.create', {
      sessionId: 'parent',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    })));
    assert.equal(parent.session.availableActions?.['sidechat.create']?.enabled, true);
    assert.equal(parent.session.availableActions?.['session.fork']?.enabled, false);

    const sidechat = resultSchemas['sidechat.create'].parse(await adapter.handle(v2Request('4', 'sidechat.create', {
      parentSessionId: 'parent',
      parentStreamId: parent.session.streamId,
      sidechatId: 'side-1',
    })));
    assert.equal(sidechat.sidechat.anchor.type, 'empty');
    assert.equal(sidechat.sidechat.parentSessionId, 'parent');
    assert.equal(harness.runtime.forkCalls[0]?.threadId, 'thread-1');

    const close = resultSchemas['sidechat.close'].parse(await adapter.handle(v2Request('5', 'sidechat.close', {
      sidechatId: 'side-1',
      streamId: sidechat.sidechat.streamId,
      resumeRef: sidechat.sidechat.resumeRef,
    })));
    assert.deepEqual(close, { ok: true, sidechatId: 'side-1', providerDataDeleted: false });
    assert.deepEqual(harness.runtime.archiveCalls, ['thread-2']);
    assert.deepEqual(
      resultSchemas['sidechat.close'].parse(await adapter.handle(v2Request('5b', 'sidechat.close', {
        sidechatId: 'side-1',
        resumeRef: sidechat.sidechat.resumeRef,
      }))),
      close,
    );

    await adapter.handle(v2Request('6', 'turn.start', {
      sessionId: 'parent',
      streamId: parent.session.streamId,
      turnId: 'host-turn-1',
      input: [{ type: 'text', text: 'establish a boundary' }],
      config: {},
    }));
    harness.runtime.setCompletedTurn('thread-1', 'turn-1');
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await waitFor(() => notifications.some((event) => event.method === 'turn.completed'));

    const headFork = resultSchemas['session.fork'].parse(await adapter.handle(v2Request('7', 'session.fork', {
      sourceSessionId: 'parent',
      sourceStreamId: parent.session.streamId,
      sessionId: 'fork-head',
      anchor: { type: 'head' },
    })));
    assert.equal(headFork.session.nativeSession?.id, 'thread-3');
    assert.deepEqual(headFork.origin, {
      kind: 'fork',
      sessionId: 'parent',
      turnId: 'host-turn-1',
      sourceTurnId: 'turn-1',
    });
    assert.equal(harness.runtime.forkCalls.at(-1)?.lastTurnId, 'turn-1');

    const turnFork = resultSchemas['session.fork'].parse(await adapter.handle(v2Request('8', 'session.fork', {
      sourceSessionId: 'parent',
      sourceStreamId: parent.session.streamId,
      sessionId: 'fork-turn',
      anchor: { type: 'turn', turnId: 'host-turn-1', sourceTurnId: 'turn-1' },
    })));
    assert.equal(turnFork.origin.turnId, 'host-turn-1');
    assert.equal(harness.runtime.forkCalls.at(-1)?.lastTurnId, 'turn-1');
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 generation fence drops late events from the replaced Provider turn', async () => {
  const harness = await createHarness();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.1',
    (method, params) => notifications.push({ method, params }),
  );
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const created = resultSchemas['session.create'].parse(await adapter.handle(v2Request('2', 'session.create', {
      sessionId: 'generation-session',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    })));
    const start = async (requestId: string, hostTurnId: string) => adapter.handle(v2Request(requestId, 'turn.start', {
      sessionId: 'generation-session',
      streamId: created.session.streamId,
      turnId: hostTurnId,
      input: [{ type: 'text', text: hostTurnId }],
      config: {},
    }));

    await start('3', 'host-turn-old');
    harness.runtime.setCompletedTurn('thread-1', 'turn-1');
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await waitFor(() => notifications.some(event => (
      event.method === 'turn.completed' && event.params.turnId === 'host-turn-old'
    )));

    await start('4', 'host-turn-current');
    const beforeLateEvents = notifications.length;
    harness.runtime.emitNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'late', delta: 'late output' },
    });
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(notifications.length, beforeLateEvents);

    harness.runtime.setCompletedTurn('thread-1', 'turn-2');
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
    });
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
    });
    await waitFor(() => notifications.some(event => (
      event.method === 'turn.completed' && event.params.turnId === 'host-turn-current'
    )));
    assert.equal(
      notifications.filter(event => event.method === 'turn.completed' && event.params.turnId === 'host-turn-current').length,
      1,
    );
  } finally {
    await harness.cleanup();
  }
});

test('Provider interrupted status is cancelled unless Gian accepted a Host interrupt', async () => {
  const harness = await createHarness();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.1',
    (method, params) => notifications.push({ method, params }),
  );
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const created = resultSchemas['session.create'].parse(await adapter.handle(v2Request('2', 'session.create', {
      sessionId: 'provider-interrupted-session',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    })));
    await adapter.handle(v2Request('3', 'turn.start', {
      sessionId: 'provider-interrupted-session',
      streamId: created.session.streamId,
      turnId: 'provider-interrupted-turn',
      input: [{ type: 'text', text: 'provider may stop' }],
      config: {},
    }));
    harness.runtime.interruptTurn = async () => {
      throw new Error('fixture interrupt rejection');
    };
    await assert.rejects(adapter.handle(v2Request('4', 'turn.interrupt', {
      sessionId: 'provider-interrupted-session',
      streamId: created.session.streamId,
      turnId: 'provider-interrupted-turn',
    })), /fixture interrupt rejection/);
    harness.runtime.setCompletedTurn('thread-1', 'turn-1');
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
    });
    await waitFor(() => notifications.some(event => event.method === 'turn.completed'));
    assert.equal(
      (notifications.find(event => event.method === 'turn.completed')?.params.data as { stopReason?: unknown }).stopReason,
      'cancelled',
    );
  } finally {
    await harness.cleanup();
  }
});

test('Provider token limits map to the protocol limit_reached stop reason', async () => {
  const harness = await createHarness();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.1',
    (method, params) => {
      notifications.push({ method, params });
      proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
    },
  );
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const created = resultSchemas['session.create'].parse(await adapter.handle(v2Request('2', 'session.create', {
      sessionId: 'provider-limit-session',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    })));

    for (const [index, nativeStatus] of ['length', 'max_tokens'].entries()) {
      const hostTurnId = `provider-limit-turn-${index}`;
      const providerTurnId = `turn-${index + 1}`;
      await adapter.handle(v2Request(`start-${index}`, 'turn.start', {
        sessionId: 'provider-limit-session',
        streamId: created.session.streamId,
        turnId: hostTurnId,
        input: [{ type: 'text', text: `limit fixture ${index}` }],
        config: {},
      }));
      harness.runtime.setCompletedTurn('thread-1', providerTurnId);
      harness.runtime.emitNotification({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: providerTurnId, status: nativeStatus } },
      });
      await waitFor(() => notifications.some(event => (
        event.method === 'turn.completed' && event.params.turnId === hostTurnId
      )));
    }

    assert.deepEqual(
      notifications
        .filter(event => event.method === 'turn.completed')
        .map(event => (event.params.data as { stopReason?: unknown }).stopReason),
      ['limit_reached', 'limit_reached'],
    );
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 native list exposes app-server thread names as display titles', async () => {
  const harness = await createHarness();
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.1',
    () => undefined,
  );
  harness.runtime.nativeThreads = [{
    id: 'codex-thread-with-title',
    displayName: 'LM-generated project title',
    cwd: '/tmp/gian-codex-title-fixture',
    updatedAt: '2026-08-12T00:00:00.000Z',
  }];
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));

    const result = resultSchemas['session.native.list'].parse(await adapter.handle(v2Request('2', 'session.native.list', {
      cwd: '/tmp/gian-codex-title-fixture',
    })));
    assert.deepEqual(result, {
      sessions: [{
        id: 'codex-thread-with-title',
        displayName: 'LM-generated project title',
        cwd: '/tmp/gian-codex-title-fixture',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }],
      nextCursor: null,
    });
    assert.deepEqual(harness.runtime.listNativeThreadsCalls, [
      '/tmp/gian-codex-title-fixture',
    ]);
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 adapter resolves interaction before an interrupted turn terminates', async () => {
  const harness = await createHarness();
  const notifications: Array<{ method: string; params: { data?: { stopReason?: string } } }> = [];
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.1',
    (method, params) => notifications.push({ method, params }),
  );
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const created = resultSchemas['session.create'].parse(await adapter.handle(v2Request('2', 'session.create', {
      sessionId: 'host-session-2',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    })));
    await adapter.handle(v2Request('3', 'turn.start', {
      sessionId: 'host-session-2',
      streamId: created.session.streamId,
      turnId: 'host-turn-2',
      input: [{ type: 'text', text: 'needs approval' }],
      config: {},
    }));
    harness.runtime.emitServerRequest({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'echo hello' },
    });
    await waitFor(() => notifications.some((value) => value.method === 'interaction.requested'));
    await adapter.handle(v2Request('4', 'turn.interrupt', {
      sessionId: 'host-session-2',
      streamId: created.session.streamId,
      turnId: 'host-turn-2',
    }));
    harness.runtime.setCompletedTurn('thread-1', 'turn-1');
    harness.runtime.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
    });
    await waitFor(() => notifications.some((value) => value.method === 'turn.completed'));

    const methods = notifications.map((value) => value.method);
    assert.ok(methods.indexOf('interaction.resolved') > methods.indexOf('interaction.requested'));
    assert.ok(methods.indexOf('interaction.resolved') < methods.indexOf('turn.completed'));
    const completed = notifications.find((value) => value.method === 'turn.completed');
    assert.equal(completed?.params.data?.stopReason, 'interrupted');
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 adapter relays Codex request_user_input answers and cancellation', async () => {
  const harness = await createHarness();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.1',
    (method, params) => notifications.push({ method, params }),
  );
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const created = resultSchemas['session.create'].parse(await adapter.handle(v2Request('2', 'session.create', {
      sessionId: 'host-session-question',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    })));
    await adapter.handle(v2Request('3', 'turn.start', {
      sessionId: 'host-session-question',
      streamId: created.session.streamId,
      turnId: 'host-turn-question',
      input: [{ type: 'text', text: 'ask me before choosing' }],
      config: {},
    }));

    harness.runtime.emitServerRequest({
      id: 501,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-question-1',
        questions: [
          {
            id: 'approach',
            header: 'Approach',
            question: 'Which approach?',
            options: [
              { label: 'A', description: 'Use approach A.' },
              { label: 'B', description: 'Use approach B.' },
            ],
          },
          {
            id: 'notes',
            header: 'Notes',
            question: 'Anything else?',
            options: null,
          },
        ],
      },
    });
    await waitFor(() => notifications.some((value) => (
      value.method === 'interaction.requested'
      && (value.params.data as { interactionId?: string } | undefined)?.interactionId === '501'
    )));

    const requested = notifications.find((value) => (
      value.method === 'interaction.requested'
      && (value.params.data as { interactionId?: string } | undefined)?.interactionId === '501'
    ));
    assert.ok(requested);
    const data = requested.params.data as {
      presentation?: { kind?: string };
      actions?: Array<{ id: string }>;
      inputs?: Array<{ id: string; type: string }>;
    };
    assert.equal(data.presentation?.kind, 'question');
    assert.deepEqual(data.actions?.map((action) => action.id), [
      'submit',
      'cancel',
    ]);
    assert.deepEqual(data.inputs?.map((input) => [input.id, input.type]), [
      ['approach', 'single_select'],
      ['notes', 'text'],
    ]);

    resultSchemas['interaction.respond'].parse(await adapter.handle(v2Request('4', 'interaction.respond', {
      sessionId: 'host-session-question',
      streamId: created.session.streamId,
      turnId: 'host-turn-question',
      interactionId: '501',
      responseId: 'resp-501',
      actionId: 'submit',
      values: {
        approach: 'A',
        notes: 'Keep the implementation focused.',
      },
    })));
    assert.deepEqual(harness.runtime.responses.at(-1), {
      id: 501,
      payload: {
        answers: {
          approach: { answers: ['A'] },
          notes: { answers: ['Keep the implementation focused.'] },
        },
      },
    });
    const resolved = notifications.find((value) => (
      value.method === 'interaction.resolved'
      && (value.params.data as { interactionId?: string } | undefined)?.interactionId === '501'
    ));
    assert.ok(resolved);
    assert.deepEqual(resolved.params.data, {
      interactionId: '501',
      outcome: 'submitted',
      actionId: 'submit',
    });
    const responseCount = harness.runtime.responses.length;
    resultSchemas['interaction.respond'].parse(await adapter.handle(v2Request('4-duplicate', 'interaction.respond', {
      sessionId: 'host-session-question',
      streamId: created.session.streamId,
      turnId: 'host-turn-question',
      interactionId: '501',
      responseId: 'resp-501',
      actionId: 'submit',
      values: {
        approach: 'A',
        notes: 'Keep the implementation focused.',
      },
    })));
    assert.equal(harness.runtime.responses.length, responseCount);
    await assert.rejects(
      adapter.handle(v2Request('4-conflict', 'interaction.respond', {
        sessionId: 'host-session-question',
        streamId: created.session.streamId,
        turnId: 'host-turn-question',
        interactionId: '501',
        responseId: 'resp-501',
        actionId: 'cancel',
      })),
      (error: unknown) => error instanceof Error
        && 'domainCode' in error
        && error.domainCode === 'CONFLICT',
    );

    harness.runtime.emitServerRequest({
      id: 502,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-question-2',
        questions: [{
          id: 'confirm',
          header: 'Confirm',
          question: 'Continue?',
          options: [{ label: 'Yes', description: 'Continue.' }],
        }],
      },
    });
    await waitFor(() => notifications.some((value) => (
      value.method === 'interaction.requested'
      && (value.params.data as { interactionId?: string } | undefined)?.interactionId === '502'
    )));
    resultSchemas['interaction.respond'].parse(await adapter.handle(v2Request('5', 'interaction.respond', {
      sessionId: 'host-session-question',
      streamId: created.session.streamId,
      turnId: 'host-turn-question',
      interactionId: '502',
      responseId: 'resp-502',
      actionId: 'cancel',
    })));
    assert.deepEqual(harness.runtime.responses.at(-1), {
      id: 502,
      payload: { answers: {} },
    });
  } finally {
    await harness.cleanup();
  }
});

test('gian.proxy/2 adapter returns native MCP tool elicitation decisions to Codex', async () => {
  const harness = await createHarness();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexProtocolV2Adapter(
    harness.service,
    '0.2.1',
    (method, params) => notifications.push({ method, params }),
  );
  try {
    await adapter.handle(v2Request('1', 'initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    }));
    const created = resultSchemas['session.create'].parse(await adapter.handle(v2Request('2', 'session.create', {
      sessionId: 'host-session-mcp-approval',
      workspace: { cwd: '/tmp/work', roots: ['/tmp/work'] },
      config: {},
    })));
    await adapter.handle(v2Request('3', 'turn.start', {
      sessionId: 'host-session-mcp-approval',
      streamId: created.session.streamId,
      turnId: 'host-turn-mcp-approval',
      input: [{ type: 'text', text: 'Inspect Air after asking me.' }],
      config: {},
    }));

    const emitApproval = (id: number, persist?: string[]) => {
      harness.runtime.emitServerRequest({
        id,
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'node_repl',
          mode: 'form',
          message: 'Allow Computer Use to use "Air"?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            connector_id: 'computer-use',
            connector_name: 'Computer Use',
            ...(persist ? { persist } : {}),
            riskLevel: 'low',
            tool_name: 'get_app_state',
            tool_params: { app: 'com.jetbrains.air' },
            tool_params_display: [
              { display_name: 'App', name: 'app', value: 'Air' },
            ],
          },
        },
      });
    };

    emitApproval(601, ['session', 'always']);
    await waitFor(() => notifications.some((value) => (
      value.method === 'interaction.requested'
      && (value.params.data as { interactionId?: string } | undefined)?.interactionId === '601'
    )));
    const requested = notifications.find((value) => (
      value.method === 'interaction.requested'
      && (value.params.data as { interactionId?: string } | undefined)?.interactionId === '601'
    ));
    assert.ok(requested);
    const requestedData = requested.params.data as {
      title?: string;
      description?: string;
      actions?: Array<{ id: string }>;
    };
    assert.equal(requestedData.title, 'Allow Computer Use');
    assert.equal(requestedData.description, 'Allow Computer Use to use "Air"?');
    assert.deepEqual(requestedData.actions?.map((action) => action.id), [
      'accept',
      'acceptForSession',
      'decline',
    ]);

    resultSchemas['interaction.respond'].parse(await adapter.handle(v2Request('4', 'interaction.respond', {
      sessionId: 'host-session-mcp-approval',
      streamId: created.session.streamId,
      turnId: 'host-turn-mcp-approval',
      interactionId: '601',
      responseId: 'resp-601',
      actionId: 'acceptForSession',
    })));
    assert.deepEqual(harness.runtime.responses.at(-1), {
      id: 601,
      payload: {
        action: 'accept',
        content: {},
        _meta: { persist: 'session' },
      },
    });

    emitApproval(602);
    await waitFor(() => notifications.some((value) => (
      value.method === 'interaction.requested'
      && (value.params.data as { interactionId?: string } | undefined)?.interactionId === '602'
    )));
    const onceRequested = notifications.find((value) => (
      value.method === 'interaction.requested'
      && (value.params.data as { interactionId?: string } | undefined)?.interactionId === '602'
    ));
    assert.deepEqual(
      (onceRequested?.params.data as { actions?: Array<{ id: string }> } | undefined)
        ?.actions?.map((action) => action.id),
      ['accept', 'decline'],
    );
    resultSchemas['interaction.respond'].parse(await adapter.handle(v2Request('5', 'interaction.respond', {
      sessionId: 'host-session-mcp-approval',
      streamId: created.session.streamId,
      turnId: 'host-turn-mcp-approval',
      interactionId: '602',
      responseId: 'resp-602',
      actionId: 'accept',
    })));
    assert.deepEqual(harness.runtime.responses.at(-1), {
      id: 602,
      payload: { action: 'accept', content: {} },
    });

    emitApproval(603);
    await waitFor(() => notifications.some((value) => (
      value.method === 'interaction.requested'
      && (value.params.data as { interactionId?: string } | undefined)?.interactionId === '603'
    )));
    resultSchemas['interaction.respond'].parse(await adapter.handle(v2Request('6', 'interaction.respond', {
      sessionId: 'host-session-mcp-approval',
      streamId: created.session.streamId,
      turnId: 'host-turn-mcp-approval',
      interactionId: '603',
      responseId: 'resp-603',
      actionId: 'decline',
    })));
    assert.deepEqual(harness.runtime.responses.at(-1), {
      id: 603,
      payload: { action: 'decline', content: null },
    });

    harness.runtime.emitServerRequest({
      id: 604,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'unknown-thread',
        mode: 'form',
        message: 'This request no longer belongs to an attached session.',
        requestedSchema: { type: 'object', properties: {} },
      },
    });
    await waitFor(() => harness.runtime.responses.some((response) => response.id === 604));
    assert.deepEqual(harness.runtime.responses.at(-1), {
      id: 604,
      payload: { action: 'cancel', content: null },
    });
  } finally {
    await harness.cleanup();
  }
});
