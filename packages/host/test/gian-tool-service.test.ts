// GIAN-TOOL-001: Tool v0 mutations are idempotent, deliveries survive queue
// transitions, Turn config is snapshotted, and interactions can be answered
// without going through the WebSocket UI.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ProxyNotification,
  ServerToClientMessage,
  UserAgent,
  UserAgentStatus,
} from '@gian/shared';
import { ApprovalManager } from '../src/approval/index.js';
import type { AgentManager } from '../src/agents/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type {
  CreateSessionParams,
  NotificationHandler,
  ProxyClient,
  RespondInteractionParams,
  StartTurnParams,
} from '../src/proxy/types.js';
import { QueueManager } from '../src/queue/index.js';
import { SessionManager, type SessionAgentResolver } from '../src/session/manager.js';
import { openDatabase } from '../src/storage/db.js';
import { TaskManager } from '../src/task/manager.js';
import { GianToolService } from '../src/tool/service.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

const AGENT: UserAgent = {
  id: 'agent-claude-review',
  name: 'Claude Review',
  color: 'ember',
  proxy: 'claude',
  cliPath: null,
  defaults: { model: 'sonnet', thinking: 'high', mode: 'ask' },
};

class FakeProxyClient implements ProxyClient {
  readonly executor = 'claude' as const;
  notificationHandlers: NotificationHandler[] = [];
  startTurnCalls: StartTurnParams[] = [];
  interactionResponses: RespondInteractionParams[] = [];

  isExited() { return false; }
  async initialize() {
    return {
      protocol: { name: 'gian.proxy' as const, version: '2.0' as const },
      plugin: { id: 'claude', name: 'Claude', version: 'test' },
      process: { scope: 'session' as const },
      capabilities: {},
    };
  }
  async catalog() {
    return {
      catalogRevision: 'tool-test',
      input: [{ type: 'text' as const }],
      configOptions: [
        {
          id: 'model', displayName: 'Model', binding: 'turn' as const, role: 'model',
          control: 'select' as const, required: true, defaultValue: 'sonnet',
          choices: [{ value: 'sonnet', displayName: 'Sonnet' }],
        },
        {
          id: 'effort', displayName: 'Thinking', binding: 'turn' as const, role: 'effort',
          control: 'select' as const, required: true, defaultValue: 'high',
          choices: [{ value: 'high', displayName: 'High' }],
        },
        {
          id: 'mode', displayName: 'Mode', binding: 'turn' as const, role: 'approval_mode',
          control: 'select' as const, required: true, defaultValue: 'ask',
          choices: [
            { value: 'ask', displayName: 'Ask' },
            { value: 'auto', displayName: 'Auto' },
          ],
        },
      ],
      slashCommands: [],
    };
  }
  async createSession(params: CreateSessionParams) {
    return {
      session: {
        id: `proxy-${randomUUID()}`,
        cwd: params.cwd,
        state: 'idle' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
      },
      nativeSessionId: `native-${randomUUID()}`,
    };
  }
  async startTurn(params: StartTurnParams) {
    this.startTurnCalls.push(params);
    return {
      session: {
        id: params.sessionId,
        cwd: '/tmp/tool-test',
        state: 'running' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
      },
      turn: { id: `provider-turn-${this.startTurnCalls.length}` },
    };
  }
  async interruptTurn() {}
  async respondInteraction(params: RespondInteractionParams) {
    this.interactionResponses.push(params);
  }
  async closeSession() {}
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter(candidate => candidate !== handler);
    };
  }
  onExit() { return () => {}; }
  fire(notification: ProxyNotification): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }
}

class FakeProxyManager {
  readonly client = new FakeProxyClient();
  async getOrCreate(): Promise<ProxyClient> { return this.client; }
  get(): ProxyClient { return this.client; }
  async dispose() {}
  async forceDispose() {}
  async closeAll() {}
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(message: ServerToClientMessage): void { this.messages.push(message); }
  get size() { return 0; }
}

