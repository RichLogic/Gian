import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { InitializeResponse, ListSessionsRequest, ListSessionsResponse, SessionConfigOption } from '@agentclientprotocol/sdk';
import { HostProtocolValidator, proxyNotificationSchema, resultSchemas } from '@gian/proxy-protocol';

import type { AntigravityService, CreateServiceSession, ServiceEvent, ServiceSession, StartServiceTurn } from '../src/contracts.js';
import {
  ANTIGRAVITY_COLD_CATALOG_TTL_MS,
  AntigravityProtocolV2Adapter,
  type AntigravityProtocolV2AdapterOptions,
} from '../src/protocol/v2-adapter.js';
import { parseRequestLine, ProtocolError, RpcError, type WireRequest } from '../src/transport/protocol.js';
import { configOptions, modelChoices } from './fixtures/config-options.js';

const options: SessionConfigOption[] = [{
  id: 'model', name: 'Model', category: 'model', type: 'select',
  currentValue: 'gemini-3.8-flash',
  options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
}];

class FakeService implements AntigravityService {
  sink: (event: ServiceEvent) => void = () => {};
  readonly sessions = new Map<string, ServiceSession>();
  starts = 0;
  creates = 0;
  closes = 0;
  approvals = 0;
  failStart = false;
  earlyPermission = false;
  lastConfig: StartServiceTurn['config'] = undefined;
  lastCreateConfig: CreateServiceSession['config'] = undefined;
  lastCreate: CreateServiceSession | undefined;
  /** Fresh read. `assert.equal(lastConfig, undefined)` stays narrowed across later writes. */
  turnConfig(): StartServiceTurn['config'] {
    return this.lastConfig;
  }
  optionsFor: ((sessionId: string) => SessionConfigOption[]) | null = null;
  listRequests: ListSessionsRequest[] = [];
  pendingStart: (() => Promise<void>) | null = null;
  setEventSink(sink: (event: ServiceEvent) => void) { this.sink = sink; }
  async initialize(): Promise<InitializeResponse> {
    return { protocolVersion: 1, authMethods: [], agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { list: {} } } };
  }
  async createSession(input: CreateServiceSession): Promise<ServiceSession> {
    this.creates += 1;
    this.lastCreate = structuredClone(input);
    this.lastCreateConfig = input.config;
    const configOptions = structuredClone(this.optionsFor ? this.optionsFor(input.sessionId) : options);
    const session: ServiceSession = {
      id: input.sessionId, nativeSessionId: `native-${input.sessionId}`, cwd: input.cwd,
      state: 'idle', activeTurnId: null, configOptions, lastError: null,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    this.sessions.set(session.id, session);
    this.sink({ kind: 'session.changed', session });
    return session;
  }
  getSession(id: string): ServiceSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error('not found');
    return session;
  }
  async startTurn(input: StartServiceTurn): Promise<{ turnId: string }> {
    this.starts += 1;
    this.lastConfig = input.config;
    if (this.failStart) throw new Error('dispatch failed');
    const session = this.getSession(input.sessionId);
    session.state = 'running';
    session.activeTurnId = input.turnId;
    if (this.earlyPermission) this.sink({
      kind: 'permission.requested', sessionId: session.id, turnId: input.turnId, interactionId: 'early',
      request: {
        sessionId: session.nativeSessionId, toolCall: { toolCallId: 'early-tool', title: 'Confirm tool' },
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
      },
    });
    this.sink({ kind: 'turn.started', sessionId: session.id, turnId: input.turnId });
    if (session.id === 'a' && this.pendingStart) await this.pendingStart();
    return { turnId: input.turnId };
  }
  async interruptTurn(): Promise<void> {}
  respondPermission(params: { sessionId: string; interactionId: string; optionId?: string }): void {
    this.approvals += 1;
    this.sink({
      kind: 'permission.resolved', sessionId: params.sessionId, turnId: 't1',
      interactionId: params.interactionId, outcome: 'submitted',
      ...(params.optionId ? { optionId: params.optionId } : {}),
    });
  }
  async closeSession(id: string): Promise<void> {
    const session = this.getSession(id);
    session.state = 'closed';
    this.sink({ kind: 'session.changed', session });
  }
  async listNativeSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    this.listRequests.push(params);
    return params.cursor ? { sessions: [{ sessionId: 'n3', cwd: '/tmp' }] }
      : { sessions: [{ sessionId: 'n1', cwd: '/tmp' }, { sessionId: 'n2', cwd: '/tmp' }], nextCursor: 'upstream-page-2' };
  }
  async close(): Promise<void> {
    this.closes += 1;
  }
}

function request(method: string, params: Record<string, unknown>): WireRequest {
  return { jsonrpc: '2.0', id: `${method}-${Math.random()}`, method, params };
}

function sealedCli(): AntigravityProtocolV2AdapterOptions {
  return {
    cliModels: {
      candidates: [],
      osUserHome: '/Users/protocol-sealed',
      env: { HOME: '/Users/protocol-sealed', PATH: '/usr/bin:/bin' },
    },
  };
}

async function fixture(cli?: AntigravityProtocolV2AdapterOptions) {
  const service = new FakeService();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new AntigravityProtocolV2Adapter(service, '0.0.1', (method, params) => {
    proxyNotificationSchema.parse({ jsonrpc: '2.0', method, params });
    events.push({ method, params });
  }, cli ?? sealedCli());
  const init = await adapter.handle(request('initialize', { protocol: { name: 'gian.proxy', versions: ['2.3'] } }));
  resultSchemas.initialize.parse(init);
  const create = async (id: string) => {
    const result = await adapter.handle(request('session.create', {
      sessionId: id, workspace: { cwd: '/tmp', roots: ['/tmp'] }, config: {},
    }));
    return resultSchemas['session.create'].parse(result).session;
  };
  return { service, events, adapter, create };
}

test('strict request parsing rejects missing fields and malformed JSON', () => {
  assert.throws(() => parseRequestLine('{'), /valid JSON/);
  assert.throws(() => parseRequestLine('{"id":1,"method":"shutdown"}'), /jsonrpc/);
  assert.throws(() => parseRequestLine('{"jsonrpc":"2.0","id":"x","method":"turn.start","params":{}}'), /contract/);
});

