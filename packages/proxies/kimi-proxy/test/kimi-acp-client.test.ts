import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type InitializeRequest,
  type InitializeResponse,
  type ForkSessionRequest,
  type ListSessionsRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';

import {
  KimiAcpClient,
  type KimiAcpExit,
  type KimiAcpTransportFactory,
} from '../src/runtime/kimi-acp-client.js';

function initializeResponse(): InitializeResponse {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'fake-kimi', version: '0.0.0-test' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: {
        list: {},
        resume: {},
      },
    },
    authMethods: [{ id: 'login', name: 'Login', type: 'terminal', args: ['login'] }],
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function inMemoryTransport(
  agentFactory: (client: AgentSideConnection) => Agent,
): KimiAcpTransportFactory {
  return async (client) => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
    const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
    const exit = deferred<KimiAcpExit>();

    new AgentSideConnection(agentFactory, agentStream);

    return {
      connection: new ClientSideConnection(() => client, clientStream),
      exit: exit.promise,
      async stop() {
        exit.resolve({ code: 0, signal: null });
      },
    };
  };
}

class RecordingAgent {
  initializeRequest: InitializeRequest | null = null;
  newRequest: NewSessionRequest | null = null;
  loadRequest: LoadSessionRequest | null = null;
  resumeRequest: ResumeSessionRequest | null = null;
  forkRequest: ForkSessionRequest | null = null;
  listRequest: ListSessionsRequest | null = null;
  promptRequest: PromptRequest | null = null;
  configRequest: SetSessionConfigOptionRequest | null = null;
  cancelSessionId: string | null = null;
  permissionResponse: RequestPermissionResponse | null = null;

  constructor(
    private readonly client: Pick<Client, 'requestPermission' | 'sessionUpdate'>,
    private readonly capabilities: NonNullable<InitializeResponse['agentCapabilities']> = {
      loadSession: true,
      sessionCapabilities: {
        list: {},
        resume: {},
      },
    },
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeRequest = params;
    return {
      protocolVersion: 1,
      agentInfo: { name: 'fake-kimi', version: '0.0.0-test' },
      agentCapabilities: this.capabilities,
      authMethods: [{ id: 'login', name: 'Login', type: 'terminal', args: ['login'] }],
    };
  }

  async newSession(params: NewSessionRequest) {
    this.newRequest = params;
    return { sessionId: 'native-new' };
  }

  async loadSession(params: LoadSessionRequest) {
    this.loadRequest = params;
    return {};
  }

  async resumeSession(params: ResumeSessionRequest) {
    this.resumeRequest = params;
    return {};
  }

  async unstable_forkSession(params: ForkSessionRequest) {
    this.forkRequest = params;
    return { sessionId: 'native-fork' };
  }

  async listSessions(params: ListSessionsRequest) {
    this.listRequest = params;
    return {
      sessions: [{
        sessionId: 'native-new',
        cwd: '/workspace/one',
        title: 'Native session',
        updatedAt: '2026-07-28T00:00:00.000Z',
      }],
    };
  }

  async prompt(params: PromptRequest) {
    this.promptRequest = params;
    await this.client.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    });
    this.permissionResponse = await this.client.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Run command',
        kind: 'execute',
      },
      options: [
        { optionId: 'opaque-allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'opaque-reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    return { stopReason: 'end_turn' as const };
  }

  async cancel(params: { sessionId: string }) {
    this.cancelSessionId = params.sessionId;
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest) {
    this.configRequest = params;
    return { configOptions: [] };
  }
}

test('requires an absolute managed binary path', () => {
  assert.throws(
    () => new KimiAcpClient({ binaryPath: 'kimi' }),
    /binaryPath must be an absolute path/,
  );
});

test('fails startup promptly when the managed binary does not exist', async () => {
  const client = new KimiAcpClient({
    binaryPath: '/definitely-not-installed/gian-kimi-test',
    startupTimeoutMs: 5_000,
  });

  await assert.rejects(
    client.ensureStarted(),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ),
  );
});

test('negotiates ACP v1 with the terminal capability and without fs reverse capabilities', async () => {
  let agent!: RecordingAgent;
  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: inMemoryTransport((remoteClient) => {
      agent = new RecordingAgent(remoteClient);
      return agent as unknown as Agent;
    }),
  });

  const negotiated = await client.ensureStarted();

  assert.equal(negotiated.protocolVersion, 1);
  assert.deepEqual(agent.initializeRequest, {
    protocolVersion: 1,
    clientInfo: {
      name: 'gian-kimi-proxy',
      version: '0.1.0',
    },
    clientCapabilities: {
      auth: {
        terminal: false,
      },
      fs: {
        readTextFile: false,
        writeTextFile: false,
      },
      terminal: true,
    },
  });

  await client.stop();
});