function agentStatus(): UserAgentStatus {
  return {
    ...AGENT,
    proxyName: 'Claude Code',
    ready: true,
    cli: { state: 'ready', path: '/test/claude', version: 'test', source: 'path' },
    plugin: {
      state: 'ready',
      path: '/test/cc-proxy',
      version: 'test',
      source: 'development',
      defaults: AGENT.defaults,
    },
    officialInstallUrl: 'https://example.invalid/claude',
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-tool-test-'));
  const db = openDatabase(dir);
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'Tool test', '/tmp/tool-test');

  const proxy = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const resolver: SessionAgentResolver = {
    cliPathForKind: () => null,
    cliPathForSession: () => null,
    requireCliPathForSession: () => null,
    agentRuntime: id => {
      if (id !== AGENT.id) throw new Error(`agent not found: ${id}`);
      return { agent: AGENT, cliPath: null };
    },
    agentsForKind: executor => executor === AGENT.proxy ? [AGENT] : [],
  };
  const sessions = new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    queue,
    dir,
    null,
    undefined,
    undefined,
    resolver,
  );
  approvals.setRespondFn((sessionId, approvalId, decision) => (
    sessions.respondApproval(sessionId, approvalId, decision)
  ));
  approvals.setGetModeFn(sessionId => sessions.getApprovalModeForActiveTurn(sessionId));

  const agents = {
    listAgents: () => [AGENT],
    getAgent: (id: string) => {
      if (id !== AGENT.id) throw new Error(`agent not found: ${id}`);
      return AGENT;
    },
    agentStatus: async (id: string) => {
      if (id !== AGENT.id) throw new Error(`agent not found: ${id}`);
      return agentStatus();
    },
    agentRuntimePath: () => ({ proxy: AGENT.proxy, cliPath: null }),
  } as unknown as AgentManager;
  const tasks = new TaskManager(db);
  const tool = new GianToolService({
    db,
    tasks,
    sessions,
    approvals,
    broadcaster: broadcaster as unknown as WsBroadcaster,
    agents,
  });
  return { dir, db, workspaceId, proxy, broadcaster, approvals, sessions, tasks, tool };
}

function teardown(context: ReturnType<typeof setup>): void {
  context.tool.close();
  context.db.close();
  rmSync(context.dir, { recursive: true, force: true });
}

function call(
  context: ReturnType<typeof setup>,
  method: string,
  params: Record<string, unknown>,
  idempotencyKey?: string,
) {
  return context.tool.call({
    request_id: randomUUID(),
    caller_id: 'test-caller',
    method,
    params,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  });
}

async function createToolSession(context: ReturnType<typeof setup>) {
  const result = await call(context, 'session.create', {
    workspace_id: context.workspaceId,
    agent_id: AGENT.id,
    config: { approval_mode: 'ask' },
  }, 'create-session');
  assert.equal(result.ok, true);
  return (result.data as { session: { id: string } }).session.id;
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('GIAN-TOOL-001: every mutation replays by caller id and idempotency key', async () => {
  const context = setup();
  try {
    const first = await call(context, 'task.create', { name: 'Review Tool API' }, 'task-create');
    const replay = await call(context, 'task.create', { name: 'Review Tool API' }, 'task-create');
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.data, first.data);
    assert.equal(context.tasks.listTasks().length, 1);

    const conflict = await call(context, 'task.create', { name: 'Different input' }, 'task-create');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error?.code, 'IDEMPOTENCY_CONFLICT');

    const missing = await call(context, 'task.update', {
      task_id: (first.data as { task: { id: string } }).task.id,
      pinned: true,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'INVALID_ARGUMENT');

    const simultaneousFirst = call(context, 'task.create', { name: 'Concurrent A' }, 'concurrent-key');
    const simultaneousConflict = await call(context, 'task.create', { name: 'Concurrent B' }, 'concurrent-key');
    assert.equal(simultaneousConflict.ok, false);
    assert.equal(simultaneousConflict.error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await simultaneousFirst).ok, true);
  } finally {
    teardown(context);
  }
});

