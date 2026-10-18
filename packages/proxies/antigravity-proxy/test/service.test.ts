import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  AuthenticateResponse,
  ContentBlock,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import type {
  AntigravityRuntimeClient,
  CreateServiceSession,
  PermissionHandler,
  RuntimeStopped,
  ServiceEvent,
} from '../src/contracts.js';
import { AntigravityProxyError } from '../src/core/errors.js';
import { AntigravityProxyService, MAX_BUFFER_PER_NATIVE, MAX_BUFFER_TOTAL, MAX_DRAIN_ROUNDS } from '../src/core/service.js';
import { toGianConfigOptions } from '../src/core/catalog.js';
import { AntigravityProtocolV2Adapter } from '../src/protocol/v2-adapter.js';
import { configOptions } from './fixtures/config-options.js';

const CWD = '/work';

function prompt(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

function selectOption(
  id: string,
  category: 'mode' | 'model',
  current: string,
  values: string[],
): SessionConfigOption {
  return {
    id,
    name: id,
    type: 'select',
    category,
    currentValue: current,
    options: values.map((value) => ({ value, name: value })),
  };
}

function defaultOptions(): SessionConfigOption[] {
  return [
    selectOption('mode', 'mode', 'plan', ['plan', 'ask']),
    selectOption('model', 'model', 'gemini-2.5-pro', ['gemini-2.5-pro']),
    { id: 'enabled', name: 'enabled', type: 'boolean', currentValue: true },
  ];
}

function permissionRequest(nativeId: string, optionIds = ['allow', 'reject_once']): RequestPermissionRequest {
  return {
    sessionId: nativeId,
    toolCall: { toolCallId: 'tool-1', title: 'Read file' },
    options: optionIds.map((optionId) => ({
      optionId,
      name: optionId,
      kind: optionId.startsWith('reject') ? 'reject_once' : 'allow_once',
    })),
  };
}

function updateText(event: ServiceEvent): string | undefined {
  if (event.kind !== 'native.update') return undefined;
  const update = event.notification.update;
  if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return undefined;
  return update.content.text;
}

function countKind(events: readonly ServiceEvent[], kind: ServiceEvent['kind']): number {
  return events.filter((event) => event.kind === kind).length;
}

function proxy(error: unknown): AntigravityProxyError {
  assert.ok(error instanceof AntigravityProxyError);
  return error;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class FakeRuntime implements AntigravityRuntimeClient {
  negotiated: InitializeResponse | null = null;
  readonly calls: string[] = [];
  readonly prompts: PromptRequest[] = [];
  readonly configWrites: Array<{ sessionId: string; configId: string; value: string }> = [];
  readonly newSessionRequests: NewSessionRequest[] = [];
  options: SessionConfigOption[] = defaultOptions();
  ensureStartedCount = 0;
  stopCount = 0;
  nextId = 1;
  historyText: string | null = null;
  stopDuringLoad = false;
  stopDuringDispatch = false;
  dispatchError: Error | null = null;
  stopError: Error | null = null;
  onLoad: ((sessionId: string) => void) | null = null;
  listParams: ListSessionsRequest | null = null;
  onDispatch: ((params: PromptRequest) => void | Promise<void>) | null = null;
  onCancel: ((sessionId: string) => void | Promise<void>) | null = null;
  onEnsureStarted: ((count: number) => void) | null = null;
  private permissionHandler: PermissionHandler | null = null;
  private readonly updateListeners: Array<(notification: SessionNotification) => void> = [];
  private readonly stopListeners: Array<(event: RuntimeStopped) => void> = [];
  private readonly pending = new Map<string, {
    resolve: (response: PromptResponse) => void;
    reject: (error: unknown) => void;
  }>();

  async ensureStarted(): Promise<InitializeResponse> {
    this.calls.push('ensureStarted');
    this.ensureStartedCount += 1;
    if (this.onEnsureStarted) this.onEnsureStarted(this.ensureStartedCount);
    const response: InitializeResponse = { protocolVersion: 1 };
    this.negotiated = response;
    return response;
  }

  setPermissionHandler(handler: PermissionHandler | null): void {
    this.permissionHandler = handler;
  }

  on(event: 'sessionUpdate', listener: (notification: SessionNotification) => void): this;
  on(event: 'runtimeStopped', listener: (event: RuntimeStopped) => void): this;
  on(
    event: 'sessionUpdate' | 'runtimeStopped',
    listener: ((notification: SessionNotification) => void) | ((event: RuntimeStopped) => void),
  ): this {
    if (event === 'sessionUpdate') this.updateListeners.push(listener as (notification: SessionNotification) => void);
    else this.stopListeners.push(listener as (event: RuntimeStopped) => void);
    return this;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionRequests.push(structuredClone(params));
    this.calls.push('newSession');
    assert.ok(Array.isArray(params.mcpServers));
    const sessionId = `native-${this.nextId}`;
    this.nextId += 1;
    return { sessionId, configOptions: structuredClone(this.options) };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.calls.push('loadSession');
    if (this.onLoad) this.onLoad(params.sessionId);
    else if (this.historyText) this.emitUpdate(params.sessionId, this.historyText);
    if (this.stopDuringLoad) this.emitStopped({ code: 1, signal: null, expected: false });
    return { configOptions: structuredClone(this.options) };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.calls.push('resumeSession');
    if (this.historyText) this.emitUpdate(params.sessionId, this.historyText);
    return { configOptions: structuredClone(this.options) };
  }

  async listSessions(params?: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.calls.push('listSessions');
    this.listParams = params ?? null;
    return {
      sessions: [{
        sessionId: 'listed',
        cwd: CWD,
        title: 'Listed',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }],
      nextCursor: null,
    };
  }

  async dispatchPrompt(params: PromptRequest): Promise<{ response: Promise<PromptResponse> }> {
    this.calls.push('dispatchPrompt');
    if (this.dispatchError) throw this.dispatchError;
    this.prompts.push(params);
    if (this.stopDuringDispatch) {
      const response = Promise.reject(new Error('native prompt lost'));
      this.emitStopped({ code: 1, signal: null, expected: false });
      return { response };
    }
    let resolvePrompt: (response: PromptResponse) => void = () => undefined;
    let rejectPrompt: (error: unknown) => void = () => undefined;
    const response = new Promise<PromptResponse>((resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    });
    this.pending.set(params.sessionId, { resolve: resolvePrompt, reject: rejectPrompt });
    if (this.onDispatch) await this.onDispatch(params);
    return { response };
  }

  resolvePrompt(nativeId: string, response: PromptResponse = { stopReason: 'end_turn' }): void {
    const pending = this.pending.get(nativeId);
    if (!pending) throw new Error(`no prompt for ${nativeId}`);
    this.pending.delete(nativeId);
    pending.resolve(response);
  }

  rejectPrompt(nativeId: string, error: Error): void {
    const pending = this.pending.get(nativeId);
    if (!pending) throw new Error(`no prompt for ${nativeId}`);
    this.pending.delete(nativeId);
    pending.reject(error);
  }

  async cancel(sessionId: string): Promise<void> {
    this.calls.push(`cancel:${sessionId}`);
    if (this.onCancel) await this.onCancel(sessionId);
  }

  async setConfigOption(params: { sessionId: string; configId: string; value: string }): Promise<unknown> {
    this.calls.push('setConfigOption');
    this.configWrites.push(params);
    this.options = this.options.map((option) => {
      if (option.id !== params.configId || option.type !== 'select') return option;
      return { ...option, currentValue: params.value };
    });
    return { configOptions: structuredClone(this.options) };
  }

  async authenticate(): Promise<AuthenticateResponse> {
    this.calls.push('authenticate');
    return {};
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    this.stopCount += 1;
    if (this.stopError) throw this.stopError;
    this.emitStopped({ code: null, signal: null, expected: true });
  }

  requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.permissionHandler) return Promise.reject(new Error('no permission handler'));
    return this.permissionHandler(request);
  }

  emitUpdate(sessionId: string, text: string): void {
    const notification: SessionNotification = {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    };
    for (const listener of this.updateListeners) listener(notification);
  }

  emitConfig(sessionId: string, options: SessionConfigOption[]): void {
    this.options = structuredClone(options);
    for (const listener of this.updateListeners) listener({
      sessionId, update: { sessionUpdate: 'config_option_update', configOptions: structuredClone(options) },
    });
  }

  emitStopped(event: RuntimeStopped): void {
    for (const listener of this.stopListeners) listener(event);
  }
}

interface Harness {
  runtime: FakeRuntime;
  service: AntigravityProxyService;
  events: ServiceEvent[];
}

