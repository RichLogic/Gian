#!/usr/bin/env node
/**
 * Scriptable fake ZCode CLI 0.16.9 app-server for zcode-proxy tests.
 *
 * Usage: node fake-app-server.mjs app-server --stdio --surface desktop
 *   (argv is accepted and ignored so the spawn contract matches zcode.cjs)
 * Scenario: FAKE_SCENARIO env var points at a JSON file.
 *
 * The fake records every request it receives into FAKE_LOG (JSONL) so tests
 * can assert exact wire behavior, e.g. that sendText carries the exact
 * attachment refs, or that forkAssistant passes the CAS watermark.
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
  sessions: [], // known native session ids (created, resumed, or forked)
  // Sessions created through the LEGACY session/create surface. Real 0.16.9
  // keeps those rows outside the v4 conversation store, so a v4 sendText
  // against them dies on the session_input foreign key — the fake reproduces
  // that boundary instead of accepting anything.
  legacySessions: [],
  model: scenario.initialModel ?? { providerId: 'bigmodel', modelId: 'GLM-5.3-Flash' },
  thoughtLevel: scenario.initialThoughtLevel ?? 'max',
  mode: scenario.initialMode ?? 'build',
  activeTurn: null,
  subscribedSessions: new Set(),
  answeredPermissions: [],
  answeredUserInputs: [],
  steerCommands: [],
  sendCommands: [],
};

function availableModels() {
  return scenario.availableModels ?? [
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
  ];
}

/** Mirror the real registry's Selection validation (zcode.cjs
 *  resolveRegistryOwnedModelSelection): model must exist, a model whose
 *  reasoning is enabled requires options.reasoningLevel, and the requested
 *  level must be in the TARGET model's own vocabulary. */
function validateModelSelection(model) {
  const info = availableModels().find(
    (entry) => entry.ref?.providerId === model?.providerId && entry.ref?.modelId === model?.modelId,
  );
  if (!info) {
    return {
      code: -32603,
      message: `Unsupported model: ${model?.providerId}/${model?.modelId}. Available models: bigmodel/GLM-5.3-Flash.`,
    };
  }
  const levels = (info.reasoning?.levels ?? []).map((level) => level.value);
  const requested = model?.options?.reasoningLevel;
  if (requested === undefined) {
    if (info.reasoning?.enabled && levels.length > 0) {
      return { code: -32603, message: `Reasoning level is required for ${model.providerId}/${model.modelId}` };
    }
    return null;
  }
  if (!levels.includes(requested)) {
    return {
      code: -32603,
      message: `Reasoning effort "${requested}" is not supported by ${model.providerId}/${model.modelId}`,
    };
  }
  return null;
}

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

