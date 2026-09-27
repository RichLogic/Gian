import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import test from 'node:test';

import {
  HostProtocolValidator,
  signNativeSessionHostBinding,
  proxyErrorResponseSchema,
  type ProxyNotification,
} from '@gian/proxy-protocol';

interface WireResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: unknown;
}

interface WireNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

type WireMessage = WireResponse | WireNotification;

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

function startProxy(script = 'success'): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      resolve('dist/src/cli/spawn.js'),
      `--bridge=${process.execPath}`,
      resolve('test/fixtures/fake-dsh-bridge.mjs'),
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_FAKE_SCRIPT: script,
        GIAN_HOST_BINDING_KEY: 'stdio-binding-test-key',
      },
    },
  );
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

test('DSH self-test reports the package version without starting a Runtime', () => {
  const result = JSON.parse(execFileSync(process.execPath, [resolve('dist/src/cli/spawn.js'), '--self-test'], {
    encoding: 'utf8', timeout: 5000,
  }));
  assert.equal(result.pluginVersion, PLUGIN_VERSION);
  assert.equal(result.id, 'ai.deepseek.harness');
  assert.equal(result.ok, true);
});

class MockGianCore {
  readonly child: ChildProcessWithoutNullStreams;
  readonly validator = new HostProtocolValidator({
    pluginId: 'ai.deepseek.harness',
    pluginVersion: PLUGIN_VERSION,
    processScope: 'shared',
  });
  readonly notifications: ProxyNotification[] = [];
  readonly rawLines: string[] = [];
  readonly stderr: string[] = [];
  private requestCounter = 0;
  private protocolFailure: unknown = null;
  private readonly responseWaiters = new Map<
    string,
    { resolve: (value: WireResponse) => void; reject: (error: unknown) => void }
  >();
  private readonly notificationWaiters: Array<{
    method: string;
    predicate: (notification: ProxyNotification) => boolean;
    resolve: (notification: ProxyNotification) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(script = 'success') {
    this.child = startProxy(script);
    this.child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')));
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      this.rawLines.push(line);
      let raw: WireMessage;
      try {
        raw = JSON.parse(line) as WireMessage;
      } catch (error) {
        this.failProtocol(error);
        return;
      }

      let accepted: ReturnType<HostProtocolValidator['acceptLine']>;
      try {
        accepted = this.validator.acceptLine(line);
      } catch (error) {
        if ('id' in raw && typeof raw.id === 'string') {
          const waiter = this.responseWaiters.get(raw.id);
          this.responseWaiters.delete(raw.id);
          waiter?.reject(error);
        }
        this.failProtocol(error);
        return;
      }

      if ('id' in raw && typeof raw.id === 'string') {
        const waiter = this.responseWaiters.get(raw.id);
        this.responseWaiters.delete(raw.id);
        if (!waiter) {
          this.failProtocol(new Error(`unexpected DSH Proxy response ${raw.id}`));
          return;
        }
        waiter.resolve(raw);
        return;
      }

      if (accepted && 'method' in accepted) {
        this.notifications.push(accepted);
        for (let index = 0; index < this.notificationWaiters.length; index += 1) {
          const waiter = this.notificationWaiters[index];
          if (waiter && waiter.method === accepted.method && waiter.predicate(accepted)) {
            this.notificationWaiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(accepted);
            break;
          }
        }
      }
    });
    this.child.once('error', (error) => this.failProtocol(error));
    this.child.once('exit', (code, signal) => {
      if (this.responseWaiters.size === 0 && this.notificationWaiters.length === 0) return;
      this.failProtocol(new Error(`DSH Proxy exited early (code=${code}, signal=${signal}).`));
    });
  }

  async request(method: string, params: Record<string, unknown>): Promise<WireResponse> {
    if (this.protocolFailure) throw this.protocolFailure;
    this.requestCounter += 1;
    const id = `mock-core-${this.requestCounter}`;
    const request = { jsonrpc: '2.0' as const, id, method, params };
    this.validator.registerRequest(request);
    const response = new Promise<WireResponse>((resolveResponse, reject) => {
      this.responseWaiters.set(id, { resolve: resolveResponse, reject });
    });
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    return response;
  }

  waitForNotification(
    method: string,
    predicate: (notification: ProxyNotification) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<ProxyNotification> {
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    const existing = this.notifications.find(
      (notification) => notification.method === method && predicate(notification),
    );
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveNotification, reject) => {
      const timer = setTimeout(() => {
        const index = this.notificationWaiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.notificationWaiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${method}; stderr=${this.stderr.join('')}`));
      }, timeoutMs);
      this.notificationWaiters.push({
        method,
        predicate,
        resolve: resolveNotification,
        reject,
        timer,
      });
    });
  }

  assertCleanWire(): void {
    if (this.protocolFailure) throw this.protocolFailure;
    assert.equal(this.stderr.join(''), '', 'DSH Proxy/Bridge wrote unexpected stderr');
    assert.equal(
      this.rawLines.some((line) => line.trim() === ''),
      false,
      'DSH Proxy emitted a blank stdout line',
    );
    assert.equal(
      this.rawLines.some((line) => /\u001b\[[0-?]*[ -\/]*[@-~]/u.test(line)),
      false,
      'DSH Proxy stdout contained ANSI control sequences',
    );
  }

  private failProtocol(error: unknown): void {
    if (this.protocolFailure === null) this.protocolFailure = error;
    for (const waiter of this.responseWaiters.values()) waiter.reject(error);
    this.responseWaiters.clear();
    for (const waiter of this.notificationWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

async function initialize(core: MockGianCore): Promise<void> {
  const response = await core.request('initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Mock Gian Core', version: '0.5.0', locale: 'zh-CN' },
  });
  assert.ok(response.result);
  assert.equal(core.validator.initializeResult?.protocol.version, '2.1');
}

async function createSession(
  core: MockGianCore,
  sessionId: string,
): Promise<{ streamId: string }> {
  const created = await core.request('session.create', {
    sessionId,
    workspace: { cwd: '/tmp/gian-dsh-contract', roots: ['/tmp/gian-dsh-contract'] },
    config: {},
  });
  return (created.result as { session: { streamId: string } }).session;
}

test('Mock Gian Core validates the real DSH Proxy stdio lifecycle', async (t) => {
  const core = new MockGianCore();
  t.after(() => {
    if (core.child.exitCode === null) core.child.kill('SIGKILL');
  });

  await initialize(core);
  const catalog = await core.request('catalog.list', {});
  assert.ok(catalog.result);
  const catalogRevision = (catalog.result as { catalogRevision: string }).catalogRevision;
  const resolved = await core.request('catalog.resolve', {
    catalogRevision,
    sessionConfig: {},
    turnConfig: { model: 'deepseek-chat' },
  });
  assert.ok(resolved.result);

  const session = await createSession(core, 'dsh-contract-session');
  const snapshot = await core.request('session.get', {
    sessionId: 'dsh-contract-session',
  });
  assert.equal(
    (snapshot.result as { session: { streamId: string } }).session.streamId,
    session.streamId,
  );

  const started = await core.request('turn.start', {
    sessionId: 'dsh-contract-session',
    streamId: session.streamId,
    turnId: 'dsh-contract-turn',
    input: [{ type: 'text', text: 'hello' }],
    config: { model: 'deepseek-chat' },
  });
  assert.deepEqual(started.result, { accepted: true, turnId: 'dsh-contract-turn' });
  await core.waitForNotification(
    'turn.completed',
    (notification) => 'turnId' in notification.params
      && notification.params.turnId === 'dsh-contract-turn',
  );

  const methods = new Set(core.notifications.map((notification) => notification.method));
  const expectedMethods: Array<ProxyNotification['method']> = [
    'session.updated',
    'turn.started',
    'step.updated',
    'request.updated',
    'content.delta',
    'content.completed',
    'usage.updated',
    'turn.completed',
  ];
  for (const method of expectedMethods) {
    assert.ok(methods.has(method), `expected ${method}; saw ${[...methods].join(', ')}`);
  }

  await core.request('session.close', {
    sessionId: 'dsh-contract-session',
    streamId: session.streamId,
  });
  await core.request('shutdown', {});
  assert.equal(await waitForExit(core.child), 0);
  core.assertCleanWire();
});

test('Mock Gian Core validates DSH replay response schema on the real stdio boundary', async (t) => {
  const core = new MockGianCore('success-no-claim');
  t.after(() => {
    if (core.child.exitCode === null) core.child.kill('SIGKILL');
  });

  await initialize(core);
  await core.request('catalog.list', {});
  const session = await createSession(core, 'dsh-replay-session');
  await core.request('turn.start', {
    sessionId: 'dsh-replay-session',
    streamId: session.streamId,
    turnId: 'dsh-replay-turn',
    input: [{ type: 'text', text: 'replay me' }],
    config: { model: 'deepseek-chat' },
  });
  await core.waitForNotification(
    'turn.completed',
    (notification) => 'turnId' in notification.params
      && notification.params.turnId === 'dsh-replay-turn',
  );
  const replay = await core.request('session.replay', {
    sessionId: 'dsh-replay-session',
    streamId: session.streamId,
    cursor: null,
    limit: 100,
  });
  assert.ok(replay.result);

  await core.request('session.close', {
    sessionId: 'dsh-replay-session',
    streamId: session.streamId,
  });
  await core.request('shutdown', {});
  assert.equal(await waitForExit(core.child), 0);
  core.assertCleanWire();
});

test('Mock Gian Core validates the DSH approval interaction round trip', async (t) => {
  const core = new MockGianCore('approval');
  t.after(() => {
    if (core.child.exitCode === null) core.child.kill('SIGKILL');
  });

  await initialize(core);
  await core.request('catalog.list', {});
  const session = await createSession(core, 'dsh-approval-session');
  await core.request('turn.start', {
    sessionId: 'dsh-approval-session',
    streamId: session.streamId,
    turnId: 'dsh-approval-turn',
    input: [{ type: 'text', text: 'run tests' }],
    config: { model: 'deepseek-chat', permission_preset: 'workspace-write' },
  });
  const requested = await core.waitForNotification(
    'interaction.requested',
    notification => 'turnId' in notification.params
      && notification.params.turnId === 'dsh-approval-turn',
  );
  const data = requested.params.data as { interactionId: string };
  const responded = await core.request('interaction.respond', {
    responseId: 'dsh-approval-response',
    sessionId: 'dsh-approval-session',
    streamId: session.streamId,
    turnId: 'dsh-approval-turn',
    interactionId: data.interactionId,
    actionId: 'allow-once',
    values: {},
  });
  assert.ok(responded.result);
  await core.waitForNotification(
    'turn.completed',
    notification => 'turnId' in notification.params
      && notification.params.turnId === 'dsh-approval-turn',
  );
  await core.request('session.close', {
    sessionId: 'dsh-approval-session',
    streamId: session.streamId,
  });
  await core.request('shutdown', {});
  assert.equal(await waitForExit(core.child), 0);
  core.assertCleanWire();
});

test('DSH Proxy returns standard JSON-RPC errors on its real stdio boundary', async (t) => {
  const child = startProxy();
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const value = JSON.parse(line) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else messages.push(value);
  });
  const next = (): Promise<unknown> => {
    const value = messages.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolveMessage) => waiters.push(resolveMessage));
  };

  child.stdin.write('{not-json\n');
  const parseError = proxyErrorResponseSchema.parse(await next());
  assert.equal(parseError.id, null);
  assert.equal(parseError.error.code, -32700);
  assert.equal(parseError.error.data, undefined);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.1'] },
      host: { name: 'Mock Gian Core', version: '0.5.0' },
    },
  })}\n`);
  const initialized = await next() as { id?: string; result?: unknown };
  assert.equal(initialized.id, 'initialize');
  assert.ok(initialized.result);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'unknown-method',
    method: 'does.not.exist',
    params: {},
  })}\n`);
  const unknown = proxyErrorResponseSchema.parse(await next());
  assert.equal(unknown.id, 'unknown-method');
  assert.equal(unknown.error.code, -32601);
  assert.equal(unknown.error.data, undefined);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'shutdown',
    method: 'shutdown',
    params: {},
  })}\n`);
  await next();
  assert.equal(await waitForExit(child), 0);
});