function harness(options?: {
  maxSessions?: number;
  approvalTimeoutMs?: number;
  cancelTimeoutMs?: number;
}): Harness {
  const runtime = new FakeRuntime();
  const events: ServiceEvent[] = [];
  const service = new AntigravityProxyService({
    runtime,
    now: () => new Date('2026-04-01T00:00:00.000Z'),
    approvalTimeoutMs: options?.approvalTimeoutMs ?? 40,
    cancelTimeoutMs: options?.cancelTimeoutMs ?? 40,
    ...(options?.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
  });
  service.setEventSink((event) => { events.push(event); });
  return { runtime, service, events };
}

function attach(
  h: Harness,
  sessionId: string,
  extra?: Omit<CreateServiceSession, 'sessionId' | 'cwd'>,
): Promise<ReturnType<AntigravityProxyService['getSession']>> {
  return h.service.createSession({ sessionId, cwd: CWD, ...extra });
}

function assertNoNativeClose(runtime: FakeRuntime): void {
  assert.equal(runtime.calls.some((call) => call.includes('session/close') || call === 'close'), false);
  assert.equal(typeof (runtime as { close?: unknown }).close, 'undefined');
  assert.equal(runtime.calls.includes('authenticate'), false);
}

test('Host context roots stay out of ACP creation and triplet setters preserve permission lifecycle', async () => {
  const h = harness({ approvalTimeoutMs: 5_000 });
  h.runtime.options = configOptions();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new AntigravityProtocolV2Adapter(h.service, '0.0.1', (method, params) => events.push({ method, params }), {
    cliModels: { candidates: [] },
  });
  const call = (method: string, params: Record<string, unknown>) => adapter.handle({ jsonrpc: '2.0', id: method, method, params });
  await call('initialize', { protocol: { name: 'gian.proxy', versions: ['2.3'] } });
  const created = await call('session.create', {
    sessionId: 'product', workspace: { cwd: CWD, roots: [CWD, '/session/attachments'] },
    config: { model: 'gemini-3.8-flash', thinking: 'low', mode: 'auto_edit' },
  }) as { session: { streamId: string; turnConfigOptions: Array<{ id: string; defaultValue: unknown }> } };
  assert.deepEqual(h.runtime.newSessionRequests, [{ cwd: CWD, mcpServers: [] }]);
  assert.deepEqual(h.runtime.configWrites.map(({ configId, value }) => ({ configId, value })), [
    { configId: 'model', value: 'gemini-3.8-flash-low' }, { configId: 'mode', value: 'auto_edit' },
  ]);
  assert.deepEqual(created.session.turnConfigOptions.map(option => [option.id, option.defaultValue]), [
    ['model', 'gemini-3.8-flash'], ['thinking', 'low'], ['mode', 'auto_edit'],
  ]);
  let permission: Promise<RequestPermissionResponse> | undefined;
  h.runtime.onDispatch = params => {
    assert.deepEqual(h.runtime.configWrites.slice(-2).map(({ configId, value }) => ({ configId, value })), [
      { configId: 'model', value: 'gemini-3.8-flash-medium' }, { configId: 'mode', value: 'default' },
    ]);
    permission = h.runtime.requestPermission(permissionRequest(params.sessionId));
  };
  await call('turn.start', {
    sessionId: 'product', streamId: created.session.streamId, turnId: 'turn-1',
    input: prompt('hello'), config: { mode: 'default', model: 'gemini-3.8-flash', thinking: 'medium' },
  });
  const interaction = events.find(event => event.method === 'interaction.requested');
  assert.ok(interaction);
  await call('interaction.respond', {
    sessionId: 'product', streamId: created.session.streamId,
    turnId: 'turn-1', interactionId: (interaction.params.data as Record<string, unknown>).interactionId,
    responseId: 'approval-1', actionId: 'allow', values: {},
  });
  assert.deepEqual(await permission, { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.equal(events.filter(event => event.method === 'interaction.resolved').length, 1);
  assert.equal(h.runtime.configWrites.some(write => write.configId === 'thinking'), false);
  h.runtime.resolvePrompt('native-1');
  await new Promise<void>(resolve => setImmediate(resolve));
  await adapter.close();
});

test('load and resume preserve exact native variant/mode and apply legacy defaults without synthetic setters', async () => {
  for (const resumeMode of ['load', 'resume'] as const) {
    const h = harness();
    h.runtime.options = configOptions('gemini-3.8-flash-medium', 'auto_edit');
    const loaded = await attach(h, `native-${resumeMode}`, { nativeSessionId: 'restored', resumeMode });
    assert.deepEqual(toGianConfigOptions(loaded.configOptions).map(option => [option.id, option.defaultValue]), [
      ['model', 'gemini-3.8-flash'], ['thinking', 'medium'], ['mode', 'auto_edit'],
    ]);
    assert.deepEqual(h.runtime.configWrites, []);
    h.runtime.emitConfig('restored', configOptions('gemini-3.8-flash-low', 'yolo'));
    const changed = h.events.filter(event => event.kind === 'session.changed').at(-1);
    assert.ok(changed?.kind === 'session.changed');
    assert.deepEqual(toGianConfigOptions(changed.session.configOptions).map(option => [option.id, option.defaultValue]), [
      ['model', 'gemini-3.8-flash'], ['thinking', 'low'], ['mode', 'yolo'],
    ]);
    await h.service.close();
    const legacy = harness();
    legacy.runtime.options = configOptions();
    const session = await attach(legacy, 'legacy', {
      nativeSessionId: 'legacy-native', resumeMode, config: { model: 'gemini-3.8-flash-low', mode: 'auto_edit' },
    });
    assert.deepEqual(legacy.runtime.configWrites.map(write => [write.configId, write.value]), [
      ['model', 'gemini-3.8-flash-low'], ['mode', 'auto_edit'],
    ]);
    assert.equal(toGianConfigOptions(session.configOptions).find(option => option.id === 'thinking')?.defaultValue, 'low');
    await legacy.service.close();
  }
});

test('invalid pairs and unsupported live modes fail as a batch before any setter or prompt', async () => {
  const h = harness();
  h.runtime.options = configOptions();
  await attach(h, 'gian');
  for (const config of [
    { model: 'gemini-3.8-flash', thinking: 'max', mode: 'yolo' },
    { model: 'gemini-3.8-flash-high', thinking: 'low', mode: 'auto_edit' },
    { model: 'gemini-future-pro', mode: 'auto_edit' },
    { model: 'gemini-3.8-flash', thinking: 'low', mode: 'ask' },
    { model: 'gemini-fixed', thinking: 'high' },
  ] as Array<Record<string, string>>) {
    await assert.rejects(h.service.startTurn({ sessionId: 'gian', turnId: 'bad', prompt: prompt('never'), config }),
      error => proxy(error).domainCode === 'CONFIG_VALUE_INVALID');
    assert.deepEqual(h.runtime.configWrites, []);
    assert.deepEqual(h.runtime.prompts, []);
  }
  await h.service.close();
});

test('new session mode is conservative; a refused or later changed native selection never prompts', async () => {
  const h = harness();
  h.runtime.options = configOptions('gemini-3.8-flash-high', 'yolo');
  await attach(h, 'gian');
  assert.deepEqual(h.runtime.configWrites.map(write => [write.configId, write.value]), [['mode', 'default']]);
  const write = h.runtime.setConfigOption.bind(h.runtime);
  h.runtime.setConfigOption = async params => {
    await write(params);
    if (params.configId === 'mode') h.runtime.options = configOptions('gemini-3.8-flash-high', params.value);
    return { configOptions: structuredClone(h.runtime.options) };
  };
  await assert.rejects(h.service.startTurn({
    sessionId: 'gian', turnId: 'changed', prompt: prompt('never'),
    config: { model: 'gemini-3.8-flash', thinking: 'low', mode: 'auto_edit' },
  }), /configuration changed/);
  assert.deepEqual(h.runtime.prompts, []);
  h.runtime.setConfigOption = async () => ({ configOptions: configOptions() });
  await assert.rejects(h.service.startTurn({
    sessionId: 'gian', turnId: 'refused', prompt: prompt('never'), config: { model: 'gemini-3.8-flash', thinking: 'low' },
  }), /did not select/);
  assert.deepEqual(h.runtime.prompts, []);
  h.runtime.setConfigOption = async () => ({ configOptions: [null] });
  await assert.rejects(h.service.startTurn({
    sessionId: 'gian', turnId: 'malformed', prompt: prompt('never'), config: { model: 'gemini-3.8-flash', thinking: 'low' },
  }), /unreadable config options/);
  assert.deepEqual(h.runtime.prompts, []);
  await h.service.close();
});

test('missing native Default cannot silently turn a new session into YOLO', async () => {
  const h = harness();
  h.runtime.options = configOptions('gemini-3.8-flash-high', 'yolo').map(option => option.id === 'mode'
    ? { ...option, options: [{ value: 'yolo', name: 'YOLO' }] } as SessionConfigOption : option);
  await assert.rejects(attach(h, 'never'), error => proxy(error).domainCode === 'CONFIG_VALUE_INVALID');
  assert.deepEqual(h.runtime.configWrites, []);
  assert.deepEqual(h.runtime.prompts, []);
  await h.service.close();
});

test('two sessions run concurrent turns and one approval does not block the other', async () => {
  const h = harness();
  const first = await attach(h, 'gian-a');
  const second = await attach(h, 'gian-b');
  assert.equal(first.id, 'gian-a');
  assert.equal(first.nativeSessionId, 'native-1');
  assert.notEqual(first.id, first.nativeSessionId);
  assert.equal(second.nativeSessionId, 'native-2');

  let permission: Promise<RequestPermissionResponse> | undefined;
  h.runtime.onDispatch = (params) => {
    if (params.sessionId !== first.nativeSessionId) return;
    permission = h.runtime.requestPermission(permissionRequest(params.sessionId));
  };
  const startedA = await withTimeout(h.service.startTurn({
    sessionId: 'gian-a',
    turnId: 'turn-a',
    prompt: prompt('from a'),
  }), 'start A');
  assert.equal(startedA.turnId, 'turn-a');
  assert.ok(permission);
  let resolved = false;
  void permission.then(() => { resolved = true; }, () => { resolved = true; });

  const startedB = await withTimeout(h.service.startTurn({
    sessionId: 'gian-b',
    turnId: 'turn-b',
    prompt: prompt('from b'),
  }), 'start B');
  assert.equal(startedB.turnId, 'turn-b');
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(countKind(h.events, 'turn.completed'), 0);
  assert.equal(h.runtime.prompts.length, 2);
  assert.equal(h.runtime.prompts[0]?.sessionId, 'native-1');
  assert.equal(h.runtime.prompts[1]?.sessionId, 'native-2');
  await assert.rejects(
    () => h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-a2', prompt: prompt('again') }),
    (error: unknown) => proxy(error).domainCode === 'SESSION_BUSY',
  );
  assert.equal(h.runtime.prompts.length, 2);

  const requested = h.events.find((event) => event.kind === 'permission.requested');
  assert.ok(requested && requested.kind === 'permission.requested');
  assert.equal(requested.interactionId, 'perm:gian-a:turn-a:1');
  h.service.respondPermission({
    sessionId: 'gian-a',
    interactionId: requested.interactionId,
    optionId: 'allow',
  });
  const decision = await permission;
  assert.deepEqual(decision.outcome, { outcome: 'selected', optionId: 'allow' });
  h.runtime.resolvePrompt('native-1');
  h.runtime.resolvePrompt('native-2');
  await Promise.resolve();
  assert.equal(countKind(h.events, 'turn.completed'), 2);
  assert.equal(h.service.getSession('gian-a').state, 'idle');
  assert.equal(h.service.getSession('gian-b').state, 'idle');
  assertNoNativeClose(h.runtime);
});

test('startTurn returns after dispatch and before the native prompt settles', async () => {
  const h = harness();
  const session = await attach(h, 'gian-1');
  const started = await withTimeout(h.service.startTurn({
    sessionId: 'gian-1',
    turnId: 'turn-1',
    prompt: prompt('hello'),
  }), 'start');
  assert.equal(started.turnId, 'turn-1');
  assert.equal(countKind(h.events, 'turn.completed'), 0);
  assert.equal(h.service.getSession('gian-1').state, 'running');
  assert.equal(h.service.getSession('gian-1').activeTurnId, 'turn-1');
  h.runtime.resolvePrompt(session.nativeSessionId, { stopReason: 'end_turn' });
  await Promise.resolve();
  const completed = h.events.find((event) => event.kind === 'turn.completed');
  assert.ok(completed && completed.kind === 'turn.completed');
  assert.equal(completed.response.stopReason, 'end_turn');
  assert.equal(h.runtime.prompts.length, 1);
});

test('unknown, mismatched, and expired permission requests fail closed', async () => {
  const h = harness({ approvalTimeoutMs: 20 });
  const session = await attach(h, 'gian-1');
  await attach(h, 'gian-2');
  await h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-1', prompt: prompt('hello') });
  const unknown = await h.runtime.requestPermission(permissionRequest('native-missing'));
  assert.deepEqual(unknown.outcome, { outcome: 'cancelled' });
  const duplicate = await h.runtime.requestPermission(permissionRequest(session.nativeSessionId, ['allow', 'allow']));
  assert.deepEqual(duplicate.outcome, { outcome: 'cancelled' });
  assert.equal(countKind(h.events, 'permission.requested'), 0);

  const pending = h.runtime.requestPermission(permissionRequest(session.nativeSessionId));
  const requested = h.events.find((event) => event.kind === 'permission.requested');
  assert.ok(requested && requested.kind === 'permission.requested');
  assert.throws(
    () => h.service.respondPermission({
      sessionId: 'gian-2',
      interactionId: requested.interactionId,
      optionId: 'allow',
    }),
    (error: unknown) => proxy(error).domainCode === 'INTERACTION_NOT_FOUND',
  );
  assert.throws(
    () => h.service.respondPermission({
      sessionId: 'gian-1',
      interactionId: 'perm:missing',
      optionId: 'allow',
    }),
    (error: unknown) => proxy(error).domainCode === 'INTERACTION_NOT_FOUND',
  );
  assert.throws(
    () => h.service.respondPermission({
      sessionId: 'gian-1',
      interactionId: requested.interactionId,
      optionId: 'not-advertised',
    }),
    (error: unknown) => proxy(error).domainCode === 'INTERACTION_ACTION_NOT_FOUND',
  );
  assert.equal(h.service.getSession('gian-1').state, 'waiting_interaction');
  const decision = await pending;
  assert.deepEqual(decision.outcome, { outcome: 'cancelled' });
  const resolved = h.events.find((event) => event.kind === 'permission.resolved');
  assert.ok(resolved && resolved.kind === 'permission.resolved');
  assert.equal(resolved.outcome, 'expired');
  assert.throws(
    () => h.service.respondPermission({
      sessionId: 'gian-1',
      interactionId: requested.interactionId,
      optionId: 'allow',
    }),
    (error: unknown) => proxy(error).domainCode === 'INTERACTION_NOT_FOUND',
  );
  h.runtime.resolvePrompt(session.nativeSessionId);
  await Promise.resolve();
});

test('confirmed cancel waits for the native stop reason and does not invent one', async () => {
  const h = harness();
  const session = await attach(h, 'gian-1');
  await h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-1', prompt: prompt('hello') });
  h.runtime.onCancel = (nativeId) => {
    h.runtime.resolvePrompt(nativeId, { stopReason: 'cancelled' });
  };
  await withTimeout(h.service.interruptTurn('gian-1', 'turn-1'), 'interrupt');
  await Promise.resolve();
  const completed = h.events.find((event) => event.kind === 'turn.completed');
  assert.ok(completed && completed.kind === 'turn.completed');
  assert.equal(completed.response.stopReason, 'cancelled');
  assert.equal(countKind(h.events, 'turn.failed'), 0);
  assert.equal(h.runtime.prompts.length, 1);
  assert.equal(h.runtime.calls.includes(`cancel:${session.nativeSessionId}`), true);
  assert.equal(h.service.getSession('gian-1').activeTurnId, null);
});

test('cancel timeout does not invent cancelled and does not resend', async () => {
  const h = harness({ cancelTimeoutMs: 20 });
  const session = await attach(h, 'gian-1');
  await h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-1', prompt: prompt('hello') });
  await withTimeout(assert.rejects(
    () => h.service.interruptTurn('gian-1', 'turn-1'),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_ERROR');
      assert.equal(proxyError.retryable, true);
      assert.equal(proxyError.details?.resent, false);
      assert.match(proxyError.message, /not marked cancelled/);
      return true;
    },
  ), 'interrupt');
  assert.equal(countKind(h.events, 'turn.completed'), 0);
  assert.equal(countKind(h.events, 'turn.failed'), 0);
  assert.equal(h.runtime.prompts.length, 1);
  assert.equal(h.runtime.stopCount, 0);
  assert.equal(h.service.getSession('gian-1').state, 'running');
  assert.equal(h.service.getSession('gian-1').activeTurnId, 'turn-1');
  h.runtime.resolvePrompt(session.nativeSessionId, { stopReason: 'end_turn' });
  await Promise.resolve();
  const completed = h.events.find((event) => event.kind === 'turn.completed');
  assert.ok(completed && completed.kind === 'turn.completed');
  assert.equal(completed.response.stopReason, 'end_turn');
  assert.equal(h.runtime.prompts.length, 1);
});

test('unconfirmed close stays attached while another session keeps the runtime', async () => {
  const h = harness({ cancelTimeoutMs: 20 });
  const busy = await attach(h, 'gian-a');
  await attach(h, 'gian-b');
  await h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-a', prompt: prompt('still running') });
  h.runtime.onCancel = async (nativeId) => {
    const response = await h.runtime.requestPermission(permissionRequest(nativeId));
    assert.deepEqual(response.outcome, { outcome: 'cancelled' });
  };
  await withTimeout(assert.rejects(
    () => h.service.closeSession('gian-a'),
    (error: unknown) => proxy(error).domainCode === 'RUNTIME_ERROR',
  ), 'close');
  const after = h.service.getSession('gian-a');
  assert.equal(after.state, 'running');
  assert.equal(after.activeTurnId, 'turn-a');
  assert.notEqual(after.state, 'closed');
  assert.equal(h.service.getSession('gian-b').state, 'idle');
  assert.equal(h.runtime.stopCount, 0);
  assert.equal(countKind(h.events, 'turn.failed'), 0);
  assert.equal(countKind(h.events, 'turn.completed'), 0);
  assert.equal(countKind(h.events, 'permission.requested'), 0);
  assert.equal(h.runtime.prompts.length, 1);
  assertNoNativeClose(h.runtime);

  h.runtime.resolvePrompt(busy.nativeSessionId, { stopReason: 'end_turn' });
  await Promise.resolve();
  const completed = h.events.find((event) => event.kind === 'turn.completed');
  assert.ok(completed && completed.kind === 'turn.completed');
  assert.equal(completed.response.stopReason, 'end_turn');
  await h.service.closeSession('gian-a');
  assert.equal(h.service.getSession('gian-a').state, 'closed');
  assert.equal(h.runtime.stopCount, 0);
  await h.service.closeSession('gian-b');
  assert.equal(h.service.getSession('gian-b').state, 'closed');
  assert.equal(h.runtime.stopCount, 1);
  const stopped = h.events.find((event) => event.kind === 'runtime.stopped');
  assert.ok(stopped && stopped.kind === 'runtime.stopped');
  assert.equal(stopped.event.expected, true);
  assert.equal(h.events.some((event) => event.kind === 'session.changed' && event.session.state === 'stale'), false);
});

test('a native cancel error rejects close and leaves the turn open', async () => {
  const h = harness();
  const session = await attach(h, 'gian-1');
  await h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-1', prompt: prompt('hello') });
  h.runtime.onCancel = () => { throw new Error('cancel broke'); };
  await assert.rejects(
    () => h.service.closeSession('gian-1'),
    (error: unknown) => proxy(error).domainCode === 'RUNTIME_ERROR',
  );
  assert.equal(h.service.getSession('gian-1').state, 'running');
  assert.equal(h.service.getSession('gian-1').activeTurnId, 'turn-1');
  assert.equal(countKind(h.events, 'turn.failed'), 0);
  assert.equal(h.runtime.stopCount, 0);
  assert.equal(h.runtime.prompts.length, 1);
  h.runtime.resolvePrompt(session.nativeSessionId, { stopReason: 'end_turn' });
  await Promise.resolve();
  assert.equal(h.service.getSession('gian-1').state, 'idle');
});

test('unexpected runtime exit marks sessions stale and does not resend', async () => {
  const h = harness();
  const session = await attach(h, 'gian-old');
  await h.service.startTurn({ sessionId: 'gian-old', turnId: 'turn-old', prompt: prompt('old prompt') });
  const pending = h.runtime.requestPermission(permissionRequest(session.nativeSessionId));
  h.runtime.emitStopped({ code: 1, signal: null, expected: false });
  const decision = await pending;
  assert.deepEqual(decision.outcome, { outcome: 'cancelled' });
  assert.equal(h.service.getSession('gian-old').state, 'stale');
  const failed = h.events.find((event) => event.kind === 'turn.failed');
  assert.ok(failed && failed.kind === 'turn.failed');
  const error = proxy(failed.error);
  assert.equal(error.domainCode, 'RUNTIME_ERROR');
  assert.equal(error.retryable, false);
  assert.equal(error.details?.uncertain, true);
  assert.equal(error.details?.resent, false);
  const permission = h.events.find((event) => event.kind === 'permission.resolved');
  assert.ok(permission && permission.kind === 'permission.resolved');
  assert.equal(permission.outcome, 'runtime_ended');
  assert.equal(h.runtime.ensureStartedCount, 1);
  assert.equal(h.runtime.prompts.length, 1);
  await assert.rejects(
    () => h.service.startTurn({ sessionId: 'gian-old', turnId: 'turn-again', prompt: prompt('old prompt') }),
    (error: unknown) => proxy(error).domainCode === 'SESSION_STALE',
  );
  assert.equal(h.runtime.ensureStartedCount, 1);
  assert.equal(h.runtime.prompts.length, 1);

  const created = await attach(h, 'gian-new');
  assert.equal(h.runtime.ensureStartedCount, 2);
  assert.equal(h.service.getSession('gian-old').state, 'stale');
  h.runtime.emitUpdate(session.nativeSessionId, 'from-old-native');
  assert.equal(h.events.some((event) => updateText(event) === 'from-old-native'), false);
  await h.service.startTurn({ sessionId: 'gian-new', turnId: 'turn-new', prompt: prompt('new prompt') });
  assert.deepEqual(h.runtime.prompts.map((item) => item.prompt[0]), [
    { type: 'text', text: 'old prompt' },
    { type: 'text', text: 'new prompt' },
  ]);
  assert.equal(h.runtime.prompts[1]?.sessionId, created.nativeSessionId);
  assert.notEqual(created.nativeSessionId, session.nativeSessionId);
});

test('runtime exit during close detaches only after the process is gone', async () => {
  const h = harness();
  await attach(h, 'gian-a');
  await attach(h, 'gian-b');
  await h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-a', prompt: prompt('hello') });
  h.runtime.onCancel = () => {
    h.runtime.emitStopped({ code: 1, signal: null, expected: false });
  };
  await h.service.closeSession('gian-a');
  assert.equal(h.service.getSession('gian-a').state, 'closed');
  assert.equal(h.service.getSession('gian-b').state, 'stale');
  assert.equal(h.runtime.stopCount, 0);
  assert.equal(h.runtime.prompts.length, 1);
  const failed = h.events.find((event) => event.kind === 'turn.failed');
  assert.ok(failed && failed.kind === 'turn.failed');
  assert.equal(proxy(failed.error).details?.resent, false);
});

test('the last live close stops the runtime and a later create starts a fresh one', async () => {
  const h = harness();
  const oldSession = await attach(h, 'gian-old');
  await h.service.startTurn({ sessionId: 'gian-old', turnId: 'turn-old', prompt: prompt('old prompt') });
  h.runtime.resolvePrompt(oldSession.nativeSessionId);
  await Promise.resolve();
  await h.service.closeSession('gian-old');
  assert.equal(h.service.getSession('gian-old').state, 'closed');
  assert.equal(h.runtime.stopCount, 1);
  assert.equal(h.runtime.ensureStartedCount, 1);
  const stopped = h.events.find((event) => event.kind === 'runtime.stopped');
  assert.ok(stopped && stopped.kind === 'runtime.stopped');
  assert.equal(stopped.event.expected, true);
  assert.equal(h.events.some((event) => event.kind === 'session.changed' && event.session.state === 'stale'), false);
  await assert.rejects(
    () => h.service.startTurn({ sessionId: 'gian-old', turnId: 'turn-again', prompt: prompt('old prompt') }),
    (error: unknown) => proxy(error).domainCode === 'SESSION_CLOSED',
  );
  assert.equal(h.runtime.ensureStartedCount, 1);
  assert.equal(h.runtime.prompts.length, 1);

  const listed = await h.service.listNativeSessions({ cursor: 'page-2' });
  assert.equal(listed.sessions[0]?.sessionId, 'listed');
  assert.equal(listed.sessions[0]?.title, 'Listed');
  assert.equal(h.runtime.listParams?.cursor, 'page-2');
  assert.equal(h.runtime.ensureStartedCount, 2);
  const created = await attach(h, 'gian-new');
  assert.equal(h.runtime.ensureStartedCount, 2);
  assert.equal(h.service.getSession('gian-old').state, 'closed');
  await h.service.startTurn({ sessionId: 'gian-new', turnId: 'turn-new', prompt: prompt('new prompt') });
  assert.deepEqual(h.runtime.prompts.map((item) => item.prompt[0]), [
    { type: 'text', text: 'old prompt' },
    { type: 'text', text: 'new prompt' },
  ]);
  assert.equal(h.runtime.prompts[1]?.sessionId, created.nativeSessionId);
  assertNoNativeClose(h.runtime);
});

test('load history is replay and later live updates are not', async () => {
  const h = harness();
  h.runtime.historyText = 'old-history';
  const session = await attach(h, 'gian-1', { nativeSessionId: 'native-history', resumeMode: 'load' });
  const history = h.events.find((event) => updateText(event) === 'old-history');
  assert.ok(history && history.kind === 'native.update');
  assert.equal(history.replay, true);
  assert.equal(history.turnId, undefined);
  assert.equal(history.sessionId, 'gian-1');
  h.runtime.emitUpdate(session.nativeSessionId, 'live-idle');
  const idle = h.events.find((event) => updateText(event) === 'live-idle');
  assert.ok(idle && idle.kind === 'native.update');
  assert.equal(idle.replay, false);
  assert.equal(idle.turnId, undefined);
  h.runtime.onDispatch = (params) => { h.runtime.emitUpdate(params.sessionId, 'during-start'); };
  await h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-1', prompt: prompt('hello') });
  const startedAt = h.events.findIndex((event) => event.kind === 'turn.started');
  const duringAt = h.events.findIndex((event) => updateText(event) === 'during-start');
  assert.ok(startedAt >= 0 && duringAt > startedAt);
  const during = h.events[duringAt];
  assert.ok(during && during.kind === 'native.update');
  assert.equal(during.replay, false);
  assert.equal(during.turnId, 'turn-1');
});

test('resume updates that arrive before the response are replay', async () => {
  const h = harness();
  h.runtime.historyText = 'resume-history';
  await attach(h, 'gian-1', { nativeSessionId: 'native-resume', resumeMode: 'resume' });
  const history = h.events.find((event) => updateText(event) === 'resume-history');
  assert.ok(history && history.kind === 'native.update');
  assert.equal(history.replay, true);
  assert.equal(h.runtime.calls.includes('resumeSession'), true);
  assert.equal(h.runtime.calls.includes('loadSession'), false);
});

test('a crashed load drops buffered history instead of reusing it', async () => {
  const h = harness();
  h.runtime.historyText = 'old-history';
  h.runtime.stopDuringLoad = true;
  h.runtime.onEnsureStarted = (count) => {
    if (count === 2) h.runtime.emitUpdate('native-history', 'stale-gen');
  };
  await assert.rejects(
    () => attach(h, 'gian-old', { nativeSessionId: 'native-history', resumeMode: 'load' }),
    (error: unknown) => proxy(error).domainCode === 'RUNTIME_UNAVAILABLE',
  );
  assert.equal(h.service.getSession('gian-old').state, 'stale');
  assert.equal(h.events.some((event) => updateText(event) === 'old-history'), false);
  await attach(h, 'gian-new');
  assert.equal(h.events.some((event) => updateText(event) === 'stale-gen'), false);
  assert.equal(h.events.some((event) => updateText(event) === 'old-history'), false);
  assert.equal(h.runtime.prompts.length, 0);
  assert.equal(h.service.getSession('gian-old').state, 'stale');
});

test('invalid explicit models are rejected from the advertised options', async () => {
  const h = harness();
  h.runtime.options = [selectOption('mode', 'mode', 'plan', ['plan', 'ask'])];
  await assert.rejects(
    () => attach(h, 'gian-1', { config: { model: 'gemini-invented' } }),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'CONFIG_VALUE_INVALID');
      assert.equal(proxyError.retryable, false);
      assert.match(proxyError.message, /Unknown config id 'model'/);
      assert.equal(proxyError.details?.nativeSessionId, 'native-1');
      return true;
    },
  );
  assert.equal(h.runtime.configWrites.length, 0);
  assert.equal(countKind(h.events, 'session.changed'), 0);
  assert.throws(() => h.service.getSession('gian-1'), (error: unknown) => proxy(error).domainCode === 'SESSION_NOT_FOUND');
  const restored = await attach(h, 'gian-2', { nativeSessionId: 'native-1', resumeMode: 'resume' });
  assert.equal(restored.nativeSessionId, 'native-1');
  assert.equal(h.runtime.calls.filter((call) => call === 'newSession').length, 1);
  assert.equal(h.runtime.calls.includes('resumeSession'), true);
});

