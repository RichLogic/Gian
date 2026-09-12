import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import test from 'node:test';

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
}

function startV2Proxy(runtimeBin: string, versions: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: 'codex',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-codex-customization-test',
      GIAN_RUNTIME_BIN: runtimeBin,
      GIAN_PROTOCOL_VERSIONS: versions,
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
    next(timeoutMs = 8_000): Promise<unknown> {
      const value = messages.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolveMessage, reject) => {
        const waiter = (message: unknown) => { clearTimeout(timer); resolveMessage(message); };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for Codex Proxy output.'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function responseFor(proxy: ReturnType<typeof startV2Proxy>, id: string) {
  while (true) {
    const message = await proxy.next() as { id?: string };
    if (message.id === id) return message as { id: string; result: unknown };
  }
}

test('real Codex Proxy CLI negotiates 2.3 and serves customization.list over the fake app-server', async () => {
  const fakeRuntime = resolve('dist/test/fixtures/fake-codex-lifecycle-server.js');
  chmodSync(fakeRuntime, 0o755);
  const proxy = startV2Proxy(fakeRuntime, '2.3,2.1');
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
    const initialized = await responseFor(proxy, 'req-1') as {
      result: { protocol: { version: string }; capabilities: Record<string, number> };
    };
    assert.equal(initialized.result.protocol.version, '2.3');
    assert.equal(initialized.result.capabilities['customization.list'], 1);

    proxy.send({ jsonrpc: '2.0', id: 'req-2', method: 'customization.list', params: { kind: 'skill' } });
    const listed = await responseFor(proxy, 'req-2') as { result: {
      kind: string; status: string; completeness: string; items: unknown[]; truncated: boolean;
    } };
    assert.equal(listed.result.kind, 'skill');
    assert.equal(listed.result.status, 'ok');
    assert.equal(listed.result.completeness, 'effective');
    assert.deepEqual(listed.result.items, []);
    assert.equal(listed.result.truncated, false);

    proxy.send({ jsonrpc: '2.0', id: 'req-3', method: 'customization.list', params: { kind: 'hook' } });
    const hooks = await responseFor(proxy, 'req-3') as { result: { status: string; items: unknown[] } };
    assert.equal(hooks.result.status, 'ok');
    assert.deepEqual(hooks.result.items, []);

    proxy.send({ jsonrpc: '2.0', id: 'req-4', method: 'shutdown', params: {} });
    await responseFor(proxy, 'req-4');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
  }
});

test('real Codex Proxy CLI downgrades to 2.1 when 2.3 is not offered', async () => {
  const fakeRuntime = resolve('dist/test/fixtures/fake-codex-lifecycle-server.js');
  chmodSync(fakeRuntime, 0o755);
  const proxy = startV2Proxy(fakeRuntime, '2.1,2.0');
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.1', '2.0'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    const initialized = await responseFor(proxy, 'req-1') as {
      result: { protocol: { version: string }; capabilities: Record<string, number> };
    };
    assert.equal(initialized.result.protocol.version, '2.1');
    assert.equal(initialized.result.capabilities['customization.list'], undefined);
    proxy.send({ jsonrpc: '2.0', id: 'req-2', method: 'shutdown', params: {} });
    await responseFor(proxy, 'req-2');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
  }
});

function makeSlowTree(prefix: string, depthCount = 160): string {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  let dir = ws;
  for (let depth = 0; depth < depthCount; depth += 1) {
    mkdirSync(join(dir, 'd'), { recursive: true });
    dir = join(dir, 'd');
    writeFileSync(join(dir, 'AGENTS.md'), `# deep ${depth}\n`);
  }
  return ws;
}

