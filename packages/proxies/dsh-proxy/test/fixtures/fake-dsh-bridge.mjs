#!/usr/bin/env node

import { createInterface } from 'node:readline';

const script = process.env.DSH_FAKE_SCRIPT ?? 'success';
const sessions = new Map();
// Native sessions ever created, keyed by nativeId, for session.resume
// re-attachment (Side Chat resume survives bridge-session loss).
const nativeSessions = new Map();
let sessionCounter = 0;
let interactionCounter = 0;

const SKILL_ID = `ci1_${'7'.repeat(32)}`;

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

function openTurnAt(events, boundary) {
  let open = null;
  for (let index = 0; index <= boundary && index < events.length; index += 1) {
    const candidate = events[index];
    if (candidate.type === 'turn/start' && typeof candidate.data.turn === 'number') open = candidate.data.turn;
    if (candidate.type === 'turn/end' && candidate.data.turn === open) open = null;
  }
  return open;
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
    defaultApprovalPolicy: 'ask',
    permissionPresets: [
      {
        id: 'workspace-write',
        label: 'Workspace Write',
        description: 'Write inside the workspace; wider retries require approval.',
        approvalPolicy: 'ask',
      },
      {
        id: 'danger-full-access',
        label: 'Full access',
        description: 'Full file access without approval prompts.',
        approvalPolicy: 'never',
      },
    ],
    defaultPermissionPreset: 'workspace-write',
    agentPresets: ['standard'],
    defaultAgentPreset: 'standard',
    slashCommands: [],
  };
}

