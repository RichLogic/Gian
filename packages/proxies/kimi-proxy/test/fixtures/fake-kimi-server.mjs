#!/usr/bin/env node
/**
 * Scriptable fake Kimi local server (`kimi web`) for zcode-proxy-style
 * deterministic tests of the kimi proxy.
 *
 * Usage: node fake-kimi-server.mjs web --no-open --port <N> --host 127.0.0.1
 *   (argv is accepted so the spawn contract matches the real CLI)
 * Scenario: FAKE_SCENARIO env var points at a JSON file; every request is
 * logged to FAKE_LOG (JSONL).
 *
 * Implements the subset of the kap-server surface the proxy uses:
 * - REST envelope {code, msg, data, request_id} with real error codes;
 * - POST /api/v1/workspaces, /api/v1/sessions (+list/get/profile/delete/
 *   children), prompts (+steer/:abort), approvals, questions, models, config,
 *   messages, file-history changes/content, shutdown;
 * - /api/v1/ws with server_hello, subscribe acks, ping/pong, and
 *   scenario-scripted session-event frames (seq/epoch journal semantics).
 */

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';

const scenarioPath = process.env.FAKE_SCENARIO;
const logPath = process.env.FAKE_LOG;
const scenario = scenarioPath ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
const log = (entry) => {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

// Parse `--port <N>` from argv (ignore everything else).
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(argv[portIndex + 1]) : 58627;
const TOKEN = scenario.token ?? 'test-token';
const KIMI_CODE_HOME = process.env.KIMI_CODE_HOME ?? process.env.HOME;

// Persist the token where the supervisor expects it.
try {
  fs.mkdirSync(`${KIMI_CODE_HOME}/server`, { recursive: true });
  fs.writeFileSync(`${KIMI_CODE_HOME}/server/server.token`, TOKEN, { mode: 0o600 });
} catch { /* best-effort */ }

let requestIdCounter = 1;
const requestId = () => `01FAKE${String(requestIdCounter++).padStart(20, '0')}`;
const ulid = () => crypto.randomBytes(12).toString('hex');

function envelope(res, status, code, msg, data, extra = {}) {
  const body = JSON.stringify({ code, msg, data, request_id: requestId(), ...extra });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}
const ok = (res, data) => envelope(res, 200, 0, 'success', data);
const fail = (res, code, msg) => envelope(res, 200, code, msg, null);

// ---- state (FAKE_STATE file persists sessions/workspaces across restarts) ----

const statePath = process.env.FAKE_STATE ?? null;

function persistState() {
  if (!statePath) return;
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      workspaces: [...state.workspaces.entries()],
      sessions: [...state.sessions.entries()].map(([id, session]) => [id, {
        info: session.info,
        messages: session.messages,
        childOf: session.childOf,
        turnCounter: session.turnCounter,
      }]),
    }));
  } catch { /* best-effort */ }
}

const state = {
  workspaces: new Map(), // root -> {id, root}
  sessions: new Map(), // id -> {info, messages, busy, activePrompt, turnCounter, childOf}
  approvals: new Map(), // id -> {record, decision}
  questions: new Map(),
  models: scenario.models ?? [],
  defaultModel: scenario.default_model ?? null,
  wsClients: new Set(),
};

if (statePath && fs.existsSync(statePath)) {
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const [root, workspace] of saved.workspaces ?? []) state.workspaces.set(root, workspace);
    for (const [id, session] of saved.sessions ?? []) {
      state.sessions.set(id, {
        info: session.info, messages: session.messages ?? [], busy: false, activePrompt: null,
        turnCounter: session.turnCounter ?? 0, childOf: session.childOf ?? null, turnIdByPrompt: new Map(),
      });
    }
  } catch { /* corrupt state: start clean */ }
}

