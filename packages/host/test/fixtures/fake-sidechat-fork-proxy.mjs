import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dataDir = process.env.GIAN_PLUGIN_DATA_DIR ?? process.cwd();
mkdirSync(dataDir, { recursive: true });
const statePath = join(dataDir, 'sidechat-fork-state.json');
const controlPath = join(dataDir, 'fake-control.json');
const timestamp = '2026-08-20T00:00:00.000Z';

const REJECT_ON_SIDECHAT = new Set([
  'session.get',
  'session.rename',
  'session.replay',
  'session.close',
  'catalog.resolve',
]);

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function control() {
  return readJson(controlPath, {});
}

function loadState() {
  return readJson(statePath, {
    sessions: {},
    sidechats: {},
    resumeOwners: {},
    sequences: {},
  });
}

function saveState(state) {
  writeJson(statePath, state);
}

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

function fail(id, domainCode, message, retryable = false) {
  write({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message,
      data: { domainCode, retryable, details: {} },
    },
  });
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

function nextSequence(state, sessionId) {
  const current = state.sequences[sessionId] ?? 0;
  const sequence = current + 1;
  state.sequences[sessionId] = sequence;
  return sequence;
}

function sessionSnapshot(session) {
  const flags = control();
  return {
    id: session.id,
    ...(session.nativeId ? { nativeSession: { id: session.nativeId } } : {}),
    streamId: session.streamId,
    state: session.state,
    sessionConfig: session.sessionConfig,
    lastError: session.lastError ?? null,
    availableActions: flags.availableActions ?? {
      'sidechat.create': { enabled: true },
      'session.fork': { enabled: true },
      'session.fork.atTurn': { enabled: true },
    },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function sidechatSnapshot(sidechat) {
  return {
    id: sidechat.id,
    parentSessionId: sidechat.parentSessionId,
    streamId: sidechat.streamId,
    state: sidechat.state,
    resumeRef: { id: sidechat.resumeRefId },
    anchor: sidechat.anchor,
    sessionConfig: sidechat.sessionConfig,
    lastError: sidechat.lastError ?? null,
    createdAt: sidechat.createdAt,
    updatedAt: sidechat.updatedAt,
  };
}

function mintResumeRef(sidechatId, generation) {
  return `opaque-ref-${sidechatId}-${generation}`;
}

function replayFor(session, untilSourceTurnId) {
  const events = [];
  for (const turn of session.turns) {
    events.push(...turn.events);
    if (untilSourceTurnId && turn.sourceTurnId === untilSourceTurnId) break;
  }
  return events;
}

function emitTurnFamily(state, sessionId, streamId, turnId, sourceTurnId, text) {
  const base = {
    streamId,
    sessionId,
    turnId,
    sourceTurnId,
    emittedAt: timestamp,
  };
  notify('turn.started', {
    ...base,
    eventId: `${turnId}-started`,
    sequence: nextSequence(state, sessionId),
    data: {},
  });
  notify('content.delta', {
    ...base,
    eventId: `${turnId}-delta`,
    sequence: nextSequence(state, sessionId),
    data: { contentId: `${turnId}-c1`, kind: 'text', delta: text },
  });
  notify('content.completed', {
    ...base,
    eventId: `${turnId}-content`,
    sequence: nextSequence(state, sessionId),
    data: { contentId: `${turnId}-c1`, kind: 'text', content: text },
  });
  notify('activity.updated', {
    ...base,
    eventId: `${turnId}-activity`,
    sequence: nextSequence(state, sessionId),
    data: {
      activityId: `${turnId}-act`,
      kind: 'search',
      title: 'lookup',
      status: 'succeeded',
      presentation: { type: 'search', data: { query: text || 'lookup' } },
    },
  });
  notify('step.updated', {
    ...base,
    eventId: `${turnId}-step`,
    sequence: nextSequence(state, sessionId),
    data: { stepId: `${turnId}-step`, index: 0, status: 'completed' },
  });
  notify('request.updated', {
    ...base,
    eventId: `${turnId}-request`,
    sequence: nextSequence(state, sessionId),
    data: { requestId: `${turnId}-req`, reason: 'initial', stepId: `${turnId}-step` },
  });
  notify('interaction.requested', {
    ...base,
    eventId: `${turnId}-ask`,
    sequence: nextSequence(state, sessionId),
    data: {
      interactionId: `${turnId}-ix`,
      title: 'Confirm',
      presentation: { kind: 'confirmation' },
      inputs: [],
      actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
    },
  });
  notify('interaction.resolved', {
    ...base,
    eventId: `${turnId}-resolved`,
    sequence: nextSequence(state, sessionId),
    data: { interactionId: `${turnId}-ix`, outcome: 'cancelled' },
  });
  notify('turn.completed', {
    ...base,
    eventId: `${turnId}-done`,
    sequence: nextSequence(state, sessionId),
    data: { stopReason: 'completed' },
  });
}

function recordReplayTurn(session, turnId, sourceTurnId, text) {
  session.turns.push({
    turnId,
    sourceTurnId,
    events: [
      {
        method: 'turn.started',
        eventId: `${sourceTurnId}-started`,
        replayStreamId: session.replayStreamId,
        sequence: session.turns.length * 4 + 1,
        sessionId: session.id,
        sourceTurnId,
        emittedAt: timestamp,
        data: {},
      },
      {
        method: 'input.recorded',
        eventId: `${sourceTurnId}-input`,
        replayStreamId: session.replayStreamId,
        sequence: session.turns.length * 4 + 2,
        sessionId: session.id,
        sourceTurnId,
        emittedAt: timestamp,
        data: { input: [{ type: 'text', text }] },
      },
      {
        method: 'content.completed',
        eventId: `${sourceTurnId}-content`,
        replayStreamId: session.replayStreamId,
        sequence: session.turns.length * 4 + 3,
        sessionId: session.id,
        sourceTurnId,
        emittedAt: timestamp,
        data: { contentId: `${sourceTurnId}-c1`, kind: 'text', content: text },
      },
      {
        method: 'turn.completed',
        eventId: `${sourceTurnId}-done`,
        replayStreamId: session.replayStreamId,
        sequence: session.turns.length * 4 + 4,
        sessionId: session.id,
        sourceTurnId,
        emittedAt: timestamp,
        data: { stopReason: 'completed' },
      },
    ],
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    continue;
  }
  const state = loadState();
  const flags = control();
  const method = req.method;
  const params = req.params ?? {};

  if (method === 'initialize') {
    result(req.id, {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: {
        id: process.env.GIAN_PLUGIN_ID ?? 'claude',
        name: 'Side Chat Fork Fake',
        version: '0.2.0',
      },
      process: { scope: 'session' },
      capabilities: {
        sidechat: 1,
        'session.replay': 1,
        'session.fork': 1,
        'session.fork.atTurn': 1,
        interaction: 1,
        'turn.steer': 1,
        'event.step': 1,
        'event.request': 1,
      },
    });
    continue;
  }

  if (method === 'catalog.list') {
    result(req.id, {
      catalogRevision: flags.catalogRevision ?? 'sidechat-fork-fake-1',
      input: [{ type: 'text' }],
      configOptions: [{
        id: 'execution_mode',
        displayName: 'Mode',
        binding: 'session',
        control: 'select',
        required: true,
        defaultValue: 'agent',
        choices: [
          { value: 'agent', displayName: 'Agent' },
          { value: 'plan', displayName: 'Plan' },
        ],
      }],
      actions: flags.actions ?? [
        { id: 'sidechat.create', supported: true },
        { id: 'session.fork', supported: true },
        { id: 'session.fork.atTurn', supported: true },
      ],
      slashCommands: [],
    });
    continue;
  }

  if (REJECT_ON_SIDECHAT.has(method) && state.sidechats[params.sessionId]) {
    fail(req.id, 'SESSION_NOT_FOUND', `${method} rejects a Side Chat id`);
    continue;
  }

  if (method === 'catalog.resolve') {
    result(req.id, {
      catalogRevision: flags.catalogRevision ?? 'sidechat-fork-fake-1',
      input: [{ type: 'text' }],
      configOptions: [],
      actions: flags.actions ?? [
        { id: 'sidechat.create', supported: true },
        { id: 'session.fork', supported: true },
        { id: 'session.fork.atTurn', supported: true },
      ],
      slashCommands: [],
      resolvedDefaults: { sessionConfig: {}, turnConfig: {} },
    });
    continue;
  }

  if (method === 'session.create') {
    const session = {
      id: params.sessionId,
      nativeId: params.nativeSession?.id ?? `native-${params.sessionId}`,
      streamId: `stream-${params.sessionId}`,
      replayStreamId: `replay-${params.sessionId}`,
      state: 'idle',
      sessionConfig: params.config ?? {},
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      turns: [],
      activeTurnId: null,
    };
    state.sessions[session.id] = session;
    saveState(state);
    result(req.id, { session: sessionSnapshot(session) });
    continue;
  }

  if (method === 'session.get') {
    const session = state.sessions[params.sessionId];
    if (!session) {
      fail(req.id, 'SESSION_NOT_FOUND', 'unknown session');
      continue;
    }
    result(req.id, { session: sessionSnapshot(session) });
    continue;
  }

  if (method === 'session.rename') {
    const session = state.sessions[params.sessionId];
    if (!session) {
      fail(req.id, 'SESSION_NOT_FOUND', 'unknown session');
      continue;
    }
    result(req.id, { ok: true });
    continue;
  }

  if (method === 'session.close') {
    const session = state.sessions[params.sessionId];
    if (!session) {
      fail(req.id, 'SESSION_NOT_FOUND', 'unknown session');
      continue;
    }
    session.state = 'closed';
    saveState(state);
    result(req.id, { ok: true });
    continue;
  }

  if (method === 'session.replay') {
    const session = state.sessions[params.sessionId];
    if (!session) {
      fail(req.id, 'SESSION_NOT_FOUND', 'unknown session');
      continue;
    }
    result(req.id, {
      replayStreamId: session.replayStreamId,
      events: replayFor(session),
      nextCursor: null,
    });
    continue;
  }

  if (method === 'session.fork') {
    const source = state.sessions[params.sourceSessionId];
    if (!source) {
      fail(req.id, 'SESSION_NOT_FOUND', 'unknown source session');
      continue;
    }
    if (state.sidechats[params.sourceSessionId]) {
      fail(req.id, 'SESSION_NOT_FOUND', 'Side Chat cannot be a Fork source');
      continue;
    }
    let until = null;
    if (params.anchor.type === 'head') {
      const last = source.turns[source.turns.length - 1];
      if (!last) {
        fail(req.id, 'FORK_BOUNDARY_UNAVAILABLE', 'head has no terminal Turn');
        continue;
      }
      until = last.sourceTurnId;
    } else {
      const match = source.turns.find((turn) => (
        turn.turnId === params.anchor.turnId && turn.sourceTurnId === params.anchor.sourceTurnId
      ));
      if (!match) {
        fail(req.id, 'FORK_BOUNDARY_UNAVAILABLE', 'turn anchor was not an exact terminal Turn');
        continue;
      }
      until = match.sourceTurnId;
    }
    const child = {
      id: params.sessionId,
      nativeId: `native-${params.sessionId}`,
      streamId: `stream-${params.sessionId}`,
      replayStreamId: `replay-${params.sessionId}`,
      state: 'idle',
      sessionConfig: { ...source.sessionConfig },
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      turns: source.turns
        .filter((turn) => !until || source.turns.findIndex((item) => item.sourceTurnId === until) >= source.turns.indexOf(turn))
        .filter((_, index, all) => {
          const cutoff = source.turns.findIndex((item) => item.sourceTurnId === until);
          return index <= cutoff;
        })
        .map((turn) => ({
          ...turn,
          events: turn.events.map((event) => ({
            ...event,
            sessionId: params.sessionId,
            replayStreamId: `replay-${params.sessionId}`,
          })),
        })),
      activeTurnId: null,
    };
    state.sessions[child.id] = child;
    saveState(state);
    const originTurn = source.turns.find((turn) => turn.sourceTurnId === until) ?? source.turns[source.turns.length - 1];
    result(req.id, {
      session: sessionSnapshot(child),
      origin: {
        kind: 'fork',
        sessionId: source.id,
        turnId: originTurn.turnId,
        sourceTurnId: originTurn.sourceTurnId,
      },
    });
    continue;
  }

  if (method === 'sidechat.create') {
    const parent = state.sessions[params.parentSessionId];
    if (!parent) {
      fail(req.id, 'SESSION_NOT_FOUND', 'unknown parent session');
      continue;
    }
    const existing = state.sidechats[params.sidechatId];
    if (existing && existing.parentSessionId !== params.parentSessionId) {
      fail(req.id, 'CONFLICT', 'sidechatId was reused with a different parent');
      continue;
    }
    if (existing) {
      result(req.id, { sidechat: sidechatSnapshot(existing) });
      continue;
    }
    const generation = 1;
    const resumeRefId = mintResumeRef(params.sidechatId, generation);
    const last = parent.turns[parent.turns.length - 1];
    const anchor = flags.anchor ?? (last
      ? { type: parent.activeTurnId ? 'activeInput' : 'turn', turnId: last.turnId, sourceTurnId: last.sourceTurnId }
      : { type: 'empty' });
    const sidechat = {
      id: params.sidechatId,
      parentSessionId: params.parentSessionId,
      streamId: `stream-${params.sidechatId}`,
      resumeRefId,
      generation,
      state: 'idle',
      anchor,
      sessionConfig: { ...parent.sessionConfig },
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      activeTurnId: null,
    };
    state.sidechats[sidechat.id] = sidechat;
    state.resumeOwners[resumeRefId] = sidechat.id;
    saveState(state);
    result(req.id, { sidechat: sidechatSnapshot(sidechat) });
    continue;
  }

  if (method === 'sidechat.resume') {
    const owner = state.resumeOwners[params.resumeRef?.id];
    if (owner && owner !== params.sidechatId) {
      fail(req.id, 'CONFLICT', 'resumeRef belongs to another live Side Chat');
      continue;
    }
    const sidechat = state.sidechats[params.sidechatId];
    if (!sidechat || flags.resumeUnavailable) {
      fail(req.id, 'SIDECHAT_UNAVAILABLE', 'Side Chat is unavailable');
      continue;
    }
    if (sidechat.parentSessionId !== params.parentSessionId) {
      fail(req.id, 'CONFLICT', 'sidechat.resume parent does not match');
      continue;
    }
    delete state.resumeOwners[sidechat.resumeRefId];
    sidechat.generation += 1;
    sidechat.resumeRefId = mintResumeRef(sidechat.id, sidechat.generation);
    sidechat.streamId = `stream-${sidechat.id}-${sidechat.generation}`;
    sidechat.updatedAt = timestamp;
    state.resumeOwners[sidechat.resumeRefId] = sidechat.id;
    saveState(state);
    result(req.id, { sidechat: sidechatSnapshot(sidechat) });
    continue;
  }

  if (method === 'sidechat.close') {
    const owner = state.resumeOwners[params.resumeRef?.id];
    if (owner && owner !== params.sidechatId) {
      fail(req.id, 'CONFLICT', 'resumeRef belongs to another live Side Chat');
      continue;
    }
    const sidechat = state.sidechats[params.sidechatId];
    if (!sidechat || !owner) {
      result(req.id, { ok: true, sidechatId: params.sidechatId, providerDataDeleted: false });
      continue;
    }
    if (sidechat.activeTurnId) {
      notify('turn.completed', {
        eventId: `${sidechat.activeTurnId}-close`,
        streamId: sidechat.streamId,
        sessionId: sidechat.id,
        turnId: sidechat.activeTurnId,
        sourceTurnId: sidechat.activeTurnId,
        sequence: nextSequence(state, sidechat.id),
        emittedAt: timestamp,
        data: { stopReason: 'interrupted' },
      });
      sidechat.activeTurnId = null;
    }
    delete state.sidechats[sidechat.id];
    delete state.resumeOwners[sidechat.resumeRefId];
    saveState(state);
    result(req.id, {
      ok: true,
      sidechatId: params.sidechatId,
      providerDataDeleted: flags.providerDataDeleted !== false,
    });
    continue;
  }

  if (method === 'turn.start') {
    const sidechat = state.sidechats[params.sessionId];
    const session = state.sessions[params.sessionId];
    const target = sidechat ?? session;
    if (!target) {
      fail(req.id, 'SESSION_NOT_FOUND', 'unknown session');
      continue;
    }
    const text = Array.isArray(params.input)
      ? params.input.map((item) => item.text).filter(Boolean).join('')
      : 'ok';
    if (text === 'FATAL' && sidechat) {
      result(req.id, { accepted: true, turnId: params.turnId });
      notify('turn.started', {
        eventId: `${params.turnId}-bad`,
        streamId: 'wrong-stream',
        sessionId: sidechat.id,
        turnId: params.turnId,
        sourceTurnId: params.turnId,
        sequence: nextSequence(state, sidechat.id),
        emittedAt: timestamp,
        data: {},
      });
      continue;
    }
    target.activeTurnId = params.turnId;
    target.state = 'running';
    if (session) {
      recordReplayTurn(session, params.turnId, params.turnId, text || 'ok');
    }
    saveState(state);
    result(req.id, { accepted: true, turnId: params.turnId });
    emitTurnFamily(state, params.sessionId, target.streamId, params.turnId, params.turnId, text || 'ok');
    target.activeTurnId = null;
    target.state = 'idle';
    saveState(state);
    continue;
  }

  if (method === 'turn.interrupt' || method === 'turn.steer' || method === 'interaction.respond') {
    result(req.id, method === 'interaction.respond'
      ? { ok: true }
      : { accepted: true, turnId: params.turnId });
    continue;
  }

  if (method === 'shutdown') {
    result(req.id, { ok: true });
    process.exit(0);
  }

  fail(req.id, 'METHOD_NOT_FOUND', method);
}
