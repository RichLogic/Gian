import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProxyProtocolError, type ProxyNotification } from '@gian/proxy-protocol';
import {
  isProxyRequestTimeout,
  ProtocolV2Client,
  proxyRequestTimeoutError,
} from '../src/proxy/protocol-v2-client.js';
import {
  normalizeProtocolCatalog,
  PROXY_SESSION_RPC_TIMEOUT_MS,
  PROXY_SIDECHAT_RPC_TIMEOUT_MS,
  ProtocolV2SessionClient,
} from '../src/proxy/protocol-v2-session-client.js';

test('Host normalizes 2.1 Special Catalog ids for existing internal config projections', () => {
  const catalog = normalizeProtocolCatalog({
    catalogRevision: 'rev-21',
    input: [{ type: 'text' }],
    configOptions: [
      { id: 'native-model', displayName: 'Model', binding: 'turn', control: 'select', required: false, defaultValue: 'm', choices: [{ value: 'm', displayName: 'M' }] },
      { id: 'native-thinking', displayName: 'Thinking', binding: 'turn', control: 'select', required: false, defaultValue: 'high', choices: [{ value: 'high', displayName: 'High' }] },
      { id: 'native-fast', displayName: 'Fast', binding: 'turn', control: 'boolean', required: false, defaultValue: false },
      { id: 'native-approval', displayName: 'Approval', binding: 'turn', control: 'select', required: false, defaultValue: 'ask', choices: [{ value: 'ask', displayName: 'Ask' }] },
    ],
    specialCatalogs: {
      model: 'native-model',
      thinking: 'native-thinking',
      fast: 'native-fast',
      approvalMode: 'native-approval',
    },
    slashCommands: [],
  });
  assert.deepEqual(catalog.configOptions.map(option => [option.id, option.role]), [
    ['native-model', 'model'],
    ['native-thinking', 'effort'],
    ['native-fast', 'fast'],
    ['native-approval', 'approval_mode'],
  ]);
});

test('catalog invalidation keeps Special Catalog roles for an immediate session snapshot', async () => {
  const catalog = normalizeProtocolCatalog({
    catalogRevision: 'rev-21',
    input: [{ type: 'text' }],
    configOptions: [
      { id: 'model', displayName: 'Model', binding: 'turn', control: 'select', required: false, defaultValue: 'k3', choices: [{ value: 'k3', displayName: 'K3' }] },
      { id: 'thinking', displayName: 'Thinking', binding: 'turn', control: 'select', required: false, defaultValue: 'high', choices: [{ value: 'high', displayName: 'High' }] },
      { id: 'mode', displayName: 'Mode', binding: 'turn', control: 'select', required: false, defaultValue: 'yolo', choices: [{ value: 'yolo', displayName: 'YOLO' }] },
    ],
    specialCatalogs: { model: 'model', thinking: 'thinking', approvalMode: 'mode' },
    slashCommands: [],
  });
  let catalogCalls = 0;
  const client = new ProtocolV2SessionClient({
    executor: 'kimi',
    catalog: async () => {
      catalogCalls += 1;
      return catalog;
    },
  } as never, 'session-1');
  await client.catalog();

  client.deliverNotification({
    method: 'catalog.changed',
    params: {
      eventId: 'catalog-event',
      emittedAt: '2026-08-31T09:00:00.000Z',
      data: { reason: 'available-commands', revision: 'rev-22' },
    },
  } as ProxyNotification);
  client.deliverNotification({
    method: 'session.updated',
    params: {
      eventId: 'session-event',
      emittedAt: '2026-08-31T09:00:00.001Z',
      sessionId: 'session-1',
      streamId: 'stream-1',
      data: {
        turnConfigOptions: catalog.configOptions.map(({ role: _role, ...option }) => option),
        turnConfigRevision: 'turn-rev-2',
      },
    },
  } as ProxyNotification);

  const snapshot = client as unknown as {
    turnConfigOptions?: Array<{ id: string; role?: string }>;
  };
  assert.deepEqual(snapshot.turnConfigOptions?.map(option => [option.id, option.role]), [
    ['model', 'model'],
    ['thinking', 'effort'],
    ['mode', 'approval_mode'],
  ]);
  await client.catalog();
  assert.equal(catalogCalls, 2, 'the invalidated catalog still refetches on demand');
});

