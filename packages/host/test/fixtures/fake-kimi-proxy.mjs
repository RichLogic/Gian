import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const sessions = new Map();
const emittedAt = '2026-07-29T00:00:00.000Z';

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

function error(id, domainCode, message) {
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

function catalog() {
  return {
    catalogRevision: 'kimi-fixture-1',
    input: [{ type: 'text' }, { type: 'localFile' }, { type: 'localImage' }],
    configOptions: [{
      id: 'mode',
      displayName: 'Mode',
      binding: 'session',
      role: 'approval_mode',
      control: 'select',
      required: false,
      defaultValue: 'default',
      choices: [
        { value: 'default', displayName: 'Default' },
        { value: 'plan', displayName: 'Plan' },
        { value: 'auto', displayName: 'Auto' },
        { value: 'yolo', displayName: 'YOLO' },
      ],
    }],
    slashCommands: [{
      name: '/skill:review',
      description: 'Review code',
      source: 'builtin',
      argHints: [{ kind: 'free', placeholder: 'path' }],
    }],
  };
}

for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  switch (request.method) {
    case 'initialize':
      result(request.id, {
        protocol: { name: 'gian.proxy', version: '2.0' },
        plugin: {
          id: process.env.GIAN_PLUGIN_ID ?? 'kimi',
          name: 'Kimi Code',
          version: '0.2.0',
        },
        process: { scope: 'shared' },
        capabilities: {
          'input.localFile': 1,
          'session.native.list': 1,
          'session.replay': 1,
          interaction: 1,
        },
      });
      break;
    case 'catalog.list':
      result(request.id, catalog());
      break;
    case 'session.create': {
      const cwd = request.params?.workspace?.cwd ?? request.params?.cwd;
      if (cwd === '/auth-required') {
        error(
          request.id,
          'RUNTIME_AUTH_REQUIRED',
          "Run '/managed/kimi' login in a terminal, then retry.",
        );
        break;
      }
      const sessionId = request.params.sessionId;
      const nativeSessionId = request.params.nativeSession?.id ?? `kimi_native_${sessions.size + 1}`;
      sessions.set(sessionId, {
        id: sessionId,
        nativeSessionId,
        streamId: `stream-${sessionId}`,
        cwd,
        history: request.params.nativeSession?.history,
      });
      result(request.id, {
        session: {
          id: sessionId,
          nativeSession: { id: nativeSessionId },
          streamId: `stream-${sessionId}`,
          state: 'idle',
          sessionConfig: request.params.config ?? {},
          lastError: null,
          createdAt: emittedAt,
          updatedAt: emittedAt,
        },
      });
      break;
    }
    case 'session.replay': {
      const session = sessions.get(request.params.sessionId);
      const events = session?.history === 'replay'
        ? [{
          method: 'turn.started',
          eventId: 'replay-1',
          sessionId: request.params.sessionId,
          replayStreamId: 'replay-kimi',
          sequence: 1,
          sourceTurnId: 'native-turn-1',
          emittedAt,
          data: {},
        }]
        : [];
      result(request.id, {
        replayStreamId: 'replay-kimi',
        events,
        nextCursor: null,
      });
      break;
    }
    case 'session.native.list':
      result(request.id, {
        sessions: [{
          id: 'kimi-existing',
          displayName: 'Existing Kimi session',
          cwd: request.params?.cwd ?? '/tmp',
          updatedAt: emittedAt,
        }],
        nextCursor: null,
      });
      break;
    case 'turn.start': {
      const sessionId = request.params.sessionId;
      const turnId = request.params.turnId;
      const streamId = request.params.streamId;
      const base = {
        streamId,
        sessionId,
        turnId,
        sourceTurnId: turnId,
        emittedAt,
      };
      result(request.id, { accepted: true, turnId });
      write({
        jsonrpc: '2.0',
        method: 'turn.started',
        params: { ...base, eventId: `${turnId}-started`, sequence: 1, data: {} },
      });
      write({
        jsonrpc: '2.0',
        method: 'content.delta',
        params: {
          ...base,
          eventId: `${turnId}-delta`,
          sequence: 2,
          data: { contentId: 'c1', kind: 'text', delta: 'hello from Kimi' },
        },
      });
      write({
        jsonrpc: '2.0',
        method: 'content.completed',
        params: {
          ...base,
          eventId: `${turnId}-done`,
          sequence: 3,
          data: { contentId: 'c1', kind: 'text', content: 'hello from Kimi' },
        },
      });
      write({
        jsonrpc: '2.0',
        method: 'turn.completed',
        params: {
          ...base,
          eventId: `${turnId}-end`,
          sequence: 4,
          data: { stopReason: 'completed' },
        },
      });
      break;
    }
    case 'session.close':
      sessions.delete(request.params.sessionId);
      result(request.id, { ok: true });
      break;
    case 'shutdown':
      result(request.id, { ok: true });
      process.exit(0);
      break;
    default:
      write({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: `Unknown method ${request.method}.`,
          data: { domainCode: 'METHOD_NOT_FOUND', retryable: false, details: {} },
        },
      });
  }
}