function makeSessionInfo(cwd) {
  return {
    id: `session_${ulid()}`,
    workspace_id: '',
    title: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    busy: false,
    main_turn_active: false,
    pending_interaction: 'none',
    archived: false,
    metadata: { cwd },
    agent_config: {},
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

for (const seed of scenario.sessions ?? []) {
  const info = { ...makeSessionInfo(seed.cwd ?? '/tmp/fake-ws'), ...seed.info };
  state.sessions.set(info.id, {
    info,
    messages: seed.messages ?? [],
    busy: false,
    activePrompt: null,
    turnCounter: 0,
    childOf: seed.childOf ?? null,
    turnIdByPrompt: new Map(),
  });
}

const getTurnScript = (sessionId) => {
  const perSession = scenario.turns?.[sessionId];
  return perSession ?? scenario.turn ?? null;
};

// ---- turn scripts (WS event scheduling) ----

const timers = new Set();

function emitFrame(sessionId, type, payload) {
  const session = state.sessions.get(sessionId);
  if (!session) return;
  session.info.last_seq += 1;
  const frame = {
    type,
    seq: session.info.last_seq,
    epoch: `ep_${sessionId.slice(-8)}`,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: { type, ...payload },
  };
  for (const client of state.wsClients) {
    if (client.subscriptions.has(sessionId)) client.sendJson(frame);
  }
}

function scheduleScript(sessionId, script, promptId) {
  const session = state.sessions.get(sessionId);
  if (!session || !script) return;
  const turnId = ++session.turnCounter;
  session.turnIdByPrompt.set(promptId, turnId);
  let elapsed = script.delayBefore ?? 15;
  for (const step of script.events ?? []) {
    if (step.op === 'wait') {
      elapsed += step.ms ?? 20;
      continue;
    }
    const snapshot = { ...step };
    const at = elapsed;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (step.type === 'turn.ended') {
        session.busy = false;
        session.activePrompt = null;
        session.info.main_turn_active = false;
        session.info.last_turn_reason = step.payload?.reason ?? 'completed';
      }
      if (step.type === 'event.approval.requested') {
        state.approvals.set(step.payload.approval_id, {
          record: { approval_id: step.payload.approval_id, session_id: sessionId, agent_id: 'main', turn_id: turnId, tool_call_id: step.payload.tool_call_id ?? '', tool_name: step.payload.tool_name ?? '', action: step.payload.action ?? '', tool_input_display: step.payload.tool_input_display ?? null, created_at: new Date().toISOString(), expires_at: step.payload.expires_at ?? null },
          decision: null,
          feedback: null,
        });
      }
      if (step.type === 'event.question.requested') {
        state.questions.set(step.payload.question_id, {
          record: { question_id: step.payload.question_id, session_id: sessionId, agent_id: 'main', turn_id: turnId, questions: step.payload.questions ?? [], created_at: new Date().toISOString() },
          answers: null,
          note: null,
        });
      }
      emitFrame(sessionId, step.type, { promptId, turnId, ...(step.payload ?? {}) });
      log({ kind: 'ws-frame', sessionId, type: step.type, turnId });
    }, at);
    timer.unref();
    timers.add(timer);
    void snapshot;
  }
}

function abortScript(sessionId, promptId) {
  const session = state.sessions.get(sessionId);
  if (!session) return false;
  const turnId = session.turnIdByPrompt.get(promptId);
  session.busy = false;
  session.activePrompt = null;
  session.info.main_turn_active = false;
  if (turnId !== undefined) {
    emitFrame(sessionId, 'turn.ended', { promptId, turnId, reason: 'cancelled' });
    return true;
  }
  return false;
}