function fixtureSource(options: { malformedCatalog?: boolean; invalidUtf8Catalog?: boolean } = {}): string {
  return `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const emittedAt = '2026-08-10T00:00:00.000Z';
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.jsonrpc !== '2.0' || typeof request.id !== 'string') {
    throw new Error('fixture expected JSON-RPC 2.0 string ids');
  }
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: process.env.GIAN_PLUGIN_ID, name: 'Fixture', version: '7.4.2' },
      process: { scope: 'shared' },
      capabilities: {},
    } }) + '\\n');
  } else if (request.method === 'catalog.list') {
    ${options.invalidUtf8Catalog
      ? "process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));"
      : options.malformedCatalog
      ? "process.stdout.write('{bad-json\\n');"
      : "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { catalogRevision: 'rev-1', input: [{ type: 'text' }], configOptions: [], slashCommands: [] } }) + '\\n');"}
  } else if (request.method === 'session.create') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { session: {
      id: request.params.sessionId,
      nativeSession: { id: 'native-1' },
      streamId: 'stream-1',
      state: 'idle',
      sessionConfig: request.params.config ?? {},
      createdAt: emittedAt,
      updatedAt: emittedAt,
    } } }) + '\\n');
  } else if (request.method === 'turn.start') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      accepted: true,
      turnId: request.params.turnId,
    } }) + '\\n');
    const base = {
      streamId: request.params.streamId,
      sessionId: request.params.sessionId,
      turnId: request.params.turnId,
      sourceTurnId: request.params.turnId,
      emittedAt,
    };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn.started', params: {
      ...base, eventId: 'event-1', sequence: 1, data: {},
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'content.delta', params: {
      ...base, eventId: 'event-2', sequence: 2,
      data: { contentId: 'content-1', kind: 'text', delta: 'hello' },
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'content.completed', params: {
      ...base, eventId: 'event-3', sequence: 3,
      data: { contentId: 'content-1', kind: 'text', content: 'hello' },
    } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn.completed', params: {
      ...base, eventId: 'event-4', sequence: 4,
      data: { stopReason: 'completed' },
    } }) + '\\n');
  } else if (request.method === 'session.close' || request.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
    if (request.method === 'shutdown') break;
  }
}
`;
}