function initializeV23(proxy: ReturnType<typeof startV2Proxy>, id = 'req-1') {
  proxy.send({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.3', '2.1'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  return responseFor(proxy, id);
}

/** A real-CLI concurrency contract: while a slow scan is in flight, a live
 *  turn's notifications must stay request-scoped — the turn Response
 *  precedes every notification it produced, none are lost or reordered, and
 *  the scan neither blocks nor is blocked by the turn. */
test('a concurrent scan never steals or reorders a live turn notification stream on the shared Codex Host', async () => {
  const fakeRuntime = resolve('dist/test/fixtures/fake-codex-lifecycle-server.js');
  chmodSync(fakeRuntime, 0o755);
  // The fake holds the turn/start response open, so the scan dispatched
  // right after the turn is guaranteed to overlap the turn's notification
  // window (the scan's dispatch starts before the turn's events are sent).
  const proxy = startV2Proxy(fakeRuntime, '2.3,2.1', { GIAN_FAKE_TURN_DELAY_MS: '400' });
  const ws = makeSlowTree('gian-codex-scan-overlap-');
  try {
    await initializeV23(proxy);
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-create',
      method: 'session.create',
      params: {
        sessionId: 'overlap-session',
        workspace: { cwd: '/tmp/fake-codex-workspace', roots: ['/tmp/fake-codex-workspace'] },
        config: {},
      },
    });
    const created = await responseFor(proxy, 'req-create') as {
      result: { session: { streamId: string } };
    };
    // Turn first, scan immediately after: the scan starts while the (delayed)
    // turn is still in flight.
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-turn',
      method: 'turn.start',
      params: {
        sessionId: 'overlap-session',
        streamId: created.result.session.streamId,
        turnId: 'overlap-turn',
        input: [{ type: 'text', text: 'exercise overlap' }],
        config: {},
      },
    });
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-scan',
      method: 'customization.list',
      params: { kind: 'rule', cwd: ws },
    });

    const order: string[] = [];
    const turnNotifications: string[] = [];
    let gotTurnResponse = false;
    const deadline = Date.now() + 10_000;
    const complete = () => gotTurnResponse
      && turnNotifications.includes('interaction.requested')
      && order.includes('scan-response');
    // A scan response may be the final message. Check completion before
    // waiting again, including after either response branch's continue.
    while (Date.now() < deadline && !complete()) {
      const message = await proxy.next(2_000) as {
        id?: string;
        method?: string;
        params?: { sessionId?: string };
      };
      if (message.id === 'req-turn') {
        gotTurnResponse = true;
        order.push('turn-response');
        continue;
      }
      if (message.id === 'req-scan') {
        order.push('scan-response');
        continue;
      }
      if (message.method && message.params?.sessionId === 'overlap-session') {
        turnNotifications.push(message.method);
        order.push(`notif:${message.method}`);
      }
      if (gotTurnResponse && turnNotifications.includes('interaction.requested') && order.includes('scan-response')) break;
    }

    // The scan completed without blocking the turn and vice versa.
    assert.equal(order.includes('scan-response'), true, `scan response missing: ${order.join(',')}`);
    assert.equal(gotTurnResponse, true, 'turn response missing');
    // Response-before-Notification: every turn notification produced by the
    // turn.start handler must arrive AFTER its Response, even with a scan
    // overlapping the notification window.
    const firstTurnNotification = order.findIndex(entry => entry.startsWith('notif:'));
    const turnResponseIndex = order.indexOf('turn-response');
    assert.ok(firstTurnNotification > turnResponseIndex,
      `turn notifications leaked before the turn Response: ${order.join(',')}`);
    // No notification is lost: every during-handle event of the turn stream
    // arrives at least once (the fixture may legitimately repeat activity
    // facts after the response).
    for (const expected of ['turn.started', 'content.delta', 'activity.updated', 'interaction.requested']) {
      assert.ok(turnNotifications.includes(expected),
        `expected ${expected} in turn stream, got ${turnNotifications.join(',')}`);
    }

    proxy.send({ jsonrpc: '2.0', id: 'req-4', method: 'shutdown', params: {} });
    await responseFor(proxy, 'req-4');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a slow rule scan never blocks a normal request on the shared Codex Host', async () => {
  const fakeRuntime = resolve('dist/test/fixtures/fake-codex-lifecycle-server.js');
  chmodSync(fakeRuntime, 0o755);
  const proxy = startV2Proxy(fakeRuntime, '2.3,2.1');
  // A workspace tree large enough that the directory walk takes several
  // macrotask round-trips.
  const ws = mkdtempSync(join(tmpdir(), 'gian-codex-slow-scan-'));
  try {
    let dir = ws;
    for (let depth = 0; depth < 120; depth += 1) {
      mkdirSync(join(dir, 'd'), { recursive: true });
      dir = join(dir, 'd');
      writeFileSync(join(dir, 'AGENTS.md'), `# deep ${depth}\n`);
    }

    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.3', '2.1'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    await responseFor(proxy, 'req-1');

    // Kick off the slow scan, then immediately a normal request.
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'customization.list',
      params: { kind: 'rule', cwd: ws },
    });
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-3',
      method: 'session.get',
      params: { sessionId: 'unknown-session' },
    });

    // The Host must receive the session response BEFORE the scan response
    // (sent second, answered first): the shared process stayed responsive.
    const order: string[] = [];
    while (order.length < 2) {
      const message = await proxy.next() as { id?: string };
      if (typeof message.id === 'string') order.push(message.id);
    }
    assert.equal(order.indexOf('req-3') < order.indexOf('req-2'), true, `response order was ${order.join(',')}`);

    proxy.send({ jsonrpc: '2.0', id: 'req-4', method: 'shutdown', params: {} });
    await responseFor(proxy, 'req-4');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
    rmSync(ws, { recursive: true, force: true });
  }
});