test('same DSH session completes two stdio Turns across authenticated native reattach', async (t) => {
  const core = new MockGianCore();
  t.after(() => { if (core.child.exitCode === null) core.child.kill('SIGKILL'); });
  await initialize(core);
  await core.request('catalog.list', {});
  const sessionId = 'dsh-follow-up';
  const session = await createSession(core, sessionId);
  for (const turnId of ['first-turn', 'second-turn']) {
    const started = await core.request('turn.start', {
      sessionId, streamId: session.streamId, turnId,
      input: [{ type: 'text', text: turnId }], config: { model: 'deepseek-chat' },
    });
    assert.equal(started.error, undefined);
    await core.waitForNotification('turn.completed', n => 'turnId' in n.params && n.params.turnId === turnId);
    const reattached = await core.request('session.create', {
      sessionId, workspace: { cwd: '/tmp/gian-dsh-contract', roots: ['/tmp/gian-dsh-contract'] }, config: {},
      nativeSession: {
        id: 'native-1', history: 'none',
        hostBindingProof: signNativeSessionHostBinding('stdio-binding-test-key', {
          pluginId: 'ai.deepseek.harness', sessionId, nativeSessionId: 'native-1', cwd: '/tmp/gian-dsh-contract',
        }),
      },
    });
    assert.equal(reattached.error, undefined);
    assert.equal((reattached.result as { session: { streamId: string } }).session.streamId, session.streamId);
  }
  assert.equal(core.notifications.filter(n => n.method === 'turn.completed').length, 2);
  assert.equal(core.notifications.filter(n => n.method === 'turn.failed').length, 0);
  await core.request('session.close', { sessionId, streamId: session.streamId });
  await core.request('shutdown', {});
  assert.equal(await waitForExit(core.child), 0);
  core.assertCleanWire();
});