async function fixtureClient(
  t: TestContext,
  source: string,
): Promise<ProtocolV2Client> {
  const root = await mkdtemp(join(tmpdir(), 'gian-protocol-v2-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, source);
  return new ProtocolV2Client({
    entry,
    pluginId: 'io.gian.fixture',
    pluginVersion: '7.4.2',
    processScope: 'shared',
    dataDir: join(root, 'data'),
    runtimeBin: process.execPath,
    hostVersion: '99.8.7',
  });
}

test('generic protocol v2 client validates JSON-RPC requests, responses, and notifications', async (t) => {
  const client = await fixtureClient(t, fixtureSource());
  const notifications: ProxyNotification[] = [];
  let resolveNotifications!: () => void;
  let sessionFault: Error | undefined;
  const allNotifications = new Promise<void>((resolve) => { resolveNotifications = resolve; });
  client.onSessionFault((error) => {
    sessionFault = error;
    resolveNotifications();
  });
  client.onNotification((notification) => {
    notifications.push(notification);
    if (notifications.length === 4) resolveNotifications();
  });

  const initialized = await client.initialize();
  assert.equal(initialized.plugin.id, 'io.gian.fixture');
  assert.equal(initialized.plugin.version, '7.4.2');
  assert.equal(initialized.protocol.version, '2.0');
  assert.deepEqual(await client.catalog(), {
    catalogRevision: 'rev-1',
    input: [{ type: 'text' }],
    configOptions: [],
    slashCommands: [],
  });

  const created = await client.request<{ session: { streamId: string } }>('session.create', {
    sessionId: 'session-1',
    workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
    config: {},
  });
  assert.equal(created.session.streamId, 'stream-1');

  await client.request('turn.start', {
    sessionId: 'session-1',
    streamId: 'stream-1',
    turnId: 'turn-1',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
  });
  try {
    await allNotifications;
    if (sessionFault) throw sessionFault;
    assert.deepEqual(notifications.map((value) => value.method), [
      'turn.started',
      'content.delta',
      'content.completed',
      'turn.completed',
    ]);
    await client.request('session.close', { sessionId: 'session-1', streamId: 'stream-1' });
  } finally {
    await client.shutdown().catch(() => undefined);
  }
  assert.equal(client.isExited(), true);
});

test('generic protocol v2 client treats malformed stdout as a fatal connection error', async (t) => {
  const client = await fixtureClient(t, fixtureSource({ malformedCatalog: true }));
  const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
  await client.initialize();
  await assert.rejects(client.catalog(), /Invalid JSON|PARSE_ERROR|protocol/i);
  await exited;
  assert.equal(client.isExited(), true);
});

test('generic protocol v2 client treats invalid UTF-8 stdout as fatal', async (t) => {
  const client = await fixtureClient(t, fixtureSource({ invalidUtf8Catalog: true }));
  const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
  await client.initialize();
  await assert.rejects(client.catalog(), /UTF-8|PARSE_ERROR|protocol/i);
  await exited;
  assert.equal(client.isExited(), true);
});

test('a timed-out request settles, drops its pending record, and its late response is ignored instead of killing the shared Host', async (t) => {
  const source = `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: 'io.gian.fixture', name: 'Fixture', version: '7.4.2' },
      process: { scope: 'shared' },
      capabilities: { 'customization.list': 1 },
    } }) + '\\n');
  } else if (request.method === 'customization.list') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        kind: request.params.kind,
        status: 'ok',
        completeness: 'configured',
        observedAt: '2026-09-02T00:00:00.000Z',
        items: [],
        truncated: false,
        diagnostics: [],
      } }) + '\\n');
    }, 300);
  } else if (request.method === 'session.get') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
      code: -32002, message: 'SESSION_NOT_FOUND',
      data: { domainCode: 'SESSION_NOT_FOUND', retryable: false, details: {} },
    } }) + '\\n');
  } else if (request.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
    break;
  }
}
`;
  const client = await fixtureClient(t, source);
  await client.initialize();

  await assert.rejects(
    client.request('customization.list', { kind: 'skill' }, { timeoutMs: 30 }),
    /did not answer/,
  );
  // The late Response must arrive after the timeout fired.
  await new Promise((resolve) => setTimeout(resolve, 400));

  // The Host (this client) must still be alive and fully usable: the late
  // response was ignored as expected latency, never treated as an orphan
  // protocol violation that kills a shared Proxy serving live sessions.
  assert.equal(client.isExited(), false);
  await assert.rejects(
    client.request('session.get', { sessionId: 'x' }),
    /SESSION_NOT_FOUND/,
  );
  await client.shutdown().catch(() => undefined);
  assert.equal(client.isExited(), true);
});


test('late responses beyond any tombstone capacity stay harmless; only truly unknown ids are fatal', async (t) => {
  const source = `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: 'io.gian.fixture', name: 'Fixture', version: '7.4.2' },
      process: { scope: 'shared' },
      capabilities: { 'customization.list': 1 },
    } }) + '\\n');
  } else if (request.method === 'customization.list') {
    // req-1 answers 5s late (far past any bounded-tombstone TTL); every
    // other request answers 300ms late — far past its 10ms timeout and after
    // 128+ further timeouts would have evicted any bounded tombstone.
    const delay = request.id === 'req-1' ? 5000 : 300;
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        kind: request.params.kind, status: 'ok', completeness: 'configured',
        observedAt: '2026-09-02T00:00:00.000Z', items: [], truncated: false, diagnostics: [],
      } }) + '\\n');
    }, delay);
  } else if (request.method === 'session.get') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
      code: -32002, message: 'SESSION_NOT_FOUND',
      data: { domainCode: 'SESSION_NOT_FOUND', retryable: false, details: {} },
    } }) + '\\n');
  } else if (request.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
    break;
  }
}
`;
  const client = await fixtureClient(t, source);
  t.after(() => { client.forceKill(); });
  await client.initialize();
  let exited = false;
  client.onExit(() => { exited = true; });

  for (let i = 1; i <= 130; i += 1) {
    await assert.rejects(
      client.request('customization.list', { kind: 'skill' }, { timeoutMs: 10 }),
      /did not answer/,
    );
  }
  // Wait for every late Response (including req-1 at 5s) to arrive.
  await new Promise(resolve => setTimeout(resolve, 5600));
  assert.equal(exited, false, 'a late Response that outlives any bounded tombstone must not kill the Host');
  await assert.rejects(
    client.request('session.get', { sessionId: 'x' }),
    /SESSION_NOT_FOUND/,
  );
  await client.shutdown().catch(() => undefined);
  assert.equal(client.isExited(), true);
});

test('a response id this client never issued is still a fatal protocol violation', async (t) => {
  const source = `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: 'io.gian.fixture', name: 'Fixture', version: '7.4.2' },
      process: { scope: 'shared' },
      capabilities: {},
    } }) + '\\n');
  } else if (request.method === 'session.get') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'req-999999', result: { session: {} } }) + '\\n');
  } else if (request.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
    break;
  }
}
`;
  const client = await fixtureClient(t, source);
  t.after(() => { client.forceKill(); });
  const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
  await client.initialize();
  await assert.rejects(client.request('session.get', { sessionId: 'x' }), /protocol|violation|no client request/i);
  await exited;
  assert.equal(client.isExited(), true);
});

test('timeoutMs must be a finite positive number', async (t) => {
  const client = await fixtureClient(t, fixtureSource());
  t.after(() => { client.forceKill(); });
  await client.initialize();
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      client.request('session.get', { sessionId: 'x' }, { timeoutMs: bad }),
      /finite positive number/,
    );
  }
  // A positive timeout still applies normally: the fixture never answers
  // session.get, so the timeout settles the request.
  await assert.rejects(
    client.request('session.get', { sessionId: 'x' }, { timeoutMs: 100 }),
    /did not answer session.get within 100ms/,
  );
  await client.shutdown().catch(() => undefined);
});