test('preserves cwd and mcpServers across new, load, resume, and fork', async () => {
  let agent!: RecordingAgent;
  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: inMemoryTransport((remoteClient) => {
      agent = new RecordingAgent(remoteClient);
      return agent as unknown as Agent;
    }),
  });

  await client.newSession({ cwd: '/workspace/one', mcpServers: [] });
  await client.loadSession({
    sessionId: 'native-load',
    cwd: '/workspace/two',
    mcpServers: [],
  });
  await client.resumeSession({
    sessionId: 'native-resume',
    cwd: '/workspace/three',
    mcpServers: [],
  });
  await client.forkSession({
    sessionId: 'native-parent',
    cwd: '/workspace/four',
    mcpServers: [],
  });

  assert.deepEqual(agent.newRequest, {
    cwd: '/workspace/one',
    mcpServers: [],
  });
  assert.deepEqual(agent.loadRequest, {
    sessionId: 'native-load',
    cwd: '/workspace/two',
    mcpServers: [],
  });
  assert.deepEqual(agent.resumeRequest, {
    sessionId: 'native-resume',
    cwd: '/workspace/three',
    mcpServers: [],
  });
  assert.deepEqual(agent.forkRequest, {
    sessionId: 'native-parent',
    cwd: '/workspace/four',
    mcpServers: [],
  });

  await client.stop();
});

test('routes session updates and returns the exact native permission option', async () => {
  let agent!: RecordingAgent;
  const updates: string[] = [];
  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    permissionHandler: async (request) => {
      assert.deepEqual(
        request.options.map((option) => option.optionId),
        ['opaque-allow', 'opaque-reject'],
      );
      return {
        outcome: {
          outcome: 'selected',
          optionId: 'opaque-allow',
        },
      };
    },
    transportFactory: inMemoryTransport((remoteClient) => {
      agent = new RecordingAgent(remoteClient);
      return agent as unknown as Agent;
    }),
  });
  client.on('sessionUpdate', (notification) => {
    updates.push(notification.sessionId);
  });

  const response = await client.prompt({
    sessionId: 'native-new',
    prompt: [{ type: 'text', text: 'hello' }],
  });

  assert.equal(response.stopReason, 'end_turn');
  assert.deepEqual(updates, ['native-new']);
  assert.deepEqual(agent.permissionResponse, {
    outcome: {
      outcome: 'selected',
      optionId: 'opaque-allow',
    },
  });

  await client.stop();
});

test('defaults an unhandled permission request to cancelled', async () => {
  let agent!: RecordingAgent;
  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: inMemoryTransport((remoteClient) => {
      agent = new RecordingAgent(remoteClient);
      return agent as unknown as Agent;
    }),
  });

  await client.prompt({
    sessionId: 'native-new',
    prompt: [{ type: 'text', text: 'hello' }],
  });

  assert.deepEqual(agent.permissionResponse, {
    outcome: { outcome: 'cancelled' },
  });

  await client.stop();
});

test('capability-gates session close instead of sending an unsupported RPC', async () => {
  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: inMemoryTransport(
      (remoteClient) => new RecordingAgent(remoteClient) as unknown as Agent,
    ),
  });

  await assert.rejects(
    client.closeSession({ sessionId: 'native-new' }),
    /does not advertise session\/close/,
  );

  await client.stop();
});

test('forwards list, config, cancel, and marks an explicit stop as expected', async () => {
  let agent!: RecordingAgent;
  const stopped = deferred<boolean>();
  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: inMemoryTransport((remoteClient) => {
      agent = new RecordingAgent(remoteClient);
      return agent as unknown as Agent;
    }),
  });
  client.on('runtimeStopped', (event) => {
    stopped.resolve(event.expected);
  });

  const listed = await client.listSessions({ cwd: '/workspace/one' });
  await client.setSessionConfigOption({
    sessionId: 'native-new',
    configId: 'mode',
    value: 'yolo',
  });
  await client.cancel('native-new');
  await client.stop();

  assert.equal(listed.sessions[0]?.sessionId, 'native-new');
  assert.deepEqual(agent.listRequest, { cwd: '/workspace/one' });
  assert.deepEqual(agent.configRequest, {
    sessionId: 'native-new',
    configId: 'mode',
    value: 'yolo',
  });
  assert.equal(agent.cancelSessionId, 'native-new');
  assert.equal(await stopped.promise, true);
});

