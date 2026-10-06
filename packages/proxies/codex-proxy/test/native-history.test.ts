import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile, open, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ReplayPageValidator } from '@gian/proxy-protocol';
import {
  CodexNativeHistoryWatcher,
  listCodexNativeSessions,
  NativeTurnIdentityStore,
} from '../src/protocol/native-history.js';
import { NativeHistoryIndex, type NativeReplaySnapshot } from '../src/protocol/native-replay.js';

async function collect(snapshot: NativeReplaySnapshot) {
  const events = [];
  let cursor: string | null = null;
  do {
    const page = await snapshot.page(Number(cursor ?? 0), 100);
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { streamId: snapshot.streamId, events };
}

async function replayCodexNativeSession(host: string, native: string, home?: string, identities?: NativeTurnIdentityStore) {
  const index = new NativeHistoryIndex(host, native, home, identities, home ? join(home, 'cache') : process.env.CODEX_HOME);
  let snapshot: NativeReplaySnapshot | undefined;
  try { snapshot = await index.refresh(); return await collect(snapshot); }
  finally { snapshot?.close(); await index.close(); }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('Codex lazy Fork replay follows pinned ancestry without reading future parent turns', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-codex-lazy-fork-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.codex', 'sessions');
  await mkdir(dir, { recursive: true });
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const meta = (id: string, base?: { thread_id: string; end_byte_offset: number }) => line({
    type: 'session_meta', payload: { id, cwd: '/test', ...(base ? { history_base: base } : {}) },
  });
  const prefix = meta('parent')
    + line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'inherited-turn' } })
    + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧🙂' }] } })
    + line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'inherited answer' }] } })
    + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'inherited-turn' } });
  await writeFile(join(dir, 'rollout-parent.jsonl'), prefix
    + line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'future-turn' } })
    + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'DO_NOT_LEAK' }] } }));
  const child = meta('child', { thread_id: 'parent', end_byte_offset: Buffer.byteLength(prefix) });
  await writeFile(join(dir, 'rollout-child.jsonl'), child);
  await writeFile(join(dir, 'rollout-grandchild.jsonl'), meta('grandchild', { thread_id: 'child', end_byte_offset: Buffer.byteLength(child) }));
  const replay = await replayCodexNativeSession('host-fork', 'grandchild', home);
  assert.equal(replay.events.find(event => event.method === 'turn.completed')?.sourceTurnId, 'inherited-turn');
  assert.match(JSON.stringify(replay), /inherited answer/);
  assert.doesNotMatch(JSON.stringify(replay), /DO_NOT_LEAK|future-turn/);
  const archive = join(home, '.codex', 'archived_sessions');
  await mkdir(archive);
  await rename(join(dir, 'rollout-parent.jsonl'), join(archive, 'rollout-parent.jsonl'));
  assert.equal((await replayCodexNativeSession('host-fork', 'grandchild', home)).events
    .find(event => event.method === 'turn.completed')?.sourceTurnId, 'inherited-turn');
  assert.ok(!listCodexNativeSessions('/test', home).some(session => session.id === 'parent'));
  await writeFile(join(dir, 'rollout-child.jsonl'), meta('child', { thread_id: 'child', end_byte_offset: Buffer.byteLength(child) }));
  await assert.rejects(replayCodexNativeSession('host-cycle', 'child', home), /Cyclic|prefix/);
});