test('a model value outside the advertised choices is rejected', async () => {
  const h = harness();
  h.runtime.options = [{
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: 'gemini-2.5-pro',
    options: [{
      group: 'gemini',
      name: 'Gemini',
      options: [
        { value: 'gemini-2.5-pro', name: 'Pro' },
        { value: 'gemini-2.5-flash', name: 'Flash' },
      ],
    }],
  }];
  await assert.rejects(
    () => attach(h, 'gian-bad', { config: { model: 'claude-invented' } }),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'CONFIG_VALUE_INVALID');
      assert.equal(proxyError.retryable, false);
      assert.match(proxyError.message, /not an available Gemini model/);
      return true;
    },
  );
  assert.equal(h.runtime.configWrites.length, 0);
  const session = await attach(h, 'gian-ok', { config: { model: 'gemini-2.5-flash' } });
  assert.equal(h.runtime.configWrites.length, 1);
  assert.equal(h.runtime.configWrites[0]?.value, 'gemini-2.5-flash');
  const selected = session.configOptions[0];
  assert.ok(selected);
  assert.equal(selected.type, 'select');
  if (selected.type === 'select') assert.equal(selected.currentValue, 'gemini-2.5-flash');
});

test('string mode is applied after newSession and a boolean option is rejected', async () => {
  const h = harness();
  const session = await attach(h, 'gian-1', { config: { mode: 'ask' } });
  assert.deepEqual(h.runtime.configWrites, [{ sessionId: 'native-1', configId: 'mode', value: 'ask' }]);
  assert.deepEqual(session.configOptions.map((option) => option.id), ['mode', 'model', 'enabled']);
  const mode = session.configOptions.find((option) => option.id === 'mode');
  assert.ok(mode && mode.type === 'select');
  assert.equal(mode.currentValue, 'ask');
  await h.service.startTurn({
    sessionId: 'gian-1',
    turnId: 'turn-1',
    prompt: prompt('hello'),
    config: { mode: 'ask' },
  });
  assert.equal(h.runtime.configWrites.length, 1);
  assert.deepEqual(h.runtime.calls.slice(0, 3), ['ensureStarted', 'newSession', 'setConfigOption']);
  assert.ok(h.runtime.calls.indexOf('dispatchPrompt') > h.runtime.calls.indexOf('setConfigOption'));
  h.runtime.resolvePrompt(session.nativeSessionId);
  await Promise.resolve();

  const rejected = harness();
  await assert.rejects(
    () => attach(rejected, 'gian-bool', { config: { enabled: true } }),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'CONFIG_VALUE_INVALID');
      assert.equal(proxyError.retryable, false);
      assert.match(proxyError.message, /not a supported string selector/);
      assert.equal(proxyError.details?.nativeSessionId, 'native-1');
      return true;
    },
  );
  assert.equal(rejected.runtime.configWrites.length, 0);
});