test('Host conformance accepts modern catalogs, session events and structured failures', async (t) => {
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  ]));
  t.after(() => cli.dispose());
  const service = new FakeService();
  const host = new HostProtocolValidator({ pluginId: 'io.gian.antigravity', processScope: 'shared' });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new AntigravityProtocolV2Adapter(service, '0.0.1', (method, params) => {
    host.acceptLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
    notifications.push({ method, params });
  }, cli.options);
  const send = async (method: string, params: Record<string, unknown>) => {
    const input = request(method, params);
    host.registerRequest(input);
    let output: unknown;
    await adapter.dispatch(input, (result, error) => {
      assert.equal(error, undefined);
      host.acceptLine(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
      output = result;
    });
    return output;
  };
  await send('initialize', { protocol: { name: 'gian.proxy', versions: ['2.3'] }, host: { name: 'Gian', version: '0.6.7' } });
  const cold = resultSchemas['catalog.list'].parse(await send('catalog.list', {}));
  assert.equal(service.creates, 0);
  assert.equal(service.starts, 0);
  assert.equal(await cli.count(), 1);
  assert.equal(cold.specialCatalogs?.model, 'model');
  assert.equal(cold.specialCatalogs?.thinking, 'thinking');
  assert.equal(cold.specialCatalogs?.approvalMode, 'mode');
  assert.deepEqual(cold.configOptions.map((option) => option.id), ['model', 'thinking', 'mode']);
  assert.equal(cold.configOptions[0]?.defaultValue, null);
  const created = resultSchemas['session.create'].parse(await send('session.create', {
    sessionId: 'a', workspace: { cwd: '/tmp', roots: ['/tmp'] }, config: {},
  })).session;
  assert.ok(created.turnConfigOptions?.every(option => !('role' in option)));
  const catalog = resultSchemas['catalog.list'].parse(await send('catalog.list', {}));
  assert.equal(catalog.catalogRevision, cold.catalogRevision);
  assert.equal(catalog.specialCatalogs?.model, 'model');
  assert.equal(catalog.specialCatalogs?.approvalMode, 'mode');
  assert.equal(await cli.count(), 1);
  assert.ok(catalog.configOptions.every(option => !('role' in option)));
  await send('turn.start', {
    sessionId: 'a', streamId: created.streamId, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {},
  });
  assert.equal(Object.hasOwn(service.lastConfig ?? {}, 'model'), false);
  const failure = Object.assign(new Error('Native prompt failed'), {
    domainCode: 'RUNTIME_ERROR', retryable: false, details: { uncertain: true, authorization: 'secret' },
  });
  service.sink({ kind: 'turn.failed', sessionId: 'a', turnId: 't1', error: failure });
  const failed = notifications.at(-1);
  assert.equal(failed?.method, 'turn.failed');
  assert.match(JSON.stringify(failed), /"uncertain":true/);
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
  service.sink({ kind: 'runtime.stopped', event: { code: 1, signal: null, expected: false } });
  assert.equal(notifications.at(-1)?.method, 'runtime.error');
});

test('native listing preserves oversized ACP pages and binds cursors to the workspace', async () => {
  const f = await fixture();
  const list = async (cursor?: string) => resultSchemas['session.native.list'].parse(
    await f.adapter.handle(request('session.native.list', { cwd: '/tmp', limit: 1, ...(cursor ? { cursor } : {}) })),
  );
  const first = await list();
  assert.equal(first.sessions[0]?.id, 'n1');
  assert.ok(first.nextCursor);
  await assert.rejects(f.adapter.handle(request('session.native.list', { cwd: '/other', cursor: first.nextCursor })), /different workspace/);
  const second = await list(first.nextCursor);
  assert.equal(second.sessions[0]?.id, 'n2');
  assert.equal(f.service.listRequests.length, 1);
  assert.ok(second.nextCursor);
  const third = await list(second.nextCursor);
  assert.equal(third.sessions[0]?.id, 'n3');
  assert.equal(third.nextCursor, null);
  assert.equal(f.service.listRequests[1]?.cursor, 'upstream-page-2');
});

test('turn response precedes notifications generated during dispatch', async () => {
  const f = await fixture();
  const session = await f.create('a');
  f.events.length = 0;
  await f.adapter.dispatch(request('turn.start', {
    sessionId: 'a', streamId: session.streamId, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {},
  }), (_result, error) => { assert.equal(error, undefined); f.events.push({ method: 'response', params: {} }); });
  assert.deepEqual(f.events.map(event => event.method), ['response', 'turn.started']);
});

test('duplicate turn is not dispatched twice and changed input conflicts', async () => {
  const f = await fixture();
  const session = await f.create('a');
  const params = { sessionId: 'a', streamId: session.streamId, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {} };
  await f.adapter.handle(request('turn.start', params));
  await f.adapter.handle(request('turn.start', params));
  assert.equal(f.service.starts, 1);
  await assert.rejects(f.adapter.handle(request('turn.start', { ...params, input: [{ type: 'text', text: 'changed' }] })), /reused/);
});

test('an early ACP permission request is published after the accepted turn starts', async () => {
  const f = await fixture();
  const session = await f.create('a');
  f.service.earlyPermission = true;
  f.events.length = 0;
  await f.adapter.dispatch(request('turn.start', {
    sessionId: 'a', streamId: session.streamId, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {},
  }), (_result, error) => {
    assert.equal(error, undefined);
    f.events.push({ method: 'response', params: {} });
  });
  assert.deepEqual(f.events.map(event => event.method), ['response', 'turn.started', 'interaction.requested']);
});

test('failed dispatch remains failed on duplicate rather than fabricating acceptance', async () => {
  const f = await fixture();
  const session = await f.create('a');
  f.service.failStart = true;
  const params = { sessionId: 'a', streamId: session.streamId, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {} };
  await assert.rejects(f.adapter.handle(request('turn.start', params)), /dispatch failed/);
  await assert.rejects(f.adapter.handle(request('turn.start', params)), /dispatch failed/);
  assert.equal(f.service.starts, 1);
});

test('another session is not blocked by a pending response barrier', async () => {
  const f = await fixture();
  const a = await f.create('a');
  const b = await f.create('b');
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.service.pendingStart = () => waiting;
  f.events.length = 0;
  const first = f.adapter.dispatch(request('turn.start', {
    sessionId: 'a', streamId: a.streamId, turnId: 'a1', input: [{ type: 'text', text: 'A' }], config: {},
  }), (_result, error) => assert.equal(error, undefined));
  await Promise.resolve();
  await Promise.resolve();
  await f.adapter.dispatch(request('turn.start', {
    sessionId: 'b', streamId: b.streamId, turnId: 'b1', input: [{ type: 'text', text: 'B' }], config: {},
  }), (_result, error) => assert.equal(error, undefined));
  assert.equal(f.events.some(event => event.params.sessionId === 'b'), true);
  assert.equal(f.events.some(event => event.params.sessionId === 'a'), false);
  release();
  await first;
  assert.equal(f.events.some(event => event.params.sessionId === 'a'), true);
});