test('GIAN-TOOL-001: queued delivery attaches to its Turn and keeps the send-time config snapshot', async () => {
  const context = setup();
  try {
    const sessionId = await createToolSession(context);
    const created = await call(context, 'session.get', { session_id: sessionId });
    assert.equal((created.data as { resolved_config: { agent_id: string } }).resolved_config.agent_id, AGENT.id);
    const first = await call(context, 'session.send', {
      session_id: sessionId,
      text: 'first message',
    }, 'send-first');
    assert.equal(first.ok, true);
    assert.equal((first.data as { state: string }).state, 'started');

    const update = await call(context, 'session.update', {
      session_id: sessionId,
      config: { approval_mode: 'auto' },
    }, 'update-config');
    assert.equal(update.ok, true);
    assert.equal((update.data as { active_turn_unchanged: boolean }).active_turn_unchanged, true);

    const queued = await call(context, 'session.send', {
      session_id: sessionId,
      text: 'queued message',
    }, 'send-queued');
    assert.equal(queued.ok, true);
    assert.equal((queued.data as { state: string }).state, 'queued');
    const deliveryId = (queued.data as { delivery_id: string }).delivery_id;

    // Simulate a stop after the queue row commits but before the delivery and
    // request ledgers commit. Recovery must adopt that row, not enqueue twice.
    context.db.prepare(
      `UPDATE tool_deliveries SET state = 'pending', queue_entry_id = NULL WHERE id = ?`,
    ).run(deliveryId);
    context.db.prepare(
      `UPDATE tool_requests
          SET status = 'in_progress', result_json = NULL
        WHERE caller_id = 'test-caller' AND idempotency_key = 'send-queued'`,
    ).run();
    const recoveredQueued = await call(context, 'session.send', {
      session_id: sessionId,
      text: 'queued message',
    }, 'send-queued');
    assert.equal(recoveredQueued.ok, true);
    assert.equal((recoveredQueued.data as { state: string }).state, 'queued');
    assert.equal(context.sessions.getQueue(sessionId).length, 1);

    const firstTurn = context.db.prepare(
      'SELECT config_json FROM turns WHERE session_id = ? ORDER BY turn_number LIMIT 1',
    ).get(sessionId) as { config_json: string };
    assert.equal((JSON.parse(firstTurn.config_json) as { approval_mode: string }).approval_mode, 'ask');

    context.proxy.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy-session', data: { status: 'completed' } },
    });
    await tick();
    assert.equal(context.proxy.client.startTurnCalls.length, 2);

    const afterDrain = await call(context, 'session.get', { session_id: sessionId });
    const delivery = (afterDrain.data as { latest_delivery: { delivery_id: string; state: string; turn_id: string } }).latest_delivery;
    assert.equal(delivery.delivery_id, deliveryId);
    assert.equal(delivery.state, 'started');
    assert.ok(delivery.turn_id);

    const secondTurn = context.db.prepare(
      'SELECT tool_request_id, config_json FROM turns WHERE session_id = ? ORDER BY turn_number DESC LIMIT 1',
    ).get(sessionId) as { tool_request_id: string; config_json: string };
    assert.ok(secondTurn.tool_request_id);
    assert.equal((JSON.parse(secondTurn.config_json) as { approval_mode: string }).approval_mode, 'auto');

    const invalidUpdate = await call(context, 'session.update', {
      session_id: sessionId,
      name: 'Must not partially apply',
      config: { model: 'not-advertised' },
    }, 'invalid-update');
    assert.equal(invalidUpdate.ok, false);
    assert.equal(invalidUpdate.error?.code, 'INVALID_ARGUMENT');
    assert.notEqual(context.sessions.getSession(sessionId).name, 'Must not partially apply');

    context.proxy.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy-session', data: { status: 'completed' } },
    });
    await tick();
    const waited = await call(context, 'session.wait', {
      session_id: sessionId,
      delivery_id: deliveryId,
      timeout_ms: 50,
    });
    assert.equal(waited.ok, true);
    assert.equal((waited.data as { outcome: string }).outcome, 'completed');
  } finally {
    teardown(context);
  }
});

