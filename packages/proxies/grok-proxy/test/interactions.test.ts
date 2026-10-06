import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type InitializeResponse,
  type PromptRequest,
} from '@agentclientprotocol/sdk';

import { GrokProxyService } from '../src/core/service.js';
import type { QuestionOutcome } from '../src/core/types.js';
import { GrokProtocolV2Adapter } from '../src/protocol/v2-adapter.js';
import { GrokAcpClient } from '../src/runtime/grok-acp-client.js';

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

interface ReverseCall {
  method: string;
  params: unknown;
  response: unknown;
}

class QuestioningAgent {
  readonly reverseCalls: ReverseCall[] = [];
  private clientRef: Client | null = null;
  private connRef: AgentSideConnection | null = null;

  constructor(private readonly mode: 'question' | 'plan' | 'elicit' | 'elicit-schema' | 'permission') {}

  bind(client: Client): void {
    this.clientRef = client;
  }

  bindConnection(connection: AgentSideConnection): void {
    this.connRef = connection;
  }

  agent(): Agent {
    const self = this;
    return {
      initialize: async (): Promise<InitializeResponse> => ({
        protocolVersion: 1,
        agentInfo: { name: 'fake-q-grok', version: '1.0.41-test' },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        _meta: {
          grokShell: true,
          agentVersion: '1.0.41',
          modelState: {
            currentModelId: 'grok-4.6',
            availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6' }],
          },
          availableCommands: [],
        },
      }),
      newSession: async () => ({ sessionId: 'native-q' }),
      resumeSession: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
      loadSession: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
      listSessions: async () => ({ sessions: [{ sessionId: 'native-q', cwd: '/workspace', title: 'q' }] }),
      async prompt(params: PromptRequest) {
        if (self.mode === 'permission') {
          if (!self.connRef) throw new Error('agent connection missing');
          const response = await self.connRef.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId: 'tc-perm', title: 'Run tests', kind: 'execute' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          });
          self.reverseCalls.push({ method: 'session/request_permission', params: {}, response });
          return { stopReason: 'end_turn' as const };
        }
        const method = self.mode === 'question'
          ? 'x.ai/ask_user_question'
          : self.mode === 'plan'
            ? 'x.ai/exit_plan_mode'
            : 'x.ai/mcp/elicit';
        const payload = self.mode === 'question'
          ? {
            sessionId: params.sessionId,
            toolCallId: 'tc-1',
            mode: 'default',
            questions: [{
              question: 'Which database?',
              options: [
                { label: 'Redis', description: 'in-memory' },
                { label: 'Postgres', description: 'relational' },
              ],
            }],
          }
          : self.mode === 'plan'
            ? { sessionId: params.sessionId, toolCallId: 'tc-plan', planContent: '# Plan' }
            : self.mode === 'elicit-schema'
              ? {
                sessionId: params.sessionId,
                serverName: 'files',
                requestedSchema: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', title: 'Path', minLength: 1 },
                    level: { type: 'string', enum: ['ro', 'rw'], enumNames: ['Read only', 'Read write'] },
                    recursive: { type: 'boolean', description: 'Recurse into subdirectories' },
                    token: { type: 'string', title: 'Token', minLength: 5, maxLength: 10 },
                  },
                  required: ['path', 'level'],
                },
              }
              : { sessionId: params.sessionId, serverName: 'files' };
        const raw = self.clientRef?.extMethod as
          | ((method: string, params: unknown) => Promise<unknown>)
          | undefined;
        if (!raw) throw new Error('client extMethod callbacks missing');
        const response = await raw.call(self.clientRef, method, payload);
        self.reverseCalls.push({ method, params: payload, response });
        return { stopReason: 'end_turn' as const };
      },
      async cancel() {},
      async extNotification() {},
    } as unknown as Agent;
  }
}

function makeService(agent: QuestioningAgent, events: Array<{ method: string; data: Record<string, unknown> }>) {
  const client = new GrokAcpClient({
    binaryPath: '/usr/bin/true',
    cwd: '/workspace',
    transportFactory: async (boundClient) => {
      agent.bind(boundClient);
      const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
      const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
      const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
      const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
      const exit = deferred<{ code: number | null; signal: null }>();
      new AgentSideConnection((connection) => {
        agent.bindConnection(connection);
        return agent.agent();
      }, agentStream);
      return {
        connection: new ClientSideConnection(() => boundClient, clientStream),
        exit: exit.promise as never,
        async stop() {
          exit.resolve({ code: 0, signal: null });
        },
      } as never;
    },
  });
  const service = new GrokProxyService({
    binaryPath: '/managed/grok',
    createRuntime: () => client,
    emitEvent: (method, params) => {
      events.push({ method, data: params.data as Record<string, unknown> });
    },
  });
  return { service, client };
}

