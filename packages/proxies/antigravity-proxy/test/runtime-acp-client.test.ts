import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type AuthenticateRequest,
  type Client,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';

import type { RuntimeStopped } from '../src/contracts.js';
import {
  ANTIGRAVITY_CLIENT_INFO,
  AntigravityAcpClient,
  requireAdvertisedAuthMethod,
  type AntigravityTransportFactory,
} from '../src/runtime/acp-client.js';
import {
  AntigravityCleanupError,
  AntigravityRuntimeError,
  AntigravityTimeoutError,
} from '../src/runtime/errors.js';
import type { AntigravityProcessExit, AntigravityProcessTransport } from '../src/runtime/process-transport.js';

const BINARY = '/virtual/antigravity/agy_acp_server.par';
const CWD = '/virtual/antigravity';
const LIMIT = { timeout: 5_000 };

const cancelled = { outcome: { outcome: 'cancelled' as const } };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for an in-memory ACP condition');
    await delay(5);
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

type StopBehavior = (
  options: { force?: boolean } | undefined,
  exit: { resolve(event: AntigravityProcessExit): void },
) => Promise<void>;

class ScriptedAgent {
  initializeRequest: InitializeRequest | null = null;
  initializeCount = 0;
  newSessionCount = 0;
  loadCount = 0;
  resumeCount = 0;
  listCount = 0;
  promptCount = 0;
  authenticateCount = 0;
  cancelSessionId: string | null = null;
  configRequest: SetSessionConfigOptionRequest | null = null;
  authRequest: AuthenticateRequest | null = null;
  protocolVersion = 1;
  agentName = 'in-memory-peer';
  advertiseLoad = true;
  advertiseList = true;
  advertiseResume = true;
  holdInitialize: Promise<void> | null = null;
  holdNewSession: Promise<NewSessionResponse> | null = null;
  holdList: Promise<ListSessionsResponse> | null = null;
  promptHolds: Array<Promise<PromptResponse>> = [];
  promptPermission: 'none' | 'ask' = 'none';

  constructor(private readonly client: Pick<Client, 'requestPermission' | 'sessionUpdate'>) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeCount += 1;
    this.initializeRequest = params;
    if (this.holdInitialize) await this.holdInitialize;
    const sessionCapabilities: NonNullable<
      NonNullable<InitializeResponse['agentCapabilities']>['sessionCapabilities']
    > = {};
    if (this.advertiseList) sessionCapabilities.list = {};
    if (this.advertiseResume) sessionCapabilities.resume = {};
    return {
      protocolVersion: this.protocolVersion,
      agentInfo: { name: this.agentName, title: 'In memory', version: '1.3.0' },
      agentCapabilities: {
        loadSession: this.advertiseLoad,
        sessionCapabilities,
      },
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCount += 1;
    void params;
    if (this.holdNewSession) return this.holdNewSession;
    return { sessionId: 'native-new' };
  }

  async loadSession(): Promise<Record<string, never>> {
    this.loadCount += 1;
    return {};
  }

  async resumeSession(): Promise<Record<string, never>> {
    this.resumeCount += 1;
    return {};
  }