// ---- WS (minimal RFC6455 server) ----

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsSendText(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function attachWs(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const client = {
    socket,
    subscriptions: new Set(),
    buffer: Buffer.alloc(0),
    sendJson: (value) => wsSendText(socket, JSON.stringify(value)),
  };
  state.wsClients.add(client);
  client.sendJson({
    type: 'server_hello',
    timestamp: new Date().toISOString(),
    payload: {
      ws_connection_id: `conn_${ulid()}`,
      protocol_version: 2,
      heartbeat_ms: 10000,
      max_event_buffer_size: 1000,
      capabilities: { event_batching: false, compression: false },
    },
  });
  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    for (;;) {
      if (client.buffer.length < 2) return;
      const opcode = client.buffer[0] & 0x0f;
      const masked = (client.buffer[1] & 0x80) !== 0;
      let length = client.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (client.buffer.length < 4) return;
        length = client.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (client.buffer.length < 10) return;
        length = Number(client.buffer.readBigUInt64BE(2)); offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (client.buffer.length < offset + 4) return;
        maskKey = client.buffer.subarray(offset, offset + 4); offset += 4;
      }
      if (client.buffer.length < offset + length) return;
      let payload = Buffer.from(client.buffer.subarray(offset, offset + length));
      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }
      client.buffer = client.buffer.subarray(offset + length);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x9) {
        // protocol-level ping → pong
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        socket.write(pong);
        continue;
      }
      if (opcode !== 0x1) continue;
      const frame = JSON.parse(payload.toString('utf8'));
      log({ kind: 'ws-in', type: frame.type, payload: frame.payload });
      if (frame.type === 'pong') continue;
      if (frame.type === 'ping') {
        client.sendJson({ type: 'pong', payload: { nonce: frame.payload?.nonce ?? '' } });
        continue;
      }
      if (frame.type === 'client_hello' || frame.type === 'subscribe') {
        const requested = frame.type === 'subscribe'
          ? (frame.payload?.session_ids ?? [])
          : (frame.payload?.subscriptions ?? frame.payload?.subscribe_sessions ?? []);
        const accepted = [];
        const notFound = [];
        const cursors = {};
        for (const sid of requested) {
          const session = state.sessions.get(sid);
          if (!session) { notFound.push(sid); continue; }
          accepted.push(sid);
          cursors[sid] = { seq: session.info.last_seq, epoch: `ep_${sid.slice(-8)}` };
          client.subscriptions.add(sid);
        }
        client.sendJson({
          type: 'ack', id: frame.id ?? '', code: 0, msg: 'success',
          payload: { accepted, not_found: notFound, resync_required: [], cursors },
        });
        // A ping right after subscription exercises the pong path.
        client.sendJson({ type: 'ping', timestamp: new Date().toISOString(), payload: { nonce: ulid() } });
      }
      if (frame.type === 'unsubscribe') {
        for (const sid of frame.payload?.session_ids ?? []) client.subscriptions.delete(sid);
        client.sendJson({ type: 'ack', id: frame.id ?? '', code: 0, msg: 'success', payload: { accepted: [], not_found: [], resync_required: [] } });
      }
    }
  });
  socket.on('close', () => state.wsClients.delete(client));
  socket.on('error', () => state.wsClients.delete(client));
}

// ---- REST ----

function readBody(req) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolvePromise(raw === '' ? {} : JSON.parse(raw)); } catch { resolvePromise({}); }
    });
  });
}

