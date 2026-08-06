import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const sessions = new Map();
let sequence = 0;

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function options(mode = 'default') {
  return [{
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: mode,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
      { value: 'auto', name: 'Auto' },
      { value: 'yolo', name: 'YOLO' },
    ],
  }];
}

for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  switch (request.method) {
    case 'initialize':
      write({
        id: request.id,
        result: {
          mode: 'spawn',
          protocolVersion: 'acp/1',
          methods: ['session.create', 'turn.start'],
        },
      });
      break;
    case 'capabilities.list':
      write({
        id: request.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'kimi-code', version: '0.29.2' },
          authMethods: [{ id: 'login', name: 'Kimi Code Login' }],
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {}, resume: {} },
          },
          models: [
            {
              id: 'kimi-model-kimi-k2',
              model: 'kimi-k2',
              displayName: 'Kimi K2',
              description: '',
              hidden: false,
              isDefault: true,
              defaultThinking: null,
              supportedThinking: ['low', 'medium', 'high'],
            },
            { id: 42, model: null },
          ],
        },
      });
      break;
    case 'session.create': {
      if (request.params?.cwd === '/auth-required') {
        write({
          id: request.id,
          error: {
            code: 'AUTH_REQUIRED',
            message: "Run '/managed/kimi' login in a terminal, then retry.",
          },
        });
        break;
      }
      const id = `kimi_proxy_${++sequence}`;
      const nativeSessionId = request.params?.nativeSessionId ?? `kimi_native_${sequence}`;
      const session = {
        id,
        cwd: request.params.cwd,
        nativeSessionId,
        status: 'idle',
        activeTurnId: null,
        configOptions: options(),
        slashCommands: [{
          name: 'skill:review',
          description: 'Review code',
          input: { hint: 'path' },
        }],
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
        lastError: null,
      };
      sessions.set(id, session);
      write({
        id: request.id,
        result: {
          session,
          replayUpdates: request.params?.resumeMode === 'load'
            ? [{
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'history' },
                },
              }]
            : [],
        },
      });
      break;
    }
    case 'session.snapshot': {
      const session = sessions.get(request.params.sessionId);
      write({
        id: request.id,
        result: {
          session,
          configOptions: session?.configOptions ?? [],
          slashCommands: session?.slashCommands ?? [],
        },
      });
      break;
    }
    case 'session.config.set': {
      const session = sessions.get(request.params.sessionId);
      session.configOptions = options(request.params.value);
      write({
        id: request.id,
        result: { session, configOptions: session.configOptions },
      });
      break;
    }
    case 'slash.list': {
      const session = sessions.get(request.params.sessionId);
      write({ id: request.id, result: { commands: session?.slashCommands ?? [] } });
      break;
    }
    case 'session.listNative':
      write({
        id: request.id,
        result: {
          sessions: [{
            sessionId: 'kimi-existing',
            cwd: request.params?.cwd ?? '/tmp',
            title: 'Existing Kimi session',
            updatedAt: '2026-07-29T00:00:00.000Z',
          }],
        },
      });
      break;
    case 'turn.start': {
      const sessionId = request.params.sessionId;
      write({
        method: 'acp.sessionUpdate',
        params: {
          sessionId,
          turnId: 'kimi-turn',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello from Kimi' },
            },
          },
        },
      });
      write({
        id: request.id,
        result: {
          session: sessions.get(sessionId),
          turn: { id: 'kimi-turn' },
        },
      });
      break;
    }
    case 'approval.respond':
    case 'turn.interrupt':
      write({ id: request.id, result: { ok: true } });
      break;
    case 'session.close':
      sessions.delete(request.params.sessionId);
      write({ id: request.id, result: { ok: true, detached: true } });
      break;
    case 'shutdown':
      write({ id: request.id, result: { ok: true } });
      process.exit(0);
      break;
    default:
      write({ id: request.id, error: { code: 'METHOD_NOT_FOUND', message: request.method } });
  }
}