test('duplicate native ownership and capacity fail before another native create', async () => {
  const capped = harness({ maxSessions: 1 });
  const first = await attach(capped, 'gian-1');
  await assert.rejects(
    () => attach(capped, 'gian-2'),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  assert.equal(capped.runtime.calls.filter((call) => call === 'newSession').length, 1);
  await assert.rejects(
    () => attach(capped, 'gian-3', { nativeSessionId: first.nativeSessionId, resumeMode: 'resume' }),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  assert.equal(capped.runtime.calls.includes('resumeSession'), false);

  const retained = harness({ maxSessions: 2 });
  const alpha = await attach(retained, 'gian-a');
  await attach(retained, 'gian-b');
  await retained.service.closeSession('gian-a');
  assert.equal(retained.runtime.stopCount, 0);
  await assert.rejects(() => attach(retained, 'gian-c'), (error: unknown) => proxy(error).domainCode === 'CONFLICT');
  assert.equal(retained.runtime.calls.filter((call) => call === 'newSession').length, 2);
  const rebound = await attach(retained, 'gian-d', { nativeSessionId: alpha.nativeSessionId, resumeMode: 'resume' });
  assert.equal(rebound.nativeSessionId, alpha.nativeSessionId);
  assert.equal(retained.runtime.calls.filter((call) => call === 'newSession').length, 2);
});

test('an unconfirmed close does not free the native session for someone else', async () => {
  const h = harness({ maxSessions: 2, cancelTimeoutMs: 20 });
  const busy = await attach(h, 'gian-a');
  await attach(h, 'gian-b');
  await h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-a', prompt: prompt('running') });
  await withTimeout(
    assert.rejects(() => h.service.closeSession('gian-a')),
    'close',
  );
  await assert.rejects(() => attach(h, 'gian-c'), (error: unknown) => proxy(error).domainCode === 'CONFLICT');
  await assert.rejects(
    () => attach(h, 'gian-d', { nativeSessionId: busy.nativeSessionId, resumeMode: 'resume' }),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  assert.equal(h.runtime.calls.filter((call) => call === 'newSession').length, 2);
  assert.equal(h.runtime.calls.includes('resumeSession'), false);
  assert.equal(h.service.getSession('gian-a').state, 'running');
  assert.equal(h.runtime.stopCount, 0);
  assert.equal(h.runtime.prompts.length, 1);
});

test('invalid input and a failed dispatch do not leave a busy turn', async () => {
  const h = harness();
  await attach(h, 'gian-1');
  await assert.rejects(
    () => h.service.startTurn({
      sessionId: 'gian-1',
      turnId: 'turn-bad',
      prompt: [{ type: 'image', data: 'aaaa', mimeType: 'image/png' }],
    }),
    (error: unknown) => proxy(error).domainCode === 'CAPABILITY_NOT_SUPPORTED',
  );
  assert.equal(h.runtime.prompts.length, 0);
  assert.equal(h.service.getSession('gian-1').state, 'idle');
  h.runtime.dispatchError = new Error('dispatch failed');
  await assert.rejects(
    () => h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-fail', prompt: prompt('hello') }),
    (error: unknown) => proxy(error).domainCode === 'RUNTIME_ERROR',
  );
  assert.equal(countKind(h.events, 'turn.started'), 0);
  assert.equal(h.service.getSession('gian-1').activeTurnId, null);
  h.runtime.dispatchError = null;
  await h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-ok', prompt: prompt('hello') });
  assert.equal(h.runtime.prompts.length, 1);
  assert.equal(countKind(h.events, 'turn.started'), 1);
});

test('getSession returns an isolated snapshot', async () => {
  const h = harness();
  await attach(h, 'gian-1');
  const first = h.service.getSession('gian-1');
  first.state = 'closed';
  first.configOptions.pop();
  const second = h.service.getSession('gian-1');
  assert.equal(second.state, 'idle');
  assert.equal(second.configOptions.length, 3);
});

test('a prompt rejected during dispatch cannot become an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = harness();
    h.runtime.stopDuringDispatch = true;
    await attach(h, 'gian-1');
    await assert.rejects(
      () => h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-1', prompt: prompt('hello') }),
      (error: unknown) => {
        const proxyError = proxy(error);
        assert.equal(proxyError.domainCode, 'RUNTIME_UNAVAILABLE');
        assert.equal(proxyError.details?.resent, false);
        return true;
      },
    );
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.deepEqual(unhandled, []);
    assert.equal(countKind(h.events, 'turn.started'), 0);
    const failed = h.events.find((event) => event.kind === 'turn.failed');
    assert.ok(failed && failed.kind === 'turn.failed');
    assert.equal(proxy(failed.error).retryable, false);
    assert.equal(proxy(failed.error).details?.uncertain, true);
    assert.equal(h.runtime.prompts.length, 1);
    assert.equal(h.service.getSession('gian-1').state, 'stale');
    assert.equal(h.runtime.ensureStartedCount, 1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a settled native prompt failure can close without stopping a sibling', async () => {
  const h = harness();
  const failed = await attach(h, 'gian-a');
  await attach(h, 'gian-b');
  await h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-a', prompt: prompt('hello') });
  h.runtime.rejectPrompt(failed.nativeSessionId, new Error('prompt failed'));
  await Promise.resolve();
  assert.equal(h.service.getSession('gian-a').state, 'error');
  assert.equal(h.runtime.prompts.length, 1);
  await h.service.closeSession('gian-a');
  assert.equal(h.service.getSession('gian-a').state, 'closed');
  assert.equal(h.service.getSession('gian-b').state, 'idle');
  assert.equal(h.runtime.stopCount, 0);
  assertNoNativeClose(h.runtime);
});

test('whole-service close stops the runtime when one session close fails', async () => {
  const h = harness({ cancelTimeoutMs: 20 });
  const busy = await attach(h, 'gian-a');
  await attach(h, 'gian-b');
  await h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-a', prompt: prompt('still running') });
  const pending = h.runtime.requestPermission(permissionRequest(busy.nativeSessionId));
  await withTimeout(assert.rejects(
    () => h.service.close(),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_ERROR');
      assert.match(proxyError.message, /not marked cancelled|Shutdown/);
      assert.equal(proxyError.details?.resent, false);
      return true;
    },
  ), 'close all');
  assert.equal(h.runtime.stopCount, 1);
  assert.equal(h.runtime.prompts.length, 1);
  assert.equal(h.runtime.ensureStartedCount, 1);
  const decision = await pending;
  assert.deepEqual(decision.outcome, { outcome: 'cancelled' });
  const permission = h.events.find((event) => event.kind === 'permission.resolved');
  assert.ok(permission && permission.kind === 'permission.resolved');
  assert.equal(permission.outcome, 'cancelled');
  const failed = h.events.find((event) => event.kind === 'turn.failed');
  assert.ok(failed && failed.kind === 'turn.failed');
  assert.equal(proxy(failed.error).retryable, false);
  assert.equal(proxy(failed.error).details?.uncertain, true);
  assert.equal(proxy(failed.error).details?.resent, false);
  assert.equal(h.service.getSession('gian-a').state, 'stale');
  assert.equal(h.service.getSession('gian-b').state, 'closed');
  assert.equal(countKind(h.events, 'runtime.stopped'), 1);
  const stopped = h.events.find((event) => event.kind === 'runtime.stopped');
  assert.ok(stopped && stopped.kind === 'runtime.stopped');
  assert.equal(stopped.event.expected, true);
  assertNoNativeClose(h.runtime);
});

test('a failed runtime stop stays unconfirmed and blocks reattach', async () => {
  const h = harness({ maxSessions: 1 });
  const session = await attach(h, 'gian-1');
  h.runtime.stopError = new Error('stop broke');
  await assert.rejects(
    () => h.service.closeSession('gian-1'),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_ERROR');
      assert.equal(proxyError.retryable, true);
      assert.equal(proxyError.details?.uncertain, true);
      assert.equal(proxyError.details?.resent, false);
      assert.match(proxyError.message, /not confirmed/);
      return true;
    },
  );
  assert.equal(h.service.getSession('gian-1').state, 'closed');
  assert.equal(countKind(h.events, 'runtime.stopped'), 0);
  assert.equal(h.runtime.stopCount, 1);
  assert.equal(h.runtime.ensureStartedCount, 1);
  await assert.rejects(
    () => h.service.createSession({
      sessionId: 'gian-2',
      cwd: CWD,
      nativeSessionId: session.nativeSessionId,
      resumeMode: 'load',
    }),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  await assert.rejects(
    () => attach(h, 'gian-3'),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  assert.equal(h.runtime.calls.filter((call) => call === 'loadSession').length, 0);
  assert.equal(h.runtime.ensureStartedCount, 1);
  h.runtime.stopError = null;
  await h.service.closeSession('gian-1');
  assert.equal(h.runtime.stopCount, 2);
  const stopped = h.events.find((event) => event.kind === 'runtime.stopped');
  assert.ok(stopped && stopped.kind === 'runtime.stopped');
  assert.equal(stopped.event.expected, true);
  const created = await attach(h, 'gian-4');
  assert.equal(created.state, 'idle');
  assert.equal(h.runtime.ensureStartedCount, 2);
  assert.equal(h.service.getSession('gian-1').state, 'closed');
});

test('a hung runtime stop is bounded and does not report success', async () => {
  const h = harness({ cancelTimeoutMs: 20 });
  const session = await attach(h, 'gian-1');
  h.runtime.stop = () => {
    h.runtime.calls.push('stop');
    h.runtime.stopCount += 1;
    return new Promise<void>(() => undefined);
  };
  await withTimeout(assert.rejects(
    () => h.service.closeSession('gian-1'),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_ERROR');
      assert.equal(proxyError.retryable, true);
      assert.equal(proxyError.details?.uncertain, true);
      assert.match(proxyError.message, /timed out/);
      return true;
    },
  ), 'hung stop');
  assert.equal(h.runtime.stopCount, 1);
  assert.equal(countKind(h.events, 'runtime.stopped'), 0);
  assert.equal(h.service.getSession('gian-1').state, 'closed');
  await assert.rejects(
    () => h.service.createSession({
      sessionId: 'gian-2',
      cwd: CWD,
      nativeSessionId: session.nativeSessionId,
      resumeMode: 'resume',
    }),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  assert.equal(h.runtime.calls.includes('resumeSession'), false);
});

test('cancel during dispatch keeps later approvals closed', async () => {
  const h = harness({ approvalTimeoutMs: 5_000, cancelTimeoutMs: 800 });
  const session = await attach(h, 'gian-1');
  let releaseDispatch: () => void = () => undefined;
  const releaseGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  let enteredDispatch: () => void = () => undefined;
  const enteredGate = new Promise<void>((resolve) => { enteredDispatch = resolve; });
  let cancelSeen: () => void = () => undefined;
  const cancelGate = new Promise<void>((resolve) => { cancelSeen = resolve; });
  h.runtime.onCancel = () => { cancelSeen(); };
  h.runtime.onDispatch = async (params) => {
    enteredDispatch();
    await releaseGate;
    const response = await h.runtime.requestPermission(permissionRequest(params.sessionId));
    assert.deepEqual(response.outcome, { outcome: 'cancelled' });
  };
  await withTimeout((async () => {
    const started = h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-1', prompt: prompt('hello') });
    await enteredGate;
    const interrupting = h.service.interruptTurn('gian-1', 'turn-1');
    await cancelGate;
    releaseDispatch();
    const accepted = await started;
    assert.equal(accepted.turnId, 'turn-1');
    assert.equal(countKind(h.events, 'turn.started'), 1);
    assert.equal(countKind(h.events, 'permission.requested'), 0);
    const late = await h.runtime.requestPermission(permissionRequest(session.nativeSessionId));
    assert.deepEqual(late.outcome, { outcome: 'cancelled' });
    assert.equal(countKind(h.events, 'permission.requested'), 0);
    h.runtime.resolvePrompt(session.nativeSessionId, { stopReason: 'cancelled' });
    await interrupting;
  })(), 'cancel during dispatch');
  assert.equal(h.runtime.prompts.length, 1);
  const completed = h.events.find((event) => event.kind === 'turn.completed');
  assert.ok(completed && completed.kind === 'turn.completed');
  assert.equal(completed.response.stopReason, 'cancelled');
  assert.equal(countKind(h.events, 'turn.failed'), 0);
});

test('per-native buffer overflow invalidates the load instead of truncating it', async () => {
  const h = harness();
  h.runtime.onLoad = (nativeId) => {
    for (let index = 0; index < MAX_BUFFER_PER_NATIVE + 1; index += 1) {
      h.runtime.emitUpdate(nativeId, `chunk-${index}`);
    }
  };
  await assert.rejects(
    () => h.service.createSession({
      sessionId: 'gian-1',
      cwd: CWD,
      nativeSessionId: 'native-old',
      resumeMode: 'load',
    }),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_ERROR');
      assert.equal(proxyError.retryable, false);
      assert.match(proxyError.message, /invalidated/);
      assert.equal(proxyError.details?.buffered, MAX_BUFFER_PER_NATIVE + 1);
      assert.equal(proxyError.details?.limit, MAX_BUFFER_PER_NATIVE);
      assert.equal(proxyError.details?.resent, false);
      assert.equal(proxyError.details?.nativeSessionId, 'native-old');
      return true;
    },
  );
  assert.equal(countKind(h.events, 'native.update'), 0);
  assert.equal(countKind(h.events, 'turn.started'), 0);
  assert.equal(h.events.some((event) => (
    event.kind === 'session.changed' && event.session.id === 'gian-1' && event.session.state === 'idle'
  )), false);
  const failed = h.service.getSession('gian-1');
  assert.equal(failed.state, 'error');
  assert.match(failed.lastError ?? '', /invalidated/);
  assert.equal(h.runtime.prompts.length, 0);
  assert.equal(h.runtime.calls.some((call) => call.startsWith('cancel:')), false);
  await assert.rejects(
    () => h.service.createSession({
      sessionId: 'gian-2',
      cwd: CWD,
      nativeSessionId: 'native-old',
      resumeMode: 'load',
    }),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  assert.equal(h.runtime.calls.filter((call) => call === 'loadSession').length, 1);
  assert.equal(h.service.getSession('gian-1').state, 'error');
});

test('drain re-entrancy past the round cap invalidates a partial transcript', async () => {
  const h = harness();
  let emitted = 0;
  h.service.setEventSink((event) => {
    h.events.push(event);
    if (event.kind !== 'native.update' || emitted >= MAX_DRAIN_ROUNDS) return;
    emitted += 1;
    h.runtime.emitUpdate(event.notification.sessionId, `extra-${emitted}`);
  });
  h.runtime.historyText = 'seed';
  await assert.rejects(
    () => h.service.createSession({
      sessionId: 'gian-1',
      cwd: CWD,
      nativeSessionId: 'native-old',
      resumeMode: 'load',
    }),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_ERROR');
      assert.equal(proxyError.retryable, false);
      assert.match(proxyError.message, /invalidated/);
      assert.equal(proxyError.details?.resent, false);
      return true;
    },
  );
  const updates = countKind(h.events, 'native.update');
  assert.equal(updates > 0 && updates <= MAX_DRAIN_ROUNDS, true);
  const failed = h.service.getSession('gian-1');
  assert.equal(failed.state, 'error');
  assert.match(failed.lastError ?? '', /invalidated/);
  assert.equal(h.events.some((event) => (
    event.kind === 'session.changed' && event.session.id === 'gian-1' && event.session.state === 'idle'
  )), false);
  await assert.rejects(
    () => h.service.createSession({
      sessionId: 'gian-2',
      cwd: CWD,
      nativeSessionId: 'native-old',
      resumeMode: 'resume',
    }),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  assert.equal(h.runtime.calls.includes('resumeSession'), false);
});

test('the process-wide buffer cap invalidates only the session that cannot be stored', async () => {
  const h = harness();
  await h.service.listNativeSessions();
  const groups = MAX_BUFFER_TOTAL / MAX_BUFFER_PER_NATIVE;
  for (let native = 0; native < groups; native += 1) {
    for (let index = 0; index < MAX_BUFFER_PER_NATIVE; index += 1) {
      h.runtime.emitUpdate(`unbound-${native}`, `u-${native}-${index}`);
    }
  }
  h.runtime.onLoad = (nativeId) => {
    h.runtime.emitUpdate(nativeId, 'real');
  };
  await assert.rejects(
    () => h.service.createSession({
      sessionId: 'gian-1',
      cwd: CWD,
      nativeSessionId: 'native-real',
      resumeMode: 'load',
    }),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_ERROR');
      assert.match(proxyError.message, /invalidated/);
      assert.equal(proxyError.details?.buffered, MAX_BUFFER_TOTAL + 1);
      assert.equal(proxyError.details?.limit, MAX_BUFFER_TOTAL);
      assert.equal(proxyError.details?.resent, false);
      return true;
    },
  );
  assert.equal(h.events.some((event) => updateText(event) === 'real'), false);
  assert.equal(countKind(h.events, 'native.update'), 0);
  assert.equal(h.service.getSession('gian-1').state, 'error');
  assert.equal(h.runtime.prompts.length, 0);
});

test('turn updates that overflow before dispatch is accepted are not a started turn', async () => {
  const h = harness();
  const session = await attach(h, 'gian-1');
  h.runtime.onDispatch = (params) => {
    for (let index = 0; index < MAX_BUFFER_PER_NATIVE + 1; index += 1) {
      h.runtime.emitUpdate(params.sessionId, `live-${index}`);
    }
  };
  await assert.rejects(
    () => h.service.startTurn({ sessionId: 'gian-1', turnId: 'turn-1', prompt: prompt('hello') }),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_ERROR');
      assert.equal(proxyError.retryable, false);
      assert.equal(proxyError.details?.resent, false);
      assert.match(proxyError.message, /invalidated/);
      return true;
    },
  );
  assert.equal(countKind(h.events, 'turn.started'), 0);
  assert.equal(countKind(h.events, 'native.update'), 0);
  const failed = h.events.find((event) => event.kind === 'turn.failed');
  assert.ok(failed && failed.kind === 'turn.failed');
  assert.equal(proxy(failed.error).retryable, false);
  assert.equal(proxy(failed.error).details?.resent, false);
  assert.equal(h.runtime.prompts.length, 1);
  assert.equal(h.service.getSession('gian-1').state, 'error');
  h.runtime.resolvePrompt(session.nativeSessionId, { stopReason: 'end_turn' });
  await Promise.resolve();
  assert.equal(countKind(h.events, 'turn.completed'), 0);
  assert.equal(h.runtime.prompts.length, 1);
});

test('overflow of a dispatched prompt cancels only that native session', async () => {
  const h = harness();
  const busy = await attach(h, 'gian-a');
  const sibling = await attach(h, 'gian-b');
  h.runtime.onDispatch = (params) => {
    if (params.sessionId !== busy.nativeSessionId) return;
    for (let index = 0; index < MAX_BUFFER_PER_NATIVE + 1; index += 1) {
      h.runtime.emitUpdate(params.sessionId, `live-${index}`);
    }
  };
  await assert.rejects(
    () => h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-a', prompt: prompt('hello') }),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_ERROR');
      assert.equal(proxyError.retryable, false);
      assert.equal(proxyError.details?.resent, false);
      assert.match(proxyError.message, /invalidated/);
      return true;
    },
  );
  assert.deepEqual(
    h.runtime.calls.filter((call) => call.startsWith('cancel:')),
    [`cancel:${busy.nativeSessionId}`],
  );
  assert.equal(countKind(h.events, 'turn.completed'), 0);
  assert.equal(countKind(h.events, 'turn.started'), 0);
  assert.equal(h.service.getSession('gian-a').state, 'error');
  assert.equal(h.service.getSession('gian-b').state, 'idle');
  assert.equal(h.runtime.stopCount, 0);
  assert.equal(h.runtime.prompts.length, 1);
  await h.service.startTurn({ sessionId: 'gian-b', turnId: 'turn-b', prompt: prompt('sibling') });
  assert.equal(h.runtime.prompts.length, 2);
  assert.equal(h.runtime.prompts[1]?.sessionId, sibling.nativeSessionId);
  assert.deepEqual(
    h.runtime.calls.filter((call) => call.startsWith('cancel:')),
    [`cancel:${busy.nativeSessionId}`],
  );
  await assert.rejects(
    () => h.service.createSession({
      sessionId: 'gian-c',
      cwd: CWD,
      nativeSessionId: busy.nativeSessionId,
      resumeMode: 'resume',
    }),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  assert.equal(h.runtime.calls.includes('resumeSession'), false);
  await h.service.closeSession('gian-a');
  assert.equal(h.service.getSession('gian-a').state, 'closed');
  assert.equal(h.service.getSession('gian-b').state, 'running');
  assert.equal(h.runtime.stopCount, 0);
  h.runtime.resolvePrompt(sibling.nativeSessionId, { stopReason: 'end_turn' });
  await Promise.resolve();
  await h.service.closeSession('gian-b');
  assert.equal(h.service.getSession('gian-b').state, 'closed');
  assert.equal(h.runtime.stopCount, 1);
  assert.equal(h.service.getSession('gian-a').state, 'closed');
  assertNoNativeClose(h.runtime);
});