test('Codex 0.156 replay reads the selected CODEX_HOME and native task identity', async t => {
  const configHome = await mkdtemp(join(tmpdir(), 'gian-codex-selected-home-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = configHome;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(configHome, { recursive: true, force: true });
  });
  const directory = join(configHome, 'sessions', '2026', '09', '23');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'rollout-2026-09-23T00-00-00-native-modern.jsonl'), [
    { type: 'session_meta', payload: { id: 'native-modern', cwd: '/test' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'native-turn-modern' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_ENVIRONMENT' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] } } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'question' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'native-turn-modern' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'unfinished' } },
  ].map(value => JSON.stringify(value)).join('\n'));
  assert.equal(listCodexNativeSessions('/test')[0]?.id, 'native-modern');
  const replay = await replayCodexNativeSession('host-modern', 'native-modern');
  const completed = replay.events.filter(event => event.method === 'turn.completed');
  assert.equal(completed.length, 1, 'an unfinished native task must not be marked completed');
  assert.equal(completed[0]?.sourceTurnId, 'native-turn-modern');
  assert.equal(replay.events.find(event => event.method === 'content.completed')?.data.content, 'answer');
  assert.equal(replay.events.filter(event => event.method === 'content.completed').length, 1);
  assert.deepEqual(replay.events.find(event => event.method === 'input.recorded')?.data.input, [{ type: 'text', text: 'question' }]);
  assert.doesNotMatch(JSON.stringify(replay), /PRIVATE_ENVIRONMENT/);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('timed out waiting for native history watcher');
}

test('Codex plugin owns native discovery and normalized replay', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-codex-native-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.codex', 'sessions', '2026', '08', '10');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'rollout-2026-08-10T00-00-00-native-codex.jsonl');
  await writeFile(path, [
    { type: 'session_meta', payload: { id: 'native-codex', cwd: '/workspace/project' } },
    { timestamp: '2026-08-10T01:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'First question' } },
    { timestamp: '2026-08-10T01:00:01.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'First answer' } },
    { timestamp: '2026-08-10T01:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Second question' } },
    { timestamp: '2026-08-10T01:01:01.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Second answer' } },
  ].map(value => JSON.stringify(value)).join('\n'));

  const listed = listCodexNativeSessions('/workspace/project', home);
  assert.equal(listed[0]?.id, 'native-codex');
  assert.equal(listed[0]?.displayName, 'First question');

  const replay = await replayCodexNativeSession('host-session', 'native-codex', home);
  assert.deepEqual(replay.events.map(event => event.method), [
    'turn.started', 'input.recorded', 'content.completed', 'turn.completed',
    'turn.started', 'input.recorded', 'content.completed', 'turn.completed',
  ]);
  const validator = new ReplayPageValidator('host-session');
  assert.doesNotThrow(() => validator.acceptPage({
    replayStreamId: replay.streamId,
    events: replay.events,
    nextCursor: null,
  }));

  let changes = 0;
  const watcher = new CodexNativeHistoryWatcher(
    'native-codex',
    () => { changes += 1; },
    10,
    home,
  );
  watcher.start();
  t.after(() => watcher.stop());
  await appendFile(path, `\n${JSON.stringify({
    timestamp: '2026-08-10T01:02:00.000Z', type: 'event_msg',
    payload: { type: 'user_message', message: 'External question' },
  })}`);
  await waitFor(() => changes === 1);
  const appended = await replayCodexNativeSession('host-session', 'native-codex', home);
  assert.equal(appended.streamId, replay.streamId);
  assert.deepEqual(
    appended.events.slice(0, replay.events.length).map(event => event.eventId),
    replay.events.map(event => event.eventId),
  );

  watcher.pause();
  await appendFile(path, `\n${JSON.stringify({
    timestamp: '2026-08-10T01:02:01.000Z', type: 'event_msg',
    payload: { type: 'agent_message', message: 'Own answer' },
  })}`);
  await delay(40);
  assert.equal(changes, 1);
  watcher.resume();
});

test('live Provider turn identity survives normalized replay without persisting prompt text', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-codex-identity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataDir = join(home, 'plugin-data');
  const directory = join(home, '.codex', 'sessions', '2026', '08', '18');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'rollout-native-identity.jsonl'), [
    { type: 'session_meta', payload: { id: 'native-identity', cwd: '/workspace/project' } },
    { timestamp: '2026-08-18T01:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Sensitive fixture prompt' } },
    { timestamp: '2026-08-18T01:00:01.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Fixture answer' } },
  ].map(value => JSON.stringify(value)).join('\n'));

  const store = new NativeTurnIdentityStore(dataDir);
  store.recordLive(
    'native-identity',
    'provider-turn-stable',
    [{ type: 'text', text: 'Sensitive fixture prompt' }],
  );
  const replay = await replayCodexNativeSession('host-session', 'native-identity', home, store);
  assert.ok(replay.events.every(event => event.sourceTurnId === 'provider-turn-stable'));

  const persisted = await readFile(join(dataDir, 'codex-native-turn-identities.json'), 'utf8');
  assert.doesNotMatch(persisted, /Sensitive fixture prompt/);
  const restarted = await replayCodexNativeSession(
    'host-session',
    'native-identity',
    home,
    new NativeTurnIdentityStore(dataDir),
  );
  assert.deepEqual(
    restarted.events.map(event => event.eventId),
    replay.events.map(event => event.eventId),
  );
});

