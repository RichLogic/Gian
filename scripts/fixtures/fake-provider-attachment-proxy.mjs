import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const sessions = new Map();
const activeTurns = new Map();
const pluginId = process.env.GIAN_ATTACHMENT_CANARY_PROVIDER ?? 'grok';

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

function fail(id, domainCode, message) {
  write({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message,
      data: { domainCode, retryable: false, details: {} },
    },
  });
}

function emit(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

function sessionRecord(session) {
  return {
    id: session.id,
    nativeSession: { id: session.nativeSessionId },
    streamId: session.streamId,
    state: session.state,
    sessionConfig: {},
    lastError: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    result(request.id, {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: pluginId, name: 'Attachment fixture', version: '0.2.0' },
      process: { scope: pluginId === 'codex' || pluginId === 'kimi' ? 'shared' : 'session' },
      capabilities: {
        'input.localFile': 1,
        'input.localImage': 1,
        'session.replay': 1,
        ...(pluginId === 'codex' ? { 'turn.steer': 1 } : {}),
      },
    });
    continue;
  }
  if (request.method === 'catalog.list') {
    result(request.id, {
      catalogRevision: 'fixture-1',
      input: [{ type: 'text' }, { type: 'localFile' }],
      configOptions: [],
      slashCommands: [],
    });
    continue;
  }
  if (request.method === 'session.create') {
    const sessionId = request.params?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      fail(request.id, 'INVALID_PARAMS', 'sessionId is required.');
      continue;
    }
    const session = {
      id: sessionId,
      nativeSessionId: request.params?.nativeSession?.id ?? `native-${sessionId}`,
      streamId: `stream-${sessionId}`,
      state: 'idle',
    };
    sessions.set(sessionId, session);
    result(request.id, { session: sessionRecord(session) });
    continue;
  }
  if (request.method === 'turn.start') {
    const sessionId = request.params?.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
      fail(request.id, 'SESSION_NOT_FOUND', 'session missing');
      continue;
    }
    const localFile = request.params?.input?.find(item => item?.type === 'localFile');
    const content = await readFile(localFile.path, 'utf8');
    const turnId = request.params?.turnId;
    const streamId = request.params?.streamId ?? session.streamId;
    const emittedAt = new Date().toISOString();
    activeTurns.set(sessionId, { turnId, streamId, content, sequence: 1 });
    session.state = 'running';
    result(request.id, { accepted: true, turnId });
    emit('turn.started', {
      eventId: `${turnId}-started`,
      streamId,
      sequence: 1,
      sessionId,
      turnId,
      sourceTurnId: turnId,
      emittedAt,
      data: {},
    });
    emit('content.delta', {
      eventId: `${turnId}-delta`,
      streamId,
      sequence: 2,
      sessionId,
      turnId,
      sourceTurnId: turnId,
      emittedAt,
      data: { contentId: `text:${turnId}`, kind: 'text', delta: content },
    });
    emit('content.completed', {
      eventId: `${turnId}-content-done`,
      streamId,
      sequence: 3,
      sessionId,
      turnId,
      sourceTurnId: turnId,
      emittedAt,
      data: { contentId: `text:${turnId}`, kind: 'text' },
    });
    const active = activeTurns.get(sessionId);
    if (active) active.sequence = 3;
    if (process.env.GIAN_ATTACHMENT_CANARY_PROVIDER !== 'codex') {
      queueMicrotask(() => {
        const current = activeTurns.get(sessionId);
        if (!current || current.turnId !== turnId) return;
        emit('turn.completed', {
          eventId: `${turnId}-completed`,
          streamId,
          sequence: current.sequence + 1,
          sessionId,
          turnId,
          sourceTurnId: turnId,
          emittedAt: new Date().toISOString(),
          data: { stopReason: 'completed' },
        });
        session.state = 'idle';
        activeTurns.delete(sessionId);
      });
    }
    continue;
  }
  if (request.method === 'turn.steer') {
    const sessionId = request.params?.sessionId;
    const active = activeTurns.get(sessionId);
    const session = sessions.get(sessionId);
    if (!active || !session) {
      fail(request.id, 'NO_ACTIVE_TURN', 'no active turn');
      continue;
    }
    const localFile = request.params?.input?.find(item => item?.type === 'localFile');
    const content = await readFile(localFile.path, 'utf8');
    result(request.id, { accepted: true, turnId: active.turnId });
    queueMicrotask(() => {
      const current = activeTurns.get(sessionId);
      if (!current) return;
      const emittedAt = new Date().toISOString();
      emit('content.delta', {
        eventId: `${current.turnId}-steer-delta`,
        streamId: current.streamId,
        sequence: current.sequence + 1,
        sessionId,
        turnId: current.turnId,
        sourceTurnId: current.turnId,
        emittedAt,
        data: { contentId: `text:${current.turnId}:steer`, kind: 'text', delta: content },
      });
      emit('content.completed', {
        eventId: `${current.turnId}-steer-done`,
        streamId: current.streamId,
        sequence: current.sequence + 2,
        sessionId,
        turnId: current.turnId,
        sourceTurnId: current.turnId,
        emittedAt,
        data: { contentId: `text:${current.turnId}:steer`, kind: 'text' },
      });
      emit('turn.completed', {
        eventId: `${current.turnId}-completed`,
        streamId: current.streamId,
        sequence: current.sequence + 3,
        sessionId,
        turnId: current.turnId,
        sourceTurnId: current.turnId,
        emittedAt,
        data: { stopReason: 'completed' },
      });
      session.state = 'idle';
      activeTurns.delete(sessionId);
    });
    continue;
  }
  if (request.method === 'turn.interrupt') {
    result(request.id, { accepted: true, turnId: request.params?.turnId ?? activeTurns.get(request.params?.sessionId)?.turnId });
    continue;
  }
  if (request.method === 'session.close') {
    sessions.delete(request.params?.sessionId);
    activeTurns.delete(request.params?.sessionId);
    result(request.id, { ok: true });
    continue;
  }
  if (request.method === 'shutdown') {
    result(request.id, { ok: true });
    setImmediate(() => process.exit(0));
    continue;
  }
  fail(request.id, 'METHOD_NOT_FOUND', request.method);
}