test('a hung cancel of a lost prompt does not invent a terminal or stop the sibling', async () => {
  const h = harness({ cancelTimeoutMs: 0 });
  const busy = await attach(h, 'gian-a');
  await attach(h, 'gian-b');
  h.runtime.onCancel = () => new Promise<void>(() => undefined);
  h.runtime.onDispatch = (params) => {
    if (params.sessionId !== busy.nativeSessionId) return;
    for (let index = 0; index < MAX_BUFFER_PER_NATIVE + 1; index += 1) {
      h.runtime.emitUpdate(params.sessionId, `live-${index}`);
    }
  };
  await assert.rejects(
    () => h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-a', prompt: prompt('hello') }),
    (error: unknown) => proxy(error).domainCode === 'RUNTIME_ERROR',
  );
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const failed = h.service.getSession('gian-a');
  assert.equal(failed.state, 'error');
  assert.match(failed.lastError ?? '', /not confirmed stopped/);
  assert.match(failed.lastError ?? '', /not marked cancelled/);
  assert.match(failed.lastError ?? '', /not resent/);
  assert.equal(countKind(h.events, 'turn.completed'), 0);
  assert.equal(h.service.getSession('gian-b').state, 'idle');
  assert.equal(h.runtime.stopCount, 0);
  assert.deepEqual(
    h.runtime.calls.filter((call) => call.startsWith('cancel:')),
    [`cancel:${busy.nativeSessionId}`],
  );
  await assert.rejects(
    () => h.service.createSession({
      sessionId: 'gian-c',
      cwd: CWD,
      nativeSessionId: busy.nativeSessionId,
      resumeMode: 'load',
    }),
    (error: unknown) => proxy(error).domainCode === 'CONFLICT',
  );
  assertNoNativeClose(h.runtime);
});

