import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  initializeResultSchema,
  proxyErrorResponseSchema,
} from '@gian/proxy-protocol';

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
}

function startV2Proxy(extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
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
  assert.equal(result.plugin.version, '0.2.3');
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
