import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const sessions = new Set();
const activeTurns = new Map();
let nextSessionId = 1;
const protocolV1 = (process.env.GIAN_PROTOCOL_VERSIONS ?? '')
  .split(',')
  .map(value => value.trim())
  .includes('1.0');

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    write({
      id: request.id,
      result: protocolV1
        ? {
            protocol: { name: 'gian.proxy', version: '1.0' },
            plugin: { id: 'grok', name: 'Grok Build', version: '0.1.0' },
            process: { scope: 'shared' },
            capabilities: { 'input.localFile': 1, 'input.localImage': 1 },
          }
        : { mode: 'spawn', methods: ['session.create', 'turn.start'] },
    });
    continue;
  }
  if (request.method === 'session.create') {
    const sessionId = protocolV1
      ? request.params?.sessionId
      : `session-${nextSessionId++}`;
    sessions.add(sessionId);
    write({
      id: request.id,
      result: {
        session: protocolV1
          ? {
              id: sessionId,
              streamId: `stream-${sessionId}`,
              nativeSession: { id: `native-${sessionId}` },
              status: 'idle',
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            }
          : { id: sessionId, status: 'idle' },
      },
    });
    continue;
  }
  if (request.method === 'turn.start') {
    const sessionId = request.params?.sessionId;
    if (!sessions.has(sessionId)) {
      write({ id: request.id, error: { code: 'NOT_FOUND', message: 'session missing' } });
      continue;
    }
    const localFile = request.params?.input?.find(item => item?.type === 'localFile');
    const content = await readFile(localFile.path, 'utf8');
    const turnId = protocolV1 ? request.params?.turnId : 'turn-1';
    activeTurns.set(sessionId, { turnId, content });
    if (protocolV1) {
      write({
        method: 'turn.started',
        params: {
          eventId: 'event-started',
          streamId: request.params?.streamId,
          sequence: 1,
          sessionId,
          turnId,
          emittedAt: new Date().toISOString(),
          data: {},
        },
      });
      write({
        method: 'content.delta',
        params: {
          eventId: 'event-delta',
          streamId: request.params?.streamId,
          sequence: 2,
          sessionId,
          turnId,
          emittedAt: new Date().toISOString(),
          data: { contentId: `text:${turnId}`, kind: 'text', delta: content },
        },
      });
      write({ id: request.id, result: { accepted: true, turnId } });
      queueMicrotask(() => {
        write({
          method: 'turn.completed',
          params: {
            eventId: 'event-completed',
            streamId: request.params?.streamId,
            sequence: 3,
            sessionId,
            turnId,
            emittedAt: new Date().toISOString(),
            data: { stopReason: 'completed' },
          },
        });
      });
      continue;
    }
    write({ method: 'turn.started', params: { sessionId, turnId, data: { status: 'running' } } });
    write({ id: request.id, result: { turn: { id: turnId, status: 'running' } } });
    if (process.env.GIAN_ATTACHMENT_CANARY_PROVIDER !== 'codex') {
      queueMicrotask(() => {
        write({ method: 'output.text', params: { sessionId, turnId, data: { text: content } } });
        write({ method: 'turn.completed', params: { sessionId, turnId, data: { status: 'completed' } } });
      });
    }
    continue;
  }
  if (request.method === 'turn.steer') {
    const sessionId = request.params?.sessionId;
    const active = activeTurns.get(sessionId);
    const localFile = request.params?.input?.find(item => item?.type === 'localFile');
    const content = await readFile(localFile.path, 'utf8');
    write({ id: request.id, result: { ok: true, turnId: active.turnId } });
    queueMicrotask(() => {
      write({
        method: 'output.text',
        params: { sessionId, turnId: active.turnId, data: { text: `${active.content}\n${content}` } },
      });
      write({
        method: 'turn.completed',
        params: { sessionId, turnId: active.turnId, data: { status: 'completed' } },
      });
    });
    continue;
  }
  if (request.method === 'turn.interrupt') {
    write({ id: request.id, result: { ok: true } });
    continue;
  }
  if (request.method === 'session.close') {
    sessions.delete(request.params?.sessionId);
    activeTurns.delete(request.params?.sessionId);
    write({ id: request.id, result: { ok: true } });
    continue;
  }
  if (request.method === 'shutdown') {
    write({ id: request.id, result: { ok: true } });
    setImmediate(() => process.exit(0));
    continue;
  }
  write({ id: request.id, error: { code: 'METHOD_NOT_FOUND', message: request.method } });
}