test('GIAN-TOOL-001: Host restart settles a started delivery whose in-memory Turn was lost', async () => {
  const context = setup();
  try {
    const sessionId = await createToolSession(context);
    const sent = await call(context, 'session.send', {
      session_id: sessionId,
      text: 'interrupted by Host restart',
    }, 'send-before-restart');
    assert.equal(sent.ok, true);
    const deliveryId = (sent.data as { delivery_id: string }).delivery_id;
    const turnId = (sent.data as { turn_id: string }).turn_id;

    // A new Host has no in-memory ActiveTurn even though the durable rows still
    // say running/started. Forgetting only runtime state reproduces that edge.
    const runtime = context.sessions as unknown as {
      turns: { forget(sessionId: string): void };
    };
    runtime.turns.forget(sessionId);
    assert.equal(context.sessions.getActiveTurn(sessionId), null);

    const snapshot = await call(context, 'session.get', { session_id: sessionId });
    assert.equal(snapshot.ok, true);
    const data = snapshot.data as {
      session: { status: string };
      active_turn: unknown;
      latest_delivery: {
        delivery_id: string;
        state: string;
        session_id: string;
        turn_id: string;
        turn_number: number;
        config_snapshot: unknown;
      };
    };
    assert.equal(data.session.status, 'done');
    assert.equal(data.active_turn, null);
    assert.equal(data.latest_delivery.delivery_id, deliveryId);
    assert.equal(data.latest_delivery.state, 'stopped');
    assert.equal(data.latest_delivery.session_id, sessionId);
    assert.equal(data.latest_delivery.turn_id, turnId);
    assert.equal(data.latest_delivery.turn_number, 1);
    assert.ok(data.latest_delivery.config_snapshot);

    const waited = await call(context, 'session.wait', {
      session_id: sessionId,
      delivery_id: deliveryId,
      timeout_ms: 0,
    });
    assert.equal(waited.ok, true);
    assert.equal((waited.data as { outcome: string }).outcome, 'stopped');
    const turn = context.db.prepare('SELECT status FROM turns WHERE id = ?').get(turnId) as { status: string };
    assert.equal(turn.status, 'stopped');
  } finally {
    teardown(context);
  }
});

test('GIAN-TOOL-001: Tool projects and answers a pending question with tool attribution', async () => {
  const context = setup();
  try {
    const sessionId = await createToolSession(context);
    await call(context, 'session.send', { session_id: sessionId, text: 'ask me' }, 'send-question');
    context.proxy.client.fire({
      method: 'approval.requested',
      params: {
        sessionId: 'proxy-session',
        data: {
          approvalId: 'question-1',
          toolName: 'AskUserQuestion',
          inputPreview: JSON.stringify({
            questions: [{
              question: 'Which path?',
              header: 'Path',
              multiSelect: false,
              options: [
                { label: 'Conservative', description: 'Use the existing architecture.' },
                { label: 'Experimental', description: 'Try a new transport.' },
              ],
            }],
          }),
        },
      },
    });
    await tick();

    const listed = await call(context, 'interaction.list', { session_id: sessionId });
    const interaction = (listed.data as {
      interactions: Array<{ id: string; kind: string; questions: Array<{ options: Array<{ value: string }> }> }>;
    }).interactions[0]!;
    assert.equal(interaction.id, 'question-1');
    assert.equal(interaction.kind, 'question');
    assert.deepEqual(interaction.questions[0]!.options.map(option => option.value), [
      'Conservative',
      'Experimental',
    ]);

    const invalid = await call(context, 'interaction.respond', {
      session_id: sessionId,
      interaction_id: interaction.id,
      answers: { 'Which path?': 'Unadvertised' },
    }, 'answer-invalid');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error?.code, 'INVALID_INTERACTION_RESPONSE');

    const responded = await call(context, 'interaction.respond', {
      session_id: sessionId,
      interaction_id: interaction.id,
      answers: { 'Which path?': 'Conservative' },
    }, 'answer-valid');
    assert.equal(responded.ok, true);
    assert.equal(context.proxy.client.interactionResponses.length, 1);
    assert.deepEqual(context.proxy.client.interactionResponses[0]!.values, {
      'Which path?': 'Conservative',
    });

    context.db.prepare(
      `UPDATE tool_requests
          SET status = 'in_progress', result_json = NULL
        WHERE caller_id = 'test-caller' AND idempotency_key = 'answer-valid'`,
    ).run();
    const recovered = await call(context, 'interaction.respond', {
      session_id: sessionId,
      interaction_id: interaction.id,
      answers: { 'Which path?': 'Conservative' },
    }, 'answer-valid');
    assert.equal(recovered.ok, true);
    assert.equal(context.proxy.client.interactionResponses.length, 2);
    assert.equal(
      context.proxy.client.interactionResponses[1]!.responseId,
      context.proxy.client.interactionResponses[0]!.responseId,
      'crash recovery must reuse the Provider-idempotent response identity',
    );

    context.proxy.client.fire({
      method: 'approval.resolved',
      params: {
        sessionId: 'proxy-session',
        data: {
          approvalId: interaction.id,
          behavior: 'allow',
          answers: { 'Which path?': 'Conservative' },
        },
      },
    });
    await tick();
    context.db.prepare(
      `UPDATE tool_requests
          SET status = 'in_progress', result_json = NULL
        WHERE caller_id = 'test-caller' AND idempotency_key = 'answer-valid'`,
    ).run();
    const recoveredResolved = await call(context, 'interaction.respond', {
      session_id: sessionId,
      interaction_id: interaction.id,
      answers: { 'Which path?': 'Conservative' },
    }, 'answer-valid');
    assert.equal(recoveredResolved.ok, true);
    assert.equal(context.proxy.client.interactionResponses.length, 3);
    assert.equal(
      context.proxy.client.interactionResponses[2]!.responseId,
      context.proxy.client.interactionResponses[0]!.responseId,
    );
    const update = context.broadcaster.messages.find(message => (
      message.type === 'approval:updated' && message.approval.id === interaction.id
    ));
    assert.equal(update?.type, 'approval:updated');
    if (update?.type === 'approval:updated') assert.equal(update.approval.resolved_by, 'tool');

    const read = await call(context, 'session.read', {
      session_id: sessionId,
      turns: 1,
      view: 'messages',
    });
    const summaries = (read.data as {
      turns: Array<{ interactions: Array<{ id: string; status: string; decision: string }> }>;
    }).turns[0]!.interactions;
    assert.deepEqual(summaries.map(summary => ({
      id: summary.id,
      status: summary.status,
      decision: summary.decision,
    })), [{ id: interaction.id, status: 'resolved', decision: 'allow_once' }]);
  } finally {
    teardown(context);
  }
});