  async listSessions(): Promise<ListSessionsResponse> {
    this.listCount += 1;
    if (this.holdList) return this.holdList;
    return { sessions: [] };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.promptCount += 1;
    if (this.promptPermission === 'ask') await this.ask();
    const held = this.promptHolds.shift();
    if (held) return held;
    await this.emitText(params.sessionId, 'hello');
    return { stopReason: 'end_turn' };
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    this.cancelSessionId = params.sessionId;
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<{ configOptions: [] }> {
    this.configRequest = params;
    return { configOptions: [] };
  }

  async authenticate(params: AuthenticateRequest): Promise<Record<string, never>> {
    this.authenticateCount += 1;
    this.authRequest = params;
    return {};
  }

  ask(): Promise<RequestPermissionResponse> {
    return this.client.requestPermission({
      sessionId: 'native-1',
      toolCall: { toolCallId: 'tool-1', title: 'Run command', kind: 'execute' },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
  }

  emitText(sessionId: string, text: string): Promise<void> {
    return this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
  }
}

function openMemory(
  client: Client,
  setup: (agent: ScriptedAgent) => void,
  stop: StopBehavior,
): AntigravityProcessTransport & { resolveExit(event: AntigravityProcessExit): void } {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  new AgentSideConnection((connection) => {
    const agent = new ScriptedAgent(connection);
    setup(agent);
    return agent as unknown as Agent;
  }, agentStream);
  const exit = deferred<AntigravityProcessExit>();
  return {
    connection: new ClientSideConnection(() => client, clientStream),
    exit: exit.promise,
    stop: (options) => stop(options, exit),
    resolveExit: (event) => exit.resolve(event),
  };
}

function memoryFactory(setup: (agent: ScriptedAgent) => void, stop?: StopBehavior): AntigravityTransportFactory {
  const behavior: StopBehavior = stop ?? (async (_options, exit) => {
    exit.resolve({ code: 0, signal: null });
  });
  return async (client) => openMemory(client, setup, behavior);
}

function clientFor(factory: AntigravityTransportFactory, timeouts: {
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  gracefulStopMs?: number;
} = {}): AntigravityAcpClient {
  const options: {
    binaryPath: string;
    cwd: string;
    transportFactory: AntigravityTransportFactory;
    startupTimeoutMs?: number;
    requestTimeoutMs?: number;
    gracefulStopMs?: number;
  } = {
    binaryPath: BINARY,
    cwd: CWD,
    transportFactory: factory,
  };
  if (timeouts.startupTimeoutMs !== undefined) options.startupTimeoutMs = timeouts.startupTimeoutMs;
  if (timeouts.requestTimeoutMs !== undefined) options.requestTimeoutMs = timeouts.requestTimeoutMs;
  if (timeouts.gracefulStopMs !== undefined) options.gracefulStopMs = timeouts.gracefulStopMs;
  return new AntigravityAcpClient(options);
}

const allowOnce = {
  outcome: { outcome: 'selected' as const, optionId: 'allow-once' },
};

test('requires absolute paths and positive deadlines', () => {
  assert.throws(
    () => new AntigravityAcpClient({ binaryPath: 'agy', cwd: '/tmp' }),
    /binaryPath must be an absolute path/,
  );
  assert.throws(
    () => new AntigravityAcpClient({ binaryPath: BINARY, cwd: 'relative' }),
    /cwd must be an absolute path/,
  );
  assert.throws(
    () => new AntigravityAcpClient({ binaryPath: BINARY, startupTimeoutMs: 0 }),
    /startupTimeoutMs must be a positive number/,
  );
  assert.throws(
    () => new AntigravityAcpClient({ binaryPath: BINARY, requestTimeoutMs: -1 }),
    /requestTimeoutMs must be a positive number/,
  );
  assert.throws(
    () => new AntigravityAcpClient({ binaryPath: BINARY, gracefulStopMs: Number.NaN }),
    /gracefulStopMs must be a positive number/,
  );
});

test('negotiates gian-antigravity-proxy without closing or authenticating', LIMIT, async () => {
  let agent!: ScriptedAgent;
  const client = clientFor(memoryFactory((created) => {
    agent = created;
  }));
  try {
    const negotiated = await client.ensureStarted();
    assert.equal(negotiated.protocolVersion, 1);
    assert.equal(negotiated.agentInfo?.name, 'in-memory-peer');
    assert.equal(negotiated.agentInfo?.version, '1.3.0');
    assert.equal(agent.initializeCount, 1);
    assert.equal(agent.authenticateCount, 0);
    const request = agent.initializeRequest;
    assert.ok(request);
    assert.equal(request.protocolVersion, 1);
    assert.deepEqual(request.clientInfo, {
      name: ANTIGRAVITY_CLIENT_INFO.name,
      title: ANTIGRAVITY_CLIENT_INFO.title,
      version: ANTIGRAVITY_CLIENT_INFO.version,
    });
    assert.equal(request.clientCapabilities?.fs?.readTextFile, false);
    assert.equal(request.clientCapabilities?.fs?.writeTextFile, false);
    assert.equal(request.clientCapabilities?.terminal, false);
    assert.equal(request._meta, undefined);
    const auth = request.clientCapabilities?.auth;
    if (auth !== undefined) assert.equal(auth.terminal, false);
  } finally {
    await client.stop();
  }
});

test('shares one initialize across concurrent ensureStarted calls', LIMIT, async () => {
  let agent!: ScriptedAgent;
  const client = clientFor(memoryFactory((created) => {
    agent = created;
  }));
  try {
    const [first, second] = await Promise.all([client.ensureStarted(), client.ensureStarted()]);
    assert.equal(first, second);
    assert.equal(agent.initializeCount, 1);
    assert.equal(client.negotiated, first);
  } finally {
    await client.stop();
  }
});

test('forwards session methods and cancels only with a session id', LIMIT, async () => {
  let agent!: ScriptedAgent;
  const updates: string[] = [];
  const client = clientFor(memoryFactory((created) => {
    agent = created;
  }));
  client.setPermissionHandler(async () => allowOnce);
  client.on('sessionUpdate', (notification) => {
    if (notification.update.sessionUpdate !== 'agent_message_chunk') return;
    if (notification.update.content.type !== 'text') return;
    updates.push(notification.update.content.text);
  });
  try {
    await client.ensureStarted();
    assert.equal(agent.authenticateCount, 0);
    const created = await client.newSession({ cwd: '/workspace', mcpServers: [] });
    assert.equal(created.sessionId, 'native-new');
    await client.loadSession({ sessionId: 'native-new', cwd: '/workspace', mcpServers: [] });
    await client.resumeSession({ sessionId: 'native-new', cwd: '/workspace', mcpServers: [] });
    const listed = await client.listSessions({ cwd: '/workspace' });
    assert.deepEqual(listed.sessions, []);
    const configured = await client.setConfigOption({
      sessionId: 'native-new',
      configId: 'model',
      value: 'gemini-2.5',
    });
    assert.deepEqual(configured, { configOptions: [] });
    assert.equal(agent.configRequest?.sessionId, 'native-new');
    assert.equal(agent.configRequest?.configId, 'model');
    assert.equal(agent.configRequest?.value, 'gemini-2.5');
    let opened = false;
    const emptyClient = clientFor(async () => {
      opened = true;
      throw new Error('empty sessionId must not open a transport');
    });
    await assert.rejects(emptyClient.cancel(''), /sessionId is required/);
    assert.equal(opened, false);
    await client.cancel('native-new');
    await waitFor(() => agent.cancelSessionId === 'native-new');
    const turn = await client.dispatchPrompt({
      sessionId: 'native-new',
      prompt: [{ type: 'text', text: 'hello' }],
    });
    assert.equal((await turn.response).stopReason, 'end_turn');
    assert.deepEqual(updates, ['hello']);
    assert.deepEqual(await agent.ask(), allowOnce);
    const authenticated = await client.authenticate({ methodId: 'oauth-personal' });
    assert.deepEqual(authenticated, {});
    assert.equal(agent.authRequest?.methodId, 'oauth-personal');
    await assert.rejects(
      client.authenticate({ methodId: 'agent-platform' }),
      /did not advertise authentication method agent-platform/,
    );
    assert.equal(agent.authenticateCount, 1);
  } finally {
    await client.stop();
  }
});

test('gates load, resume, and list before sending the RPC', LIMIT, async () => {
  let agent!: ScriptedAgent;
  const client = clientFor(memoryFactory((created) => {
    created.advertiseLoad = false;
    created.advertiseList = false;
    created.advertiseResume = false;
    agent = created;
  }));
  try {
    await client.ensureStarted();
    await assert.rejects(
      client.loadSession({ sessionId: 'native-new', cwd: '/workspace', mcpServers: [] }),
      /does not advertise session\/load/,
    );
    await assert.rejects(
      client.resumeSession({ sessionId: 'native-new', cwd: '/workspace', mcpServers: [] }),
      /does not advertise session\/resume/,
    );
    await assert.rejects(client.listSessions(), /does not advertise session\/list/);
    assert.equal(agent.loadCount, 0);
    assert.equal(agent.resumeCount, 0);
    assert.equal(agent.listCount, 0);
  } finally {
    await client.stop();
  }
});

test('cancels a permission when no handler is set or the handler throws', LIMIT, async () => {
  let agent!: ScriptedAgent;
  const client = clientFor(memoryFactory((created) => {
    agent = created;
  }));
  try {
    await client.ensureStarted();
    assert.deepEqual(await agent.ask(), cancelled);
    client.setPermissionHandler(async () => {
      throw new Error('handler failed');
    });
    assert.deepEqual(await agent.ask(), cancelled);
  } finally {
    await client.stop();
  }
});

test('a delayed allow is cancelled when the generation is stopping', LIMIT, async () => {
  let agent!: ScriptedAgent;
  const entered = deferred<void>();
  let release!: () => void;
  const answer = new Promise<RequestPermissionResponse>((resolve) => {
    release = () => resolve(allowOnce);
  });
  const gate = deferred<void>();
  const events: RuntimeStopped[] = [];
  const client = clientFor(memoryFactory((created) => {
    agent = created;
  }, async (options, exit) => {
    if (options?.force === true) {
      exit.resolve({ code: null, signal: 'SIGKILL' });
      return;
    }
    await gate.promise;
    exit.resolve({ code: 0, signal: null });
  }));
  client.on('runtimeStopped', (event) => {
    events.push(event);
  });
  client.setPermissionHandler(() => {
    entered.resolve();
    return answer;
  });
  try {
    await client.ensureStarted();
    const asking = agent.ask();
    await entered.promise;
    const stopping = client.stop();
    void stopping.catch(() => undefined);
    release();
    assert.deepEqual(await asking, cancelled);
    let settled = false;
    void stopping.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false);
    gate.resolve();
    await stopping;
    const event = events[0];
    assert.ok(event);
    assert.equal(event.expected, true);
    assert.equal(event.error, undefined);
    assert.equal(events.length, 1);
  } finally {
    gate.resolve();
    await client.stop().catch(() => undefined);
  }
});

test('a delayed allow is cancelled while cleanup is failing', LIMIT, async () => {
  let agent!: ScriptedAgent;
  const entered = deferred<void>();
  let release!: () => void;
  const answer = new Promise<RequestPermissionResponse>((resolve) => {
    release = () => resolve(allowOnce);
  });
  const gate = deferred<never>();
  const events: RuntimeStopped[] = [];
  const client = clientFor(memoryFactory((created) => {
    agent = created;
  }, async () => {
    await gate.promise;
  }));
  client.on('runtimeStopped', (event) => {
    events.push(event);
  });
  client.setPermissionHandler(() => {
    entered.resolve();
    return answer;
  });
  try {
    await client.ensureStarted();
    const asking = agent.ask();
    await entered.promise;
    const stopping = client.stop();
    void stopping.catch(() => undefined);
    await flush();
    release();
    assert.deepEqual(await asking, cancelled);
    gate.reject(new Error('group still has descendants'));
    await assert.rejects(stopping, (error: unknown) => {
      assert.ok(error instanceof AntigravityCleanupError);
      assert.match(error.message, /group still has descendants/);
      return true;
    });
    const event = events[0];
    assert.ok(event);
    assert.equal(event.expected, true);
    assert.ok(event.error instanceof AntigravityCleanupError);
    assert.equal(client.negotiated, null);
  } finally {
    gate.reject(new Error('group still has descendants'));
    await client.stop().catch(() => undefined);
  }
});

test('a delayed allow is cancelled after an unexpected exit', LIMIT, async () => {
  let agent!: ScriptedAgent;
  const entered = deferred<void>();
  let release!: () => void;
  const answer = new Promise<RequestPermissionResponse>((resolve) => {
    release = () => resolve(allowOnce);
  });
  const promptHold = deferred<PromptResponse>();
  const events: RuntimeStopped[] = [];
  let resolveExit: (event: AntigravityProcessExit) => void = () => undefined;
  const client = clientFor(async (callbacks) => {
    const transport = openMemory(callbacks, (created) => {
      created.promptHolds.push(promptHold.promise);
      agent = created;
    }, async (_options, transportExit) => {
      transportExit.resolve({ code: 0, signal: null });
    });
    resolveExit = transport.resolveExit;
    return transport;
  });
  client.on('runtimeStopped', (event) => {
    events.push(event);
  });
  client.setPermissionHandler(() => {
    entered.resolve();
    return answer;
  });
  try {
    await client.ensureStarted();
    const turn = await client.dispatchPrompt({
      sessionId: 'native-1',
      prompt: [{ type: 'text', text: 'hold' }],
    });
    void turn.response.catch(() => undefined);
    await waitFor(() => agent.promptCount === 1);
    const asking = agent.ask();
    await entered.promise;
    resolveExit({ code: 1, signal: null });
    await flush();
    release();
    assert.deepEqual(await asking, cancelled);
    await assert.rejects(turn.response, /Antigravity ACP exited \(code=1, signal=null\)/);
    await waitFor(() => events.length === 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.expected, false);
    assert.equal(event.code, 1);
    assert.equal(event.signal, null);
    assert.equal(event.error, undefined);
  } finally {
    resolveExit({ code: 1, signal: null });
    promptHold.resolve({ stopReason: 'cancelled' });
    await client.stop().catch(() => undefined);
  }
});

test('prompt completion is not bounded by requestTimeoutMs', LIMIT, async () => {
  let agent!: ScriptedAgent;
  const hold = deferred<PromptResponse>();
  const client = clientFor(memoryFactory((created) => {
    created.promptHolds.push(hold.promise);
    agent = created;
  }), { requestTimeoutMs: 30 });
  try {
    await client.ensureStarted();
    const turn = await client.dispatchPrompt({
      sessionId: 'native-1',
      prompt: [{ type: 'text', text: 'slow' }],
    });
    await waitFor(() => agent.promptCount === 1);
    let settled = false;
    void turn.response.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await delay(50);
    assert.equal(settled, false);
    assert.equal(client.negotiated?.protocolVersion, 1);
    assert.equal(agent.initializeCount, 1);
    hold.resolve({ stopReason: 'end_turn' });
    assert.equal((await turn.response).stopReason, 'end_turn');
  } finally {
    hold.resolve({ stopReason: 'cancelled' });
    await client.stop().catch(() => undefined);
  }
});

test('two prompts stay in flight until each agent result arrives', LIMIT, async () => {
  const firstHold = deferred<PromptResponse>();
  const secondHold = deferred<PromptResponse>();
  let agent!: ScriptedAgent;
  const client = clientFor(memoryFactory((created) => {
    created.promptHolds.push(firstHold.promise, secondHold.promise);
    agent = created;
  }));
  try {
    await client.ensureStarted();
    const first = await client.dispatchPrompt({
      sessionId: 'native-1',
      prompt: [{ type: 'text', text: 'one' }],
    });
    const second = await client.dispatchPrompt({
      sessionId: 'native-1',
      prompt: [{ type: 'text', text: 'two' }],
    });
    await waitFor(() => agent.promptCount === 2);
    let settled = 0;
    void first.response.then(() => {
      settled += 1;
    }, () => {
      settled += 1;
    });
    void second.response.then(() => {
      settled += 1;
    }, () => {
      settled += 1;
    });
    await delay(20);
    assert.equal(settled, 0);
    firstHold.resolve({ stopReason: 'end_turn' });
    secondHold.resolve({ stopReason: 'max_tokens' });
    assert.equal((await first.response).stopReason, 'end_turn');
    assert.equal((await second.response).stopReason, 'max_tokens');
  } finally {
    firstHold.resolve({ stopReason: 'cancelled' });
    secondHold.resolve({ stopReason: 'cancelled' });
    await client.stop().catch(() => undefined);
  }
});

test('a request timeout retires the generation and does not retry', LIMIT, async () => {
  const agents: ScriptedAgent[] = [];
  const hold = deferred<NewSessionResponse>();
  const events: RuntimeStopped[] = [];
  const client = clientFor(memoryFactory((created) => {
    agents.push(created);
    if (agents.length === 1) {
      created.holdNewSession = hold.promise;
      created.promptHolds.push(new Promise<PromptResponse>(() => undefined));
      created.holdList = new Promise<ListSessionsResponse>(() => undefined);
    }
  }), { requestTimeoutMs: 40 });
  client.on('runtimeStopped', (event) => {
    events.push(event);
  });
  try {
    await client.ensureStarted();
    const turn = await client.dispatchPrompt({
      sessionId: 'native-1',
      prompt: [{ type: 'text', text: 'sibling' }],
    });
    void turn.response.catch(() => undefined);
    const creating = client.newSession({ cwd: '/workspace', mcpServers: [] });
    void creating.catch(() => undefined);
    const listing = client.listSessions();
    void listing.catch(() => undefined);
    await assert.rejects(creating, (error: unknown) => error instanceof AntigravityTimeoutError);
    await assert.rejects(turn.response, (error: unknown) => error instanceof AntigravityTimeoutError);
    await assert.rejects(listing, (error: unknown) => error instanceof AntigravityTimeoutError);
    const first = agents[0];
    assert.ok(first);
    assert.equal(first.newSessionCount, 1);
    assert.equal(first.listCount, 1);
    hold.resolve({ sessionId: 'late-session' });
    await delay(20);
    assert.equal(client.negotiated, null);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.expected, true);
    assert.ok(event.error instanceof AntigravityTimeoutError);
    const restarted = await client.ensureStarted();
    assert.equal(restarted.protocolVersion, 1);
    const second = agents[1];
    assert.ok(second);
    assert.equal(second.newSessionCount, 0);
    const created = await client.newSession({ cwd: '/workspace', mcpServers: [] });
    assert.equal(created.sessionId, 'native-new');
    assert.equal(first.newSessionCount, 1);
    assert.equal(second.newSessionCount, 1);
  } finally {
    hold.resolve({ sessionId: 'late-session' });
    await client.stop().catch(() => undefined);
  }
});

test('startup timeout covers a blocked factory and reaps the late transport', LIMIT, async () => {
  const gate = deferred<void>();
  const firstStopped = deferred<void>();
  let opened = 0;
  let firstForce: boolean | undefined;
  const client = clientFor(async (callbacks) => {
    const generation = ++opened;
    if (generation === 1) await gate.promise;
    return openMemory(callbacks, () => undefined, async (options, exit) => {
      if (generation === 1) {
        firstForce = options?.force;
        firstStopped.resolve();
      }
      exit.resolve({ code: null, signal: 'SIGKILL' });
    });
  }, { startupTimeoutMs: 40 });
  try {
    await assert.rejects(client.ensureStarted(), (error: unknown) => {
      assert.ok(error instanceof AntigravityTimeoutError);
      assert.equal(error.label, 'initialize');
      return true;
    });
    assert.equal(client.negotiated, null);
    const restarted = await client.ensureStarted();
    assert.equal(restarted.protocolVersion, 1);
    assert.equal(client.negotiated, restarted);
    gate.resolve();
    await firstStopped.promise;
    assert.equal(firstForce, true);
    assert.equal(client.negotiated, restarted);
    assert.equal(opened, 2);
  } finally {
    gate.resolve();
    await client.stop().catch(() => undefined);
  }
});

test('a hung initialize is force-stopped when startup times out', LIMIT, async () => {
  const stops: Array<boolean | undefined> = [];
  const client = clientFor(memoryFactory((created) => {
    created.holdInitialize = new Promise(() => undefined);
  }, async (options, exit) => {
    stops.push(options?.force);
    exit.resolve({ code: null, signal: 'SIGKILL' });
  }), { startupTimeoutMs: 40 });
  try {
    await assert.rejects(client.ensureStarted(), (error: unknown) => error instanceof AntigravityTimeoutError);
    assert.equal(client.negotiated, null);
    assert.deepEqual(stops, [true]);
  } finally {
    await client.stop().catch(() => undefined);
  }
});

test('rejects a protocol version other than 1 and force-stops', LIMIT, async () => {
  const stops: Array<boolean | undefined> = [];
  const client = clientFor(memoryFactory((created) => {
    created.protocolVersion = 2;
  }, async (options, exit) => {
    stops.push(options?.force);
    exit.resolve({ code: null, signal: 'SIGKILL' });
  }));
  try {
    await assert.rejects(client.ensureStarted(), /Unsupported Antigravity ACP protocol version 2/);
    assert.equal(client.negotiated, null);
    assert.equal(stops.includes(true), true);
  } finally {
    await client.stop().catch(() => undefined);
  }
});

test('a restarted generation drops updates and results from the retired transport', LIMIT, async () => {
  const agents: ScriptedAgent[] = [];
  const gate = deferred<void>();
  const updates: string[] = [];
  const events: RuntimeStopped[] = [];
  const client = clientFor(memoryFactory((created) => {
    agents.push(created);
  }, async (options, exit) => {
    if (options?.force === true) {
      exit.resolve({ code: null, signal: 'SIGKILL' });
      return;
    }
    await gate.promise;
    exit.resolve({ code: 0, signal: null });
  }));
  client.on('sessionUpdate', (notification) => {
    if (notification.update.sessionUpdate !== 'agent_message_chunk') return;
    if (notification.update.content.type !== 'text') return;
    updates.push(notification.update.content.text);
  });
  client.on('runtimeStopped', (event) => {
    events.push(event);
  });
  client.setPermissionHandler(async () => allowOnce);
  const lateSession = deferred<NewSessionResponse>();
  try {
    await client.ensureStarted();
    const first = agents[0];
    assert.ok(first);
    first.holdNewSession = lateSession.promise;
    const creating = client.newSession({ cwd: '/workspace', mcpServers: [] });
    await waitFor(() => first.newSessionCount === 1);
    const rejected = assert.rejects(creating, /Antigravity ACP generation ended/);
    const stopping = client.stop();
    void stopping.catch(() => undefined);
    await client.ensureStarted();
    const second = agents[1];
    assert.ok(second);
    await first.emitText('old', 'stale');
    assert.deepEqual(updates, []);
    assert.deepEqual(await first.ask(), cancelled);
    lateSession.resolve({ sessionId: 'late-session' });
    await rejected;
    await second.emitText('new', 'live');
    assert.deepEqual(updates, ['live']);
    assert.equal(events.length, 0);
    gate.resolve();
    await stopping;
    assert.equal(events.length, 0);
    assert.equal(client.negotiated?.agentInfo?.name, 'in-memory-peer');
    await client.stop();
    const event = events[0];
    assert.ok(event);
    assert.equal(event.expected, true);
    assert.equal(events.length, 1);
  } finally {
    gate.resolve();
    lateSession.resolve({ sessionId: 'late-session' });
    await client.stop().catch(() => undefined);
  }
});

test('requireAdvertisedAuthMethod matches initialize authMethods only', () => {
  const initialized = {
    protocolVersion: 1,
    authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
  } as InitializeResponse;
  requireAdvertisedAuthMethod(initialized, 'oauth-personal');
  assert.throws(
    () => requireAdvertisedAuthMethod(initialized, 'gemini-api-key'),
    (error: unknown) => error instanceof AntigravityRuntimeError
      && /did not advertise authentication method gemini-api-key/.test(error.message),
  );
});
