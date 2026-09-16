import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  initializeResultSchema,
  proxyErrorResponseSchema,
} from '@gian/proxy-protocol';

const isolatedKimiHome = mkdtempSync(join(tmpdir(), 'gian-kimi-cli-home-'));
mkdirSync(join(isolatedKimiHome, '.kimi-code'), { recursive: true });
process.env.HOME = isolatedKimiHome;
process.env.KIMI_CODE_HOME = join(isolatedKimiHome, '.kimi-code');

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
}

function startV2Proxy(extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: isolatedKimiHome,
      KIMI_CODE_HOME: join(isolatedKimiHome, '.kimi-code'),
      GIAN_PLUGIN_ID: 'kimi',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-kimi-v2-test',
      GIAN_RUNTIME_BIN: resolve('test/fixtures/fake-kimi-cli.mjs'),
      GIAN_PROTOCOL_VERSIONS: '2.1',
      ...extraEnv,
    },
  });
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const value = JSON.parse(line) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else messages.push(value);
  });
  return {
    child,
    send(value: unknown) { child.stdin.write(`${JSON.stringify(value)}\n`); },
    sendRaw(line: string) { child.stdin.write(`${line}\n`); },
    next(): Promise<unknown> {
      const value = messages.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolveMessage) => waiters.push(resolveMessage));
    },
  };
}

const PLUGIN_VERSION = (() => {
  let dir = import.meta.dirname;
  for (let i = 0; i < 4; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (typeof pkg.version === 'string' && pkg.name?.startsWith('@gian/')) return pkg.version;
    } catch { /* keep walking */ }
    dir = resolve(dir, '..');
  }
  throw new Error('Proxy package.json not found for the version assertion');
})();

