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

function startV1Proxy(environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: 'grok',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-grok-v1-test',
      GIAN_RUNTIME_BIN: resolve('test/fixtures/fake-grok-cli.mjs'),
      GIAN_PROTOCOL_VERSIONS: '1.0',
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

test('Grok CLI negotiates gian.proxy/1 independently from its ACP runtime version', async () => {
  const proxy = startV1Proxy();
  proxy.send({
    id: 1,
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['1.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  try {
    const initialized = await proxy.next() as { id: number; result?: unknown; error?: unknown };
    assert.equal(initialized.id, 1);
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    const result = initializeResultSchema.parse(initialized.result);
    assert.equal(result.protocol.version, '1.0');
    assert.equal(result.plugin.id, 'grok');
    assert.equal(result.process.scope, 'session');
    assert.equal(result.capabilities['session.nativeDelete'], 1);

    proxy.send({ id: 2, method: 'does.not.exist', params: {} });
    assert.equal(proxyErrorResponseSchema.parse(await proxy.next()).error.code, 'METHOD_NOT_FOUND');
  } finally {
    proxy.child.kill();
    await waitForExit(proxy.child);
  }
});

test('Grok gian.proxy/1 CLI treats malformed NDJSON as a fatal protocol failure', async () => {
  const proxy = startV1Proxy();
  proxy.sendRaw('{not-json');
  assert.notEqual(await waitForExit(proxy.child), 0);
});

test('Grok CLI speaks gian.proxy/1 even when GIAN_PROTOCOL_VERSIONS is omitted', async () => {
  const child = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: 'grok',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-grok-v1-default-test',
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
    id: 1,
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['1.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  })}\n`);
  const initialized = await next() as { id: number; result: unknown };
  assert.equal(initialized.id, 1);
  assert.equal(initializeResultSchema.parse(initialized.result).protocol.version, '1.0');
  child.stdin.write(`${JSON.stringify({ id: 2, method: 'shutdown', params: {} })}\n`);
  assert.deepEqual(await next(), { id: 2, result: { ok: true } });
  assert.equal(await waitForExit(child), 0);
});

test('Grok runtime uses the locked ACP command and forces the workspace sandbox', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-grok-spawn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recordPath = join(root, 'spawn.json');
  const proxy = startV1Proxy({
    GROK_SANDBOX: 'off',
    GROK_TEST_SPAWN_RECORD: recordPath,
  });
  proxy.send({
    id: 1,
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['1.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  await proxy.next();
  proxy.send({ id: 2, method: 'catalog.list', params: {} });
  const catalog = await proxy.next() as { result?: { modes?: Array<{ id: string; workspace: string }> } };
  assert.deepEqual(catalog.result?.modes?.map(mode => mode.id), ['default', 'auto', 'always_approve']);
  assert.equal(catalog.result?.modes?.every(mode => mode.workspace === 'workspace-write'), true);
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
  proxy.send({ id: 3, method: 'shutdown', params: {} });
  assert.deepEqual(await proxy.next(), { id: 3, result: { ok: true } });
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Grok turn notifications all carry the Host turn id', async () => {
  const proxy = startV1Proxy();
  try {
    proxy.send({
      id: 1,
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['1.0'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    const initialized = await proxy.next() as { id: number; error?: unknown };
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));

    proxy.send({
      id: 2,
      method: 'session.create',
      params: {
        sessionId: 'sess-turn-id',
        cwd: process.cwd(),
        workspaceRoots: [process.cwd()],
        mode: 'auto',
        config: {},
      },
    });
    const created = await proxy.next() as {
      id: number;
      result?: { session?: { streamId?: string } };
      error?: unknown;
    };
    assert.equal(created.error, undefined, JSON.stringify(created));
    const streamId = created.result?.session?.streamId;
    assert.ok(streamId, 'session.create must return a stream id');

    const hostTurnId = 'turn-host-generated';
    proxy.send({
      id: 3,
      method: 'turn.start',
      params: {
        sessionId: 'sess-turn-id',
        streamId,
        turnId: hostTurnId,
        input: [{ type: 'text', text: 'ping' }],
        policy: { workspaceRoots: [process.cwd()], approval: 'auto', network: 'allow' },
        config: { mode: 'auto', native: {} },
      },
    });

    // The Grok service mints its own internal turn id; the adapter must map it
    // back to the Host turn id on every turn-scoped notification, or the Host
    // rejects the stream with "references inactive turn".
    const notifications: Array<{ method: string; params?: { turnId?: string } }> = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        proxy.next(),
        new Promise(resolve => setTimeout(() => resolve('__timeout__'), 2_000)),
      ]);
      if (next === '__timeout__') break;
      const message = next as {
        id?: number;
        method?: string;
        params?: { turnId?: string };
        error?: unknown;
      };
      if (message.method !== undefined) {
        notifications.push(message as { method: string; params?: { turnId?: string } });
        if (message.params?.turnId !== undefined) {
          assert.equal(
            message.params.turnId,
            hostTurnId,
            'notification ' + message.method + ' used a non-Host turn id',
          );
        }
        if (message.method === 'turn.completed' || message.method === 'turn.failed') break;
      } else if (message.id === 3) {
        assert.equal(message.error, undefined, JSON.stringify(message));
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
