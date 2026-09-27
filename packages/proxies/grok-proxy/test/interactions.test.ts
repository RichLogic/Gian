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

  constructor(private readonly mode: 'question' | 'plan' | 'elicit') {}

  bind(client: Client): void {
    this.clientRef = client;
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
        const method = self.mode === 'question'
          ? 'x.ai/ask_user_question'
          : self.mode === 'plan' ? 'x.ai/exit_plan_mode' : 'x.ai/mcp/elicit';
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
      new AgentSideConnection(() => agent.agent(), agentStream);
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
  assert.equal(agent.reverseCalls[0]!.response, 'decline');
  await service.close();
});

test('question outcome type covers the accepted annotation shape', () => {
  const outcome: QuestionOutcome = {
    kind: 'submitted',
    answers: { q: ['a'] },
    annotations: { q: { notes: 'freeform' } },
  };
  assert.equal(outcome.kind, 'submitted');
});
