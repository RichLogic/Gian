import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const emittedAt = '2026-04-26T00:00:00.000Z';

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
          id: process.env.GIAN_PLUGIN_ID ?? 'claude',
          name: 'Claude Code',
          version: '0.2.0',
        },
        process: { scope: 'session' },
        capabilities: { 'session.replay': 1, interaction: 1, 'catalog.resolve': 1 },
      });
      break;
    case 'catalog.list':
      result(req.id, {
        catalogRevision: 'claude-fixture-1',
        input: [{ type: 'text' }],
        configOptions: [],
        slashCommands: [],
      });
      break;
    case 'catalog.resolve':
      write({
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: -32000,
          message: 'forced failure',
          data: { domainCode: 'INTERNAL', retryable: false, details: {} },
        },
      });
      break;
    case 'session.create':
      result(req.id, {
        session: {
          id: req.params.sessionId,
          nativeSession: { id: req.params.nativeSession?.id ?? 'cc_fixture' },
          streamId: 'stream-fixture',
          state: 'idle',
          sessionConfig: req.params.config ?? {},
          lastError: null,
          createdAt: emittedAt,
          updatedAt: emittedAt,
        },
      });
      break;
    case 'turn.start': {
      const turnId = req.params.turnId;
      const base = {
        streamId: req.params.streamId,
        sessionId: req.params.sessionId,
        turnId,
        sourceTurnId: turnId,
        emittedAt,
      };
      result(req.id, { accepted: true, turnId });
      write({
        jsonrpc: '2.0',
        method: 'turn.started',
        params: { ...base, eventId: 'event-1', sequence: 1, data: {} },
      });
      write({
        jsonrpc: '2.0',
        method: 'content.delta',
        params: {
          ...base,
          eventId: 'event-2',
          sequence: 2,
          data: { contentId: 'c1', kind: 'text', delta: 'ok' },
        },
      });
      write({
        jsonrpc: '2.0',
        method: 'content.completed',
        params: {
          ...base,
          eventId: 'event-3',
          sequence: 3,
          data: { contentId: 'c1', kind: 'text', content: 'ok' },
        },
      });
      write({
        jsonrpc: '2.0',
        method: 'turn.completed',
        params: {
          ...base,
          eventId: 'event-4',
          sequence: 4,
          data: { stopReason: 'completed' },
        },
      });
      break;
    }
    case 'session.close':
    case 'shutdown':
      result(req.id, { ok: true });
      if (req.method === 'shutdown') process.exit(0);
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