async function waitForEvent(
  events: Array<{ method: string; data: Record<string, unknown> }>,
  method: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let index = 0;
  while (Date.now() < deadline) {
    while (index < events.length) {
      if (events[index]!.method === method) return events[index]!.data;
      index += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${method}; saw ${events.map((item) => item.method).join(',')}`);
}

test('ask_user_question maps to a Gian interaction and carries accepted answers back', async () => {
  const agent = new QuestioningAgent('question');
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, events);
  const created = await service.createSession({ cwd: '/workspace' });
  const sessionId = created.session.id;

  const turn = await service.beginTurn({ sessionId, input: [{ type: 'text', text: 'ask me' }] });
  const requested = await waitForEvent(events, 'question.requested');
  const questionId = String(requested.questionId);
  assert.ok(questionId);

  // Duplicate identical response is idempotent; a different payload conflicts.
  await service.respondQuestion({
    questionId,
    responseId: 'resp-1',
    actionId: 'submit',
    values: { 'Which database?': 'Redis' },
  });
  await service.respondQuestion({
    questionId,
    responseId: 'resp-1',
    actionId: 'submit',
    values: { 'Which database?': 'Redis' },
  });
  await assert.rejects(
    service.respondQuestion({
      questionId,
      responseId: 'resp-1',
      actionId: 'submit',
      values: { 'Which database?': 'Postgres' },
    }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
  );
  await assert.rejects(
    service.respondQuestion({
      questionId: 'does-not-exist',
      responseId: 'resp-2',
      actionId: 'submit',
    }),
    (error: unknown) => (error as { code?: string }).code === 'APPROVAL_NOT_FOUND',
  );

  await waitForEvent(events, 'turn.completed');
  assert.equal(agent.reverseCalls.length, 1);
  assert.deepEqual(agent.reverseCalls[0]!.response, {
    outcome: 'accepted',
    answers: { 'Which database?': ['Redis'] },
  });
  const resolved = events.filter((item) => item.method === 'question.resolved');
  assert.equal(resolved.length, 1);
  await service.close();
});

test('ending the turn expires a pending question with an honest cancelled response', async () => {
  const agent = new QuestioningAgent('question');
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, events);
  const created = await service.createSession({ cwd: '/workspace' });
  const sessionId = created.session.id;

  void service.beginTurn({ sessionId, input: [{ type: 'text', text: 'hang' }] });
  await waitForEvent(events, 'question.requested');
  // Interrupt expires the pending question; the blocked agent prompt settles
  // with the cancelled outcome instead of hanging forever.
  await service.interruptTurn({ sessionId });
  await waitForEvent(events, 'turn.completed');
  assert.equal(agent.reverseCalls.length, 1);
  assert.deepEqual(agent.reverseCalls[0]!.response, { outcome: 'cancelled' });
  const resolved = await waitForEvent(events, 'question.resolved');
  assert.equal(resolved.actionId, null);
  await service.close();
});

test('exit_plan_mode approval returns the plan wire outcome', async () => {
  const agent = new QuestioningAgent('plan');
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, events);
  const created = await service.createSession({ cwd: '/workspace' });
  void service.beginTurn({ sessionId: created.session.id, input: [{ type: 'text', text: 'plan' }] });
  await waitForEvent(events, 'question.requested');
  const requested = events.filter((item) => item.method === 'question.requested').at(-1)!.data;
  await service.respondQuestion({
    questionId: String(requested.questionId),
    responseId: 'r1',
    actionId: 'approve',
  });
  await waitForEvent(events, 'turn.completed');
  assert.deepEqual(agent.reverseCalls[0]!.response, { outcome: 'approved' });
  await service.close();
});

test('mcp elicit decline keeps the agent moving without fabricated content', async () => {
  const agent = new QuestioningAgent('elicit');
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, events);
  const created = await service.createSession({ cwd: '/workspace' });
  void service.beginTurn({ sessionId: created.session.id, input: [{ type: 'text', text: 'elicit' }] });
  await waitForEvent(events, 'question.requested');
  const requested = events.filter((item) => item.method === 'question.requested').at(-1)!.data;
  await service.respondQuestion({
    questionId: String(requested.questionId),
    responseId: 'r1',
    actionId: 'decline',
  });
  await waitForEvent(events, 'turn.completed');
  // The runtime parses the MCP ElicitResult envelope; a bare string or an
  // { accept: ... } shape is malformed and would cancel natively.
  assert.deepEqual(agent.reverseCalls[0]!.response, { action: 'decline' });
  await service.close();
});

test('mcp elicit accept returns the ElicitResult action envelope with typed content', async () => {
  const agent = new QuestioningAgent('elicit-schema');
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, events);
  const created = await service.createSession({ cwd: '/workspace' });
  void service.beginTurn({ sessionId: created.session.id, input: [{ type: 'text', text: 'elicit' }] });
  const requested = await waitForEvent(events, 'question.requested');
  assert.equal(requested.kind, 'mcp_elicit');
  await service.respondQuestion({
    questionId: String(requested.questionId),
    responseId: 'r1',
    actionId: 'submit',
    values: { content: { path: '/tmp', level: 'rw', recursive: true } },
  });
  await waitForEvent(events, 'turn.completed');
  assert.deepEqual(agent.reverseCalls[0]!.response, {
    action: 'accept',
    content: { path: '/tmp', level: 'rw', recursive: true },
  });
  await service.close();
});

test('a pending permission settles as cancelled on interrupt and the prompt unwinds', async () => {
  const agent = new QuestioningAgent('permission');
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, events);
  const created = await service.createSession({ cwd: '/workspace' });
  void service.beginTurn({ sessionId: created.session.id, input: [{ type: 'text', text: 'perm' }] });
  const requested = await waitForEvent(events, 'approval.requested');
  assert.ok(requested.approvalId);
  // Interrupt while the native prompt is parked in requestPermission: the
  // reverse request must settle without the client answering it.
  await service.interruptTurn({ sessionId: created.session.id });
  await waitForEvent(events, 'turn.completed');
  assert.equal(agent.reverseCalls.length, 1);
  assert.deepEqual(agent.reverseCalls[0]!.response, { outcome: { outcome: 'cancelled' } });
  const resolved = events.filter((item) => item.method === 'approval.resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.data.optionId, null);
  await service.close();
});

test('a permission answered through the native option id settles selected', async () => {
  const agent = new QuestioningAgent('permission');
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, events);
  const created = await service.createSession({ cwd: '/workspace' });
  void service.beginTurn({ sessionId: created.session.id, input: [{ type: 'text', text: 'perm' }] });
  const requested = await waitForEvent(events, 'approval.requested');
  await service.respondApproval({
    sessionId: created.session.id,
    approvalId: String(requested.approvalId),
    nativeOptionId: 'allow',
  });
  await waitForEvent(events, 'turn.completed');
  assert.deepEqual(agent.reverseCalls[0]!.response, {
    outcome: { outcome: 'selected', optionId: 'allow' },
  });
  await service.close();
});

test('closing the session settles a parked permission before native close', async () => {
  const agent = new QuestioningAgent('permission');
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, events);
  const created = await service.createSession({ cwd: '/workspace' });
  void service.beginTurn({ sessionId: created.session.id, input: [{ type: 'text', text: 'perm' }] });
  await waitForEvent(events, 'approval.requested');
  await service.close();
  assert.equal(agent.reverseCalls.length, 1);
  assert.deepEqual(agent.reverseCalls[0]!.response, { outcome: { outcome: 'cancelled' } });
});

test('question outcome type covers the accepted annotation shape', () => {
  const outcome: QuestionOutcome = {
    kind: 'submitted',
    answers: { q: ['a'] },
    annotations: { q: { notes: 'freeform' } },
  };
  assert.equal(outcome.kind, 'submitted');
});

test('mcp elicit enforces schema length constraints before any native accept', async () => {
  const agent = new QuestioningAgent('elicit-schema');
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, events);
  const protocolEvents: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.8-test', (method, params) => {
    protocolEvents.push({ method, params: params as Record<string, unknown> });
  });
  const waitForProtocol = async (method: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const found = protocolEvents.find((event) => event.method === method);
      if (found) return found.params;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${method}; saw ${protocolEvents.map((item) => item.method).join(',')}`);
  };

  await adapter.handle({ id: 'i1', method: 'initialize', params: {
    protocol: { name: 'gian.proxy', versions: ['2.3'] },
    host: { name: 'Gian', version: '0.0.0' },
  } });
  const created = await adapter.handle({ id: 's1', method: 'session.create', params: {
    sessionId: 'host-elicit',
    workspace: { cwd: '/workspace', roots: ['/workspace'] },
    config: {},
  } }) as { session: { id: string; streamId: string } };
  await adapter.handle({ id: 't1', method: 'turn.start', params: {
    sessionId: created.session.id,
    streamId: created.session.streamId,
    turnId: 'turn-elicit',
    input: [{ type: 'text', text: 'elicit' }],
  } });
  const requested = await waitForProtocol('interaction.requested');
  const requestedData = requested.data as {
    interactionId: string;
    inputs: Array<{ id: string; minimumLength?: number; maximumLength?: number }>;
  };
  // The constraint is advertised to the Host…
  const token = requestedData.inputs.find((input) => input.id === 'token');
  assert.equal(token?.minimumLength, 5);
  assert.equal(token?.maximumLength, 10);

  const respond = (id: string, responseId: string, tokenValue: string) => adapter.handle({
    id,
    method: 'interaction.respond',
    params: {
      sessionId: created.session.id,
      streamId: created.session.streamId,
      turnId: 'turn-elicit',
      interactionId: requestedData.interactionId,
      responseId,
      actionId: 'submit',
      values: { path: '/tmp', level: 'rw', token: tokenValue },
    },
  });

  // …and enforced on submission: too short and too long are both rejected
  // before any native answer exists.
  await assert.rejects(
    respond('r1', 'resp-1', 'abc'),
    (error: unknown) => (error as { code?: number }).code === -32602
      && /at least 5 characters/.test((error as Error).message),
  );
  await assert.rejects(
    respond('r2', 'resp-2', 'x'.repeat(11)),
    (error: unknown) => (error as { code?: number }).code === -32602
      && /at most 10 characters/.test((error as Error).message),
  );
  assert.equal(agent.reverseCalls.length, 0);

  // A valid submission still accepts; the failed attempts settled nothing.
  await respond('r3', 'resp-3', 'abcde');
  await waitForProtocol('turn.completed');
  assert.deepEqual(agent.reverseCalls[0]!.response, {
    action: 'accept',
    content: { path: '/tmp', level: 'rw', token: 'abcde' },
  });
  await service.close();
});