test('service close rejects new admission and closeSession does not', async () => {
  const open = harness();
  await attach(open, 'gian-a');
  await open.service.closeSession('gian-a');
  assert.equal(open.runtime.stopCount, 1);
  const again = await attach(open, 'gian-b');
  assert.equal(again.state, 'idle');
  assert.equal(open.runtime.ensureStartedCount, 2);

  const h = harness({ cancelTimeoutMs: 30 });
  await attach(h, 'gian-a');
  await h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-a', prompt: prompt('still running') });
  let releaseStop: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { releaseStop = resolve; });
  h.runtime.stop = async () => {
    h.runtime.calls.push('stop');
    h.runtime.stopCount += 1;
    await gate;
    h.runtime.emitStopped({ code: null, signal: null, expected: true });
  };
  const started = h.runtime.ensureStartedCount;
  const closing = h.service.close();
  await assert.rejects(
    () => attach(h, 'gian-b'),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'RUNTIME_UNAVAILABLE');
      assert.equal(proxyError.retryable, false);
      assert.match(proxyError.message, /closing/);
      assert.equal(proxyError.details?.resent, false);
      return true;
    },
  );
  await assert.rejects(
    () => h.service.startTurn({ sessionId: 'gian-a', turnId: 'turn-b', prompt: prompt('again') }),
    (error: unknown) => proxy(error).domainCode === 'RUNTIME_UNAVAILABLE',
  );
  await assert.rejects(
    () => h.service.listNativeSessions(),
    (error: unknown) => proxy(error).domainCode === 'RUNTIME_UNAVAILABLE',
  );
  assert.equal(h.runtime.ensureStartedCount, started);
  assert.equal(h.runtime.prompts.length, 1);
  assert.equal(h.runtime.calls.filter((call) => call === 'newSession').length, 1);
  releaseStop();
  await withTimeout(assert.rejects(
    () => closing,
    (error: unknown) => proxy(error).domainCode === 'RUNTIME_ERROR',
  ), 'close');
  assert.equal(h.runtime.stopCount, 1);
  await assert.rejects(
    () => attach(h, 'gian-c'),
    (error: unknown) => proxy(error).domainCode === 'RUNTIME_UNAVAILABLE',
  );
  assert.equal(h.runtime.ensureStartedCount, started);
  assertNoNativeClose(h.runtime);
});