test('GIAN-TOOL-001: native choices expose only native_option_id responses', async () => {
  const context = setup();
  try {
    const sessionId = await createToolSession(context);
    await call(context, 'session.send', { session_id: sessionId, text: 'request native approval' }, 'send-native');
    const turnId = context.sessions.getActiveTurn(sessionId)!.id;
    void context.approvals.request({
      sessionId,
      turnId,
      category: 'other',
      risk: 'medium',
      description: 'Allow the external write?',
      payload: { approvalId: 'native-choice-1' },
      nativeOptions: [
        { optionId: 'accept', label: 'Accept', kind: 'accept' },
        { optionId: 'acceptForSession', label: 'Accept for session', kind: 'acceptForSession' },
        { optionId: 'decline', label: 'Decline', kind: 'decline' },
      ],
    });
    await tick();

    const listed = await call(context, 'interaction.list', { session_id: sessionId });
    const interaction = (listed.data as {
      interactions: Array<{
        id: string;
        kind: string;
        allowed_decisions: string[];
        native_options: Array<{ optionId: string }>;
      }>;
    }).interactions[0]!;
    assert.equal(interaction.kind, 'native_choice');
    assert.deepEqual(interaction.allowed_decisions, []);
    assert.deepEqual(interaction.native_options.map(option => option.optionId), [
      'accept',
      'acceptForSession',
      'decline',
    ]);

    const genericDecision = await call(context, 'interaction.respond', {
      session_id: sessionId,
      interaction_id: interaction.id,
      decision: 'allow_once',
    }, 'native-generic-invalid');
    assert.equal(genericDecision.ok, false);
    assert.equal(genericDecision.error?.code, 'INVALID_INTERACTION_RESPONSE');

    const responded = await call(context, 'interaction.respond', {
      session_id: sessionId,
      interaction_id: interaction.id,
      native_option_id: 'accept',
    }, 'native-valid');
    assert.equal(responded.ok, true);
    assert.equal(context.proxy.client.interactionResponses[0]!.actionId, 'accept');
  } finally {
    teardown(context);
  }
});