test('native turn identity persistence is bounded by least-recently-used cleanup', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-codex-identity-prune-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataDir = join(home, 'plugin-data');
  let now = 1;
  const store = new NativeTurnIdentityStore(dataDir, {
    maxEntries: 2,
    now: () => now,
  });

  store.recordLive('native-prune', 'provider-old', [{ type: 'text', text: 'Old secret prompt' }]);
  now += 1;
  store.recordLive('native-prune', 'provider-recent', [{ type: 'text', text: 'Recent secret prompt' }]);
  now += 1;
  store.recordLive('native-prune', 'provider-old', [{ type: 'text', text: 'Old secret prompt' }]);
  now += 1;
  store.recordLive('native-prune', 'provider-new', [{ type: 'text', text: 'New secret prompt' }]);

  const path = join(dataDir, 'codex-native-turn-identities.json');
  const persisted = await readFile(path, 'utf8');
  const identities = JSON.parse(persisted) as Array<{ providerTurnId: string }>;
  assert.deepEqual(
    identities.map(entry => entry.providerTurnId),
    ['provider-old', 'provider-new'],
  );
  assert.doesNotMatch(persisted, /secret prompt/i);

  const restarted = new NativeTurnIdentityStore(dataDir, { maxEntries: 2, now: () => now });
  assert.equal(
    restarted.resolveReplay(
      'native-prune',
      'rollout-line-old',
      [{ type: 'text', text: 'Old secret prompt' }],
      'fallback-old',
    ),
    'provider-old',
  );
  assert.equal(
    restarted.resolveReplay(
      'native-prune',
      'rollout-line-evicted',
      [{ type: 'text', text: 'Recent secret prompt' }],
      'fallback-evicted',
    ),
    'fallback-evicted',
  );
});

test('large lazy Fork history is disk-paged, prefix-pinned and append-incremental', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-codex-large-replay-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.codex', 'sessions');
  await mkdir(dir, { recursive: true });
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const parent = join(dir, 'rollout-large-parent.jsonl');
  const file = await open(parent, 'w');
  await file.writeFile(line({ type: 'session_meta', payload: { id: 'large-parent', cwd: '/test' } })
    + line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'large-turn' } })
    + line({ type: 'event_msg', payload: { type: 'user_message', message: 'before fork' } }));
  const ignored = line({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(4096) } }).repeat(256);
  for (let i = 0; i < 65; i += 1) await file.writeFile(ignored);
  await file.writeFile(line({ type: 'event_msg', payload: { type: 'agent_message', message: 'large answer' } })
    + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'large-turn' } }));
  await file.close();
  const prefix = (await stat(parent)).size;
  assert.ok(prefix > 64 * 1024 * 1024);
  await appendFile(parent, line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'future-parent' } }));
  const child = join(dir, 'rollout-large-child.jsonl');
  await writeFile(child, line({ type: 'session_meta', payload: { id: 'large-child', cwd: '/test',
    history_base: { thread_id: 'large-parent', end_byte_offset: prefix } } }));
  const cache = join(home, 'cache');
  const index = new NativeHistoryIndex('host', 'large-child', home, undefined, cache);
  let old: NativeReplaySnapshot | undefined;
  let latest: NativeReplaySnapshot | undefined;
  try {
    old = await index.refresh();
    const before = await collect(old);
    assert.equal(old.eventCount, 4);
    assert.equal('events' in old, false, 'snapshot must not materialize the complete event array');
    assert.match(JSON.stringify(before), /large answer/);
    assert.doesNotMatch(JSON.stringify(before), /future-parent/);
    const bytes = index.metrics.bytesRead;
    const append = line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } })
      + line({ type: 'event_msg', payload: { type: 'user_message', message: 'new child turn' } });
    await appendFile(child, append);
    latest = await index.refresh();
    assert.equal(index.metrics.bytesRead - bytes, Buffer.byteLength(append), 'append must not rescan the inherited 64+ MiB');
    assert.equal(index.metrics.rebuilds, 1);
    assert.equal(latest.eventCount, 6);
    assert.deepEqual((await collect(old)).events, before.events, 'existing cursor snapshot remains immutable');
    const after = await collect(latest);
    assert.deepEqual(after.events.slice(0, 4).map(e => e.eventId), before.events.map(e => e.eventId));
    await index.close();
    assert.deepEqual((await collect(old)).events, before.events, 'closing the reader does not invalidate pinned pages');
  } finally { old?.close(); latest?.close(); await index.close(); }
  assert.deepEqual(await readdir(join(cache, 'codex-replay-cache')), [], 'closing the last snapshot reclaims derived cache files');
});

