#!/usr/bin/env node
/**
 * Scriptable fake ZCode Protocol v1 app-server for zcode-proxy tests.
 *
 * Usage: node fake-app-server.mjs app-server --cwd <dir>
 *   (argv is accepted and ignored so the spawn contract matches zcode.cjs)
 * Scenario: FAKE_SCENARIO env var points at a JSON file.
 *
 * The fake records every request it receives into FAKE_LOG (JSONL) so tests
 * can assert exact wire behavior, e.g. that catalog.list never calls
 * session/create, or the exact permission response payload.
 */

import fs from 'node:fs';
import { createInterface } from 'node:readline';

const scenarioPath = process.env.FAKE_SCENARIO;
const logPath = process.env.FAKE_LOG;
const scenario = scenarioPath ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
const log = (entry) => {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

let nextServerId = 1;
const state = {
  sessions: [], // created native session ids (in order)
  model: scenario.initialModel ?? { providerId: 'bigmodel', modelId: 'GLM-5.3-Flash' },
  thoughtLevel: scenario.initialThoughtLevel ?? 'max',
  mode: scenario.initialMode ?? 'build',
  activeTurn: null,
  subscribedSessions: new Set(),
  answeredPermissions: [],
};

function write(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeRaw(text) {
  process.stdout.write(text);
}

function reply(id, result) {
  write({ id, result });
}

function replyError(id, error) {
  write({ id, error });
}

function reverseRequest(method, params) {
  return new Promise((resolve) => {
    const id = `server-${nextServerId++}`;
    pendingReverses.set(id, resolve);
    write({ id, method, params });
  });
}

const pendingReverses = new Map();

async function sleep(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTurnScript(script, sessionId) {
  const turnId = script.turnId ?? `turn_${Math.random().toString(36).slice(2, 10)}`;
  state.activeTurn = { sessionId, turnId };
  await sleep(script.delayBefore ?? 10);
  if (scenario.behavior?.requireSubscribe && !state.subscribedSessions.has(sessionId)) {
    state.activeTurn = null;
    return;
  }
  if (script.turnStartedEvent !== false) {
    write({
      method: 'computer-use/operation-event',
      params: {
        eventId: `evt_cu_${turnId}`,
        sequenceNumber: 1,
        sessionId,
        timestamp: Date.now(),
        kind: 'turn-started',
        turnId,
      },
    });
  }
  if (scenario.behavior?.crashAfterTurnStarted) process.exit(9);
  if (script.providerBusinessError) {
    const code = script.providerBusinessError.code ?? '1113';
    process.stderr.write(`ProviderBusinessError: [${code}][fixture provider rejection][fixture-request]\n`);
    state.activeTurn = null;
    return;
  }
  if (script.permissionRequest) {
    const answer = await reverseRequest('interaction/requestPermission', {
      sessionId,
      turnId,
      requestId: script.permissionRequest.requestId ?? 'perm-1',
      toolCallId: 'call_1',
      toolName: script.permissionRequest.toolName ?? 'Bash',
      reason: 'Run a shell command',
      riskLevel: script.permissionRequest.riskLevel ?? 'medium',
      input: { command: script.permissionRequest.command ?? 'echo hi' },
      options: script.permissionRequest.options ?? [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once', response: { decision: 'allow', reason: 'Approved once' } },
        { optionId: 'allow_project', kind: 'allow_always', name: 'Always allow in this project', response: { decision: 'allow', permissionUpdates: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] }], reason: 'Approved for this project' } },
        { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny', reason: 'Denied' } },
      ],
    });
    state.answeredPermissions.push({ requestId: script.permissionRequest.requestId ?? 'perm-1', answer });
  }
  for (const event of script.events ?? []) {
    if (event.op === 'wait') {
      await sleep(event.ms ?? 10);
      continue;
    }
    const nativeEventId = event.eventId ?? `evt_${Math.random().toString(36).slice(2, 10)}`;
    if (event.channel === 'computer-use') {
      write({
        method: 'computer-use/operation-event',
        params: {
          eventId: nativeEventId,
          sequenceNumber: event.sequenceNumber ?? 1,
          sessionId,
          timestamp: Date.now(),
          kind: event.kind,
          turnId: event.turnId ?? turnId,
        },
      });
      continue;
    }
    write({
      method: 'session/event',
      params: {
        deliveryKind: 'desktop-continuous',
        eventId: nativeEventId,
        seq: event.seq ?? 1,
        sessionId,
        timestamp: Date.now(),
        ...(event.type ? { type: event.type } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        payload: event.payload,
      },
    });
  }
  state.activeTurn = null;
}

function defaultReadState() {
  return scenario.readState ?? {
    session: { status: 'idle', mode: state.mode, model: state.model },
    settings: {
      mode: { current: state.mode },
      permission: { mode: state.mode },
      model: {
        current: state.model,
        available: scenario.availableModels ?? [
          {
            ref: state.model,
            label: 'GLM-5.3-Flash',
            providerLabel: 'BigModel - Coding Plan',
            contextWindow: 1_000_000,
            maxOutputTokens: 128_000,
            supportsImages: true,
            reasoning: {
              enabled: true,
              levels: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
              defaultLevel: 'max',
            },
          },
        ],
      },
      thoughtLevel: { available: [{ value: 'low' }, { value: 'high' }, { value: 'max' }], current: state.thoughtLevel, defaultLevel: 'max', enabled: true },
    },
    slashCommands: [
      { name: 'goal', description: 'Show or set the current session goal.', source: 'builtin', inputHint: '/goal [objective]' },
    ],
    protocol: { name: 'ZCode Protocol', version: 1 },
  };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Single reader handles BOTH directions: proxy requests ({id, method, params})
// and the proxy's answers to our reverse requests ({id: "server-N", result}).
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let envelope;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    log({ kind: 'unparseable' });
    return;
  }
  if (
    envelope.method === undefined
    && typeof envelope.id === 'string'
    && pendingReverses.has(envelope.id)
  ) {
    const resolveReverse = pendingReverses.get(envelope.id);
    pendingReverses.delete(envelope.id);
    resolveReverse(envelope);
    log({ kind: 'reverse-answer', id: envelope.id, result: envelope.result, error: envelope.error });
    return;
  }
  log({ kind: 'request', id: envelope.id, method: envelope.method, params: envelope.params });
  void handle(envelope);
});

