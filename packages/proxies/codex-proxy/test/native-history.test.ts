import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReplayPageValidator } from '@gian/proxy-protocol';
import {
  CodexNativeHistoryWatcher,
  listCodexNativeSessions,
  replayCodexNativeSession,
} from '../src/protocol/native-history.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    appended.events.slice(0, replay.events.length).map(event => event.params.eventId),
    replay.events.map(event => event.params.eventId),
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