test('permission responses cannot cross sessions or select an unadvertised option', async () => {
  const f = await fixture();
  const a = await f.create('a');
  const b = await f.create('b');
  f.service.sink({
    kind: 'permission.requested', sessionId: 'a', turnId: 't1', interactionId: 'i1',
    request: {
      sessionId: 'native-a', toolCall: { toolCallId: 'tool1', title: 'Run command' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    },
  });
  const params = { sessionId: 'a', streamId: a.streamId, turnId: 't1', interactionId: 'i1', responseId: 'r1', actionId: 'allow-once', values: {} };
  await assert.rejects(f.adapter.handle(request('interaction.respond', { ...params, sessionId: 'b', streamId: b.streamId })), /not active/);
  await assert.rejects(f.adapter.handle(request('interaction.respond', { ...params, actionId: 'invented' })), /advertised/);
  await f.adapter.handle(request('interaction.respond', params));
  await f.adapter.handle(request('interaction.respond', params));
  assert.equal(f.service.approvals, 1);
});

test('permission requests publish opaque option ids with their native ACP kinds', async () => {
  const f = await fixture();
  await f.create('a');
  f.service.sink({
    kind: 'permission.requested', sessionId: 'a', turnId: 't1', interactionId: 'i-reject',
    request: {
      sessionId: 'native-a',
      toolCall: { toolCallId: 'tool-reject', title: 'Run command' },
      options: [
        { optionId: 'agy-opt-allow-17', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'agy-opt-reject-9c', name: 'Reject', kind: 'reject_once' },
        { optionId: 'agy-opt-reject-always-3', name: 'Reject always', kind: 'reject_always' },
      ],
    },
  });
  const requested = f.events.find((event) => event.method === 'interaction.requested');
  assert.ok(requested);
  const data = requested.params.data as {
    actions: Array<{ id: string; label: string; style: string }>;
    context: {
      toolCall: { toolCallId: string };
      permissionOptionKinds: Record<string, string>;
    };
  };
  assert.deepEqual(data.actions, [
    { id: 'agy-opt-allow-17', label: 'Allow once', style: 'primary' },
    { id: 'agy-opt-reject-9c', label: 'Reject', style: 'danger' },
    { id: 'agy-opt-reject-always-3', label: 'Reject always', style: 'danger' },
  ]);
  assert.equal(data.context.toolCall.toolCallId, 'tool-reject');
  assert.deepEqual(data.context.permissionOptionKinds, {
    'agy-opt-allow-17': 'allow_once',
    'agy-opt-reject-9c': 'reject_once',
    'agy-opt-reject-always-3': 'reject_always',
  });

  f.service.sink({
    kind: 'permission.requested', sessionId: 'a', turnId: 't1', interactionId: 'i-custom',
    request: {
      sessionId: 'native-a',
      toolCall: { toolCallId: 'tool-custom', title: 'Custom' },
      options: [{ optionId: 'agy-opt-custom', name: 'Custom', kind: 'allow_everything_forever' }],
    },
  } as unknown as ServiceEvent);
  const custom = f.events.filter((event) => event.method === 'interaction.requested').at(-1);
  assert.ok(custom);
  const customData = custom.params.data as {
    actions: Array<{ id: string; label: string; style: string }>;
    context: { permissionOptionKinds: Record<string, string> };
  };
  assert.deepEqual(customData.actions, [
    { id: 'agy-opt-custom', label: 'Custom', style: 'primary' },
  ]);
  assert.deepEqual(customData.context.permissionOptionKinds, {
    'agy-opt-custom': 'allow_everything_forever',
  });

  f.service.sink({
    kind: 'permission.resolved', sessionId: 'a', turnId: 't1',
    interactionId: 'i-reject', outcome: 'submitted', optionId: 'agy-opt-reject-9c',
  });
  const resolved = f.events.filter((event) => event.method === 'interaction.resolved').at(-1);
  assert.ok(resolved);
  assert.deepEqual(resolved.params.data, {
    interactionId: 'i-reject', outcome: 'submitted', actionId: 'agy-opt-reject-9c',
  });
  assert.equal(f.service.starts, 0);
});

test('Host cwd plus attachment roots are context only and preserve create idempotency', async () => {
  const f = await fixture();
  // ProxySessionCoordinator + ProtocolV2SessionClient's actual wire shape.
  const params = {
    sessionId: 'a', workspace: { cwd: '/workspace/project', roots: ['/workspace/project', '/session/attachments'] }, config: {},
  };
  const create = parseRequestLine(JSON.stringify(request('session.create', params)));
  const first = resultSchemas['session.create'].parse(await f.adapter.handle(create)).session;
  assert.deepEqual(f.service.lastCreate, { sessionId: 'a', cwd: params.workspace.cwd, config: {}, mcpServers: [] });
  assert.deepEqual(resultSchemas['session.create'].parse(await f.adapter.handle(create)).session, first);
  assert.equal(f.service.creates, 1);
  await assert.rejects(f.adapter.handle(request('session.create', {
    ...params, workspace: { ...params.workspace, roots: [...params.workspace.roots, '/other/context'] },
  })), /different creation parameters/);
  assert.equal(f.service.creates, 1);
});

test('malformed, relative or NUL workspace paths fail before service create', async () => {
  const f = await fixture();
  const valid = { cwd: '/workspace/project', roots: ['/workspace/project', '/session/attachments'] };
  const invalid = [
    null, [], {}, { ...valid, cwd: '' }, { ...valid, cwd: 1 },
    { ...valid, cwd: 'relative/project' }, { ...valid, cwd: '/workspace/\0project' },
    { cwd: valid.cwd }, { ...valid, roots: null }, { ...valid, roots: '/session/attachments' },
    { ...valid, roots: [] }, { ...valid, roots: [''] }, { ...valid, roots: [null] },
    { ...valid, roots: [1] }, { ...valid, roots: [{}] },
    { ...valid, roots: [valid.cwd, 'relative/attachments'] },
    { ...valid, roots: [valid.cwd, '/session/\0attachments'] },
  ];
  for (const workspace of invalid) {
    const wire = JSON.stringify(request('session.create', { sessionId: 'bad', workspace, config: {} }));
    await assert.rejects(async () => f.adapter.handle(parseRequestLine(wire)), (error: unknown) => (
      error instanceof RpcError && error.code === -32602
    ));
    assert.equal(f.service.creates, 0);
  }
});

test('unsupported history replay is still rejected with valid context roots', async () => {
  const f = await fixture();
  const create = { sessionId: 'a', workspace: { cwd: '/tmp', roots: ['/tmp', '/session/attachments'] }, config: {} };
  await assert.rejects(f.adapter.handle(request('session.create', { ...create, nativeSession: { id: 'foreign', history: 'replay' } })), /history import/);
  assert.equal(f.service.creates, 0);
});

test('context roots do not bypass the native HTTP MCP capability guard', async () => {
  const service = new FakeService();
  service.initialize = async () => ({ protocolVersion: 1 });
  const adapter = new AntigravityProtocolV2Adapter(service, '0.0.1', () => {}, sealedCli());
  await adapter.handle(request('initialize', { protocol: { name: 'gian.proxy', versions: ['2.3'] } }));
  await assert.rejects(adapter.handle(request('session.create', {
    sessionId: 'a', workspace: { cwd: '/tmp', roots: ['/tmp', '/session/attachments'] }, config: {},
    hostServices: [{ id: 'gian', protocol: 'mcp', transport: { type: 'streamable-http', url: 'http://127.0.0.1:12345/mcp', headers: {} } }],
  })), /did not advertise HTTP MCP/);
  assert.equal(service.creates, 0);
});

test('stale reattach requires the exact native identity and rotates the stream', async () => {
  const f = await fixture();
  const create = { sessionId: 'a', workspace: { cwd: '/tmp', roots: ['/tmp', '/session/attachments'] }, config: {} };
  const first = resultSchemas['session.create'].parse(await f.adapter.handle(request('session.create', create))).session;
  const original = f.service.getSession('a');
  original.state = 'stale';
  f.service.sink({ kind: 'session.changed', session: original });
  await assert.rejects(f.adapter.handle(request('session.create', create)), /exact native session id/);
  const second = resultSchemas['session.create'].parse(await f.adapter.handle(request('session.create', {
    ...create, nativeSession: { id: 'native-a' },
  }))).session;
  assert.deepEqual(f.service.lastCreate, {
    sessionId: 'a', cwd: '/tmp', config: {}, mcpServers: [], nativeSessionId: 'native-a', resumeMode: 'resume',
  });
  assert.notEqual(second.streamId, first.streamId);
  await assert.rejects(f.adapter.handle(request('turn.start', {
    sessionId: 'a', streamId: first.streamId, turnId: 'old-stream-turn', input: [{ type: 'text', text: 'hello' }], config: {},
  })), /stream has changed/);
  assert.equal(f.service.starts, 0);
});

test('an invalid service event retires the adapter instead of silently losing a notification', async () => {
  const f = await fixture();
  await f.create('a');
  const session = f.service.getSession('a');
  f.service.sink({ kind: 'session.changed', session: { ...session, nativeSessionId: '' } });
  assert.equal(f.events.at(-1)?.method, 'runtime.error');
  await assert.rejects(f.adapter.handle(request('catalog.list', {})), /invalid or oversized event/);
});

test('an unadvertised or non-Gemini native default cannot run behind an empty config', async () => {
  const f = await fixture();
  const session = await f.create('a');
  f.service.getSession('a').configOptions = [{
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'another-model',
    options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'another-model', name: 'Another model' }],
  }];
  const params = { sessionId: 'a', streamId: session.streamId, turnId: 't1', input: [{ type: 'text', text: 'hello' }], config: {} };
  await assert.rejects(f.adapter.handle(request('turn.start', params)), /advertised Gemini model/);
  assert.equal(f.service.starts, 0);
  assert.equal(f.service.lastConfig, undefined);
  await f.adapter.handle(request('turn.start', { ...params, config: { model: 'gemini-3.8-flash' } }));
  assert.equal(f.service.starts, 1);
  assert.equal(f.service.turnConfig()?.model, 'gemini-3.8-flash');
});

