import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import {
  HostProtocolValidator,
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
      },
    },
  );
}

class MockGianCore {
  readonly child: ChildProcessWithoutNullStreams;
  readonly validator = new HostProtocolValidator({
    pluginId: 'ai.deepseek.harness',
    pluginVersion: '0.1.1',
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
    protocol: { name: 'gian.proxy', versions: ['2.0'] },
    host: { name: 'Mock Gian Core', version: '0.5.0', locale: 'zh-CN' },
  });
  assert.ok(response.result);
  assert.equal(core.validator.initializeResult?.protocol.version, '2.0');
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

test('Mock Gian Core validates interaction response ordering through DSH Proxy stdio', async (t) => {
  const core = new MockGianCore('question-no-claim');
  t.after(() => {
    if (core.child.exitCode === null) core.child.kill('SIGKILL');
  });

  await initialize(core);
  await core.request('catalog.list', {});
  const session = await createSession(core, 'dsh-question-session');
  await core.request('turn.start', {
    sessionId: 'dsh-question-session',
    streamId: session.streamId,
    turnId: 'dsh-question-turn',
    input: [{ type: 'text', text: 'ask me' }],
    config: { model: 'deepseek-chat' },
  });
  const requested = await core.waitForNotification(
    'interaction.requested',
    (notification) => 'turnId' in notification.params
      && notification.params.turnId === 'dsh-question-turn',
  );
  const data = requested.params.data as {
    interactionId: string;
    actions: Array<{ id: string }>;
  };
  assert.deepEqual(data.actions.map((action) => action.id), ['submit']);

  const response = await core.request('interaction.respond', {
    responseId: 'dsh-question-response',
    sessionId: 'dsh-question-session',
    streamId: session.streamId,
    turnId: 'dsh-question-turn',
    interactionId: data.interactionId,
    actionId: 'submit',
    values: { file: 'a' },
  });
  assert.deepEqual(response.result, {
    accepted: true,
    interactionId: data.interactionId,
    responseId: 'dsh-question-response',
  });
  await core.waitForNotification(
    'interaction.resolved',
    (notification) => (
      notification.params.data as { interactionId?: string }
    ).interactionId === data.interactionId,
  );
  await core.waitForNotification(
    'turn.completed',
    (notification) => 'turnId' in notification.params
      && notification.params.turnId === 'dsh-question-turn',
  );

  await core.request('session.close', {
    sessionId: 'dsh-question-session',
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
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
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