test('ACP failure logs attribute the operation without leaking command paths', async () => {
  const { logAcpFailure } = await import('../src/runtime/kimi-acp-client.js');
  const original = console.error;
  const lines: string[] = [];
  console.error = (line: string) => {
    lines.push(line);
  };
  try {
    const spawnError = new Error('spawn /secret/tools/hidden-command ENOENT') as NodeJS.ErrnoException;
    spawnError.code = 'ENOENT';
    logAcpFailure('terminal/create', spawnError);
    logAcpFailure('session/prompt', new Error('line1\nline2\u0007bell'));
    logAcpFailure('session/prompt', new Error('x'.repeat(500)));
  } finally {
    console.error = original;
  }

  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^\[kimi-acp\] terminal\/create failed code=ENOENT \(Error\): spawn <redacted> ENOENT$/);
  assert.ok(!lines[0]!.includes('/secret'));
  assert.match(lines[1]!, /^\[kimi-acp\] session\/prompt failed \(Error\): line1 line2 bell$/);
  const prefix = '[kimi-acp] session/prompt failed (Error): ';
  assert.ok(lines[2]!.startsWith(prefix));
  assert.ok(lines[2]!.length <= prefix.length + 200, 'sanitized message must stay bounded');
  assert.ok(!lines[2]!.includes('x'.repeat(300)));
});

test('a failing reverse terminal/create never dumps raw request params (Finding 4)', async () => {
  const CWD_SENTINEL = 'gian-cwd-nonexistent-9f2';
  const COMMAND_SENTINEL = 'GIAN_SENTINEL_COMMAND';
  const ARG_SENTINEL = 'GIAN_SENTINEL_ARG_VALUE';
  const ENV_SENTINEL = 'GIAN_SENTINEL_ENV_VALUE';
  const secretCwd = mkdtempSync(join(tmpdir(), 'gian-sentinel-'));
  const terminalFailure = deferred<void>();
  let agentSawError: unknown = null;

  const client = new KimiAcpClient({
    binaryPath: '/managed/kimi',
    transportFactory: inMemoryTransport((remoteClient) => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({ sessionId: 'native-sentinel' }),
      prompt: async (params: { sessionId: string }) => {
        try {
          await remoteClient.createTerminal({
            sessionId: params.sessionId,
            command: `/${COMMAND_SENTINEL}/no-such-binary`,
            args: [`--value=${ARG_SENTINEL}`],
            cwd: secretCwd,
            env: [{ name: 'GIAN_SENTINEL_ENV', value: ENV_SENTINEL }],
            outputByteLimit: 4096,
          });
        } catch (error) {
          agentSawError = error;
        } finally {
          terminalFailure.resolve();
        }
        return { stopReason: 'end_turn' as const };
      },
      cancel: async () => undefined,
    }) as unknown as Agent),
  });

  // Bind the native session so the failing request travels past ownership
  // into the spawn attempt, where the ENOENT message would embed the command.
  await client.newSession({ cwd: secretCwd, mcpServers: [] });

  const originalConsoleError = console.error;
  const captured: string[] = [];
  console.error = (...parts: unknown[]) => {
    captured.push(parts.map(String).join(' '));
  };
  try {
    await client.prompt({
      sessionId: 'native-sentinel',
      prompt: [{ type: 'text', text: 'run it' }],
    });
  } finally {
    console.error = originalConsoleError;
  }
  await terminalFailure.promise;

  // The agent observed the actual failure, so the handler really ran.
  assert.ok(agentSawError instanceof Error, 'terminal/create must fail the agent request');
  assert.ok(captured.length > 0, 'the failure must be logged for attribution');
  const allOutput = captured.join('\n');
  for (const sentinel of [COMMAND_SENTINEL, ARG_SENTINEL, ENV_SENTINEL, secretCwd, CWD_SENTINEL]) {
    assert.ok(!allOutput.includes(sentinel), `stderr leaked sentinel ${sentinel}: ${allOutput}`);
  }
  assert.ok(!allOutput.includes('params'), 'raw request params must not reach stderr');
  // Attribution survives: method label plus the redacted failure identity.
  assert.match(allOutput, /terminal\/create/);
  assert.match(allOutput, /spawn <redacted> ENOENT/);
  await client.stop();
});