test('cold catalog selects Gemini before any native session and omits an unselected model', async (t) => {
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  ]));
  t.after(() => cli.dispose());
  const f = await fixture(cli.options);
  const listed = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.equal(f.service.creates, 0);
  assert.equal(f.service.starts, 0);
  assert.equal(await cli.count(), 1);
  assert.deepEqual(listed.configOptions.map((option) => option.id), ['model', 'thinking', 'mode']);
  assert.equal(listed.specialCatalogs?.model, 'model');
  assert.equal(listed.specialCatalogs?.thinking, 'thinking');
  assert.equal(listed.specialCatalogs?.approvalMode, 'mode');
  assert.equal(listed.configOptions[0]?.defaultValue, null);
  assert.deepEqual(listed.configOptions[0]?.choices?.map((choice) => choice.value), [
    'gemini-3.8-flash',
  ]);
  const resolved = resultSchemas['catalog.resolve'].parse(await f.adapter.handle(request('catalog.resolve', {
    catalogRevision: listed.catalogRevision,
    sessionConfig: {},
    turnConfig: { model: null },
  })));
  assert.deepEqual(resolved.resolvedDefaults, { sessionConfig: {}, turnConfig: { mode: 'default' } });
  assert.equal(JSON.stringify(resolved.resolvedDefaults).includes('null'), false);
  assert.equal(f.service.creates, 0);
  assert.equal(f.service.starts, 0);
  const session = await f.create('cold');
  await f.adapter.handle(request('turn.start', {
    sessionId: 'cold',
    streamId: session.streamId,
    turnId: 'unselected',
    input: [{ type: 'text', text: 'hello' }],
    config: { model: null },
  }));
  assert.equal(f.service.starts, 1);
  assert.equal(Object.hasOwn(f.service.lastConfig ?? {}, 'model'), false);
  const nativeSession = f.service.getSession('cold');
  nativeSession.state = 'idle';
  nativeSession.activeTurnId = null;
  f.service.sink({ kind: 'turn.completed', sessionId: 'cold', turnId: 'unselected', response: { stopReason: 'end_turn' } });
  assert.equal(f.events.at(-1)?.method, 'turn.completed');
  assert.equal(f.events.at(-1)?.params.turnId, 'unselected');
  await f.adapter.handle(request('turn.start', {
    sessionId: 'cold',
    streamId: session.streamId,
    turnId: 'explicit',
    input: [{ type: 'text', text: 'hello' }],
    config: { model: 'gemini-3.8-flash' },
  }));
  assert.equal(f.service.starts, 2);
  assert.equal(f.service.lastConfig?.model, 'gemini-3.8-flash');
});

test('a CLI model the native session does not advertise is rejected with no prompt', async (t) => {
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  ]));
  t.after(() => cli.dispose());
  const f = await fixture(cli.options);
  await f.adapter.handle(request('catalog.list', {}));
  const session = await f.create('a');
  const params = {
    sessionId: 'a',
    streamId: session.streamId,
    turnId: 'missing',
    input: [{ type: 'text', text: 'hello' }],
    config: { model: 'gemini-3.8-flash-high' },
  };
  await assert.rejects(f.adapter.handle(request('turn.start', params)), /not an available Gemini model/);
  assert.equal(f.service.starts, 0);
  assert.equal(f.service.lastConfig, undefined);
  await f.adapter.handle(request('turn.start', {
    ...params,
    turnId: 'native',
    config: { model: 'gemini-3.8-flash' },
  }));
  assert.equal(f.service.starts, 1);
  assert.equal(f.service.turnConfig()?.model, 'gemini-3.8-flash');
});

test('session catalogs stay on their own native options', async (t) => {
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  ]));
  t.after(() => cli.dispose());
  const f = await fixture(cli.options);
  f.service.optionsFor = (sessionId) => [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: sessionId === 'a' ? 'gemini-session-a' : 'gemini-session-b',
    options: [{
      value: sessionId === 'a' ? 'gemini-session-a' : 'gemini-session-b',
      name: sessionId === 'a' ? 'Session A' : 'Session B',
    }],
  }];
  const cold = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  const a = await f.create('a');
  const b = await f.create('b');
  const resolveA = resultSchemas['catalog.resolve'].parse(await f.adapter.handle(request('catalog.resolve', {
    catalogRevision: a.turnConfigRevision,
    sessionId: 'a',
    streamId: a.streamId,
    sessionConfig: {},
    turnConfig: {},
  })));
  const resolveB = resultSchemas['catalog.resolve'].parse(await f.adapter.handle(request('catalog.resolve', {
    catalogRevision: b.turnConfigRevision,
    sessionId: 'b',
    streamId: b.streamId,
    sessionConfig: {},
    turnConfig: {},
  })));
  assert.deepEqual(resolveA.configOptions[0]?.choices?.map((choice) => choice.value), ['gemini-session-a']);
  assert.deepEqual(resolveB.configOptions[0]?.choices?.map((choice) => choice.value), ['gemini-session-b']);
  const again = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.equal(again.catalogRevision, cold.catalogRevision);
  assert.deepEqual(again.configOptions[0]?.choices?.map((choice) => choice.value), ['gemini-3.8-flash']);
  assert.equal(f.service.starts, 0);
});