test('Kimi CLI negotiates gian.proxy/2.1 independently from its ACP runtime version', async (t) => {
  const proxy = startV2Proxy();
  t.after(() => { proxy.child.kill('SIGKILL'); });
  proxy.send({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.1'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  const initialized = await proxy.next() as { id: string; result: unknown };
  assert.equal(initialized.id, 'req-1');
  const result = initializeResultSchema.parse(initialized.result);
  assert.equal(result.protocol.version, '2.1');
  assert.equal(result.plugin.version, PLUGIN_VERSION);
  assert.equal(result.process.scope, 'shared');
  assert.equal(result.capabilities.interaction, 1);
  assert.equal(result.capabilities['session.replay'], 1);
  assert.equal(result.capabilities['catalog.resolve'], 1);

  proxy.send({ jsonrpc: '2.0', id: 'req-3', method: 'does.not.exist', params: {} });
  const missing = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(missing.error.code, -32601);
  assert.equal(missing.error.data, undefined, 'standard JSON-RPC errors carry no domain data');

  proxy.send({ jsonrpc: '2.0', id: 'req-4', method: 'shutdown', params: {} });
  assert.deepEqual(await proxy.next(), { jsonrpc: '2.0', id: 'req-4', result: { ok: true } });
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Kimi gian.proxy/2 CLI reports a JSON-RPC parse error for malformed NDJSON', async (t) => {
  const proxy = startV2Proxy();
  t.after(() => { proxy.child.kill('SIGKILL'); });
  proxy.sendRaw('{not-json');
  const error = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(error.id, null);
  assert.equal(error.error.code, -32700);
  assert.equal(error.error.data, undefined, 'standard JSON-RPC errors carry no domain data');
  proxy.send({ jsonrpc: '2.0', id: 'req-shutdown', method: 'shutdown', params: {} });
  await proxy.next();
  assert.equal(await waitForExit(proxy.child), 0);
});

interface WireMessage {
  id?: string;
  method?: string;
  result?: unknown;
  error?: { code: number; data?: { domainCode?: string } };
  params?: Record<string, unknown>;
}

async function initializeProxy(proxy: ReturnType<typeof startV2Proxy>): Promise<void> {
  proxy.send({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.1'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  const message = await proxy.next() as WireMessage;
  assert.equal(message.id, 'init');
  assert.ok(message.result);
}

test('Kimi gian.proxy/2 CLI writes a turn.start response before its notifications', async (t) => {
  const proxy = startV2Proxy();
  t.after(() => { proxy.child.kill('SIGKILL'); });
  await initializeProxy(proxy);

  proxy.send({
    jsonrpc: '2.0',
    id: 'create',
    method: 'session.create',
    params: {
      sessionId: 's-cli',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      config: {},
    },
  });
  const created = await proxy.next() as WireMessage;
  assert.equal(created.id, 'create');
  assert.ok(created.result, JSON.stringify(created.error));
  const session = (created.result as { session: { streamId: string } }).session;
  assert.ok(session.streamId);

  // Session-bound config is a binding violation reported as a domain error
  // before any native session side effect.
  proxy.send({
    jsonrpc: '2.0',
    id: 'bad-create',
    method: 'session.create',
    params: {
      sessionId: 's-cli-2',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      config: { mode: 'auto' },
    },
  });
  const bindingError = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(bindingError.id, 'bad-create');
  assert.equal(bindingError.error.code, -32000);
  assert.equal(
    (bindingError.error.data as { domainCode?: string }).domainCode,
    'CONFIG_BINDING_INVALID',
  );

  // An out-of-choices turn config value fails before the turn is accepted.
  proxy.send({
    jsonrpc: '2.0',
    id: 'bad-turn',
    method: 'turn.start',
    params: {
      sessionId: 's-cli',
      streamId: session.streamId,
      turnId: 't-cli',
      input: [{ type: 'text', text: 'hi' }],
      config: { mode: 'bogus' },
    },
  });
  const configError = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(configError.id, 'bad-turn');
  assert.equal(configError.error.code, -32000);
  assert.equal(
    (configError.error.data as { domainCode?: string }).domainCode,
    'CONFIG_VALUE_INVALID',
  );

  // The same turnId stays reusable because the invalid request was never
  // fingerprinted.
  proxy.send({
    jsonrpc: '2.0',
    id: 'turn',
    method: 'turn.start',
    params: {
      sessionId: 's-cli',
      streamId: session.streamId,
      turnId: 't-cli',
      input: [{ type: 'text', text: 'hi' }],
      config: { mode: 'auto' },
    },
  });
  const accepted = await proxy.next() as WireMessage;
  assert.equal(accepted.id, 'turn', 'turn.start response must precede its notifications');
  assert.deepEqual(accepted.result, { accepted: true, turnId: 't-cli' });

  const started = await proxy.next() as WireMessage;
  assert.equal(started.method, 'turn.started');
  let terminal: WireMessage | null = null;
  for (let i = 0; i < 20 && !terminal; i += 1) {
    const message = await proxy.next() as WireMessage;
    if (message.method === 'turn.completed') terminal = message;
  }
  assert.ok(terminal, 'turn did not complete');
  assert.equal(
    (terminal.params?.data as { stopReason?: string }).stopReason,
    'completed',
  );

  proxy.send({ jsonrpc: '2.0', id: 'bye', method: 'shutdown', params: {} });
  await proxy.next();
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Kimi gian.proxy/2 CLI answers interaction.respond before interaction.resolved', async (t) => {
  const proxy = startV2Proxy({ FAKE_KIMI_PERMISSION: '1' });
  t.after(() => { proxy.child.kill('SIGKILL'); });
  await initializeProxy(proxy);

  proxy.send({
    jsonrpc: '2.0',
    id: 'create',
    method: 'session.create',
    params: {
      sessionId: 's-perm',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      config: {},
    },
  });
  const created = await proxy.next() as WireMessage;
  assert.ok(created.result, JSON.stringify(created.error));
  const session = (created.result as { session: { streamId: string } }).session;

  proxy.send({
    jsonrpc: '2.0',
    id: 'turn',
    method: 'turn.start',
    params: {
      sessionId: 's-perm',
      streamId: session.streamId,
      turnId: 't-perm',
      input: [{ type: 'text', text: 'deploy' }],
      config: {},
    },
  });
  const accepted = await proxy.next() as WireMessage;
  assert.equal(accepted.id, 'turn');

  let requested: WireMessage | null = null;
  for (let i = 0; i < 20 && !requested; i += 1) {
    const message = await proxy.next() as WireMessage;
    if (message.method === 'interaction.requested') requested = message;
  }
  assert.ok(requested, 'permission request was not relayed as an interaction');
  const requestedData = requested.params?.data as {
    interactionId: string;
    actions: Array<{ id: string; label: string }>;
  };
  assert.deepEqual(
    requestedData.actions.map((action) => action.id),
    ['allow-once', 'reject-once'],
    'native ACP option IDs must round-trip untouched',
  );

  proxy.send({
    jsonrpc: '2.0',
    id: 'respond',
    method: 'interaction.respond',
    params: {
      responseId: 'r-cli-1',
      sessionId: 's-perm',
      streamId: session.streamId,
      turnId: 't-perm',
      interactionId: requestedData.interactionId,
      actionId: 'allow-once',
      values: {},
    },
  });
  const responded = await proxy.next() as WireMessage;
  assert.equal(responded.id, 'respond', 'interaction.respond response must precede interaction.resolved');
  assert.deepEqual(responded.result, {
    accepted: true,
    interactionId: requestedData.interactionId,
    responseId: 'r-cli-1',
  });

  const resolved = await proxy.next() as WireMessage;
  assert.equal(resolved.method, 'interaction.resolved');
  assert.deepEqual(resolved.params?.data, {
    interactionId: requestedData.interactionId,
    outcome: 'submitted',
    actionId: 'allow-once',
  });

  proxy.send({ jsonrpc: '2.0', id: 'bye', method: 'shutdown', params: {} });
  await proxy.next();
  assert.equal(await waitForExit(proxy.child), 0);
});

function makeDeepTree(prefix: string): string {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  let dir = ws;
  for (let depth = 0; depth < 160; depth += 1) {
    mkdirSync(join(dir, 'd'), { recursive: true });
    dir = join(dir, 'd');
    writeFileSync(join(dir, 'AGENTS.md'), `# deep ${depth}\n`);
  }
  return ws;
}

test('a concurrent scan never steals or reorders a live turn notification stream on the shared Kimi Host', async (t) => {
  const proxy = startV2Proxy({ FAKE_KIMI_TURN_DELAY_MS: '400' });
  t.after(() => { proxy.child.kill('SIGKILL'); });
  await initializeProxy(proxy);
  const ws = makeDeepTree('gian-kimi-scan-overlap-');
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'create',
      method: 'session.create',
      params: {
        sessionId: 'overlap-session',
        workspace: { cwd: '/tmp', roots: ['/tmp'] },
        config: {},
      },
    });
    const created = await proxy.next() as WireMessage;
    assert.equal(created.id, 'create');
    const streamId = (created.result as { session: { streamId: string } }).session.streamId;
    // Turn first, scan immediately after: the scan starts while the turn is
    // still in flight (the fake publishes turn notifications then keeps the
    // prompt result open for 400ms).
    proxy.send({
      jsonrpc: '2.0',
      id: 'turn',
      method: 'turn.start',
      params: {
        sessionId: 'overlap-session',
        streamId,
        turnId: 'overlap-turn',
        input: [{ type: 'text', text: 'hi' }],
        config: {},
      },
    });
    proxy.send({
      jsonrpc: '2.0',
      id: 'scan',
      method: 'customization.list',
      params: { kind: 'rule', cwd: ws },
    });

    const order: string[] = [];
    const turnNotifications: string[] = [];
    let gotTurnResponse = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const message = await proxy.next() as WireMessage;
      if (message.id === 'turn') {
        gotTurnResponse = true;
        order.push('turn-response');
        continue;
      }
      if (message.id === 'scan') {
        order.push('scan-response');
        continue;
      }
      if (message.method && message.params?.sessionId === 'overlap-session') {
        turnNotifications.push(message.method);
        order.push(`notif:${message.method}`);
      }
      if (gotTurnResponse && turnNotifications.includes('turn.completed') && order.includes('scan-response')) break;
    }
    assert.equal(order.includes('scan-response'), true, `scan response missing: ${order.join(',')}`);
    assert.equal(gotTurnResponse, true, 'turn response missing');
    const firstTurnNotification = order.findIndex(entry => entry.startsWith('notif:'));
    assert.ok(firstTurnNotification > order.indexOf('turn-response'),
      `turn notifications leaked before the turn Response: ${order.join(',')}`);
    for (const expected of ['turn.started', 'content.delta', 'turn.completed']) {
      assert.ok(turnNotifications.includes(expected),
        `expected ${expected} in turn stream, got ${turnNotifications.join(',')}`);
    }

    proxy.send({ jsonrpc: '2.0', id: 'bye', method: 'shutdown', params: {} });
    await proxy.next();
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    rmTree(ws);
  }
});

