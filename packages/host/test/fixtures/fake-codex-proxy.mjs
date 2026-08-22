import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const emittedAt = '2026-04-26T00:00:00.000Z';
let seq = 0;
const sessions = new Map();

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    continue;
  }

  switch (req.method) {
    case 'initialize':
      result(req.id, {
        protocol: { name: 'gian.proxy', version: '2.0' },
        plugin: {
          id: process.env.GIAN_PLUGIN_ID ?? 'codex',
          name: 'Codex',
          version: '0.2.0',
        },
        process: { scope: 'shared' },
        capabilities: { 'session.replay': 1, interaction: 1 },
      });
      break;
    case 'catalog.list':
      result(req.id, {
        catalogRevision: 'codex-fixture-1',
        input: [{ type: 'text' }],
        configOptions: [],
        slashCommands: [],
      });
      break;
    case 'session.create': {
      const sessionId = req.params.sessionId;
      const nativeId = req.params.nativeSession?.id ?? `thread_${++seq}`;
      const cwd = req.params.workspace?.cwd ?? '/tmp';
      sessions.set(sessionId, { nativeId, cwd, streamId: `stream-${sessionId}` });
      result(req.id, {
        session: {
          id: sessionId,
          nativeSession: { id: nativeId },
          streamId: `stream-${sessionId}`,
          state: 'idle',
          sessionConfig: req.params.config ?? {},
          lastError: null,
          createdAt: emittedAt,
          updatedAt: emittedAt,
        },
      });
      break;
    }
    case 'turn.start': {
      const sessionId = req.params.sessionId;
      const turnId = req.params.turnId;
      const streamId = req.params.streamId;
      const base = { streamId, sessionId, turnId, sourceTurnId: turnId, emittedAt };
      result(req.id, { accepted: true, turnId });
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
          data: { contentId: 'c1', kind: 'text', delta: `pong from ${sessionId}` },
        },
      });
      write({
        jsonrpc: '2.0',
        method: 'content.completed',
        params: {
          ...base,
          eventId: `${turnId}-done`,
          sequence: 3,
          data: { contentId: 'c1', kind: 'text', content: `pong from ${sessionId}` },
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
    case 'session.close': {
      const session = sessions.get(req.params.sessionId);
      if (session?.cwd === '/force-busy') {
        write({
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32000,
            message: 'active turn',
            data: { domainCode: 'SESSION_BUSY', retryable: false, details: {} },
          },
        });
        break;
      }
      sessions.delete(req.params.sessionId);
      result(req.id, { ok: true });
      break;
    }
    case 'session.replay':
      result(req.id, { replayStreamId: 'replay-codex', events: [], nextCursor: null });
      break;
    case 'shutdown':
      result(req.id, { ok: true });
      process.exit(0);
      break;
    default:
      write({
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: -32601,
          message: req.method,
          data: { domainCode: 'METHOD_NOT_FOUND', retryable: false, details: {} },
        },
      });
  }
}