async function adapterInteraction(mode: 'question' | 'plan', t: { after(fn: () => Promise<void>): void }) {
  const agent = new QuestioningAgent(mode);
  const serviceEvents: Array<{ method: string; data: Record<string, unknown> }> = [];
  const { service } = makeService(agent, serviceEvents);
  t.after(() => service.close());
  const events: Array<{ method: string; data: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter(service, '0.3.9-test', (method, params) => {
    events.push({ method, data: (params as { data: Record<string, unknown> }).data });
  });
  await adapter.handle({ id: 'init', method: 'initialize', params: {
    protocol: { name: 'gian.proxy', versions: ['2.3'] }, host: { name: 'Gian', version: '0.0.0' },
  } });
  const created = await adapter.handle({ id: 'create', method: 'session.create', params: {
    sessionId: `host-${mode}`, workspace: { cwd: '/workspace', roots: ['/workspace'] }, config: {},
  } }) as { session: { id: string; streamId: string } };
  const identity = { sessionId: created.session.id, streamId: created.session.streamId, turnId: `turn-${mode}` };
  await adapter.handle({ id: 'start', method: 'turn.start', params: {
    ...identity, input: [{ type: 'text', text: mode }],
  } });
  const requested = await waitForEvent(events, 'interaction.requested');
  return { agent, adapter, events, requested, identity };
}

test('Question cancel resolves as cancelled on the Host wire, including an identical retry', async (t) => {
  const { agent, adapter, events, requested, identity } = await adapterInteraction('question', t);
  const params = { ...identity, interactionId: requested.interactionId, responseId: 'cancel-once', actionId: 'cancel' };
  await adapter.handle({ id: 'cancel', method: 'interaction.respond', params });
  await waitForEvent(events, 'turn.completed');
  await adapter.handle({ id: 'cancel-retry', method: 'interaction.respond', params });
  assert.deepEqual(agent.reverseCalls[0]?.response, { outcome: 'cancelled' });
  const resolved = events.filter(event => event.method === 'interaction.resolved');
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0]?.data, { interactionId: requested.interactionId, outcome: 'cancelled' });
});

test('Plan return exposes optional feedback and sends it to the native cancelled outcome', async (t) => {
  const { agent, adapter, events, requested, identity } = await adapterInteraction('plan', t);
  const inputs = requested.inputs as Array<{ id: string; type: string; required: boolean }>;
  assert.deepEqual(inputs.map(input => [input.id, input.type, input.required]), [['feedback', 'text', false]]);
  await adapter.handle({ id: 'return-plan', method: 'interaction.respond', params: {
    ...identity, interactionId: requested.interactionId, responseId: 'return-once', actionId: 'cancel',
    values: { feedback: 'Only touch the Grok fixture.' },
  } });
  await waitForEvent(events, 'turn.completed');
  assert.deepEqual(agent.reverseCalls[0]?.response, { outcome: 'cancelled', feedback: 'Only touch the Grok fixture.' });
  assert.equal((await waitForEvent(events, 'interaction.resolved')).outcome, 'cancelled');
});