test('split UTF-8 tails, valid final records, rewrites and restarts keep stable replay identities', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-codex-replay-tail-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.codex', 'sessions');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'rollout-tail.jsonl');
  const header = `${JSON.stringify({ type: 'session_meta', payload: { id: 'tail', cwd: '/test' } })}\n`;
  const record = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'UTF-8🙂' } }));
  const split = record.indexOf(Buffer.from('🙂')) + 2;
  await writeFile(path, Buffer.concat([Buffer.from(header), record.subarray(0, split)]));
  const index = new NativeHistoryIndex('host', 'tail', home, undefined, join(home, 'cache'));
  const snapshots: NativeReplaySnapshot[] = [];
  try {
    snapshots.push(await index.refresh());
    assert.equal(snapshots.at(-1)!.eventCount, 0);
    await appendFile(path, record.subarray(split));
    snapshots.push(await index.refresh());
    const visible = await collect(snapshots.at(-1)!);
    assert.match(JSON.stringify(visible), /UTF-8🙂/);
    await appendFile(path, '\n');
    snapshots.push(await index.refresh());
    assert.deepEqual((await collect(snapshots.at(-1)!)).events, visible.events);
    await writeFile(path, header + `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'rewrite' } })}\n`);
    snapshots.push(await index.refresh());
    assert.match(JSON.stringify(await collect(snapshots.at(-1)!)), /rewrite/);
    assert.match(JSON.stringify(await collect(snapshots[1]!)), /UTF-8🙂/, 'rewrites must not alter pinned snapshots');
    const restarted = await replayCodexNativeSession('host', 'tail', home);
    assert.deepEqual(restarted.events, (await collect(snapshots.at(-1)!)).events);
  } finally { for (const snapshot of snapshots) snapshot.close(); await index.close(); }
});

test('missing pinned ancestry and malformed complete records fail explicitly instead of returning empty history', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-codex-invalid-history-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.codex', 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'rollout-broken.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: {
    id: 'broken', cwd: '/test', history_base: { thread_id: 'missing', end_byte_offset: 100 },
  } })}\n`);
  await assert.rejects(replayCodexNativeSession('host', 'broken', home), /inherited history is unavailable/);
  await writeFile(join(dir, 'rollout-broken.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'broken', cwd: '/test' } })}\nnot-json\n`);
  await assert.rejects(replayCodexNativeSession('host', 'broken', home), /Malformed Codex history record/);
  await writeFile(join(dir, 'rollout-broken.jsonl'), 'not-json\n');
  await assert.rejects(replayCodexNativeSession('host', 'broken', home), /metadata is unavailable or invalid/);
});

test('80 MiB of replayable text fits a 64 MiB heap with protocol-byte-bounded disk pages', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-codex-replay-memory-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.codex', 'sessions');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'rollout-memory.jsonl');
  const file = await open(path, 'w');
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  try {
    await file.writeFile(line({ type: 'session_meta', payload: { id: 'memory', cwd: '/test' } }));
    const message = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 80; i += 1) {
      await file.writeFile(line({ type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${i}` } })
        + line({ type: 'event_msg', payload: { type: 'user_message', message: `question-${i}` } })
        + line({ type: 'event_msg', payload: { type: 'agent_message', message } })
        + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${i}` } }));
    }
  } finally { await file.close(); }
  const module = new URL('../src/protocol/native-replay.js', import.meta.url).href;
  const script = `
    const { NativeHistoryIndex } = await import(${JSON.stringify(module)});
    const index = new NativeHistoryIndex('host', 'memory', ${JSON.stringify(home)}, undefined, ${JSON.stringify(join(home, 'cache'))});
    const snapshot = await index.refresh();
    let cursor = null, count = 0, pages = 0, maxBytes = 0;
    try {
      do {
        const page = await snapshot.page(Number(cursor ?? 0), 100);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(page)));
        count += page.events.length; pages += 1; cursor = page.nextCursor;
      } while (cursor !== null);
      console.log(JSON.stringify({ count, pages, maxBytes, memory: process.memoryUsage(), bytesRead: index.metrics.bytesRead }));
    } finally { snapshot.close(); await index.close(); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script], { timeout: 60_000 });
  const result = JSON.parse(stdout) as { count: number; pages: number; maxBytes: number; bytesRead: number; memory: { rss: number; heapUsed: number } };
  assert.equal(result.count, 320);
  assert.ok(result.pages > 4, 'byte budget must split pages before the event-count limit');
  assert.ok(result.maxBytes < 16 * 1024 * 1024);
  assert.ok(result.bytesRead > 80 * 1024 * 1024);
  t.diagnostic(`80 MiB replay: ${result.pages} pages, heap ${(result.memory.heapUsed / 1024 / 1024).toFixed(1)} MiB, RSS ${(result.memory.rss / 1024 / 1024).toFixed(1)} MiB`);
});
