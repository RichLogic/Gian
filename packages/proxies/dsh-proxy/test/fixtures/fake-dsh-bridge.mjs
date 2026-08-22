#!/usr/bin/env node

import { createInterface } from 'node:readline';

const script = process.env.DSH_FAKE_SCRIPT ?? 'success';
const sessions = new Map();
let sessionCounter = 0;
let interactionCounter = 0;

function write(value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
}

function notify(method, params) {
  write({ method, params });
}

function session(sessionId) {
  const found = sessions.get(sessionId);
  if (!found) throw new Error(`missing fake session ${sessionId}`);
  return found;
}

function append(sessionId, type, data) {
  const state = session(sessionId);
  const record = { type, seq: state.events.length, time: Date.now(), data };
  state.events.push(record);
  notify('session.event', {
    sessionId,
    nativeSeq: record.seq,
    type,
    data,
  });
}

function catalog() {
  return {
    catalogRevision: 'fake-dsh-cli-1',
    providers: [{ id: 'deepseek', label: 'DeepSeek' }],
    models: [
      { id: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', provider: 'deepseek', label: 'DeepSeek Reasoner' },
    ],
    effortLevels: ['low', 'medium', 'high'],
    approvalPolicies: ['ask', 'never'],
    agentPresets: ['standard'],
    slashCommands: [],
  };
}

function startTurn(params) {
  const state = session(params.sessionId);
  const turn = state.turns;
  state.turns += 1;
  append(params.sessionId, 'turn/start', { turn });
  append(params.sessionId, 'user/message', {
    turn,
    step: 0,
    source: 'gian',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  });
  notify('agent.status', {
    sessionId: params.sessionId,
    nativeId: state.nativeId,
    status: 'running',
    turn,
  });
  if (!script.endsWith('-no-claim')) {
    notify('session.event', {
      sessionId: params.sessionId,
      nativeSeq: state.events.length - 1,
      type: 'agent/inbox/claimed',
      data: { turn, messageId: `message-${turn}` },
    });
  }
  append(params.sessionId, 'step/start', { turn, step: 0 });
  append(params.sessionId, 'request/header', {
    turn,
    step: 0,
    reason: 'initial',
    header: {
      config: { provider: 'deepseek', model: 'deepseek-chat' },
      system: 'fake system prompt',
      tools: [{ name: 'read_file' }],
    },
  });

  if (script.startsWith('question')) {
    interactionCounter += 1;
    const interactionId = `question-${interactionCounter}`;
    state.pending = { interactionId, turn, step: 0 };
    notify('interaction.requested', {
      sessionId: params.sessionId,
      interactionId,
      kind: 'question',
      title: 'Choose a file',
      description: 'Select the fake file to continue.',
      turn,
      step: 0,
      inputs: [{
        id: 'file',
        type: 'single_select',
        label: 'File',
        required: true,
        choices: [
          { value: 'a', displayName: 'A' },
          { value: 'b', displayName: 'B' },
        ],
      }],
      actions: [{ id: 'submit', label: 'Submit', style: 'primary' }],
    });
    return { accepted: true };
  }

  append(params.sessionId, 'request/context', {
    turn,
    step: 0,
    provider: 'deepseek',
    model: 'deepseek-chat',
    contextWindow: 128000,
  });
  append(params.sessionId, 'assistant/chunk', {
    turn,
    step: 0,
    chunk: { type: 'text-delta', text: 'hello from fake DSH' },
  });
  append(params.sessionId, 'assistant/message', {
    turn,
    step: 0,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello from fake DSH' }],
    },
    usage: { inputTokens: 10, outputTokens: 4 },
  });
  append(params.sessionId, 'step/end', { turn, step: 0 });
  append(params.sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
  return { accepted: true };
}

function resolveInteraction(params) {
  const state = session(params.sessionId);
  const pending = state.pending;
  if (!pending || pending.interactionId !== params.interactionId) {
    throw new Error(`interaction ${params.interactionId} is not pending`);
  }
  state.pending = null;
  notify('interaction.resolved', {
    sessionId: params.sessionId,
    interactionId: pending.interactionId,
    outcome: 'submitted',
    actionId: params.actionId,
    displaySummary: 'A',
  });
  append(params.sessionId, 'step/end', { turn: pending.turn, step: pending.step });
  append(params.sessionId, 'turn/end', {
    turn: pending.turn,
    reason: { kind: 'completed' },
  });
  return { accepted: true };
}

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocol: { name: 'gian.dsh.bridge', version: '1.0' },
        plugin: {
          id: 'ai.deepseek.harness',
          bundle: '@gian/dsh-bridge',
          version: '0.1.0',
        },
        runtime: {
          id: 'deepseek-harness',
          package: '@deepseek-ai/dsh',
          version: '0.1.0-rc.7',
          sessionFormatVersion: 0,
        },
        capabilities: {
          'session.resume': 1,
          'session.events.read': 1,
          'turn.interrupt': 1,
          interaction: 1,
          'event.step': 1,
          'event.request': 1,
          'event.usage': 1,
        },
      };
    case 'catalog.list':
      return catalog();
    case 'catalog.resolve':
      return {
        ...catalog(),
        resolvedDefaults: {
          sessionConfig: params.sessionConfig ?? {},
          turnConfig: params.turnConfig ?? {},
        },
      };
    case 'session.create': {
      sessionCounter += 1;
      const nativeId = `native-${sessionCounter}`;
      const state = {
        nativeId,
        cwd: params.workspace.cwd,
        roots: params.workspace.roots,
        config: params.config ?? {},
        createdAt: new Date().toISOString(),
        events: [],
        turns: 0,
        pending: null,
      };
      sessions.set(params.sessionId, state);
      notify('agent.status', {
        sessionId: params.sessionId,
        nativeId,
        status: 'idle',
      });
      return {
        session: {
          id: params.sessionId,
          nativeId,
          cwd: state.cwd,
          roots: state.roots,
          state: 'idle',
          config: state.config,
          createdAt: state.createdAt,
        },
      };
    }
    case 'session.get': {
      const state = session(params.sessionId);
      return {
        session: {
          id: params.sessionId,
          nativeId: state.nativeId,
          cwd: state.cwd,
          roots: state.roots,
          state: 'idle',
          config: state.config,
          createdAt: state.createdAt,
        },
      };
    }
    case 'session.events.read': {
      const state = session(params.sessionId);
      const cursor = params.cursor === null || params.cursor === undefined
        ? 0
        : Number(params.cursor);
      const limit = typeof params.limit === 'number' ? params.limit : 500;
      const events = state.events.slice(cursor, cursor + limit);
      return {
        sessionId: params.sessionId,
        formatVersion: 0,
        events,
        cursor: cursor + events.length < state.events.length
          ? String(cursor + events.length)
          : null,
      };
    }
    case 'session.close':
      sessions.delete(params.sessionId);
      return { ok: true };
    case 'turn.start':
      return startTurn(params);
    case 'turn.steer':
    case 'turn.interrupt':
      return { accepted: true };
    case 'interaction.respond':
      return resolveInteraction(params);
    case 'shutdown':
      return { ok: true };
    default: {
      const error = new Error(`Unknown method ${method}`);
      error.code = -32601;
      throw error;
    }
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.trim() === '') continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    write({ id: null, error: { code: -32700, message: 'Parse error' } });
    continue;
  }
  try {
    const result = await handle(request.method, request.params ?? {});
    write({ id: request.id, result });
  } catch (caught) {
    write({
      id: request.id,
      error: {
        code: typeof caught?.code === 'number' ? caught.code : -32603,
        message: caught instanceof Error ? caught.message : String(caught),
      },
    });
  }
}
