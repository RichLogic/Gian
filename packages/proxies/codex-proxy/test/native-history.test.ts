import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReplayPageValidator } from '@gian/proxy-protocol';
import {
  CodexNativeHistoryWatcher,
  listCodexNativeSessions,
  NativeTurnIdentityStore,
  replayCodexNativeSession,
} from '../src/protocol/native-history.js';

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
  const replay = replayCodexNativeSession('host-fork', 'grandchild', home);
  assert.equal(replay.events.find(event => event.method === 'turn.completed')?.sourceTurnId, 'inherited-turn');
  assert.match(JSON.stringify(replay), /inherited answer/);
  assert.doesNotMatch(JSON.stringify(replay), /DO_NOT_LEAK|future-turn/);
  const archive = join(home, '.codex', 'archived_sessions');
  await mkdir(archive);
  await rename(join(dir, 'rollout-parent.jsonl'), join(archive, 'rollout-parent.jsonl'));
  assert.equal(replayCodexNativeSession('host-fork', 'grandchild', home).events
    .find(event => event.method === 'turn.completed')?.sourceTurnId, 'inherited-turn');
  assert.ok(!listCodexNativeSessions('/test', home).some(session => session.id === 'parent'));
  await writeFile(join(dir, 'rollout-child.jsonl'), meta('child', { thread_id: 'child', end_byte_offset: Buffer.byteLength(child) }));
  assert.throws(() => replayCodexNativeSession('host-cycle', 'child', home), /Cyclic|prefix/);
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
  const replay = replayCodexNativeSession('host-modern', 'native-modern');
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

  const replay = replayCodexNativeSession('host-session', 'native-codex', home);
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
  const appended = replayCodexNativeSession('host-session', 'native-codex', home);
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
  const replay = replayCodexNativeSession('host-session', 'native-identity', home, store);
  assert.ok(replay.events.every(event => event.sourceTurnId === 'provider-turn-stable'));

  const persisted = await readFile(join(dataDir, 'codex-native-turn-identities.json'), 'utf8');
  assert.doesNotMatch(persisted, /Sensitive fixture prompt/);
  const restarted = replayCodexNativeSession(
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
