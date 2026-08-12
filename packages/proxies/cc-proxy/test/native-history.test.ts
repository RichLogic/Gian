import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReplayPageValidator } from '@gian/proxy-protocol';
import {
  ClaudeNativeHistoryWatcher,
  listClaudeNativeSessions,
  renameClaudeNativeSession,
  replayClaudeNativeSession,
} from '../src/protocol/native-history.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('timed out waiting for native history watcher');
}

test('Claude plugin owns native discovery and normalized replay', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-claude-native-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = '/workspace/project';
  const directory = join(home, '.claude', 'projects', '-workspace-project');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'native-claude.jsonl');
  await writeFile(path, [
    { type: 'user', uuid: 'user-1', timestamp: '2026-08-10T01:00:00.000Z', message: { content: 'Fix it' } },
    { type: 'assistant', uuid: 'assistant-1', timestamp: '2026-08-10T01:00:01.000Z', message: { content: [
      { type: 'text', id: 'text-1', text: 'Working' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'true' } },
    ] } },
    { type: 'user', uuid: 'tool-result-1', timestamp: '2026-08-10T01:00:02.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
    ] } },
    { type: 'user', uuid: 'user-2', timestamp: '2026-08-10T01:01:00.000Z', message: { content: 'Verify it' } },
    { type: 'assistant', uuid: 'assistant-2', timestamp: '2026-08-10T01:01:01.000Z', message: { content: [
      { type: 'thinking', id: 'reasoning-1', thinking: 'Checking' },
      { type: 'text', id: 'text-2', text: 'Done' },
    ] } },
  ].map(value => JSON.stringify(value)).join('\n'));

  const listed = listClaudeNativeSessions(cwd, home);
  assert.equal(listed[0]?.id, 'native-claude');
  assert.equal(listed[0]?.displayName, 'Fix it');

  const replay = replayClaudeNativeSession('host-session', 'native-claude', cwd, home);
  assert.deepEqual(replay.events.map(event => event.method), [
    'turn.started',
    'input.recorded',
    'content.completed',
    'tool.started',
    'tool.completed',
    'turn.completed',
    'turn.started',
    'input.recorded',
    'content.completed',
    'content.completed',
    'turn.completed',
  ]);
  const validator = new ReplayPageValidator('host-session');
  assert.doesNotThrow(() => validator.acceptPage({
    replayStreamId: replay.streamId,
    events: replay.events,
    nextCursor: null,
  }));

  assert.equal(renameClaudeNativeSession(
    'native-claude',
    cwd,
    '  Renamed\nClaude\tSession  ',
    home,
  ), true);
  const title = JSON.parse((await readFile(path, 'utf8')).trim().split('\n').at(-1)!);
  assert.deepEqual(title, {
    type: 'custom-title',
    customTitle: 'Renamed Claude Session',
    sessionId: 'native-claude',
  });
  assert.equal(renameClaudeNativeSession('missing', cwd, 'Ignored', home), false);

  let changes = 0;
  const watcher = new ClaudeNativeHistoryWatcher(
    'native-claude',
    cwd,
    () => { changes += 1; },
    10,
    home,
  );
  watcher.start();
  t.after(() => watcher.stop());
  await appendFile(path, `\n${JSON.stringify({
    type: 'user', uuid: 'user-3', timestamp: '2026-08-10T01:02:00.000Z',
    message: { content: 'External turn' },
  })}`);
  await waitFor(() => changes === 1);
  const appended = replayClaudeNativeSession('host-session', 'native-claude', cwd, home);
  assert.equal(appended.streamId, replay.streamId);
  assert.deepEqual(
    appended.events.slice(0, replay.events.length).map(event => event.params.eventId),
    replay.events.map(event => event.params.eventId),
  );

  watcher.pause();
  await appendFile(path, `\n${JSON.stringify({
    type: 'assistant', uuid: 'assistant-3', timestamp: '2026-08-10T01:02:01.000Z',
    message: { content: [{ type: 'text', id: 'text-3', text: 'Own turn' }] },
  })}`);
  await delay(40);
  assert.equal(changes, 1);
  watcher.resume();
});
