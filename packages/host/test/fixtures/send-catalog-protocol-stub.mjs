// gian.proxy/2 stdio stub for the send-catalog host tests.
// It records every request and speaks only the methods those tests drive.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';

const tracePath = process.env.STUB_TRACE;
const releasePath = process.env.STUB_RELEASE ?? '';
const mode = process.env.STUB_MODE ?? 'fences';
const resolveMode = process.env.STUB_RESOLVE ?? 'accept';
// 2 or more: hold Catalog-changed responses and emit that many in one write.
// One chunk lets the Host dispatch every conflict before a reload microtask.
const resolveBatch = Number(process.env.STUB_RESOLVE_BATCH ?? '0');
const sessions = JSON.parse(process.env.STUB_SESSIONS ?? '{}');
const pluginVersion = process.env.STUB_PLUGIN_VERSION ?? '0.1.0-Dev';
const emittedAt = '2026-08-10T00:00:00.000Z';

const choices = [
  { value: 'gemini-session-a', displayName: 'Session A' },
  { value: 'gemini-session-b', displayName: 'Session B' },
  { value: 'gemini-not-advertised', displayName: 'Rejected' },
];

function modelOption(defaultValue) {
  return {
    id: 'model',
    displayName: 'Model',
    binding: 'turn',
    control: 'select',
    required: false,
    defaultValue,
    choices,
  };
}

function catalog(revision) {
  // gian.proxy 2.2+ requires specialCatalogs. The model slot is what
  // turn.start checks against the resolved snapshot.
  return {
    catalogRevision: revision,
    input: [{ type: 'text' }],
    configOptions: [modelOption(null)],
    specialCatalogs: { model: 'model' },
    slashCommands: [],
  };
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function trace(request) {
  if (!tracePath) return;
  appendFileSync(tracePath, `${JSON.stringify({
    method: request.method,
    id: request.id,
    params: request.params,
  })}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, domainCode, message) {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message,
      data: { domainCode, retryable: false, details: {} },
    },
  });
}

function changed() {
  send({
    jsonrpc: '2.0',
    method: 'catalog.changed',
    params: {
      eventId: 'catalog-changed-1',
      emittedAt,
      data: { reason: 'refresh', revision: 'process-next' },
    },
  });
}

let catalogLists = 0;
let released = false;
const pendingResolves = [];
const releaseWaiters = [];
let scopedResolves = 0;

function waitRelease() {
  if (released) return Promise.resolve();
  return new Promise((resolve) => releaseWaiters.push(resolve));
}

function releaseNow() {
  if (released) return;
  released = true;
  const pending = releaseWaiters.splice(0);
  for (const resolve of pending) resolve();
}

function watchRelease() {
  if (!releasePath) return;
  const timer = setInterval(() => {
    if (existsSync(releasePath)) {
      clearInterval(timer);
      releaseNow();
    }
  }, 10);
  timer.unref?.();
}

function sessionBody(sessionId) {
  const fence = sessions[sessionId] ?? 'native-unset';
  return {
    id: sessionId,
    nativeSession: { id: `native-${sessionId}` },
    streamId: `stream-${sessionId}`,
    state: 'idle',
    sessionConfig: {},
    turnConfigOptions: [modelOption(
      fence.startsWith('gemini-') ? fence : 'gemini-session-a',
    )],
    turnConfigRevision: fence,
    createdAt: emittedAt,
    updatedAt: emittedAt,
  };
}

function conflictLine(id) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: 'Catalog changed; refresh its options before resolving.',
      data: { domainCode: 'CONFLICT', retryable: false, details: {} },
    },
  });
}

function flushResolves() {
  const lines = pendingResolves.splice(0).map((request) => conflictLine(request.id));
  if (lines.length === 0) return;
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function resolveResult(request) {
  const revision = request.params.catalogRevision;
  const model = request.params.turnConfig?.model;
  if (resolveMode === 'always-conflict') {
    if (resolveBatch > 1) {
      pendingResolves.push(request);
      if (pendingResolves.length >= resolveBatch) flushResolves();
      return;
    }
    fail(request.id, 'CONFLICT', 'Catalog changed; refresh its options before resolving.');
    return;
  }
  const sessionId = request.params.sessionId;
  const sessionRevision = `session-${sessionId}`;
  if (!['process-cold', 'process-fresh', sessionRevision, 'session-new'].includes(revision)
    || (resolveMode === 'conflict-cold' && revision === 'process-cold')) {
    fail(request.id, 'CONFLICT', 'Catalog changed; refresh its options before resolving.');
    return;
  }
  if (model === 'gemini-not-advertised') {
    fail(request.id, 'CONFIG_VALUE_INVALID', "Model 'gemini-not-advertised' is not an available Gemini model.");
    return;
  }
  const index = sessionId ? ++scopedResolves : 0;
  if (index === 1) {
    if (resolveMode === 'changed-during-resolve') changed();
    if (resolveMode === 'options-during-resolve') {
      send({
        jsonrpc: '2.0', method: 'session.updated',
        params: {
          eventId: 'options-updated-1', emittedAt, sessionId,
          streamId: `stream-${sessionId}`, sequence: 1,
          data: { turnConfigOptions: [modelOption('gemini-session-b')], turnConfigRevision: 'options-new' },
        },
      });
    }
    if (['hold-first', 'changed-during-resolve', 'options-during-resolve'].includes(resolveMode)) await waitRelease();
  }
  ok(request.id, {
    ...catalog(!sessionId ? 'global-resolved'
      : resolveMode === 'hold-first' ? (index === 1 ? 'session-old' : 'session-new') : sessionRevision),
    resolvedDefaults: { sessionConfig: {}, turnConfig: request.params.turnConfig ?? {} },
  });
}

async function onCatalogList(request) {
  catalogLists += 1;
  const index = catalogLists;
  if (mode === 'reject-old-list') {
    if (index === 1) changed();
    await waitRelease();
    if (index === 1) fail(request.id, 'RUNTIME_ERROR', 'Stale catalog list failed.');
    else ok(request.id, catalog('kept'));
    return;
  }
  if (mode === 'changed-during-list' && index === 1) {
    changed();
    ok(request.id, catalog('reloaded'));
    return;
  }
  ok(request.id, catalog(index === 1 ? 'process-cold' : 'process-fresh'));
}

async function handle(request) {
  if (request.method === 'initialize') {
    const versions = request.params?.protocol?.versions ?? [];
    const version = versions.includes('2.3') ? '2.3' : versions.includes('2.2') ? '2.2' : '2.3';
    ok(request.id, {
      protocol: { name: 'gian.proxy', version },
      plugin: { id: process.env.GIAN_PLUGIN_ID, name: 'Send catalog stub', version: pluginVersion },
      process: { scope: 'shared' },
      capabilities: { 'catalog.resolve': 1 },
    });
    return;
  }
  if (request.method === 'catalog.list') {
    await onCatalogList(request);
    return;
  }
  if (request.method === 'session.create') {
    ok(request.id, { session: sessionBody(request.params.sessionId) });
    return;
  }
  if (request.method === 'catalog.resolve') {
    await resolveResult(request);
    return;
  }
  if (request.method === 'turn.start') {
    ok(request.id, { accepted: true, turnId: request.params.turnId });
    return;
  }
  if (request.method === 'session.close') {
    ok(request.id, { ok: true });
  }
}

watchRelease();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const tasks = [];
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  trace(request);
  if (request.method === 'shutdown') {
    ok(request.id, { ok: true });
    releaseNow();
    break;
  }
  tasks.push(handle(request));
}
await Promise.all(tasks);
process.exit(0);