async function handle(request) {
  const { id, method, params } = request;
  switch (method) {
    case 'workspace/readState': {
      if (scenario.behavior?.crashCatalogOnce && scenarioPath) {
        const marker = `${scenarioPath}.catalog-crashed`;
        if (!fs.existsSync(marker)) {
          fs.writeFileSync(marker, 'crashed\n');
          process.exit(9);
        }
      }
      reply(id, defaultReadState());
      return;
    }
    case 'session/list': {
      const sessions = (scenario.list ?? []).filter((entry) => !state.sessions.includes(entry.sessionId));
      reply(id, { sessions });
      return;
    }
    case 'session/create': {
      if (scenario.behavior?.failCreate) {
        replyError(id, { code: -32603, message: 'Model config is missing.' });
        return;
      }
      const sessionId = `sess_${Math.random().toString(36).slice(2, 12)}`;
      state.sessions.push(sessionId);
      await reverseRequest('session/requestRuntimePreferences', { sessionId, scope: 'runtime-materialization' });
      await reverseRequest('interaction/requestOfficialMcpAuthHeaders', {
        sessionId, mcpKey: 'image_search', requestId: 'official-mcp-auth:1',
      });
      const readState = defaultReadState();
      reply(id, {
        messages: [],
        protocol: readState.protocol,
        session: {
          sessionId,
          mode: state.mode,
          model: state.model,
          status: 'idle',
          title: '',
          workspace: params.workspace,
        },
        settings: readState.settings,
        slashCommands: readState.slashCommands,
      });
      return;
    }
    case 'session/subscribe': {
      state.subscribedSessions.add(params.sessionId);
      reply(id, { eventSeq: 0, events: [], sessionId: params.sessionId });
      return;
    }
    case 'session/read': {
      const readState = defaultReadState();
      const active = state.sessions.includes(params.sessionId);
      if (!active && scenario.knownSessions?.includes(params.sessionId) !== true) {
        replyError(id, { code: -32004, message: `Session is not active: ${params.sessionId}` });
        return;
      }
      reply(id, {
        ...readState,
        session: {
          ...readState.session,
          sessionId: params.sessionId,
          status: state.activeTurn?.sessionId === params.sessionId ? 'running' : 'idle',
          workspace: { workspacePath: '/tmp/fake-ws', workspaceKey: '/tmp/fake-ws' },
        },
      });
      return;
    }
    case 'session/resume': {
      if (
        scenario.knownSessions?.includes(params.sessionId) !== true
        && state.sessions.includes(params.sessionId) === false
      ) {
        replyError(id, { code: -32004, message: `Session not found: ${params.sessionId}` });
        return;
      }
      if (scenario.behavior?.failResume) {
        replyError(id, { code: -32004, message: `Session not found: ${params.sessionId}` });
        return;
      }
      if (state.sessions.includes(params.sessionId) === false) state.sessions.push(params.sessionId);
      write({
        method: 'session/event',
        params: {
          deliveryKind: 'desktop-continuous',
          eventId: `evt_resume_${params.sessionId}`,
          seq: 1,
          sessionId: params.sessionId,
          timestamp: Date.now(),
          payload: { type: 'session.resumed', directory: '/tmp/fake-ws' },
        },
      });
      reply(id, { sessionId: params.sessionId });
      return;
    }
    case 'session/send': {
      if (state.activeTurn !== null) {
        replyError(id, { code: -32603, message: 'A turn is already running.' });
        return;
      }
      state.activeTurn = { sessionId: params.sessionId, turnId: 'pending' };
      state.activeTurn = null;
      reply(id, { accepted: true, sessionId: params.sessionId, stateRevision: 1 });
      const script = scenario.turn ?? {};
      setImmediate(() => {
        void runTurnScript(script, params.sessionId).then(() => {
          if (scenario.behavior?.crashAfterTurn) process.exit(9);
        });
      });
      return;
    }
    case 'session/stop': {
      log({ kind: 'stop' });
      reply(id, {});
      return;
    }
    case 'v4/command': {
      log({ kind: 'v4-command', params });
      if (params.type !== 'stop' || typeof params.issuedAt !== 'number') {
        reply(id, {
          ack: {
            commandId: params.commandId ?? '',
            status: 'rejected',
            reasonCode: 'proto.invalidPayload',
            revisionAtDecision: 1,
          },
        });
        return;
      }
      reply(id, {
        ack: {
          commandId: params.commandId,
          status: 'accepted',
          revisionAtDecision: 1,
        },
      });
      return;
    }
    case 'session/setModel': {
      const known = (scenario.availableModels ?? []).some(
        (model) => model.ref?.providerId === params.model?.providerId
          && model.ref?.modelId === params.model?.modelId,
      );
      if (!known) {
        replyError(id, {
          code: -32603,
          message: `Unsupported model: ${params.model?.providerId}/${params.model?.modelId}. Available models: bigmodel/GLM-5.3-Flash.`,
        });
        return;
      }
      state.model = params.model;
      reply(id, { ok: true });
      return;
    }
    case 'session/setThoughtLevel': {
      if (typeof params.thoughtLevel !== 'string') {
        replyError(id, { code: -32602, message: 'Invalid params — thoughtLevel is required' });
        return;
      }
      state.thoughtLevel = params.thoughtLevel;
      reply(id, { ok: true });
      return;
    }
    case 'session/setMode': {
      const known = ['plan', 'build', 'edit', 'yolo', 'auto'];
      if (known.includes(params.mode) === false) {
        replyError(id, { code: -32602, message: 'Invalid params — mode: Invalid option' });
        return;
      }
      state.mode = params.mode;
      reply(id, { ok: true });
      return;
    }
    case 'session/messages': {
      reply(id, { messages: scenario.messages ?? [] });
      return;
    }
    case 'session/events': {
      reply(id, { events: scenario.events ?? [], eventSeq: scenario.eventSeq ?? 0, sessionId: params.sessionId });
      return;
    }
    case 'session/close': {
      log({ kind: 'inner-close-called' });
      reply(id, { closed: true });
      return;
    }
    default: {
      replyError(id, { code: -32601, message: `Method not found: ${method}` });
    }
  }
}

// Oversized-line / malformed-line probes.
if (scenario.behavior?.emitGarbageOnStart) {
  writeRaw('not-json\n');
}
if (scenario.behavior?.emitFragmentOnStart) {
  writeRaw('{"method":"session/event","params":{"seq":0}}');
  setTimeout(() => writeRaw('\n'), 20);
}
