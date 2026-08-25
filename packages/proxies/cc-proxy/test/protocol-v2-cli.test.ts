import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import test from 'node:test';
import { initializeResultSchema, proxyErrorResponseSchema } from '@gian/proxy-protocol';

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolveExit => child.once('exit', code => resolveExit(code)));
}

function startV2Proxy(environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: 'claude',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-claude-v2-test',
      GIAN_RUNTIME_BIN: process.execPath,
      GIAN_PROTOCOL_VERSIONS: '2.0',
      ...environment,
    },
  });
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
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
      return new Promise(resolveMessage => waiters.push(resolveMessage));
    },
  };
}

test('Claude CLI negotiates gian.proxy/2.0 independently from its runtime version', async () => {
  const proxy = startV2Proxy();
  proxy.send({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  const initialized = await proxy.next() as { id: string; result: unknown };
  assert.equal(initialized.id, 'req-1');
  const result = initializeResultSchema.parse(initialized.result);
  assert.equal(result.protocol.version, '2.0');
  assert.equal(result.plugin.id, 'claude');
  assert.equal(result.plugin.version, '0.2.2');
  assert.equal(result.process.scope, 'session');
  assert.equal(result.capabilities.interaction, 1);
  assert.equal(result.capabilities['session.replay'], 1);
  assert.equal(result.capabilities['session.rename'], 1);
  assert.equal(result.capabilities['session.native.list'], 1);
  assert.equal(result.capabilities['event.usage'], 1);
  assert.equal(result.capabilities['event.reasoning'], 1);
  assert.equal(result.capabilities['slash.list'], undefined);
  assert.equal(result.capabilities['turn.steer'], undefined);
  assert.equal(result.capabilities['session.native.delete'], undefined);
  assert.equal(result.capabilities['integration.mcp.streamableHttp'], undefined);

  proxy.send({ jsonrpc: '2.0', id: 'req-3', method: 'does.not.exist', params: {} });
  const missing = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(missing.error.code, -32601);
  assert.equal((missing.error.data as { domainCode?: string }).domainCode, 'METHOD_NOT_FOUND');

  proxy.send({ jsonrpc: '2.0', id: 'req-4', method: 'shutdown', params: {} });
  assert.deepEqual(await proxy.next(), { jsonrpc: '2.0', id: 'req-4', result: { ok: true } });
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Claude gian.proxy/2 CLI reports a JSON-RPC parse error for malformed NDJSON', async () => {
  const proxy = startV2Proxy();
  proxy.sendRaw('{not-json');
  const error = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(error.id, null);
  assert.equal(error.error.code, -32700);
  assert.equal((error.error.data as { domainCode?: string }).domainCode, 'PARSE_ERROR');
  proxy.send({ jsonrpc: '2.0', id: 'req-shutdown', method: 'shutdown', params: {} });
  await proxy.next();
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Claude CLI speaks gian.proxy/2.0 even when GIAN_PROTOCOL_VERSIONS is omitted', async () => {
  const proxy = startV2Proxy({ GIAN_PROTOCOL_VERSIONS: undefined });
  proxy.send({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  const initialized = await proxy.next() as { id: string; result: unknown };
  assert.equal(initialized.id, 'req-1');
  assert.equal(initializeResultSchema.parse(initialized.result).protocol.version, '2.0');
  proxy.send({ jsonrpc: '2.0', id: 'req-2', method: 'shutdown', params: {} });
  assert.deepEqual(await proxy.next(), { jsonrpc: '2.0', id: 'req-2', result: { ok: true } });
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Claude CLI writes turn.start response before turn.started with a Fake Runtime', async () => {
  const fakeRuntime = resolve('test/fixtures/fake-claude-runtime.mjs');
  const proxy = startV2Proxy({ GIAN_RUNTIME_BIN: fakeRuntime });
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.0'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    const initialized = await proxy.next() as { id: string; result: unknown };
    assert.equal(initialized.id, 'req-1');
    assert.equal(initializeResultSchema.parse(initialized.result).protocol.version, '2.0');

    proxy.send({ jsonrpc: '2.0', id: 'req-2', method: 'catalog.list', params: {} });
    const catalog = await proxy.next() as { id: string; result: unknown };
    assert.equal(catalog.id, 'req-2');

    proxy.send({
      jsonrpc: '2.0',
      id: 'req-3',
      method: 'session.create',
      params: {
        sessionId: 'cli-session',
        workspace: { cwd: '/tmp', roots: ['/tmp'] },
        config: {},
      },
    });
    const created = await proxy.next() as { id: string; result: { session: { streamId: string } } };
    assert.equal(created.id, 'req-3');
    const streamId = created.result.session.streamId;

    proxy.send({
      jsonrpc: '2.0',
      id: 'req-4',
      method: 'turn.start',
      params: {
        sessionId: 'cli-session',
        streamId,
        turnId: 'cli-turn',
        input: [{ type: 'text', text: 'hello' }],
        config: {},
      },
    });

    // Response-before-Notification: the first stdout object after turn.start
    // must be the JSON-RPC Response.
    const accepted = await proxy.next() as { id: string; result: unknown };
    assert.equal(accepted.id, 'req-4');
    assert.deepEqual(accepted.result, { accepted: true, turnId: 'cli-turn' });

    const events: Array<{ method?: string; params?: { turnId?: string; sourceTurnId?: string; sequence?: number; data?: unknown } }> = [];
    let terminal = false;
    while (!terminal) {
      const message = await proxy.next() as {
        id?: string;
        method?: string;
        params?: { turnId?: string; sourceTurnId?: string; sequence?: number; data?: unknown };
      };
      assert.equal(message.id, undefined);
      assert.ok(message.method && message.params);
      events.push(message);
      if (message.method === 'turn.completed' || message.method === 'turn.failed') terminal = true;
    }
    const methods = events.map((event) => event.method);
    assert.deepEqual(methods, [
      'turn.started',
      'usage.updated',
      'content.delta',
      'content.delta',
      'activity.updated',
      'usage.updated',
      'content.completed',
      'content.completed',
      'turn.completed',
    ]);
    assert.equal(events[0]?.params?.turnId, 'cli-turn');
    assert.ok(events[0]?.params?.sourceTurnId);
    assert.notEqual(events[0]?.params?.sourceTurnId, 'cli-turn');
    assert.equal(
      ((events[2]?.params?.data as { kind?: string }).kind),
      'reasoning',
    );
    assert.deepEqual(
      events.map((event) => event.params?.sequence),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    const unknown = events.find((event) => event.method === 'activity.updated')!;
    assert.equal(
      ((unknown.params?.data as { presentation?: { type?: string } }).presentation ?? {}).type,
      'generic',
    );

    const actionUpdate = await proxy.next() as { method?: string; params?: { sequence?: number } };
    assert.equal(actionUpdate.method, 'session.updated');
    assert.equal(actionUpdate.params?.sequence, 10);

    proxy.send({ jsonrpc: '2.0', id: 'req-5', method: 'shutdown', params: {} });
    assert.deepEqual(await proxy.next(), { jsonrpc: '2.0', id: 'req-5', result: { ok: true } });
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    if (proxy.child.exitCode === null && proxy.child.signalCode === null) {
      proxy.child.kill('SIGTERM');
    }
  }
});