function sessionView(session) {
  return { ...session.info };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const auth = req.headers.authorization ?? '';
  if (path !== '/api/v1/healthz' && auth !== `Bearer ${TOKEN}`) {
    envelope(res, 401, 40112, 'unauthorized', null);
    return;
  }
  const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
    ? await readBody(req)
    : {};
  log({ kind: 'request', method: req.method, path, query: Object.fromEntries(url.searchParams), body });

  const segments = path.split('/').filter(Boolean); // ['api','v1',...]
  // Glued action paths (`:delete`/`:archive`) put the action inside segment 2.
  const gluedAction = segments[3]?.match(/^(session_[^:]+):(delete|archive)$/);
  const sid = gluedAction != null
    ? gluedAction[1]
    : segments[3]?.startsWith('session_') ? segments[3] : null;
  const session = sid !== null ? state.sessions.get(sid) : undefined;

  try {
    // Health/meta/models/config/workspaces
    if (req.method === 'GET' && path === '/api/v1/healthz') return ok(res, { ok: true });
    if (req.method === 'GET' && path === '/api/v1/meta') {
      return ok(res, {
        server_version: '2.1.1-fake', server_id: `srv_${ulid()}`,
        started_at: new Date().toISOString(), capabilities: {}, backend: 'v2',
      });
    }
    if (req.method === 'GET' && path === '/api/v1/models') return ok(res, { items: state.models });
    if (req.method === 'GET' && path === '/api/v1/config') return ok(res, { default_model: state.defaultModel });
    if (req.method === 'POST' && path === '/api/v1/workspaces') {
      const root = body.root ?? '';
      if (!fs.existsSync(root)) return fail(res, 40409, `workspace root ${root} does not exist`);
      const existing = state.workspaces.get(root);
      if (existing) return ok(res, existing);
      const workspace = { id: `wd_${ulid()}`, root, name: root.split('/').pop() ?? root, created_at: new Date().toISOString(), session_count: 0 };
      state.workspaces.set(root, workspace);
      persistState();
      return ok(res, workspace);
    }
    if (req.method === 'POST' && path === '/api/v1/sessions') {
      const info = makeSessionInfo(body.metadata?.cwd ?? '/tmp/fake-ws');
      info.workspace_id = body.workspace_id ?? '';
      if (body.agent_config) info.agent_config = body.agent_config;
      state.sessions.set(info.id, { info, messages: [], busy: false, activePrompt: null, turnCounter: 0, childOf: null, turnIdByPrompt: new Map() });
      persistState();
      return ok(res, info);
    }
    if (req.method === 'GET' && path === '/api/v1/sessions') {
      const pageSize = Number(url.searchParams.get('page_size') ?? 50);
      const afterId = url.searchParams.get('after_id');
      const busyOnly = url.searchParams.get('busy');
      let items = [...state.sessions.values()].map(sessionView);
      if (busyOnly === 'false') items = items.filter((info) => info.busy === false);
      if (afterId) {
        const index = items.findIndex((info) => info.id === afterId);
        if (index >= 0) items = items.slice(index + 1);
      }
      const hasMore = items.length > pageSize;
      return ok(res, { items: items.slice(0, pageSize), has_more: hasMore });
    }
    if (req.method === 'POST' && gluedAction?.[2] === 'delete') {
      if (!session) return fail(res, 40401, 'session not found');
      state.sessions.delete(sid);
      return ok(res, { deleted: true });
    }
    if (req.method === 'POST' && gluedAction?.[2] === 'archive') {
      if (!session) return fail(res, 40401, 'session not found');
      return ok(res, { archived: true });
    }
    if (req.method === 'POST' && path === `/api/v1/sessions/${sid}/children`) {
      if (!session) return fail(res, 40401, 'session not found');
      const childInfo = makeSessionInfo(session.info.metadata?.cwd ?? '/tmp/fake-ws');
      childInfo.title = body.title ?? `Fork of ${session.info.title}`;
      state.sessions.set(childInfo.id, {
        info: childInfo, messages: [], busy: false, activePrompt: null, turnCounter: 0,
        childOf: sid, turnIdByPrompt: new Map(),
      });
      return ok(res, childInfo);
    }
    if (sid !== null && !session) return fail(res, 40401, 'session not found');

    if (req.method === 'GET' && path === `/api/v1/sessions/${sid}`) return ok(res, sessionView(session));
    if (req.method === 'POST' && path === `/api/v1/sessions/${sid}/profile`) {
      if (typeof body.title === 'string' && body.title !== '') session.info.title = body.title;
      return ok(res, sessionView(session));
    }
    if (req.method === 'GET' && path === `/api/v1/sessions/${sid}/messages`) {
      const pageSize = Number(url.searchParams.get('page_size') ?? 200);
      const afterId = url.searchParams.get('after_id');
      let items = session.messages;
      if (afterId) {
        const index = items.findIndex((message) => message.id === afterId);
        if (index >= 0) items = items.slice(index + 1);
      }
      const hasMore = items.length > pageSize;
      return ok(res, { items: items.slice(0, pageSize), has_more: hasMore });
    }
    if (req.method === 'GET' && path === `/api/v1/sessions/${sid}/status`) {
      return ok(res, {
        busy: session.busy, model: session.info.agent_config?.model ?? '',
        thinking_level: session.info.agent_config?.thinking ?? '', permission: 'manual',
        plan_mode: false, swarm_mode: false, tower_mode: false,
        context_tokens: session.info.usage?.context_tokens ?? 0, max_context_tokens: 0, context_usage: 0,
      });
    }
    if (req.method === 'POST' && path === `/api/v1/sessions/${sid}/prompts`) {
      if (scenario.behavior?.rejectPrompts) return fail(res, 40113, 'model not resolved');
      const promptId = typeof body.prompt_id === 'string' && body.prompt_id !== ''
        ? body.prompt_id
        : `msg_${ulid()}`;
      const userMessageId = `msg_${ulid()}`;
      const wasBusy = session.busy;
      const status = wasBusy ? 'queued' : 'running';
      if (!wasBusy) {
        session.busy = true;
        session.activePrompt = promptId;
        session.info.main_turn_active = true;
        session.messages.push({
          id: userMessageId, session_id: sid, role: 'user',
          content: body.content ?? [], created_at: new Date().toISOString(), prompt_id: promptId,
        });
        session.info.message_count += 1;
        const script = getTurnScript(sid);
        if (script) scheduleScript(sid, script, promptId);
      }
      return ok(res, {
        prompt_id: promptId, user_message_id: userMessageId, status,
        content: body.content ?? [], created_at: new Date().toISOString(),
      });
    }
    if (req.method === 'POST' && path === `/api/v1/sessions/${sid}/prompts:steer`) {
      const ids = body.prompt_ids ?? [];
      if (!session.busy || ids.length === 0) return fail(res, 40402, 'no active prompt to steer into');
      emitFrame(sid, 'prompt.steered', { activePromptId: session.activePrompt, promptIds: ids });
      return ok(res, { steered: true, prompt_ids: ids });
    }
    if (req.method === 'POST' && segments[4] === 'prompts' && segments[5] !== undefined && segments[6] === undefined) {
      if (segments[5].endsWith(':abort')) {
        const bare = segments[5].replace(/:abort$/, '');
        const aborted = abortScript(sid, bare);
        return ok(res, { aborted, at_seq: session.info.last_seq });
      }
      return fail(res, 40402, 'unknown prompt action');
    }
    if (req.method === 'GET' && path === `/api/v1/sessions/${sid}/approvals`) {
      const items = [...state.approvals.values()]
        .filter((entry) => entry.record.session_id === sid && entry.decision === null)
        .map((entry) => entry.record);
      return ok(res, { items });
    }
    if (req.method === 'POST' && segments[4] === 'approvals' && segments[5] !== undefined && segments[6] === undefined) {
      const entry = state.approvals.get(segments[5]);
      if (!entry) return fail(res, 40404, 'approval not found');
      if (entry.decision !== null) return fail(res, 40902, 'approval already resolved');
      entry.decision = body.decision ?? null;
      entry.feedback = body.feedback ?? null;
      return ok(res, { resolved: true });
    }
    if (req.method === 'GET' && path === `/api/v1/sessions/${sid}/questions`) {
      const items = [...state.questions.values()]
        .filter((entry) => entry.record.session_id === sid && entry.answers === null)
        .map((entry) => entry.record);
      return ok(res, { items });
    }
    if (req.method === 'POST' && segments[4] === 'questions' && segments[5] !== undefined && segments[6] === undefined) {
      const entry = state.questions.get(segments[5].replace(/:dismiss$/, ''));
      if (!entry) return fail(res, 40405, 'question not found');
      if (segments[5].endsWith(':dismiss')) {
        entry.answers = {};
        return ok(res, { answered: true });
      }
      if (entry.answers !== null) return fail(res, 40909, 'question dismissed or answered');
      entry.answers = body.answers ?? null;
      entry.note = body.note ?? null;
      return ok(res, { answered: true });
    }
    if (req.method === 'GET' && path === `/api/v1/sessions/${sid}/file-history/changes`) {
      const turnId = url.searchParams.get('turn_id') ?? '';
      const entry = scenario.fileHistory?.[turnId];
      return ok(res, entry ? { changes: entry.changes, recorded: true } : { changes: [], recorded: false });
    }
    if (req.method === 'GET' && path === `/api/v1/sessions/${sid}/file-history/content`) {
      const turnId = url.searchParams.get('turn_id') ?? '';
      const file = url.searchParams.get('path') ?? '';
      const phase = url.searchParams.get('phase') ?? 'after';
      const content = scenario.fileHistory?.[turnId]?.content?.[file]?.[phase];
      if (content === undefined) return fail(res, 40407, 'file not found');
      return ok(res, { content: { version: 1, content } });
    }
    if (req.method === 'GET' && path === `/api/v1/sessions/${sid}/skills`) {
      return ok(res, { skills: scenario.skills ?? [] });
    }
    if (req.method === 'POST' && path === '/api/v1/shutdown') {
      ok(res, {});
      setTimeout(() => process.exit(0), 50);
      return undefined;
    }
    return fail(res, 40401, `Method not found: ${req.method} ${path}`);
  } catch (error) {
    return envelope(res, 200, 50001, error instanceof Error ? error.message : String(error), null, {
      stack: String(error?.stack ?? '').slice(0, 500),
    });
  }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/api/v1/ws') { socket.destroy(); return; }
  const auth = req.headers.authorization ?? '';
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',');
  const protocolToken = protocols
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('kimi-code.bearer.'))
    ?.slice('kimi-code.bearer.'.length);
  if (auth !== `Bearer ${TOKEN}` && protocolToken !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  attachWs(req, socket);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Kimi server: http://127.0.0.1:${PORT}/#token=${TOKEN}\n`);
  if (scenario.behavior?.selfDestructMs) {
    const timer = setTimeout(() => process.exit(9), scenario.behavior.selfDestructMs);
    timer.unref();
  }
});

// Drain stdin so the supervisor's spawn does not block on a full pipe.
createInterface({ input: process.stdin }).on('line', () => undefined);

process.on('SIGTERM', () => process.exit(0));