test('cold resolution owns the triplet, exact pair validation, legacy ids and revision fence', async (t) => {
  const cli = await cliDouble(modelsDocument(modelChoices.map(choice => ({ id: choice.value, label: choice.name }))));
  t.after(() => cli.dispose());
  const f = await fixture(cli.options);
  const cold = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  const resolve = (turnConfig: Record<string, string>, revision = cold.catalogRevision) => f.adapter.handle(request('catalog.resolve', {
    catalogRevision: revision, sessionConfig: {}, turnConfig,
  }));
  const future = resultSchemas['catalog.resolve'].parse(await resolve({ model: 'gemini-future-pro' }));
  assert.deepEqual(future.configOptions.find(option => option.id === 'thinking')?.choices?.map(choice => choice.value), ['max']);
  assert.deepEqual(future.resolvedDefaults.turnConfig, { model: 'gemini-future-pro', mode: 'default' });
  const legacy = resultSchemas['catalog.resolve'].parse(await resolve({ model: 'gemini-3.8-flash-low', mode: 'auto_edit' }));
  assert.deepEqual(legacy.resolvedDefaults.turnConfig, { model: 'gemini-3.8-flash', thinking: 'low', mode: 'auto_edit' });
  assert.equal(legacy.catalogRevision, cold.catalogRevision);
  assert.ok(legacy.configOptions[0]?.choices?.some(choice => choice.value === 'gemini-3.8-flash-low'));
  for (const values of [
    { model: 'gemini-3.8-flash', thinking: 'max' },
    { model: 'gemini-3.8-flash-high', thinking: 'low' },
    { model: 'gemini-fixed', thinking: 'high' },
    { model: 'gemini-3.8-flash', mode: 'plan' },
  ] as Array<Record<string, string>>) await assert.rejects(resolve(values), error => (
    error instanceof Error && 'domainCode' in error && error.domainCode === 'CONFIG_VALUE_INVALID'
  ));
  await assert.rejects(resolve({ model: 'gemini-3.8-flash' }, 'stale'), /Catalog changed/);
  assert.equal(f.service.creates, 0);
  assert.equal(f.service.starts, 0);
});

test('native session updates and resolves use the same family/Thinking/mode projection', async () => {
  const f = await fixture();
  f.service.optionsFor = () => configOptions('gemini-3.8-flash-medium', 'auto_edit');
  const session = await f.create('a');
  assert.deepEqual(session.turnConfigOptions?.map(option => [option.id, option.defaultValue]), [
    ['model', 'gemini-3.8-flash'], ['thinking', 'medium'], ['mode', 'auto_edit'],
  ]);
  const native = f.service.getSession('a');
  native.configOptions = configOptions('gemini-future-pro-max', 'default');
  f.service.sink({ kind: 'session.changed', session: native });
  const update = f.events.at(-1)!;
  assert.equal(update.method, 'session.updated');
  const updateData = update.params.data as Record<string, unknown>;
  assert.deepEqual((updateData.turnConfigOptions as Array<{ id: string; defaultValue: unknown }>).map(option => [option.id, option.defaultValue]), [
    ['model', 'gemini-future-pro'], ['thinking', 'max'], ['mode', 'default'],
  ]);
  await assert.rejects(f.adapter.handle(request('catalog.resolve', {
    sessionId: 'a', streamId: session.streamId, catalogRevision: session.turnConfigRevision, sessionConfig: {}, turnConfig: {},
  })), /Catalog changed/);
  const resolved = resultSchemas['catalog.resolve'].parse(await f.adapter.handle(request('catalog.resolve', {
    sessionId: 'a', streamId: session.streamId, catalogRevision: updateData.turnConfigRevision,
    sessionConfig: {}, turnConfig: { model: 'gemini-3.8-flash', thinking: 'low', mode: 'yolo' },
  })));
  assert.deepEqual(resolved.resolvedDefaults.turnConfig, { model: 'gemini-3.8-flash', thinking: 'low', mode: 'yolo' });
  // Live modes are not supplemented from the pinned cold-mode contract.
  native.configOptions = configOptions().map(option => option.id === 'mode'
    ? { ...option, options: [{ value: 'default', name: 'Default' }] } as SessionConfigOption : option);
  await assert.rejects(f.adapter.handle(request('turn.start', {
    sessionId: 'a', streamId: session.streamId, turnId: 'unsupported', input: [{ type: 'text', text: 'hello' }], config: { mode: 'yolo' },
  })), /does not accept/);
  assert.equal(f.service.starts, 0);
});

test('an unselected family variant change still fences old resolves', async () => {
  const f = await fixture();
  f.service.optionsFor = () => configOptions();
  const session = await f.create('a');
  const native = f.service.getSession('a');
  const model = native.configOptions[0]!;
  assert.ok(model.type === 'select');
  model.options = [...modelChoices, { value: 'gemini-future-pro-low', name: 'Gemini Future Pro (Low)' }];
  f.service.sink({ kind: 'session.changed', session: native });
  await assert.rejects(f.adapter.handle(request('catalog.resolve', {
    sessionId: 'a', streamId: session.streamId, catalogRevision: session.turnConfigRevision,
    sessionConfig: {}, turnConfig: { model: 'gemini-future-pro', thinking: 'max' },
  })), /Catalog changed/);
});

test('owning session accepts the issued process revision but resolves legacy defaults against native choices', async (t) => {
  const cli = await cliDouble(modelsDocument(modelChoices.map(choice => ({ id: choice.value, label: choice.name }))));
  t.after(() => cli.dispose());
  const f = await fixture(cli.options);
  f.service.optionsFor = () => configOptions();
  const cold = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  const session = await f.create('a');
  const resolved = resultSchemas['catalog.resolve'].parse(await f.adapter.handle(request('catalog.resolve', {
    sessionId: 'a', streamId: session.streamId, catalogRevision: cold.catalogRevision,
    sessionConfig: {}, turnConfig: { model: 'gemini-3.8-flash-low' },
  })));
  assert.equal(resolved.catalogRevision, session.turnConfigRevision);
  assert.deepEqual(resolved.resolvedDefaults.turnConfig, { model: 'gemini-3.8-flash', thinking: 'low', mode: 'default' });
  assert.ok(resolved.configOptions[0]?.choices?.some(choice => choice.value === 'gemini-3.8-flash-low'));
  assert.equal(resolved.configOptions[1]?.defaultValue, 'low');
  const native = f.service.getSession('a');
  native.configOptions = configOptions().map(option => option.id === 'model' && option.type === 'select'
    ? { ...option, options: option.options.filter(choice => !('value' in choice) || choice.value !== 'gemini-3.8-flash-low') } as SessionConfigOption
    : option);
  await assert.rejects(f.adapter.handle(request('catalog.resolve', {
    sessionId: 'a', streamId: session.streamId, catalogRevision: cold.catalogRevision,
    sessionConfig: {}, turnConfig: { model: 'gemini-3.8-flash-low' },
  })), /not an available Gemini model/);
});