test('session create rejects an explicit non-Gemini model before setConfigOption', async () => {
  const h = harness();
  h.runtime.options = [
    selectOption('mode', 'mode', 'plan', ['plan', 'ask']),
    selectOption('model', 'model', 'gemini-2.5-pro', ['gemini-2.5-pro', 'gemini-2.5-flash', 'claude-sonnet']),
  ];
  await assert.rejects(
    () => attach(h, 'gian-bad', { config: { mode: 'ask', model: 'claude-sonnet' } }),
    (error: unknown) => {
      const proxyError = proxy(error);
      assert.equal(proxyError.domainCode, 'CONFIG_VALUE_INVALID');
      assert.equal(proxyError.retryable, false);
      assert.match(proxyError.message, /claude-sonnet/);
      assert.match(proxyError.message, /not an available Gemini model/);
      assert.equal(proxyError.details?.configId, 'model');
      return true;
    },
  );
  assert.equal(h.runtime.configWrites.length, 0);
  assert.equal(h.runtime.calls.includes('setConfigOption'), false);
  assert.equal(h.events.some((event) => (
    event.kind === 'session.changed' && event.session.id === 'gian-bad' && event.session.state === 'idle'
  )), false);
  assert.throws(
    () => h.service.getSession('gian-bad'),
    (error: unknown) => proxy(error).domainCode === 'SESSION_NOT_FOUND',
  );
  const selected = await attach(h, 'gian-ok', { config: { model: 'gemini-2.5-flash' } });
  assert.equal(h.runtime.configWrites.length, 1);
  assert.equal(h.runtime.configWrites[0]?.configId, 'model');
  assert.equal(h.runtime.configWrites[0]?.value, 'gemini-2.5-flash');
  assert.equal(selected.state, 'idle');
});

