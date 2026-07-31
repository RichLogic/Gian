// Minimal stdio JSON-RPC fixture for the codex-proxy host.
// Mirrors the real codex-proxy contract closely enough to exercise multi-session
// routing: notifications carry `params.sessionId` (the proxy-side session id —
// equal to the codex `threadId`), and `session.create` returns a unique
// `session.id` + `session.threadId` pair. There is no sessionKey on the wire.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let seq = 0;
const sessions = new Map(); // sessionId -> { threadId, cwd, model }

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
      write({
        id: req.id,
        result: { mode: 'spawn', protocolVersion: '0.1.0', methods: ['initialize', 'shutdown'] },
      });
      break;
    case 'capabilities.list':
      write({
        id: req.id,
        result: { protocolVersion: '0.1.0', models: [], slashCommands: [] },
      });
      break;
    case 'session.create': {
      const sessionId = `codex_sess_${++seq}`;
      const threadId = req.params?.threadId ?? `thread_${seq}`;
      const cwd = req.params?.cwd ?? '/tmp';
      const model = req.params?.model ?? null;
      sessions.set(sessionId, { threadId, cwd, model });
      write({
        id: req.id,
        result: {
          session: {
            id: sessionId,
            cwd,
            threadId,
            model,
            thinking: req.params?.thinking ?? null,
            status: 'idle',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z',
            lastError: null,
          },
        },
      });
      break;
    }
    case 'turn.start': {
      const sessionId = req.params?.sessionId;
      const session = sessions.get(sessionId);
      const turnId = `turn_${++seq}`;
      // Fire notifications BEFORE the response so tests can verify routing
      // while a request is still in flight. Routing is by `params.sessionId`.
      write({
        method: 'output.text',
        params: {
          sessionId,
          turnId,
          data: { text: `pong from ${sessionId}` },
        },
      });
      write({
        method: 'turn.completed',
        params: {
          sessionId,
          turnId,
          data: { status: 'completed', result: 'ok' },
        },
      });
      write({
        id: req.id,
        result: {
          session: {
            id: sessionId,
            cwd: session?.cwd ?? '/tmp',
            threadId: session?.threadId ?? null,
            model: session?.model ?? null,
            thinking: null,
            status: 'idle',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z',
            lastError: null,
          },
          turn: { id: turnId },
        },
      });
      break;
    }
    case 'session.close': {
      const sessionId = req.params?.sessionId;
      sessions.delete(sessionId);
      write({ id: req.id, result: { ok: true } });
      break;
    }
    case 'shutdown':
      write({ id: req.id, result: { ok: true } });
      process.exit(0);
    default:
      write({
        id: req.id,
        error: { code: 'METHOD_NOT_FOUND', message: req.method },
      });
  }
}