test('attached sessions resolve on their native fence while a cold refresh drops the process catalog', async (t) => {
  let clock = 1_000;
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  ]));
  t.after(() => cli.dispose());
  const f = await fixture({
    ...cli.options,
    catalogTtlMs: ANTIGRAVITY_COLD_CATALOG_TTL_MS,
    now: () => clock,
  });
  // Same shape as coldModelOptions + coldModeOption, so this session's native
  // fence is the issued process revision. The other two sessions differ.
  const coldShaped: SessionConfigOption[] = [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select',
      options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
    } as SessionConfigOption,
    {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
      options: [
        { value: 'default', name: 'Default', description: 'Default permission prompt flow' },
        { value: 'auto_edit', name: 'Auto Edit', description: 'Auto-approve file edit tools' },
        { value: 'yolo', name: 'YOLO', description: 'Auto-approve all tools' },
      ],
    },
  ];
  const sessionModel = (modelId: string): SessionConfigOption[] => [{
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelId,
    options: [{ value: modelId, name: modelId }],
  }];
  f.service.optionsFor = (sessionId) => (
    sessionId === 'same' ? coldShaped : sessionModel(sessionId === 'a' ? 'gemini-session-a' : 'gemini-session-b')
  );
  const cold = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  const same = await f.create('same');
  const a = await f.create('a');
  const b = await f.create('b');
  assert.equal(same.turnConfigRevision, cold.catalogRevision);
  assert.notEqual(a.turnConfigRevision, cold.catalogRevision);
  assert.notEqual(b.turnConfigRevision, cold.catalogRevision);
  assert.notEqual(a.turnConfigRevision, b.turnConfigRevision);

  const resolve = (
    session: { streamId: string },
    sessionId: string,
    revision: string,
    turnConfig: Record<string, string> = {},
  ) => f.adapter.handle(request('catalog.resolve', {
    sessionId, streamId: session.streamId, catalogRevision: revision, sessionConfig: {}, turnConfig,
  }));
  const viaSame = resultSchemas['catalog.resolve'].parse(await resolve(same, 'same', cold.catalogRevision));
  assert.equal(viaSame.catalogRevision, same.turnConfigRevision);
  await assert.rejects(resolve(same, 'same', 'stale-not-a-fence'), /Catalog changed/);
  const viaCold = resultSchemas['catalog.resolve'].parse(await resolve(
    a, 'a', cold.catalogRevision, { model: 'gemini-session-a' },
  ));
  assert.equal(viaCold.catalogRevision, a.turnConfigRevision);
  const viaA = resultSchemas['catalog.resolve'].parse(await resolve(a, 'a', a.turnConfigRevision!));
  const viaB = resultSchemas['catalog.resolve'].parse(await resolve(b, 'b', b.turnConfigRevision!));
  assert.equal(viaA.catalogRevision, a.turnConfigRevision);
  assert.equal(viaB.catalogRevision, b.turnConfigRevision);

  clock = 1_000 + ANTIGRAVITY_COLD_CATALOG_TTL_MS;
  cli.env.FAKE_AGY_CLI_DELAY_MS = '400';
  cli.env.FAKE_AGY_CLI_STDOUT = modelsDocument([
    { id: 'gemini-refreshed', label: 'Gemini Refreshed' },
  ]);
  const refreshing = f.adapter.handle(request('catalog.list', {}));
  await waitForCount(cli, 2);
  const [duringSame, duringA, duringB] = await Promise.all([
    resolve(same, 'same', same.turnConfigRevision!),
    resolve(a, 'a', a.turnConfigRevision!, { model: 'gemini-session-a' }),
    resolve(b, 'b', b.turnConfigRevision!, { model: 'gemini-session-b' }),
  ]);
  assert.equal(resultSchemas['catalog.resolve'].parse(duringSame).catalogRevision, same.turnConfigRevision);
  assert.equal(resultSchemas['catalog.resolve'].parse(duringA).catalogRevision, a.turnConfigRevision);
  assert.equal(resultSchemas['catalog.resolve'].parse(duringB).catalogRevision, b.turnConfigRevision);
  await assert.rejects(resolve(a, 'a', cold.catalogRevision, { model: 'gemini-session-a' }), /Catalog changed/);
  await assert.rejects(resolve(a, 'a', cold.catalogRevision, { model: 'gemini-session-a' }), /Catalog changed/);
  await assert.rejects(
    resolve(a, 'a', a.turnConfigRevision!, { model: 'gemini-not-advertised' }),
    (error: unknown) => error instanceof Error && 'domainCode' in error && error.domainCode === 'CONFIG_VALUE_INVALID',
  );
  assert.equal(f.service.starts, 0);

  const refreshed = resultSchemas['catalog.list'].parse(await refreshing);
  assert.notEqual(refreshed.catalogRevision, cold.catalogRevision);
  await assert.rejects(resolve(a, 'a', cold.catalogRevision, { model: 'gemini-session-a' }), /Catalog changed/);
  const viaFresh = resultSchemas['catalog.resolve'].parse(await resolve(
    a, 'a', refreshed.catalogRevision, { model: 'gemini-session-a' },
  ));
  assert.equal(viaFresh.catalogRevision, a.turnConfigRevision);
  assert.equal(f.service.starts, 0);

  const start = (sessionId: string, streamId: string, turnId: string, model: string) => f.adapter.handle(request('turn.start', {
    sessionId, streamId, turnId, input: [{ type: 'text', text: 'hello' }], config: { model },
  }));
  await start('a', a.streamId, 't-a', 'gemini-session-a');
  await start('b', b.streamId, 't-b', 'gemini-session-b');
  assert.equal(f.service.starts, 2);
  await start('a', a.streamId, 't-a', 'gemini-session-a');
  assert.equal(f.service.starts, 2);
});

test('concurrent cold catalog queries share one CLI process', async (t) => {
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  ]), { FAKE_AGY_CLI_DELAY_MS: '200' });
  t.after(() => cli.dispose());
  const f = await fixture(cli.options);
  const [first, second] = await Promise.all([
    f.adapter.handle(request('catalog.list', {})),
    f.adapter.handle(request('catalog.list', {})),
  ]);
  assert.deepEqual(first, second);
  assert.equal(await cli.count(), 1);
  assert.equal(f.service.creates, 0);
  assert.equal(f.service.starts, 0);
});