test('GIAN-TOOL-001: minimum public-contract journey reaches a completed Task', async () => {
  const context = setup();
  try {
    const catalog = await call(context, 'catalog.get_create_options', { refresh: false });
    assert.equal(catalog.ok, true);
    assert.equal((catalog.data as { workspaces: Array<{ id: string }> }).workspaces[0]!.id, context.workspaceId);
    assert.equal((catalog.data as { agents: Array<{ id: string }> }).agents[0]!.id, AGENT.id);

    const taskResult = await call(context, 'task.create', {
      name: 'Public contract journey',
    }, 'journey-task');
    const taskId = (taskResult.data as { task: { id: string } }).task.id;
    const sessionResult = await call(context, 'session.create', {
      workspace_id: context.workspaceId,
      task_id: taskId,
      agent_id: AGENT.id,
      config: { approval_mode: 'ask' },
    }, 'journey-session');
    assert.equal(sessionResult.ok, true);
    const created = sessionResult.data as {
      session: { id: string; type: string; task_id: string };
      agent: { id: string; name: string };
    };
    assert.equal(created.session.type, 'subtask');
    assert.equal(created.session.task_id, taskId);
    assert.deepEqual(created.agent, {
      id: AGENT.id,
      name: AGENT.name,
      color: AGENT.color,
      proxy: AGENT.proxy,
      defaults: AGENT.defaults,
    });

    const firstSend = await call(context, 'session.send', {
      session_id: created.session.id,
      text: 'Choose a path and finish the task.',
    }, 'journey-send-1');
    const firstDelivery = (firstSend.data as { delivery_id: string }).delivery_id;
    context.proxy.client.fire({
      method: 'approval.requested',
      params: {
        sessionId: 'proxy-session',
        data: {
          approvalId: 'journey-question',
          toolName: 'AskUserQuestion',
          inputPreview: JSON.stringify({
            questions: [{
              question: 'Proceed?',
              multiSelect: false,
              options: [{ label: 'Yes' }, { label: 'No' }],
            }],
          }),
        },
      },
    });
    await tick();
    const needsInteraction = await call(context, 'session.wait', {
      session_id: created.session.id,
      delivery_id: firstDelivery,
      timeout_ms: 25,
    });
    assert.equal((needsInteraction.data as { outcome: string }).outcome, 'needs_interaction');

    const answered = await call(context, 'interaction.respond', {
      session_id: created.session.id,
      interaction_id: 'journey-question',
      answers: { 'Proceed?': 'Yes' },
    }, 'journey-answer');
    assert.equal(answered.ok, true);
    context.proxy.client.fire({
      method: 'approval.resolved',
      params: {
        sessionId: 'proxy-session',
        data: { approvalId: 'journey-question', behavior: 'allow', answers: { 'Proceed?': 'Yes' } },
      },
    });
    context.proxy.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy-session', data: { status: 'completed' } },
    });
    await tick();
    const firstWait = await call(context, 'session.wait', {
      session_id: created.session.id,
      delivery_id: firstDelivery,
      timeout_ms: 25,
    });
    assert.equal((firstWait.data as { outcome: string }).outcome, 'completed');

    const updated = await call(context, 'session.update', {
      session_id: created.session.id,
      config: { approval_mode: 'auto' },
    }, 'journey-update');
    assert.equal((updated.data as { resolved_config: { approval_mode: string } }).resolved_config.approval_mode, 'auto');
    const secondSend = await call(context, 'session.send', {
      session_id: created.session.id,
      text: 'Finish without asking again.',
    }, 'journey-send-2');
    const secondDelivery = (secondSend.data as { delivery_id: string }).delivery_id;
    context.proxy.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy-session', data: { status: 'completed' } },
    });
    await tick();
    const secondWait = await call(context, 'session.wait', {
      session_id: created.session.id,
      delivery_id: secondDelivery,
      timeout_ms: 25,
    });
    assert.equal((secondWait.data as {
      outcome: string;
      turn: { config_snapshot: { approval_mode: string } };
    }).outcome, 'completed');
    assert.equal((secondWait.data as {
      turn: { config_snapshot: { approval_mode: string } };
    }).turn.config_snapshot.approval_mode, 'auto');

    const completed = await call(context, 'session.set_subtask_state', {
      session_id: created.session.id,
      state: 'completed',
    }, 'journey-complete-subtask');
    assert.ok((completed.data as { session: { completed_at: string } }).session.completed_at);
    const done = await call(context, 'task.update', {
      task_id: taskId,
      status: 'done',
    }, 'journey-complete-task');
    assert.equal((done.data as { task: { status: string } }).task.status, 'done');

    const closedSend = await call(context, 'session.send', {
      session_id: created.session.id,
      text: 'This must remain closed.',
    }, 'journey-send-closed');
    assert.equal(closedSend.ok, false);
    assert.equal(closedSend.error?.code, 'SESSION_CLOSED');

    const read = await call(context, 'session.read', {
      session_id: created.session.id,
      turns: 3,
      view: 'messages',
    });
    assert.equal((read.data as { turns: unknown[] }).turns.length, 2);
  } finally {
    teardown(context);
  }
});
