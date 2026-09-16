import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

test('Claude CLI negotiates gian.proxy/2.1 independently from its runtime version', async (t) => {
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
  assert.equal(result.plugin.id, 'claude');
  assert.equal(result.plugin.version, PLUGIN_VERSION);
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
  assert.equal(result.capabilities['integration.mcp.streamableHttp'], 1);

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

test('Claude CLI speaks gian.proxy/2.1 even when GIAN_PROTOCOL_VERSIONS is omitted', async () => {
  const proxy = startV2Proxy({ GIAN_PROTOCOL_VERSIONS: undefined });
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
  assert.equal(initializeResultSchema.parse(initialized.result).protocol.version, '2.1');
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
        protocol: { name: 'gian.proxy', versions: ['2.1'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    const initialized = await proxy.next() as { id: string; result: unknown };
    assert.equal(initialized.id, 'req-1');
    assert.equal(initializeResultSchema.parse(initialized.result).protocol.version, '2.1');

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

test('a slow rule scan never queues the remaining kinds behind it on the Claude inspection process', async () => {
  const proxy = startV2Proxy();
  const ws = makeDeepTree('gian-cc-scan-isolation-');
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.3', '2.1'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    const initialized = await proxy.next() as { id: string; result: unknown };
    assert.equal(initialized.id, 'req-1');
    assert.equal(initializeResultSchema.parse(initialized.result).protocol.version, '2.3');

    proxy.send({ jsonrpc: '2.0', id: 'rule', method: 'customization.list', params: { kind: 'rule', cwd: ws } });
    // The fast kind is sent second but must be answered first: kinds are
    // pipelined, so the slow kind cannot queue this request past its own
    // bound (which would push it into the Host per-request timeout).
    proxy.send({ jsonrpc: '2.0', id: 'skill', method: 'customization.list', params: { kind: 'skill' } });
    const first = await proxy.next() as { id?: string };
    assert.equal(first.id, 'skill', `fast kind must not be queued behind the slow one, got ${JSON.stringify(first).slice(0, 200)}`);
    const second = await proxy.next() as { id?: string };
    assert.equal(second.id, 'rule', 'slow kind must still answer');

    proxy.send({ jsonrpc: '2.0', id: 'req-4', method: 'shutdown', params: {} });
    await proxy.next();
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
  }
});

test('EOF while a rule scan is in flight still delivers the scan Response before exit', async () => {
  const proxy = startV2Proxy();
  const ws = makeDeepTree('gian-cc-eof-scan-');
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.3', '2.1'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    await proxy.next();
    proxy.send({ jsonrpc: '2.0', id: 'scan', method: 'customization.list', params: { kind: 'rule', cwd: ws } });
    proxy.child.stdin.end();
    const scan = await Promise.race([
      proxy.next(),
      new Promise<unknown>(resolve => setTimeout(() => resolve(null), 10_000)),
    ]) as { id?: string } | null;
    assert.ok(scan && scan.id === 'scan', 'scan Response was orphaned by EOF');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
  }
});

test('two overlapping normal requests are strictly serialized: the second starts only after the first ends', async () => {
  const fakeRuntime = resolve('test/fixtures/fake-claude-runtime.mjs');
  // The fake delays the capability probe ONLY, so the first catalog.list
  // (cold catalog → runtime probe) stays open for 400ms while the
  // does.not.exist sent right after it deliberately overlaps: with
  // normal-request serialization restored, the fast request must not start
  // until the catalog probe has fully ended.
  const proxy = startV2Proxy({ GIAN_RUNTIME_BIN: fakeRuntime, FAKE_CLAUDE_HELP_DELAY_MS: '400' });
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
    const initialized = await proxy.next() as { id: string; result: unknown };
    assert.equal(initialized.id, 'req-1');
    assert.equal(initializeResultSchema.parse(initialized.result).protocol.version, '2.1');

    proxy.send({ jsonrpc: '2.0', id: 'req-catalog', method: 'catalog.list', params: {} });
    // Second normal request arrives while the first is still in flight; it
    // is answered synchronously and needs no session.
    proxy.send({ jsonrpc: '2.0', id: 'req-unknown', method: 'does.not.exist', params: {} });

    const order: string[] = [];
    let gotCatalog = false;
    let gotUnknown = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const message = await proxy.next() as { id?: string };
      if (message.id === 'req-catalog') {
        gotCatalog = true;
        order.push('catalog-response');
        continue;
      }
      if (message.id === 'req-unknown') {
        gotUnknown = true;
        order.push('unknown-response');
        break;
      }
    }
    assert.equal(gotCatalog, true, 'catalog.list response missing');
    assert.equal(gotUnknown, true, 'does.not.exist response missing');
    // The second normal request must only start after the first has fully
    // ended: its Response cannot arrive inside the catalog probe window.
    assert.ok(order.indexOf('unknown-response') > order.indexOf('catalog-response'),
      `does.not.exist must not overlap the catalog probe: ${order.join(',')}`);

    // Response-before-Notification and notification completeness are
    // unchanged under serialization: a turn's deferred notifications still
    // arrive only AFTER the turn Response.
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-create',
      method: 'session.create',
      params: {
        sessionId: 'serial-session',
        workspace: { cwd: '/tmp', roots: ['/tmp'] },
        config: {},
      },
    });
    const created = await proxy.next() as { id: string; result: { session: { streamId: string } } };
    assert.equal(created.id, 'req-create');
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-turn',
      method: 'turn.start',
      params: {
        sessionId: 'serial-session',
        streamId: created.result.session.streamId,
        turnId: 'serial-turn',
        input: [{ type: 'text', text: 'serialize me' }],
        config: {},
      },
    });
    const turnOrder: string[] = [];
    let gotTurnResponse = false;
    let gotStarted = false;
    const turnDeadline = Date.now() + 10_000;
    while (Date.now() < turnDeadline) {
      const message = await proxy.next() as { id?: string; method?: string };
      if (message.id === 'req-turn') {
        gotTurnResponse = true;
        turnOrder.push('turn-response');
        continue;
      }
      if (message.method === 'turn.started') {
        gotStarted = true;
        turnOrder.push('notif:turn.started');
        break;
      }
    }
    assert.equal(gotTurnResponse, true, 'turn response missing');
    assert.equal(gotStarted, true, 'turn.started missing');
    assert.ok(turnOrder.indexOf('notif:turn.started') > turnOrder.indexOf('turn-response'),
      `turn.started leaked before the turn Response: ${turnOrder.join(',')}`);
  } finally {
    if (proxy.child.exitCode === null && proxy.child.signalCode === null) {
      proxy.child.kill('SIGTERM');
    }
  }
});

test('a shutdown request never orphans an in-flight scan on the Claude inspection process', async () => {
  const proxy = startV2Proxy();
  const ws = makeDeepTree('gian-cc-shutdown-scan-');
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.3', '2.1'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    await proxy.next();
    proxy.send({ jsonrpc: '2.0', id: 'scan', method: 'customization.list', params: { kind: 'rule', cwd: ws } });
    proxy.send({ jsonrpc: '2.0', id: 'bye', method: 'shutdown', params: {} });
    const ids = new Set<string>();
    for (let i = 0; i < 2; i += 1) {
      const message = await Promise.race([
        proxy.next(),
        new Promise<unknown>(resolve => setTimeout(() => resolve(null), 10_000)),
      ]) as { id?: string } | null;
      if (message?.id) ids.add(message.id);
    }
    assert.equal(ids.has('scan'), true, 'scan Response was orphaned by shutdown');
    assert.equal(ids.has('bye'), true, 'shutdown Response missing');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
  }
});
