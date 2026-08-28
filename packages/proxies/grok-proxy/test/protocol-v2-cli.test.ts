import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
      GIAN_PLUGIN_ID: 'grok',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-grok-v2-test',
      GIAN_RUNTIME_BIN: resolve('test/fixtures/fake-grok-cli.mjs'),
      GIAN_PROTOCOL_VERSIONS: '2.1',
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
    async nextResult(id: string): Promise<unknown> {
      for (;;) {
        const value = await this.next() as { id?: unknown };
        if (value.id === id) return value;
      }
    },
  };
}

test('Grok CLI negotiates gian.proxy/2.1 independently from its ACP runtime version', async () => {
  const proxy = startV2Proxy();
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
  assert.equal(result.plugin.id, 'grok');
  assert.equal(result.plugin.version, '0.3.2');
  assert.equal(result.process.scope, 'session');
  assert.equal(result.capabilities.interaction, 1);
  assert.equal(result.capabilities['session.native.delete'], 1);
  assert.equal(result.capabilities['turn.steer'], 1);
  assert.equal(result.capabilities['slash.list'], undefined);
  assert.equal(result.capabilities['integration.mcp.streamableHttp'], undefined);

  proxy.send({ jsonrpc: '2.0', id: 'req-3', method: 'does.not.exist', params: {} });
  const missing = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(missing.error.code, -32601);
  assert.equal(missing.error.data, undefined);

  proxy.send({
    jsonrpc: '2.0',
    id: 'req-params',
    method: 'session.create',
    params: {
      workspace: { cwd: process.cwd(), roots: [process.cwd()] },
      config: {},
    },
  });
  const invalidParams = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(invalidParams.error.code, -32602);
  assert.equal(invalidParams.error.data, undefined);

  proxy.send({ jsonrpc: '2.0', id: 'req-4', method: 'shutdown', params: {} });
  assert.deepEqual(await proxy.next(), { jsonrpc: '2.0', id: 'req-4', result: { ok: true } });
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Grok gian.proxy/2 CLI reports a JSON-RPC parse error for malformed NDJSON', async () => {
  const proxy = startV2Proxy();
  proxy.sendRaw('{not-json');
  const error = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(error.id, null);
  assert.equal(error.error.code, -32700);
  assert.equal(error.error.data, undefined);
  proxy.send({ jsonrpc: '2.0', id: 'req-shutdown', method: 'shutdown', params: {} });
  await proxy.next();
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Grok CLI speaks gian.proxy/2.1 even when GIAN_PROTOCOL_VERSIONS is omitted', async () => {
  const child = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: 'grok',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-grok-v2-default-test',
      GIAN_RUNTIME_BIN: resolve('test/fixtures/fake-grok-cli.mjs'),
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
  const next = (): Promise<unknown> => {
    const value = messages.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise(resolveMessage => waiters.push(resolveMessage));
  };
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.1'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  })}\n`);
  const initialized = await next() as { id: string; result: unknown };
  assert.equal(initialized.id, 'req-1');
  assert.equal(initializeResultSchema.parse(initialized.result).protocol.version, '2.1');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'req-2', method: 'shutdown', params: {} })}\n`);
  assert.deepEqual(await next(), { jsonrpc: '2.0', id: 'req-2', result: { ok: true } });
  assert.equal(await waitForExit(child), 0);
});

test('Grok runtime uses the locked ACP command and forces the workspace sandbox', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-grok-spawn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recordPath = join(root, 'spawn.json');
  const proxy = startV2Proxy({
    GROK_SANDBOX: 'off',
    GROK_TEST_SPAWN_RECORD: recordPath,
  });
  proxy.send({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.1'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  await proxy.next();
  proxy.send({ jsonrpc: '2.0', id: 'req-2', method: 'catalog.list', params: {} });
  const catalog = await proxy.next() as {
    result?: {
      specialCatalogs?: { approvalMode?: string };
      configOptions?: Array<{
        id: string;
        role?: string;
        binding?: string;
        choices?: Array<{ value: string; displayName: string }>;
      }>;
    };
  };
  const permission = catalog.result?.configOptions?.find(option => option.id === 'permission_mode');
  assert.equal(catalog.result?.specialCatalogs?.approvalMode, 'permission_mode');
  assert.equal(permission?.role, undefined);
  assert.equal(permission?.binding, 'session');
  assert.deepEqual(permission?.choices?.map(choice => choice.value), ['default', 'auto', 'always_approve']);
  const recorded = JSON.parse(await readFile(recordPath, 'utf8')) as {
    argv: string[];
    sandbox: string;
  };
  assert.deepEqual(recorded.argv, [
    '--deny',
    'MCPTool(*)',
    '--disallowed-tools',
    'search_tool,use_tool',
    'agent',
    '--no-leader',
    'stdio',
  ]);
  assert.equal(recorded.sandbox, 'workspace');
  proxy.send({ jsonrpc: '2.0', id: 'req-3', method: 'shutdown', params: {} });
  assert.deepEqual(await proxy.next(), { jsonrpc: '2.0', id: 'req-3', result: { ok: true } });
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Grok turn notifications all carry the Host turn id and sourceTurnId', async () => {
  const proxy = startV2Proxy();
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.1'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    const initialized = await proxy.next() as { id: string; error?: unknown };
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));

    proxy.send({
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'session.create',
      params: {
        sessionId: 'sess-turn-id',
        workspace: { cwd: process.cwd(), roots: [process.cwd()] },
        config: {},
      },
    });
    const created = await proxy.nextResult('req-2') as {
      id: string;
      result?: { session?: { streamId?: string; state?: string } };
      error?: unknown;
    };
    assert.equal(created.error, undefined, JSON.stringify(created));
    const streamId = created.result?.session?.streamId;
    assert.ok(streamId, 'session.create must return a stream id');
    assert.equal(created.result?.session?.state, 'idle');

    const hostTurnId = 'turn-host-generated';
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-3',
      method: 'turn.start',
      params: {
        sessionId: 'sess-turn-id',
        streamId,
        turnId: hostTurnId,
        input: [{ type: 'text', text: 'ping' }],
        config: {},
      },
    });

    const notifications: Array<{
      method: string;
      jsonrpc?: string;
      params?: { turnId?: string; sourceTurnId?: string };
    }> = [];
    let sawTurnStartResult = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        proxy.next(),
        new Promise(resolve => setTimeout(() => resolve('__timeout__'), 2_000)),
      ]);
      if (next === '__timeout__') break;
      const message = next as {
        id?: string;
        jsonrpc?: string;
        method?: string;
        params?: { turnId?: string; sourceTurnId?: string };
        error?: unknown;
      };
      if (message.method !== undefined) {
        if (message.method === 'turn.started') {
          assert.equal(sawTurnStartResult, true, 'turn.started arrived before turn.start Response');
        }
        notifications.push(message as {
          method: string;
          jsonrpc?: string;
          params?: { turnId?: string; sourceTurnId?: string };
        });
        assert.equal(message.jsonrpc, '2.0');
        if (message.params?.turnId !== undefined) {
          assert.equal(
            message.params.turnId,
            hostTurnId,
            'notification ' + message.method + ' used a non-Host turn id',
          );
          assert.equal(message.params.sourceTurnId, hostTurnId);
        }
        if (message.method === 'turn.completed' || message.method === 'turn.failed') break;
      } else if (message.id === 'req-3') {
        assert.equal(message.error, undefined, JSON.stringify(message));
        sawTurnStartResult = true;
      }
    }
    assert.ok(
      notifications.some(notification => notification.method === 'turn.started'),
      'expected turn.started',
    );
    assert.ok(
      notifications.some(notification => notification.method === 'turn.completed'),
      'expected turn.completed, saw: ' + notifications.map(notification => notification.method).join(','),
    );
  } finally {
    proxy.child.kill();
    await waitForExit(proxy.child);
  }
});

test('Grok CLI lists native sessions and rejects session-bound turn config', async () => {
  const proxy = startV2Proxy();
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.1'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    await proxy.next();
    proxy.send({ jsonrpc: '2.0', id: 'req-2', method: 'catalog.list', params: {} });
    await proxy.nextResult('req-2');
    proxy.send({ jsonrpc: '2.0', id: 'req-3', method: 'session.native.list', params: {} });
    const listed = await proxy.nextResult('req-3') as {
      result?: { sessions?: Array<{ id?: string }> };
      error?: unknown;
    };
    assert.equal(listed.error, undefined, JSON.stringify(listed));
    assert.equal(listed.result?.sessions?.[0]?.id, 'native-existing');

    proxy.send({
      jsonrpc: '2.0',
      id: 'req-4',
      method: 'session.create',
      params: {
        sessionId: 'sess-bind',
        workspace: { cwd: process.cwd(), roots: [process.cwd()] },
        config: {},
      },
    });
    const created = await proxy.nextResult('req-4') as {
      result?: { session?: { streamId?: string } };
      error?: unknown;
    };
    assert.equal(created.error, undefined, JSON.stringify(created));
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-5',
      method: 'turn.start',
      params: {
        sessionId: 'sess-bind',
        streamId: created.result?.session?.streamId,
        turnId: 'turn-bind',
        input: [{ type: 'text', text: 'ping' }],
        config: { model: 'grok-4.6' },
      },
    });
    const rejected = proxyErrorResponseSchema.parse(await proxy.nextResult('req-5'));
    assert.equal(rejected.error.code, -32000);
    assert.equal((rejected.error.data as { domainCode?: string }).domainCode, 'CONFIG_BINDING_INVALID');
    proxy.send({ jsonrpc: '2.0', id: 'req-6', method: 'session.native.delete', params: {
      nativeSessionId: 'native-existing',
    } });
    const deleted = await proxy.nextResult('req-6') as { result?: { ok?: boolean }; error?: unknown };
    assert.equal(deleted.error, undefined, JSON.stringify(deleted));
    assert.equal(deleted.result?.ok, true);
  } finally {
    proxy.child.kill();
    await waitForExit(proxy.child);
  }
});