test('model is written first and dependent settings use the refreshed choices', async () => {
  const h = harness();
  h.runtime.options = [
    selectOption('mode', 'mode', 'plan', ['plan', 'ask']),
    selectOption('model', 'model', 'gemini-2.5-pro', ['gemini-2.5-pro', 'gemini-2.5-flash']),
  ];
  const write = h.runtime.setConfigOption.bind(h.runtime);
  h.runtime.setConfigOption = async params => {
    await write(params);
    if (params.configId === 'model') {
      h.runtime.options = h.runtime.options.map(option => option.id === 'mode'
        ? selectOption('mode', 'mode', 'plan', ['plan']) : option);
    }
    return { configOptions: structuredClone(h.runtime.options) };
  };
  await assert.rejects(
    () => attach(h, 'gian-dependent', { config: { mode: 'ask', model: 'gemini-2.5-flash' } }),
    (error: unknown) => proxy(error).domainCode === 'CONFIG_VALUE_INVALID',
  );
  assert.deepEqual(h.runtime.configWrites.map(item => item.configId), ['model']);
  assert.equal(h.runtime.prompts.length, 0);
});

test('late lost-prompt cancel rejection cannot modify a reused native id in a new generation', async () => {
  const h = harness({ cancelTimeoutMs: 1_000 });
  const original = await attach(h, 'gian-old');
  let rejectCancel!: (error: Error) => void;
  const cancel = new Promise<void>((_resolve, reject) => { rejectCancel = reject; });
  h.runtime.onCancel = () => cancel;
  h.runtime.onDispatch = params => {
    for (let index = 0; index <= MAX_BUFFER_PER_NATIVE; index += 1) {
      h.runtime.emitUpdate(params.sessionId, `overflow-${index}`);
    }
  };
  await assert.rejects(() => h.service.startTurn({ sessionId: 'gian-old', turnId: 'old', prompt: prompt('old') }));
  await h.service.closeSession('gian-old');
  h.runtime.onDispatch = null;
  const fresh = await attach(h, 'gian-new', { nativeSessionId: original.nativeSessionId, resumeMode: 'resume' });
  const eventCount = h.events.length;
  rejectCancel(new Error('late old cancel failure'));
  await new Promise<void>(resolve => { setImmediate(resolve); });
  assert.equal(h.events.length, eventCount);
  assert.deepEqual(h.service.getSession('gian-new'), fresh);
  assert.equal(fresh.state, 'idle');
  assert.equal(fresh.lastError, null);
});