function defaultSettings() {
  return scenario.settings ?? {
    mode: { current: state.mode },
    permission: { mode: state.mode },
    model: {
      current: state.model,
      available: availableModels(),
    },
    thoughtLevel: {
      available: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      current: state.thoughtLevel,
      defaultLevel: 'max',
      enabled: true,
    },
  };
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
      ...(script.permissionRequest.origin ? { origin: script.permissionRequest.origin } : {}),
      options: script.permissionRequest.options ?? [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once', response: { decision: 'allow', reason: 'Approved once' } },
        { optionId: 'allow_project', kind: 'allow_always', name: 'Always allow in this project', response: { decision: 'allow', permissionUpdates: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] }], reason: 'Approved for this project' } },
        { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny', reason: 'Denied' } },
      ],
    });
    state.answeredPermissions.push({ requestId: script.permissionRequest.requestId ?? 'perm-1', answer });
  }
  if (script.userInputRequest) {
    const spec = script.userInputRequest;
    const answer = await reverseRequest('interaction/requestUserInput', {
      sessionId,
      turnId,
      requestId: spec.requestId ?? 'ask-1',
      ...(spec.toolCallId ? { toolCallId: spec.toolCallId } : {}),
      ...(spec.toolName ? { toolName: spec.toolName } : {}),
      ...(spec.prompt ? { prompt: spec.prompt } : {}),
      ...(spec.origin ? { origin: spec.origin } : {}),
      ...(spec.schema ? { schema: spec.schema } : {}),
      input: spec.input ?? { questions: spec.questions ?? [] },
      questions: spec.questions ?? [],
    });
    state.answeredUserInputs.push({ requestId: spec.requestId ?? 'ask-1', answer });
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

function snapshotFor(sessionId) {
  return {
    messages: [],
    protocol: { name: 'ZCode Protocol', version: 1 },
    session: {
      sessionId,
      mode: state.mode,
      model: state.model,
      status: state.activeTurn?.sessionId === sessionId ? 'running' : 'idle',
      sessionKind: 'interactive',
      title: '',
      workspace: { workspacePath: '/tmp/fake-ws', workspaceKey: '/tmp/fake-ws' },
    },
    settings: defaultSettings(),
    slashCommands: [
      { name: 'goal', description: 'Show or set the current session goal.', source: 'builtin', inputHint: '/goal [objective]' },
    ],
    ...(scenario.todos ? { todos: scenario.todos } : {}),
  };
}

async function handle(request) {
  const { id, method, params } = request;
  switch (method) {
    case 'gian/modelCatalog': {
      if (scenario.behavior?.missingModelCatalog) {
        replyError(id, { code: -32601, message: 'Method not found' });
        return;
      }
      const settings = defaultSettings();
      const selected = settings.model?.current;
      reply(id, {
        schemaVersion: scenario.catalogSchemaVersion ?? 1,
        models: settings.model?.available ?? [],
        ...(selected ? { selection: { ...selected,
          ...(settings.thoughtLevel?.current ? { options: { reasoningLevel: settings.thoughtLevel.current } } : {}),
        } } : {}),
      });
      return;
    }
    case 'workspace/readPresentation': {
      if (scenario.behavior?.crashCatalogOnce && scenarioPath) {
        const marker = `${scenarioPath}.catalog-crashed`;
        if (!fs.existsSync(marker)) {
          fs.writeFileSync(marker, 'crashed\n');
          process.exit(9);
        }
      }
      reply(id, {
        workspace: params.workspace,
        mode: state.mode,
        slashCommands: [
          { name: 'goal', description: 'Show or set the current session goal.', source: 'builtin', inputHint: '/goal [objective]' },
        ],
      });
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
      // Legacy surface kept ONLY to mirror the real 0.16.9 boundary: such a
      // session exists outside the v4 conversation store, so a v4 sendText
      // against it fails the session_input foreign key (live-verified). The
      // Proxy must create fresh sessions via v4 createSession instead.
      const sessionId = `sess_${Math.random().toString(36).slice(2, 12)}`;
      state.sessions.push(sessionId);
      state.legacySessions.push(sessionId);
      await reverseRequest('session/requestRuntimePreferences', { sessionId, scope: 'runtime-materialization' });
      await reverseRequest('interaction/requestOfficialMcpAuthHeaders', {
        sessionId, mcpKey: 'image_search', requestId: 'official-mcp-auth:1',
      });
      reply(id, snapshotFor(sessionId));
      return;
    }
    case 'session/subscribe': {
      state.subscribedSessions.add(params.sessionId);
      reply(id, { eventSeq: 0, events: [], sessionId: params.sessionId });
      return;
    }
    case 'session/read': {
      const active = state.sessions.includes(params.sessionId);
      if (!active && scenario.knownSessions?.includes(params.sessionId) !== true) {
        replyError(id, { code: -32004, message: `Session is not active: ${params.sessionId}` });
        return;
      }
      reply(id, {
        ...snapshotFor(params.sessionId),
        settings: {
          ...defaultSettings(),
          model: {
            ...defaultSettings().model,
            // session/read narrows the marketplace to the current model
            // (server-operations.ts:1831 modelAvailability: "current").
            available: (defaultSettings().model.available ?? []).filter(
              (model) => model.ref?.providerId === state.model.providerId
                && model.ref?.modelId === state.model.modelId,
            ),
          },
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
      reply(id, snapshotFor(params.sessionId));
      return;
    }
    case 'session/send': {
      // 0.16.9 deprecates session/send; the proxy drives turns via v4 sendText.
      // The case stays so accidental regression is visible in the log.
      log({ kind: 'legacy-send' });
      reply(id, { accepted: true, sessionId: params.sessionId, stateRevision: 1 });
      return;
    }
    case 'session/stop': {
      log({ kind: 'stop' });
      reply(id, {});
      return;
    }
    case 'v4/command': {
      log({ kind: 'v4-command', params });
      const ackBase = { commandId: params.commandId ?? '', revisionAtDecision: 1 };
      if (typeof params.issuedAt !== 'number') {
        reply(id, { ack: { ...ackBase, status: 'rejected', reasonCode: 'proto.invalidPayload' } });
        return;
      }
      if (params.type === 'createSession') {
        // v4 draft session: deferred persistence — the row is promoted by the
        // first prompt turn, which is exactly why a v4-native session can
        // take a sendText while a legacy-created one cannot.
        const sessionId = `sess_${Math.random().toString(36).slice(2, 12)}`;
        state.sessions.push(sessionId);
        await reverseRequest('session/requestRuntimePreferences', { sessionId, scope: 'runtime-materialization' });
        reply(id, {
          ack: {
            ...ackBase,
            status: 'accepted',
            result: { type: 'createSession', sessionId },
          },
        });
        return;
      }
      if (params.type === 'stop') {
        reply(id, { ack: { ...ackBase, status: 'accepted' } });
        return;
      }
      if (params.type === 'sendText') {
        const payload = params.payload ?? {};
        const delivery = payload.requestedDelivery ?? 'startNow';
        if (delivery === 'guide') state.steerCommands.push(params);
        else state.sendCommands.push(params);
        // Persistence FK emulation: a v4 sendText against a legacy-created
        // session (or an unknown one) hits the session_input foreign key.
        if (params.sessionId === null
          || state.sessions.includes(params.sessionId) === false
          || state.legacySessions.includes(params.sessionId)) {
          replyError(id, { code: -32603, message: 'FOREIGN KEY constraint failed' });
          return;
        }
        if (payload.modelSelection !== undefined) {
          const invalid = validateModelSelection(payload.modelSelection);
          if (invalid) {
            replyError(id, invalid);
            return;
          }
        }
        if (payload.text === '' && (payload.attachments ?? []).length === 0) {
          reply(id, { ack: { ...ackBase, status: 'rejected', reasonCode: 'guard.emptyInput' } });
          return;
        }
        if (delivery === 'guide' && state.activeTurn === null) {
          reply(id, { ack: { ...ackBase, status: 'accepted', result: { type: 'inputAccepted', delivery: 'startNow' } } });
          return;
        }
        reply(id, {
          ack: {
            ...ackBase,
            status: 'accepted',
            result: { type: 'inputAccepted', delivery, inputId: params.commandId },
          },
        });
        if (delivery === 'guide') return; // a guide never starts its own turn
        const script = scenario.turn ?? {};
        if (scenario.behavior?.turnStartedBeforeAck) {
          // Real 0.16.9 emits the typed turn-started operation event on input
          // admission, which can precede the command ack.
          write({
            method: 'computer-use/operation-event',
            params: {
              eventId: `evt_cu_${script.turnId ?? 'preack'}`,
              sequenceNumber: 1,
              sessionId: params.sessionId,
              timestamp: Date.now(),
              kind: 'turn-started',
              turnId: script.turnId ?? `turn_${Math.random().toString(36).slice(2, 10)}`,
            },
          });
          setImmediate(() => {
            void runTurnScript({ ...script, turnStartedEvent: false }, params.sessionId).then(() => {
              if (scenario.behavior?.crashAfterTurn) process.exit(9);
            });
          });
          reply(id, {
            ack: {
              ...ackBase,
              status: 'accepted',
              result: { type: 'inputAccepted', delivery, inputId: params.commandId },
            },
          });
          return;
        }
        setImmediate(() => {
          void runTurnScript(script, params.sessionId).then(() => {
            if (scenario.behavior?.crashAfterTurn) process.exit(9);
          });
        });
        return;
      }
      if (params.type === 'renameSession') {
        const title = params.payload?.title;
        if (typeof title !== 'string' || title === '') {
          reply(id, { ack: { ...ackBase, status: 'rejected', reasonCode: 'guard.emptyTitle' } });
          return;
        }
        reply(id, { ack: { ...ackBase, status: 'accepted' } });
        const sessionId = params.sessionId;
        setImmediate(() => {
          write({
            method: 'session/event',
            params: {
              deliveryKind: 'desktop-continuous',
              eventId: `evt_title_${Math.random().toString(36).slice(2, 8)}`,
              seq: 1,
              sessionId,
              timestamp: Date.now(),
              type: 'session.titleUpdated',
              payload: { title, titleSource: 'custom' },
            },
          });
        });
        return;
      }
      if (params.type === 'forkAssistant') {
        const rows = scenario.rows ?? [];
        const target = params.payload?.target ?? {};
        const known = rows.some(
          (row) => row.rowId === target.rowId && row.entityId === target.entityId,
        );
        if (!known || typeof params.baseRevision !== 'number' || typeof params.baseLogEpoch !== 'string') {
          reply(id, { ack: { ...ackBase, status: 'rejected', reasonCode: 'guard.forkTargetNotStable' } });
          return;
        }
        if (params.baseRevision !== (scenario.rowsRevision ?? 7)) {
          reply(id, { ack: { ...ackBase, status: 'stale', reasonCode: 'guard.staleRevision' } });
          return;
        }
        const childId = scenario.forkChild?.sessionId ?? `sess_fork_${Math.random().toString(36).slice(2, 10)}`;
        if (state.sessions.includes(childId) === false) state.sessions.push(childId);
        reply(id, { ack: { ...ackBase, status: 'accepted', result: { type: 'forkAssistant', sessionId: childId } } });
        return;
      }
      reply(id, { ack: { ...ackBase, status: 'rejected', reasonCode: 'proto.unknownType' } });
      return;
    }
    case 'v4/conversation/rowsRange': {
      const rows = scenario.rows ?? [];
      const before = typeof params.beforeRowId === 'number' ? params.beforeRowId : Infinity;
      const limit = typeof params.limit === 'number' ? params.limit : 200;
      const visible = rows.filter((row) => row.rowId < before);
      const start = Math.max(0, visible.length - limit);
      const page = visible.slice(start);
      reply(id, {
        rows: page,
        atSeq: scenario.rowsAtSeq ?? 42,
        atRevision: scenario.rowsRevision ?? 7,
        atLogEpoch: scenario.rowsLogEpoch ?? 'epoch-1',
        hasMore: start > 0,
      });
      return;
    }
    case 'session/subagents': {
      reply(id, scenario.subagents ?? { revision: 1, childSessionIds: [], running: [], ended: { total: 0, items: [] } });
      return;
    }
    case 'skills/referenceCatalog': {
      reply(id, { authority: 'workspace', skills: scenario.skills ?? [] });
      return;
    }
    case 'mcp/list': {
      if (params.mode === 'connect') {
        replyError(id, { code: -32602, message: 'fixture refuses connect mode' });
        return;
      }
      reply(id, { statuses: scenario.mcpStatuses ?? {} });
      return;
    }
    case 'session/setModel': {
      // 0.16.9 registry validation on the full ModelSelection.
      const invalid = validateModelSelection(params.model);
      if (invalid) {
        replyError(id, invalid);
        return;
      }
      state.model = {
        providerId: params.model.providerId,
        modelId: params.model.modelId,
      };
      if (params.model.options?.reasoningLevel !== undefined) {
        state.thoughtLevel = params.model.options.reasoningLevel;
      }
      reply(id, snapshotFor(params.sessionId));
      return;
    }
    case 'session/setThoughtLevel': {
      // The v4 flow resolves reasoning through the model selection; the
      // independent path is the desktop legacy chain only. Reject it so a
      // Proxy regression back to setModel + setThoughtLevel is visible.
      replyError(id, { code: -32601, message: 'Method not supported: session/setThoughtLevel on the v4 surface' });
      return;
    }
    case 'session/setMode': {
      if (scenario.behavior?.failMode === params.mode) {
        replyError(id, { code: -32603, message: 'Mode update failed' });
        return;
      }
      const known = ['plan', 'build', 'edit', 'yolo'];
      if (known.includes(params.mode) === false) {
        replyError(id, { code: -32602, message: 'Invalid params — mode: Invalid option' });
        return;
      }
      state.mode = params.mode;
      reply(id, snapshotFor(params.sessionId));
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

// Delayed exit while a reverse request may still be pending.
if (scenario.behavior?.crashAfterMs) {
  setTimeout(() => process.exit(9), scenario.behavior.crashAfterMs);
}

// Oversized-line / malformed-line probes.
if (scenario.behavior?.emitGarbageOnStart) {
  writeRaw('not-json\n');
}
if (scenario.behavior?.emitFragmentOnStart) {
  writeRaw('{"method":"session/event","params":{"seq":0}}');
  setTimeout(() => writeRaw('\n'), 20);
}