function makeWideEmptyTree(prefix: string): string {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  for (let index = 0; index < 480; index += 1) {
    mkdirSync(join(ws, `d${index.toString().padStart(3, '0')}`));
  }
  return ws;
}

test('EOF while a rule scan is in flight still delivers the scan Response before exit', async (t) => {
  const proxy = startV2Proxy();
  t.after(() => { proxy.child.kill('SIGKILL'); });
  await initializeProxy(proxy);
  const ws = makeDeepTree('gian-kimi-eof-scan-');
  try {
    // Two stacked scans keep rule walks in flight past the EOF shutdown
    // window; both Responses must still be delivered before exit.
    proxy.send({
      jsonrpc: '2.0',
      id: 'scan-1',
      method: 'customization.list',
      params: { kind: 'rule', cwd: ws },
    });
    proxy.send({
      jsonrpc: '2.0',
      id: 'scan-2',
      method: 'customization.list',
      params: { kind: 'rule', cwd: ws },
    });
    proxy.child.stdin.end();
    const ids = new Set<string>();
    for (let i = 0; i < 2; i += 1) {
      const message = (await Promise.race([
        proxy.next(),
        new Promise<WireMessage | null>(resolve => setTimeout(() => resolve(null), 10_000)),
      ])) as WireMessage | null;
      if (message?.id) ids.add(message.id);
    }
    assert.equal(ids.has('scan-1'), true, 'scan-1 Response was orphaned by EOF');
    assert.equal(ids.has('scan-2'), true, 'scan-2 Response was orphaned by EOF');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    rmTree(ws);
  }
});