function startTurn(params) {
  const state = session(params.sessionId);
  const turn = state.turns;
  state.turns += 1;
  state.openTurn = turn;
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

  if (script.startsWith('question') || script.startsWith('approval')) {
    const approval = script.startsWith('approval');
    interactionCounter += 1;
    const interactionId = `${approval ? 'approval' : 'question'}-${interactionCounter}`;
    state.pending = { interactionId, turn, step: 0 };
    notify('interaction.requested', {
      sessionId: params.sessionId,
      interactionId,
      kind: approval ? 'approval' : 'question',
      title: approval ? 'Approve bash' : 'Choose a file',
      description: approval ? 'Run tests' : 'Select the fake file to continue.',
      turn,
      step: 0,
      inputs: approval ? [] : [{
          id: 'file',
          type: 'single_select',
          label: 'File',
          required: true,
          choices: [
            { value: 'a', displayName: 'A' },
            { value: 'b', displayName: 'B' },
          ],
        }],
      actions: approval
        ? [
            { id: 'allow-once', label: 'Allow once', style: 'primary' },
            { id: 'reject', label: 'Reject', style: 'danger' },
          ]
        : [{ id: 'submit', label: 'Submit', style: 'primary' }],
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
  // Transient stream chunk: emitted on the live wire but NOT appended to the
  // durable event log, matching DSH 0.2.0-rc.2 behavior. The attempt/index pair is
  // the transient identity the proxy hashes for chunk deltas.
  notify('session.event', {
    sessionId: params.sessionId,
    type: 'assistant/chunk',
    data: {
      turn,
      step: 0,
      liveAttemptId: `attempt-${turn}`,
      liveChunkIndex: 0,
      chunk: { type: 'text-delta', text: 'hello from fake DSH' },
    },
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
  state.openTurn = null;
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
    nativeSeq: state.events.length - 1,
  });
  append(params.sessionId, 'step/end', { turn: pending.turn, step: pending.step });
  append(params.sessionId, 'turn/end', {
    turn: pending.turn,
    reason: { kind: 'completed' },
  });
  state.openTurn = null;
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
          version: '0.1.6',
        },
        runtime: {
          id: 'deepseek-harness',
          package: '@deepseek-ai/dsh',
          version: '0.2.0-rc.2',
          sessionFormatVersion: 4,
        },
        capabilities: {
          'session.events.read': 1,
          'session.fork': 1,
          'session.native.list': 1,
          'turn.interrupt': 1,
          'turn.steer': 1,
          interaction: 1,
          'input.attachments': 1,
          'input.skill': 1,
          'customization.skill': 1,
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
      nativeSessions.set(nativeId, { cwd: state.cwd, roots: state.roots, config: state.config });
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
    case 'session.resume': {
      if (sessions.has(params.sessionId)) {
        throw new Error(`CONFLICT: fake session ${params.sessionId} already exists`);
      }
      const known = nativeSessions.get(params.nativeSessionId);
      if (known === undefined) {
        throw new Error(`session "${params.nativeSessionId}" not found`);
      }
      sessions.set(params.sessionId, {
        nativeId: params.nativeSessionId,
        cwd: known.cwd,
        roots: known.roots,
        config: { ...known.config },
        createdAt: new Date().toISOString(),
        events: [],
        turns: 0,
        pending: null,
      });
      notify('agent.status', {
        sessionId: params.sessionId,
        nativeId: params.nativeSessionId,
        status: 'idle',
      });
      return {
        session: {
          id: params.sessionId,
          nativeId: params.nativeSessionId,
          cwd: known.cwd,
          roots: known.roots,
          state: 'idle',
          config: known.config,
          createdAt: new Date().toISOString(),
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
        formatVersion: 4,
        events,
        cursor: cursor + events.length < state.events.length
          ? String(cursor + events.length)
          : null,
      };
    }
    case 'session.close':
      sessions.delete(params.sessionId);
      return { ok: true };
    case 'session.native.list': {
      const summaries = [...sessions.entries()]
        .filter(([, state]) => state.parentNativeId === undefined)
        .map(([gianId, state]) => ({
          id: state.nativeId,
          cwd: state.cwd,
          updatedAt: state.createdAt,
        }));
      return { sessions: summaries, nextCursor: null };
    }
    case 'session.fork': {
      const source = session(params.sessionId);
      if (sessions.has(params.newSessionId)) {
        throw new Error(`CONFLICT: fake session ${params.newSessionId} already exists`);
      }
      if (params.anchor?.kind === 'turn') {
        const turnEnd = [...source.events]
          .reverse()
          .find((event) => event.type === 'turn/end' && event.data.turn === params.anchor.nativeTurn);
        if (turnEnd === undefined) {
          throw new Error(`FORK_BOUNDARY_UNAVAILABLE: native turn ${params.anchor.nativeTurn} has no verifiable turn/end boundary`);
        }
      } else {
        const open = openTurnAt(source.events, source.events.length - 1);
        if (open !== null) {
          throw new Error(`FORK_BOUNDARY_UNAVAILABLE: native head boundary is inside open turn ${open}`);
        }
      }
      sessionCounter += 1;
      const childNativeId = `native-${sessionCounter}`;
      sessions.set(params.newSessionId, {
        nativeId: childNativeId,
        cwd: source.cwd,
        roots: source.roots,
        config: { ...source.config },
        createdAt: new Date().toISOString(),
        events: [],
        turns: 0,
        pending: null,
        parentNativeId: source.nativeId,
      });
      nativeSessions.set(childNativeId, { cwd: source.cwd, roots: source.roots, config: source.config });
      notify('agent.status', { sessionId: params.newSessionId, nativeId: childNativeId, status: 'idle' });
      return {
        session: {
          id: params.newSessionId,
          nativeId: childNativeId,
          cwd: source.cwd,
          roots: source.roots,
          state: 'idle',
          config: source.config,
          createdAt: new Date().toISOString(),
        },
        parentNativeId: source.nativeId,
        atSeq: source.events.length - 1,
        seedEventCount: source.events.length,
        inheritedEventCount: source.events.length,
      };
    }
    case 'customization.list':
      if (params.kind !== 'skill') {
        return {
          kind: params.kind,
          status: 'provider_unsupported',
          completeness: 'none',
          observedAt: new Date().toISOString(),
          items: [],
          truncated: false,
          diagnostics: [{
            code: 'SOURCE_NOT_ENUMERABLE',
            message: 'This DSH build exposes no runtime enumeration API for this customization kind.',
          }],
        };
      }
      return {
        kind: 'skill',
        status: 'ok',
        completeness: 'effective',
        observedAt: new Date().toISOString(),
        items: [{
          id: SKILL_ID,
          kind: 'skill',
          name: 'fake-skill',
          description: 'Deterministic fake skill',
          activation: 'enabled',
          scope: { level: 'user', native: 'bundled' },
          origin: { kind: 'builtin', path: '/tmp/fake-skill/SKILL.md' },
          discovery: { method: 'provider_api' },
          skill: {
            format: 'agent-skill',
            entryPath: '/tmp/fake-skill/SKILL.md',
            invocation: 'bundled',
            userInvocable: true,
            modelInvocable: true,
          },
        }],
        truncated: false,
        diagnostics: [],
      };
    case 'customization.detail':
      if (params.kind !== 'skill' || params.id !== SKILL_ID) {
        return {
          kind: params.kind,
          id: params.id,
          status: 'unavailable',
          observedAt: new Date().toISOString(),
          text: '',
          truncated: false,
          diagnostics: [{ code: 'SOURCE_UNREADABLE', message: 'No skill matches this id in the runtime catalog.' }],
        };
      }
      return {
        kind: 'skill',
        id: params.id,
        status: 'ok',
        observedAt: new Date().toISOString(),
        text: 'Fake skill body.',
        truncated: false,
      };
    case 'turn.start':
      return startTurn(params);
    case 'turn.steer': {
      const state = session(params.sessionId);
      if (state.openTurn === undefined || state.openTurn === null) {
        throw new Error('TURN_NOT_FOUND: steering requires an open native turn; queue the input as a new turn instead.');
      }
      return { accepted: true, openTurn: state.openTurn };
    }
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
