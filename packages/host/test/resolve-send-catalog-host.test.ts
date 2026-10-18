import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProxyProtocolError } from '@gian/proxy-protocol';
import { ProtocolV2Host, type ProtocolV2SessionClient } from '../src/proxy/protocol-v2-session-client.js';
import { resolveSendCatalog } from '../src/session/resolve-send-catalog.js';

const stubEntry = fileURLToPath(new URL('./fixtures/send-catalog-protocol-stub.mjs', import.meta.url));

interface TraceRecord {
  method: string;
  id: string;
  params: {
    catalogRevision?: string;
    sessionId?: string;
    turnConfig?: { model?: string };
  };
}

async function readTrace(trace: string): Promise<TraceRecord[]> {
  try {
    const text = await readFile(trace, 'utf8');
    return text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as TraceRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(read: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the protocol stub.');
}

async function startHost(
  t: TestContext,
  options: {
    pluginId: string;
    mode?: string;
    resolve?: string;
    resolveBatch?: number;
    sessions: Record<string, string>;
  },
): Promise<{ host: ProtocolV2Host; trace: string; release: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gian-send-catalog-'));
  const trace = join(root, 'trace.ndjson');
  const release = join(root, 'release');
  const host = new ProtocolV2Host({
    entry: stubEntry,
    pluginId: options.pluginId,
    pluginVersion: '0.1.0-Dev',
    processScope: 'shared',
    dataDir: join(root, 'data'),
    hostVersion: '0.6.7-test',
    env: {
      STUB_TRACE: trace,
      STUB_RELEASE: release,
      STUB_MODE: options.mode ?? 'fences',
      STUB_RESOLVE: options.resolve ?? 'accept',
      STUB_RESOLVE_BATCH: String(options.resolveBatch ?? 0),
      STUB_PLUGIN_VERSION: '0.1.0-Dev',
      STUB_SESSIONS: JSON.stringify(options.sessions),
    },
  });
  t.after(async () => {
    await host.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { host, trace, release };
}

async function attach(
  host: ProtocolV2Host,
  sessionId: string,
): Promise<ProtocolV2SessionClient> {
  const client = host.createSessionClient(sessionId);
  await client.createSession({ cwd: '/tmp/project' });
  return client;
}

/** The production pre-dispatch path: frozen catalog(), then resolve, then one turn.start. */
async function firstSend(
  client: ProtocolV2SessionClient,
  sessionId: string,
  turnConfig: Record<string, string>,
): Promise<void> {
  const catalog = await client.catalog();
  await resolveSendCatalog(client, { sessionConfig: {}, turnConfig }, catalog.catalogRevision);
  await client.startTurn({
    sessionId,
    turnId: `turn-${sessionId}`,
    input: [{ type: 'text', text: 'hello' }],
    config: turnConfig,
  });
}

test('two attached Antigravity sessions resolve their own fences against one process catalog', async (t) => {
  const { host, trace } = await startHost(t, {
    pluginId: 'io.gian.antigravity',
    sessions: {
      a: 'native-a',
      b: 'native-b',
      ui: 'turn-config-ui-9',
    },
  });
  const a = await attach(host, 'a');
  const b = await attach(host, 'b');
  const ui = await attach(host, 'ui');
  assert.equal(a.sessionCatalogRevision(), 'native-a');
  assert.equal(b.sessionCatalogRevision(), 'native-b');
  // The Host UI revision is stored in the protocol field and is not a fence.
  assert.equal(ui.sessionCatalogRevision(), undefined);

  await firstSend(a, 'a', { model: 'gemini-session-a' });
  await firstSend(b, 'b', { model: 'gemini-session-b' });
  await firstSend(ui, 'ui', { model: 'gemini-session-a' });

  const records = await readTrace(trace);
  const lists = records.filter((record) => record.method === 'catalog.list');
  const resolves = records.filter((record) => record.method === 'catalog.resolve');
  const starts = records.filter((record) => record.method === 'turn.start');
  assert.equal(lists.length, 1, 'both sessions share the frozen process catalog');
  assert.deepEqual(resolves.map((record) => record.params.catalogRevision), [
    'native-a',
    'native-b',
    'process-cold',
  ]);
  assert.deepEqual(starts.map((record) => record.params.sessionId), ['a', 'b', 'ui']);
});

test('another proxy turnConfigRevision stays an options revision', async (t) => {
  const { host, trace } = await startHost(t, {
    pluginId: 'io.gian.grok',
    sessions: {
      ui: 'turn-config-ui-1',
      composer: 'composer-options-9',
    },
  });
  const ui = await attach(host, 'ui');
  const composer = await attach(host, 'composer');
  assert.equal(ui.sessionCatalogRevision(), undefined);
  assert.equal(composer.sessionCatalogRevision(), undefined);
  await firstSend(ui, 'ui', { model: 'gemini-session-a' });
  await firstSend(composer, 'composer', { model: 'gemini-session-b' });
  const records = await readTrace(trace);
  assert.deepEqual(
    records.filter((record) => record.method === 'catalog.resolve').map((record) => record.params.catalogRevision),
    ['process-cold', 'process-cold'],
  );
  assert.equal(records.filter((record) => record.method === 'turn.start').length, 2);
});

test('a persistent Catalog-changed conflict reloads once for two sessions and does not start turns', async (t) => {
  const { host, trace } = await startHost(t, {
    pluginId: 'io.gian.antigravity',
    resolve: 'always-conflict',
    sessions: { a: 'native-a', b: 'native-b' },
  });
  const a = await attach(host, 'a');
  const b = await attach(host, 'b');
  await assert.rejects(firstSend(a, 'a', { model: 'gemini-session-a' }), /Catalog changed/);
  await assert.rejects(firstSend(b, 'b', { model: 'gemini-session-b' }), /Catalog changed/);
  const records = await readTrace(trace);
  const resolves = records.filter((record) => record.method === 'catalog.resolve');
  assert.deepEqual(resolves.map((record) => [record.params.sessionId, record.params.catalogRevision]), [
    ['a', 'native-a'],
    ['a', 'process-fresh'],
    ['b', 'native-b'],
    ['b', 'process-fresh'],
  ]);
  assert.equal(
    records.filter((record) => record.method === 'catalog.list').length,
    3,
    'each send that already settled reloads once',
  );
  assert.equal(records.filter((record) => record.method === 'turn.start').length, 0);
});

test('concurrent first sends share the host catalog reload', async (t) => {
  // The stub writes both conflict responses in one chunk. ProtocolV2Host
  // dispatches that chunk before either reload microtask, so the shared
  // promise is reloadCatalog on the process cache.
  const { host, trace } = await startHost(t, {
    pluginId: 'io.gian.antigravity',
    resolve: 'always-conflict',
    resolveBatch: 2,
    sessions: { a: 'native-a', b: 'native-b' },
  });
  const a = await attach(host, 'a');
  const b = await attach(host, 'b');
  const listsBefore = (await readTrace(trace)).filter((record) => record.method === 'catalog.list').length;
  assert.equal(listsBefore, 1);
  await assert.rejects(Promise.all([
    firstSend(a, 'a', { model: 'gemini-session-a' }),
    firstSend(b, 'b', { model: 'gemini-session-b' }),
  ]));
  const records = await readTrace(trace);
  assert.equal(
    records.filter((record) => record.method === 'catalog.list').length,
    2,
    'the overlapping reloads share ProtocolV2Host.reloadCatalog',
  );
  assert.equal(records.filter((record) => record.method === 'catalog.resolve').length, 4);
  assert.equal(records.filter((record) => record.method === 'turn.start').length, 0);
});

test('an illegal catalog value is rejected once and does not start a turn', async (t) => {
  const { host, trace } = await startHost(t, {
    pluginId: 'io.gian.antigravity',
    sessions: { a: 'native-a' },
  });
  const a = await attach(host, 'a');
  await assert.rejects(
    firstSend(a, 'a', { model: 'gemini-not-advertised' }),
    (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFIG_VALUE_INVALID',
  );
  const records = await readTrace(trace);
  const resolves = records.filter((record) => record.method === 'catalog.resolve');
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0]?.params.catalogRevision, 'native-a');
  assert.equal(resolves[0]?.params.turnConfig?.model, 'gemini-not-advertised');
  assert.equal(records.filter((record) => record.method === 'catalog.list').length, 1);
  assert.equal(records.filter((record) => record.method === 'turn.start').length, 0);
});

test('catalog.changed during reload stays stale and the next catalog refetches', async (t) => {
  const { host, trace } = await startHost(t, {
    pluginId: 'io.gian.antigravity',
    mode: 'changed-during-list',
    sessions: { a: 'native-a' },
  });
  const client = host.createSessionClient('a');
  const reloaded = await client.reloadCatalog();
  assert.equal(reloaded.catalogRevision, 'reloaded');
  const next = await client.catalog();
  assert.equal(next.catalogRevision, 'process-fresh');
  const lists = (await readTrace(trace)).filter((record) => record.method === 'catalog.list');
  assert.equal(lists.length, 2);
});

test('a rejected catalog list does not clear a newer reload cache', async (t) => {
  const { host, trace, release } = await startHost(t, {
    pluginId: 'io.gian.antigravity',
    mode: 'reject-old-list',
    sessions: {},
  });
  const owner = host.createSessionClient('owner');
  const other = host.createSessionClient('other');
  const seen: string[] = [];
  owner.onNotification((notification) => seen.push(notification.method));
  const reload = owner.reloadCatalog();
  await waitFor(() => seen.includes('catalog.changed'));
  const kept = other.catalog();
  await waitFor(async () => (
    (await readTrace(trace)).filter((record) => record.method === 'catalog.list').length >= 2
  ));
  await writeFile(release, 'go');
  await assert.rejects(reload, /Stale catalog list failed/);
  assert.equal((await kept).catalogRevision, 'kept');
  // This client was not attached during the rejection, so its read hits the
  // host cache directly. A fence that clears every failed list would issue
  // a third catalog.list.
  const later = host.createSessionClient('later');
  assert.equal((await later.catalog()).catalogRevision, 'kept');
  assert.equal((await readTrace(trace)).filter((record) => record.method === 'catalog.list').length, 2);
});