test('Mock Gian Core drives the Side Chat lifecycle with a wire-verified close barrier', async (t) => {
  const core = new MockGianCore();
  t.after(() => { if (core.child.exitCode === null) core.child.kill('SIGKILL'); });
  await initialize(core);
  await core.request('catalog.list', {});
  const sessionId = 'dsh-sidechat-parent';
  const parent = await createSession(core, sessionId);

  const parentTurn = await core.request('turn.start', {
    sessionId, streamId: parent.streamId, turnId: 'parent-turn',
    input: [{ type: 'text', text: 'parent work' }], config: { model: 'deepseek-chat' },
  });
  assert.equal(parentTurn.error, undefined);
  await core.waitForNotification('turn.completed', n => 'turnId' in n.params && n.params.turnId === 'parent-turn');

  // The parent snapshot gates the action only while the parent is idle and a
  // terminal turn (or empty history) exists.
  const snapshot = await core.request('session.get', { sessionId });
  const available = (snapshot.result as { session: { availableActions: Record<string, { enabled: boolean }> } })
    .session.availableActions;
  assert.equal(available['sidechat.create']?.enabled, true);

  const created = await core.request('sidechat.create', {
    parentSessionId: sessionId,
    parentStreamId: parent.streamId,
    sidechatId: 'dsh-sidechat-1',
  });
  assert.equal(created.error, undefined);
  const sidechat = (created.result as {
    sidechat: {
      id: string;
      parentSessionId: string;
      streamId: string;
      resumeRef: { id: string };
      anchor: { type: string; turnId?: string; sourceTurnId?: string };
    };
  }).sidechat;
  assert.equal(sidechat.id, 'dsh-sidechat-1');
  assert.equal(sidechat.parentSessionId, sessionId);
  assert.notEqual(sidechat.streamId, parent.streamId);
  assert.ok(sidechat.resumeRef.id.length > 0);
  assert.deepEqual(sidechat.anchor, { type: 'turn', turnId: 'parent-turn', sourceTurnId: 'native-1:turn:0' });
  // The Side Chat route turns through the standard envelope.
  const sideTurn = await core.request('turn.start', {
    sessionId: sidechat.id, streamId: sidechat.streamId, turnId: 'side-turn',
    input: [{ type: 'text', text: 'parallel question' }], config: { model: 'deepseek-chat' },
  });
  assert.equal(sideTurn.error, undefined);

  // Closing the running Side Chat must converge before the Success and the
  // wire order must put the teardown events BEFORE the close response.
  const closed = await core.request('sidechat.close', {
    sidechatId: sidechat.id,
    streamId: sidechat.streamId,
    resumeRef: sidechat.resumeRef,
  });
  assert.deepEqual(closed.result, { ok: true, sidechatId: sidechat.id, providerDataDeleted: false });

  const parsed = core.rawLines.map(line => JSON.parse(line) as WireMessage);
  const barrierResponseIndex = findCloseResponseIndex(parsed, sidechat.id);
  assert.ok(barrierResponseIndex >= 0, 'close response must be on the wire');
  const sideCompletedIndex = parsed.findIndex(line => 'method' in line
    && line.method === 'turn.completed'
    && (line.params as { sessionId?: unknown }).sessionId === sidechat.id);
  assert.ok(sideCompletedIndex >= 0, 'sidechat terminal turn event must be on the wire');
  assert.ok(sideCompletedIndex < barrierResponseIndex, 'sidechat events must precede the close Success');

  // After the Success no notification may reference the closed Side Chat.
  const afterClose = parsed.slice(barrierResponseIndex + 1)
    .filter(line => 'method' in line && (line.params as { sessionId?: unknown }).sessionId === sidechat.id);
  assert.equal(afterClose.length, 0, `closed sidechat emitted ${afterClose.map(l => JSON.stringify(l)).join(', ')}`);

  await core.request('session.close', { sessionId, streamId: parent.streamId });
  await core.request('shutdown', {});
  assert.equal(await waitForExit(core.child), 0);
  core.assertCleanWire();
});