test('isProxyRequestTimeout marks only client-side timeout rejections', async (t) => {
  // Pure round-trip of the marker used by the Side Chat coordinator's
  // quarantine guard: a Proxy-reported RUNTIME_UNAVAILABLE domain error must
  // never be mistaken for a client-side deadline.
  assert.equal(isProxyRequestTimeout(proxyRequestTimeoutError('io.gian.kimi', 'turn.start', 30_000)), true);
  assert.equal(
    isProxyRequestTimeout(new ProxyProtocolError('RUNTIME_UNAVAILABLE', '[RUNTIME_UNAVAILABLE] wedged', false)),
    false,
  );
  assert.equal(isProxyRequestTimeout(new Error('did not answer')), false);

  const source = `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: 'io.gian.fixture', name: 'Fixture', version: '7.4.2' },
      process: { scope: 'shared' },
      capabilities: { 'customization.list': 1 },
    } }) + '\\n');
  } else if (request.method === 'customization.list') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        kind: request.params.kind, status: 'ok', completeness: 'configured',
        observedAt: '2026-09-17T00:00:00.000Z', items: [], truncated: false, diagnostics: [],
      } }) + '\\n');
    }, 300);
  } else if (request.method === 'session.get') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
      code: -32002, message: 'SESSION_NOT_FOUND',
      data: { domainCode: 'SESSION_NOT_FOUND', retryable: false, details: {} },
    } }) + '\\n');
  } else if (request.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
    break;
  }
}
`;
  const client = await fixtureClient(t, source);
  t.after(() => { client.forceKill(); });
  await client.initialize();
  const timeoutError = await client.request(
    'customization.list',
    { kind: 'skill' },
    { timeoutMs: 30 },
  ).then(() => null, (error: unknown) => error);
  assert.match((timeoutError as Error).message, /did not answer/);
  assert.equal(isProxyRequestTimeout(timeoutError), true);
  const domainError = await client.request('session.get', { sessionId: 'x' }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.match((domainError as Error).message, /SESSION_NOT_FOUND/);
  assert.equal(isProxyRequestTimeout(domainError), false);
  await client.shutdown().catch(() => undefined);
});

test('session/turn/sidechat RPCs carry bounded deadlines', async () => {
  // Unit-level wiring proof: every session/sidechat control RPC passes the
  // production deadline to the bounded client request. The client-side
  // timeout mechanics themselves (settle, late-response watermark) are
  // covered by the fixture-based tests above.
  const calls: Array<{ method: string; options?: { timeoutMs?: number } }> = [];
  const sessionSnapshot = {
    id: 'session-1',
    streamId: 'stream-1',
    state: 'idle',
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
  };
  const sidechatSnapshot = {
    id: 'sc-1',
    parentSessionId: 'session-1',
    streamId: 'stream-sc-1',
    state: 'idle',
    resumeRef: { id: 'ref-1' },
    anchor: { type: 'empty' },
    sessionConfig: {},
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
  };
  const results: Record<string, unknown> = {
    'session.create': { session: sessionSnapshot },
    'sidechat.create': { sidechat: sidechatSnapshot },
    'sidechat.resume': { sidechat: sidechatSnapshot },
    'sidechat.close': { ok: true, sidechatId: 'sc-1', providerDataDeleted: true },
  };
  const host = {
    pluginId: 'io.gian.fixture',
    executor: 'kimi' as const,
    initialize: async () => ({ capabilities: {} }),
    catalog: async () => ({
      catalogRevision: 'rev-1',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
    request: async (method: string, _params: unknown, options?: { timeoutMs?: number }) => {
      calls.push({ method, options });
      return results[method] ?? {};
    },
    createSessionClient: (sessionId: string) => (
      new ProtocolV2SessionClient(host as never, sessionId)
    ),
  };
  const session = new ProtocolV2SessionClient(host as never, 'session-1');
  await session.createSession({ cwd: '/tmp/project' });
  await session.startTurn({
    sessionId: 'session-1',
    turnId: 'turn-1',
    input: [{ type: 'text', text: 'hi' }],
    config: {},
  });
  await session.interruptTurn();
  await session.respondInteraction({
    sessionId: 'session-1',
    interactionId: 'int-1',
    responseId: 'resp-1',
    actionId: 'allow_once',
    values: {},
  });
  await session.createSidechat({ sidechatId: 'sc-1' });
  await session.resumeSidechat({ sidechatId: 'sc-1', resumeRef: { id: 'ref-1' } });
  await session.closeSidechat({ sidechatId: 'sc-1', resumeRef: { id: 'ref-1' } });

  const deadlineFor = (method: string) => calls.filter((call) => call.method === method)
    .map((call) => call.options?.timeoutMs);
  assert.deepEqual(deadlineFor('session.create'), [PROXY_SESSION_RPC_TIMEOUT_MS]);
  assert.deepEqual(deadlineFor('turn.start'), [PROXY_SESSION_RPC_TIMEOUT_MS]);
  assert.deepEqual(deadlineFor('turn.interrupt'), [PROXY_SESSION_RPC_TIMEOUT_MS]);
  assert.deepEqual(deadlineFor('interaction.respond'), [PROXY_SESSION_RPC_TIMEOUT_MS]);
  assert.deepEqual(deadlineFor('sidechat.create'), [PROXY_SIDECHAT_RPC_TIMEOUT_MS]);
  assert.deepEqual(deadlineFor('sidechat.resume'), [PROXY_SIDECHAT_RPC_TIMEOUT_MS]);
  assert.deepEqual(deadlineFor('sidechat.close'), [PROXY_SIDECHAT_RPC_TIMEOUT_MS]);
});