test('cold catalog cache expires, drops on helper or home changes, and retries after failure', async (t) => {
  assert.equal(ANTIGRAVITY_COLD_CATALOG_TTL_MS, 30_000);
  let clock = 1_000;
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  ]));
  t.after(() => cli.dispose());
  const f = await fixture({
    ...cli.options,
    catalogTtlMs: ANTIGRAVITY_COLD_CATALOG_TTL_MS,
    now: () => clock,
  });
  const first = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  clock = 1_000 + ANTIGRAVITY_COLD_CATALOG_TTL_MS - 1;
  const cached = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.equal(cached.catalogRevision, first.catalogRevision);
  assert.equal(await cli.count(), 1);
  const replaced = `${await readFile(cli.helper, 'utf8')}\n# replaced\n`;
  await writeFile(cli.helper, replaced, { mode: 0o755 });
  await chmod(cli.helper, 0o755);
  await utimes(cli.helper, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  cli.env.FAKE_AGY_CLI_STDOUT = modelsDocument([
    { id: 'gemini-replaced', label: 'Gemini Replaced' },
  ]);
  const refreshed = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.deepEqual(refreshed.configOptions[0]?.choices?.map((choice) => choice.value), ['gemini-replaced']);
  assert.equal(await cli.count(), 2);
  const otherHome = join(cli.root, 'other-home');
  await mkdir(otherHome, { recursive: true });
  cli.env.HOME = otherHome;
  await assert.rejects(f.adapter.handle(request('catalog.list', {})), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.domainCode, 'RUNTIME_ERROR');
    assert.equal(error.message, 'Antigravity CLI model query requires the default Gemini home.');
    return true;
  });
  assert.equal(await cli.count(), 2);
  cli.env.HOME = cli.options.cliModels?.osUserHome;
  const restored = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.equal(restored.catalogRevision, refreshed.catalogRevision);
  assert.equal(await cli.count(), 3);
  clock = 1_000 + ANTIGRAVITY_COLD_CATALOG_TTL_MS + 60_000;
  cli.env.FAKE_AGY_CLI_EXIT = '2';
  await assert.rejects(f.adapter.handle(request('catalog.list', {})), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.message, 'Antigravity CLI model query failed.');
    return true;
  });
  assert.equal(await cli.count(), 4);
  delete cli.env.FAKE_AGY_CLI_EXIT;
  cli.env.FAKE_AGY_CLI_STDOUT = modelsDocument([
    { id: 'gemini-retry', label: 'Gemini Retry' },
  ]);
  const retried = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.deepEqual(retried.configOptions[0]?.choices?.map((choice) => choice.value), ['gemini-retry']);
  assert.equal(await cli.count(), 5);
  assert.equal(f.service.creates, 0);
  assert.equal(f.service.starts, 0);
});

test('cold catalog misses when the selected symlink or preferred candidate changes', async (t) => {
  let clock = 5_000;
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-link-a', label: 'Gemini Link A' },
  ]));
  t.after(() => cli.dispose());
  const realA = join(cli.root, 'fake', 'agy-a');
  const realB = join(cli.root, 'fake', 'agy-b');
  const preferred = join(cli.root, 'fake', 'agy-preferred');
  const script = await readFile(cli.helper);
  for (const path of [realA, realB, preferred]) {
    await writeFile(path, script, { mode: 0o755 });
    await chmod(path, 0o755);
  }
  await rm(cli.helper);
  await symlink(realA, cli.helper);
  const candidates = [cli.helper];
  const f = await fixture({
    ...cli.options,
    catalogTtlMs: ANTIGRAVITY_COLD_CATALOG_TTL_MS,
    now: () => clock,
    cliModels: { ...cli.options.cliModels, candidates },
  });
  const first = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.deepEqual(first.configOptions[0]?.choices?.map((choice) => choice.value), ['gemini-link-a']);
  assert.equal(await cli.count(), 1);
  clock += 1;
  await rm(cli.helper);
  await symlink(realB, cli.helper);
  cli.env.FAKE_AGY_CLI_STDOUT = modelsDocument([
    { id: 'gemini-link-b', label: 'Gemini Link B' },
  ]);
  const retargeted = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.deepEqual(retargeted.configOptions[0]?.choices?.map((choice) => choice.value), ['gemini-link-b']);
  assert.equal(await cli.count(), 2);
  clock += 1;
  candidates.unshift(preferred);
  cli.env.FAKE_AGY_CLI_STDOUT = modelsDocument([
    { id: 'gemini-preferred', label: 'Gemini Preferred' },
  ]);
  const next = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.deepEqual(next.configOptions[0]?.choices?.map((choice) => choice.value), ['gemini-preferred']);
  assert.equal(await cli.count(), 3);
  assert.equal(f.service.creates, 0);
  assert.equal(f.service.starts, 0);
});

test('a null unknown config id is rejected and does not start a prompt', async (t) => {
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  ]));
  t.after(() => cli.dispose());
  const f = await fixture(cli.options);
  const cold = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  await assert.rejects(f.adapter.handle(request('catalog.resolve', {
    catalogRevision: cold.catalogRevision,
    sessionConfig: {},
    turnConfig: { unknown: null },
  })), /Unknown config id 'unknown'/);
  await f.adapter.handle(request('session.create', {
    sessionId: 'created',
    workspace: { cwd: '/tmp', roots: ['/tmp'] },
    config: { model: null, unknown: null },
  }));
  assert.deepEqual(f.service.lastCreateConfig, { unknown: null });
  const session = await f.create('a');
  await assert.rejects(f.adapter.handle(request('turn.start', {
    sessionId: 'a',
    streamId: session.streamId,
    turnId: 'unknown-null',
    input: [{ type: 'text', text: 'hello' }],
    config: { unknown: null },
  })), /Unknown config id 'unknown'/);
  assert.equal(f.service.starts, 0);
  assert.equal(f.service.lastConfig, undefined);
  f.service.optionsFor = () => [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-3.8-flash',
    options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
  }, {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'plan',
    options: [{ value: 'plan', name: 'Plan' }, { value: 'ask', name: 'Ask' }],
  }];
  const other = await f.create('b');
  await assert.rejects(f.adapter.handle(request('turn.start', {
    sessionId: 'b',
    streamId: other.streamId,
    turnId: 'mode-null',
    input: [{ type: 'text', text: 'hello' }],
    config: { mode: null },
  })), /does not accept the provided value/);
  assert.equal(f.service.starts, 0);
  await f.adapter.handle(request('turn.start', {
    sessionId: 'a',
    streamId: session.streamId,
    turnId: 'explicit',
    input: [{ type: 'text', text: 'hello' }],
    config: { model: 'gemini-3.8-flash' },
  }));
  assert.equal(f.service.starts, 1);
  assert.equal(f.service.turnConfig()?.model, 'gemini-3.8-flash');
});