test('a shutdown request never orphans an in-flight scan on the shared Kimi Host', async (t) => {
  const proxy = startV2Proxy();
  t.after(() => { proxy.child.kill('SIGKILL'); });
  await initializeProxy(proxy);
  const ws = makeWideEmptyTree('gian-kimi-shutdown-scan-');
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'scan',
      method: 'customization.list',
      params: { kind: 'rule', cwd: ws },
    });
    proxy.send({ jsonrpc: '2.0', id: 'bye', method: 'shutdown', params: {} });
    const ids = new Set<string>();
    for (let i = 0; i < 2; i += 1) {
      const message = (await Promise.race([
        proxy.next(),
        new Promise<WireMessage | null>(resolve => setTimeout(() => resolve(null), 10_000)),
      ])) as WireMessage | null;
      if (message?.id) ids.add(message.id);
    }
    assert.equal(ids.has('scan'), true, 'scan Response was orphaned by shutdown');
    assert.equal(ids.has('bye'), true, 'shutdown Response missing');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    rmTree(ws);
  }
});

function rmTree(ws: string): void {
  rmSync(ws, { recursive: true, force: true });
}

test('two overlapping normal requests are strictly serialized: the second starts only after the first ends', async (t) => {
  // The fake holds the native session create open for 400ms, so the
  // session.get sent right after it deliberately overlaps: with
  // normal-request serialization restored, the fast request must not start
  // until the create has fully ended.
  const proxy = startV2Proxy({ FAKE_KIMI_SESSION_DELAY_MS: '400' });
  t.after(() => { proxy.child.kill('SIGKILL'); });
  await initializeProxy(proxy);
  proxy.send({
    jsonrpc: '2.0',
    id: 'create',
    method: 'session.create',
    params: {
      sessionId: 'serial-session',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      config: {},
    },
  });
  proxy.send({
    jsonrpc: '2.0',
    id: 'get',
    method: 'session.get',
    params: { sessionId: 'serial-session' },
  });

  const order: string[] = [];
  const notifications: string[] = [];
  let gotCreateResponse = false;
  let gotGetResponse = false;
  let createdResult: { session: { streamId: string } } | null = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const message = await proxy.next() as WireMessage;
    if (message.id === 'create') {
      gotCreateResponse = true;
      order.push('create-response');
      createdResult = message.result as { session: { streamId: string } };
      continue;
    }
    if (message.id === 'get') {
      gotGetResponse = true;
      order.push('get-response');
      break;
    }
    if (message.method) {
      notifications.push(message.method);
      order.push(`notif:${message.method}`);
    }
  }
  assert.equal(gotCreateResponse, true, 'session.create response missing');
  assert.equal(gotGetResponse, true, 'session.get response missing');
  // The second normal request must only start after the first has fully
  // ended: its Response cannot arrive inside the create window.
  assert.ok(order.indexOf('get-response') > order.indexOf('create-response'),
    `session.get must not overlap the session.create: ${order.join(',')}`);

  // Response-before-Notification and notification completeness are unchanged
  // under serialization: a turn's notifications still arrive only AFTER its
  // Response, and the next queued request starts after that turn's flush.
  proxy.send({
    jsonrpc: '2.0',
    id: 'turn',
    method: 'turn.start',
    params: {
      sessionId: 'serial-session',
      streamId: createdResult!.session.streamId,
      turnId: 'serial-turn',
      input: [{ type: 'text', text: 'serialize me' }],
      config: {},
    },
  });
  proxy.send({
    jsonrpc: '2.0',
    id: 'get-2',
    method: 'session.get',
    params: { sessionId: 'serial-session' },
  });
  const turnOrder: string[] = [];
  let gotTurnResponse = false;
  let gotTurnStarted = false;
  let gotSecondGet = false;
  const turnDeadline = Date.now() + 10_000;
  while (Date.now() < turnDeadline) {
    const message = await proxy.next() as WireMessage;
    if (message.id === 'turn') {
      gotTurnResponse = true;
      turnOrder.push('turn-response');
      continue;
    }
    if (message.id === 'get-2') {
      gotSecondGet = true;
      turnOrder.push('get-2-response');
      if (gotTurnStarted) break;
      continue;
    }
    if (message.method === 'turn.started') {
      gotTurnStarted = true;
      turnOrder.push('notif:turn.started');
      if (gotSecondGet) break;
    }
  }
  assert.equal(gotTurnResponse, true, 'turn response missing');
  assert.equal(gotTurnStarted, true, 'turn.started missing');
  assert.equal(gotSecondGet, true, 'second session.get response missing');
  assert.ok(turnOrder.indexOf('notif:turn.started') > turnOrder.indexOf('turn-response'),
    `turn.started leaked before the turn Response: ${turnOrder.join(',')}`);

  proxy.send({ jsonrpc: '2.0', id: 'bye', method: 'shutdown', params: {} });
  await proxy.next();
  assert.equal(await waitForExit(proxy.child), 0);
});