test('EOF while a rule scan is in flight still delivers the scan Response before exit', async () => {
  const fakeRuntime = resolve('dist/test/fixtures/fake-codex-lifecycle-server.js');
  chmodSync(fakeRuntime, 0o755);
  const proxy = startV2Proxy(fakeRuntime, '2.3,2.1');
  const ws = makeSlowTree('gian-codex-eof-scan-', 48);
  try {
    await initializeV23(proxy);
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-scan',
      method: 'customization.list',
      params: { kind: 'rule', cwd: ws },
    });
    // EOF while the scan is in flight.
    proxy.child.stdin.end();
    const scan = await proxy.next(10_000) as { id?: string };
    assert.equal(scan.id, 'req-scan', 'scan Response was orphaned by EOF');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
    rmSync(ws, { recursive: true, force: true });
  }
});

test('two overlapping normal requests are strictly serialized: the second starts only after the first ends', async () => {
  const fakeRuntime = resolve('dist/test/fixtures/fake-codex-lifecycle-server.js');
  chmodSync(fakeRuntime, 0o755);
  // The fake holds turn/start open for 400ms, so the session.get sent right
  // after it deliberately overlaps the turn: with normal-request
  // serialization restored, the fast request must not start until the turn
  // has fully ended (Response + notification flush).
  const proxy = startV2Proxy(fakeRuntime, '2.3,2.1', { GIAN_FAKE_TURN_DELAY_MS: '400' });
  try {
    await initializeV23(proxy);
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-create',
      method: 'session.create',
      params: {
        sessionId: 'serial-session',
        workspace: { cwd: '/tmp/fake-codex-workspace', roots: ['/tmp/fake-codex-workspace'] },
        config: {},
      },
    });
    const created = await responseFor(proxy, 'req-create') as {
      result: { session: { streamId: string } };
    };
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
    // Second normal request arrives while the first is still in flight.
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-get',
      method: 'session.get',
      params: { sessionId: 'serial-session' },
    });

    const order: string[] = [];
    const turnNotifications: string[] = [];
    let gotTurnResponse = false;
    let gotGetResponse = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const message = await proxy.next(2_000) as {
        id?: string;
        method?: string;
        params?: { sessionId?: string };
      };
      if (message.id === 'req-turn') {
        gotTurnResponse = true;
        order.push('turn-response');
        continue;
      }
      if (message.id === 'req-get') {
        gotGetResponse = true;
        order.push('get-response');
        break;
      }
      if (message.method && message.params?.sessionId === 'serial-session') {
        turnNotifications.push(message.method);
        order.push(`notif:${message.method}`);
      }
    }
    assert.equal(gotTurnResponse, true, 'turn response missing');
    assert.equal(gotGetResponse, true, 'session.get response missing');
    // The second normal request must only start after the first has fully
    // ended: its Response comes after the turn Response, never inside the
    // turn's notification window.
    assert.ok(order.indexOf('get-response') > order.indexOf('turn-response'),
      `session.get must not overlap the turn: ${order.join(',')}`);
    // Response-before-Notification and completeness are unchanged.
    const firstTurnNotification = order.findIndex(entry => entry.startsWith('notif:'));
    assert.ok(firstTurnNotification > order.indexOf('turn-response'),
      `turn notifications leaked before the turn Response: ${order.join(',')}`);
    for (const expected of ['turn.started', 'content.delta', 'activity.updated', 'interaction.requested']) {
      assert.ok(turnNotifications.includes(expected),
        `expected ${expected} in turn stream, got ${turnNotifications.join(',')}`);
    }

    proxy.send({ jsonrpc: '2.0', id: 'req-4', method: 'shutdown', params: {} });
    await responseFor(proxy, 'req-4');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
  }
});

test('a shutdown request never orphans an in-flight scan on the shared Codex Host', async () => {
  const fakeRuntime = resolve('dist/test/fixtures/fake-codex-lifecycle-server.js');
  chmodSync(fakeRuntime, 0o755);
  const proxy = startV2Proxy(fakeRuntime, '2.3,2.1');
  const ws = makeSlowTree('gian-codex-shutdown-scan-', 48);
  try {
    await initializeV23(proxy);
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-scan',
      method: 'customization.list',
      params: { kind: 'rule', cwd: ws },
    });
    proxy.send({ jsonrpc: '2.0', id: 'req-shutdown', method: 'shutdown', params: {} });
    const ids = new Set<string>();
    for (let i = 0; i < 2; i += 1) {
      const message = await proxy.next(10_000) as { id?: string };
      if (typeof message.id === 'string') ids.add(message.id);
    }
    assert.equal(ids.has('req-scan'), true, 'scan Response was orphaned by shutdown');
    assert.equal(ids.has('req-shutdown'), true, 'shutdown Response missing');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
    rmSync(ws, { recursive: true, force: true });
  }
});
