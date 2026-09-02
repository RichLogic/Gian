import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { retireLegacyHostLaunchAgent } from '../src/legacy-host-retirement.js';

test('packaged macOS startup boots out and persistently retires the legacy Host plist', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'gian-legacy-host-'));
  const launchAgents = join(homeDir, 'Library', 'LaunchAgents');
  await mkdir(launchAgents, { recursive: true });
  const source = join(launchAgents, 'com.gian.host.plist');
  await writeFile(source, '<plist>legacy</plist>');
  const calls: Array<{ label: string; path: string }> = [];

  const result = await retireLegacyHostLaunchAgent({
    platform: 'darwin',
    homeDir,
    uid: 501,
    bootout: async (label, path) => { calls.push({ label, path }); },
  });

  assert.equal(result.retired, true);
  assert.deepEqual(calls, [{ label: 'gui/501', path: source }]);
  await assert.rejects(readFile(source), /ENOENT/);
  assert.equal(await readFile(result.retiredPath, 'utf8'), '<plist>legacy</plist>');
});

test('non-macOS startup leaves a legacy-looking path untouched', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'gian-legacy-host-linux-'));
  const launchAgents = join(homeDir, 'Library', 'LaunchAgents');
  await mkdir(launchAgents, { recursive: true });
  const source = join(launchAgents, 'com.gian.host.plist');
  await writeFile(source, 'keep');

  const result = await retireLegacyHostLaunchAgent({
    platform: 'linux',
    homeDir,
    uid: 501,
    bootout: async () => { throw new Error('must not run'); },
  });

  assert.equal(result.retired, false);
  assert.equal(await readFile(source, 'utf8'), 'keep');
});
