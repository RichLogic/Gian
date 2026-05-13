// Minimal stdio JSON-RPC fixture for CcProxyClient tests.
// Reads NDJSON requests from stdin and writes responses + a notification.
// Mirrors cc-proxy's stateless contract: session response carries id +
// claudeSessionId; notifications route by params.sessionId. There is no
// sessionKey on the wire.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Fire one notification on startup so tests can verify dispatch.
write({
  method: 'debug',
  params: {
    sessionId: 'sess_fixture',
    data: { message: 'fixture ready' },
  },
});

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
    case 'session.create':
      write({
        id: req.id,
        result: {
          session: {
            id: 'sess_fixture',
            cwd: req.params?.cwd ?? '/tmp',
            claudeSessionId: req.params?.claudeSessionId ?? 'cc_fixture',
            model: null,
            status: 'idle',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z',
            lastError: null,
          },
        },
      });
      break;
    case 'turn.start':
      // Send a turn.completed notification then the result.
      write({
        method: 'turn.completed',
        params: {
          requestId: req.id,
          sessionId: 'sess_fixture',
          turnId: 'turn_fixture',
          data: { status: 'completed', result: 'ok' },
        },
      });
      write({
        id: req.id,
        result: {
          session: {
            id: 'sess_fixture',
            mode: 'agent',
            cwd: '/tmp',
            model: null,
            status: 'idle',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z',
            lastError: null,
          },
          turn: { id: 'turn_fixture' },
        },
      });
      break;
    case 'fail.me':
      write({
        id: req.id,
        error: { code: 'INTERNAL_ERROR', message: 'forced failure' },
      });
      break;
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