test('shutdown during a warm catalog check does not return the cached models', { timeout: 5_000 }, async (t) => {
  let releaseCheck: (() => void) | undefined;
  let enteredCheck: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredCheck = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseCheck = resolve;
  });
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  ]));
  t.after(() => cli.dispose());
  const f = await fixture({
    ...cli.options,
    afterHelperCheck: () => {
      enteredCheck?.();
      return gate;
    },
  });
  const warm = resultSchemas['catalog.list'].parse(await f.adapter.handle(request('catalog.list', {})));
  assert.deepEqual(warm.configOptions[0]?.choices?.map((choice) => choice.value), ['gemini-3.8-flash']);
  assert.equal(await cli.count(), 1);
  const pending = f.adapter.handle(request('catalog.list', {}));
  pending.catch(() => undefined);
  try {
    await entered;
    const shutdown = await f.adapter.handle(request('shutdown', {}));
    assert.deepEqual(shutdown, { ok: true });
    assert.equal(f.service.closes, 1);
  } finally {
    releaseCheck?.();
  }
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.domainCode, 'CANCELLED');
    assert.equal(error.message, 'Antigravity catalog is closed.');
    return true;
  });
  const again = await f.adapter.handle(request('shutdown', {}));
  assert.deepEqual(again, { ok: true });
  await f.adapter.close();
  assert.equal(f.service.closes, 1);
  assert.equal(await cli.count(), 1);
  assert.equal(f.service.creates, 0);
  assert.equal(f.service.starts, 0);
});

test('a delayed close rejects session create and turn start', { timeout: 5_000 }, async () => {
  let releaseClose: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const f = await fixture();
  const session = await f.create('kept');
  const finish = f.service.close.bind(f.service);
  f.service.close = async () => {
    await gate;
    await finish();
  };
  const closing = f.adapter.handle(request('shutdown', {}));
  closing.catch(() => undefined);
  try {
    await assert.rejects(f.adapter.handle(request('session.create', {
      sessionId: 'late',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      config: {},
    })), (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.domainCode, 'RUNTIME_UNAVAILABLE');
      assert.equal(error.retryable, false);
      assert.equal(error.message, 'The Antigravity service is closing. No session or turn was admitted and the prompt was not sent.');
      return true;
    });
    await assert.rejects(f.adapter.handle(request('turn.start', {
      sessionId: 'kept',
      streamId: session.streamId,
      turnId: 'turn-late',
      input: [{ type: 'text', text: 'hello' }],
      config: {},
    })), (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.domainCode, 'RUNTIME_UNAVAILABLE');
      assert.equal(error.retryable, false);
      assert.equal(error.message, 'The Antigravity service is closing. No session or turn was admitted and the prompt was not sent.');
      return true;
    });
    assert.equal(f.service.creates, 1);
    assert.equal(f.service.starts, 0);
    assert.equal(f.service.closes, 0);
  } finally {
    releaseClose?.();
  }
  assert.deepEqual(await closing, { ok: true });
  assert.deepEqual(await f.adapter.handle(request('shutdown', {})), { ok: true });
  await f.adapter.close();
  assert.equal(f.service.closes, 1);
  assert.equal(f.service.creates, 1);
  assert.equal(f.service.starts, 0);
});

test('shutdown rejects new catalog queries and reaps an in-flight CLI query', async (t) => {
  const cli = await cliDouble(modelsDocument([
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  ]), { FAKE_AGY_CLI_DELAY_MS: '10000' });
  t.after(() => cli.dispose());
  const f = await fixture({
    ...cli.options,
    cliModels: { ...cli.options.cliModels, timeoutMs: 2_000, stopMs: 1_000 },
  });
  const session = await f.create('kept');
  const pending = f.adapter.handle(request('catalog.list', {}));
  pending.catch(() => undefined);
  await waitForCount(cli, 1);
  const started = Date.now();
  const shutdown = await f.adapter.handle(request('shutdown', {}));
  assert.deepEqual(shutdown, { ok: true });
  assert.ok(Date.now() - started < 3_000);
  await assert.rejects(pending, /closed|cancelled/);
  await assert.rejects(f.adapter.handle(request('catalog.list', {})), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.domainCode, 'RUNTIME_UNAVAILABLE');
    assert.equal(error.message, 'The Antigravity service is closing. No session or turn was admitted and the prompt was not sent.');
    return true;
  });
  assert.equal(f.service.closes, 1);
  assert.equal(f.service.sessions.has('kept'), true);
  assert.equal(f.service.getSession('kept').id, session.id);
  assert.equal(f.service.starts, 0);
  assert.equal(await cli.count(), 1);
});

test('a missing CLI helper is an unavailable catalog, not an empty one', async () => {
  const f = await fixture();
  await assert.rejects(f.adapter.handle(request('catalog.list', {})), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.domainCode, 'RUNTIME_UNAVAILABLE');
    assert.equal(error.message, 'Antigravity CLI helper is not installed.');
    assert.deepEqual(error.details, { reason: 'helper_missing' });
    return true;
  });
  assert.equal(f.service.creates, 0);
  assert.equal(f.service.starts, 0);
});

function sourceFixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(here);
  const testDir = basename(here) === 'test' && basename(parent) === 'dist'
    ? join(parent, '..', 'test')
    : here;
  return join(testDir, 'fixtures', 'fake-antigravity-cli-models.mjs');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function modelsDocument(models: unknown): string {
  return JSON.stringify({
    status: 'SUCCESS',
    command: { name: 'models', data: { models } },
  });
}

interface CliDouble {
  root: string;
  helper: string;
  env: NodeJS.ProcessEnv;
  options: AntigravityProtocolV2AdapterOptions;
  count(): Promise<number>;
  dispose(): Promise<void>;
}

async function cliDouble(stdout: string, extra: NodeJS.ProcessEnv = {}): Promise<CliDouble> {
  const root = await mkdtemp(join(tmpdir(), 'agy-catalog-'));
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  const helper = join(root, 'fake', 'agy');
  const countPath = join(root, 'count');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(dirname(helper), { recursive: true });
  const body = `#!/bin/sh\nexec ${shellQuote(execPath)} ${shellQuote(sourceFixturePath())} "$@"\n`;
  await writeFile(helper, body, { mode: 0o755 });
  await chmod(helper, 0o755);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    FAKE_AGY_CLI_COUNT: countPath,
    FAKE_AGY_CLI_STDOUT: stdout,
    ...extra,
  };
  const options: AntigravityProtocolV2AdapterOptions = {
    cliModels: {
      osUserHome: home,
      cwd,
      candidates: [helper],
      env,
      timeoutMs: 2_000,
      stopMs: 1_000,
    },
  };
  return {
    root,
    helper,
    env,
    options,
    async count() {
      try {
        const text = await readFile(countPath, 'utf8');
        return text.split('\n').filter((line) => line.length > 0).length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitForCount(cli: CliDouble, expected: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await cli.count() >= expected) return;
    if (Date.now() - started > 2_000) throw new Error('timed out waiting for the fake CLI');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