function findCloseResponseIndex(lines: WireMessage[], sidechatId: string): number {
  return lines.findIndex(line => !('method' in line)
    && line.result !== null && typeof line.result === 'object'
    && (line.result as { ok?: unknown }).ok === true
    && (line.result as { sidechatId?: unknown }).sidechatId === sidechatId);
}

test('closing a Side Chat with a running turn tears down before the Success response', async (t) => {
  // The approval script parks the sidechat turn on a pending interaction, so
  // the close barrier must interrupt it, settle the interaction, and emit the
  // terminal turn event BEFORE the close Success hits the wire.
  const core = new MockGianCore('approval');
  t.after(() => { if (core.child.exitCode === null) core.child.kill('SIGKILL'); });
  await initialize(core);
  await core.request('catalog.list', {});
  const sessionId = 'dsh-sidechat-teardown';
  const parent = await createSession(core, sessionId);

  const created = await core.request('sidechat.create', {
    parentSessionId: sessionId,
    parentStreamId: parent.streamId,
    sidechatId: 'dsh-sidechat-live',
  });
  assert.equal(created.error, undefined);
  const sidechat = (created.result as {
    sidechat: { id: string; streamId: string; resumeRef: { id: string }; anchor: { type: string } };
  }).sidechat;
  assert.deepEqual(sidechat.anchor, { type: 'empty' });

  const sideTurn = await core.request('turn.start', {
    sessionId: sidechat.id, streamId: sidechat.streamId, turnId: 'side-live-turn',
    input: [{ type: 'text', text: 'run while closing' }],
    config: { model: 'deepseek-chat', permission_preset: 'workspace-write' },
  });
  assert.equal(sideTurn.error, undefined);
  const requested = await core.waitForNotification('interaction.requested');
  assert.equal((requested.params as { sessionId?: unknown }).sessionId, sidechat.id);

  const closed = await core.request('sidechat.close', {
    sidechatId: sidechat.id,
    streamId: sidechat.streamId,
    resumeRef: sidechat.resumeRef,
  });
  assert.deepEqual(closed.result, { ok: true, sidechatId: sidechat.id, providerDataDeleted: false });

  const parsed = core.rawLines.map(line => JSON.parse(line) as WireMessage);
  const barrierResponseIndex = findCloseResponseIndex(parsed, sidechat.id);
  assert.ok(barrierResponseIndex >= 0, 'close response must be on the wire');
  const before = parsed.slice(0, barrierResponseIndex);
  const terminalTurn = before.find(line => 'method' in line
    && line.method === 'turn.completed'
    && (line.params as { sessionId?: unknown }).sessionId === sidechat.id);
  const settledInteraction = before.find(line => 'method' in line
    && line.method === 'interaction.resolved'
    && (line.params as { sessionId?: unknown }).sessionId === sidechat.id);
  assert.ok(terminalTurn, 'the terminal turn event must precede the close Success');
  const stopReason = ((terminalTurn as WireNotification).params as {
    data?: { stopReason?: string };
  }).data?.stopReason;
  assert.equal(stopReason, 'cancelled');
  assert.ok(settledInteraction, 'the pending interaction must settle before the close Success');

  const afterClose = parsed.slice(barrierResponseIndex + 1)
    .filter(line => 'method' in line && (line.params as { sessionId?: unknown }).sessionId === sidechat.id);
  assert.equal(afterClose.length, 0, 'no notification may follow the close Success');

  await core.request('session.close', { sessionId, streamId: parent.streamId });
  await core.request('shutdown', {});
  assert.equal(await waitForExit(core.child), 0);
  core.assertCleanWire();
});
