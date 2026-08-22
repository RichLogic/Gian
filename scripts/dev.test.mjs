import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GITHUB_CLIENT_ID,
  DEV_HOST_URL,
  DEV_WEB_URL,
  parseDevArguments,
  resolveDevEnvironment,
  resolveRuntimeIdentity,
  resolveRuntimePaths,
} from './dev.mjs';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseVersion = JSON.parse(
  await readFile(join(rootDir, 'package.json'), 'utf8'),
).version;

test('dev environment pins isolated GianDev services and desktop targets', () => {
  const identity = {
    runtimeId: 'gian-0.3.0-abcd1234',
    worktree: '/tmp/gian-0.3.0',
    branch: 'gian-0.3.0',
    revision: 'abc123',
    label: 'GianDev · gian-0.3.0',
  };
  const env = resolveDevEnvironment({
    PATH: '/usr/bin',
    GIAN_PORT: '8990',
    GIAN_DATA_DIR: '/tmp/production-must-not-leak',
    GIAN_DEV_DATA_DIR: '/tmp/gian-dev-test',
    GIAN_DESKTOP_USER_DATA_DIR: ' /tmp/gian-dev-electron-test ',
    // Inherited from a shell spawned by the production Gian desktop — every
    // one of these must be stripped, not overridden-but-present.
    GIAN_DESKTOP_TOKEN: 'production-token',
    GIAN_DESKTOP_INSTANCE_ID: 'production-instance',
    GIAN_PARENT_MANAGED: '1',
    GIAN_WEB_DIST: '/Applications/Gian.app/Contents/Resources/web',
    GIAN_DEV_RUNTIME_ID: 'inherited-runtime',
  }, identity);

  assert.equal(env.GIAN_HOST, '127.0.0.1');
  assert.equal(env.GIAN_PORT, '8991');
  assert.equal(env.GIAN_WEB_PORT, '5191');
  assert.equal(env.GIAN_DATA_DIR, '/tmp/gian-dev-test');
  assert.equal(env.GIAN_DESKTOP_HOST_URL, DEV_HOST_URL);
  assert.equal(env.GIAN_DESKTOP_WEB_URL, DEV_WEB_URL);
  assert.equal(env.GIAN_DESKTOP_DISABLE_HOST_MANAGEMENT, '1');
  assert.equal(env.GIAN_GITHUB_CLIENT_ID, DEFAULT_GITHUB_CLIENT_ID);
  assert.match(
    env.GIAN_DESKTOP_GITHUB_BROKER_SOCKET,
    /gian-github-[a-f0-9]{24}\.sock$/,
  );
  assert.equal(env.GIAN_RELEASE_VERSION, releaseVersion);
  assert.equal(env.GIAN_DEV_RUNTIME_ID, identity.runtimeId);
  assert.equal(env.GIAN_DEV_WORKTREE, identity.worktree);
  assert.equal(env.GIAN_DESKTOP_LABEL, identity.label);
  assert.equal(env.GIAN_DESKTOP_TOKEN, undefined);
  assert.equal(env.GIAN_DESKTOP_INSTANCE_ID, undefined);
  assert.equal(env.GIAN_PARENT_MANAGED, undefined);
  assert.equal(env.GIAN_WEB_DIST, undefined);
  assert.equal(env.GIAN_DEV_DATA_DIR, '/tmp/gian-dev-test');
  assert.equal(env.GIAN_DESKTOP_USER_DATA_DIR, '/tmp/gian-dev-electron-test');
  assert.equal(env.GIAN_CC_PROXY_ENTRY, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('dev environment forwards explicit Proxy entry overrides', () => {
  const env = resolveDevEnvironment({
    PATH: '/usr/bin',
    GIAN_CC_PROXY_ENTRY: ' /tmp/fake-cc.mjs ',
    GIAN_KIMI_PROXY_ENTRY: '/tmp/fake-kimi.mjs',
    GIAN_DESKTOP_TOKEN: 'production-token',
  });
  assert.equal(env.GIAN_CC_PROXY_ENTRY, '/tmp/fake-cc.mjs');
  assert.equal(env.GIAN_KIMI_PROXY_ENTRY, '/tmp/fake-kimi.mjs');
  assert.equal(env.GIAN_CODEX_PROXY_ENTRY, undefined);
  assert.equal(env.GIAN_DESKTOP_TOKEN, undefined);
});

test('dev environment preserves an explicit GitHub OAuth client id override', () => {
  const env = resolveDevEnvironment({
    GIAN_GITHUB_CLIENT_ID: ' Ov23liForkClient ',
  });
  assert.equal(env.GIAN_GITHUB_CLIENT_ID, 'Ov23liForkClient');
});

test('dev command exposes one default preview and explicit lifecycle commands', () => {
  assert.deepEqual(parseDevArguments([]), { command: 'start', target: null });
  assert.deepEqual(parseDevArguments(['--no-desktop']), { command: 'up', target: null });
  assert.deepEqual(parseDevArguments(['status']), { command: 'status', target: null });
  assert.deepEqual(parseDevArguments(['restart', '--', 'desktop']), {
    command: 'restart',
    target: 'desktop',
  });
  assert.throws(() => parseDevArguments(['browser']), /unknown dev command/);
  assert.throws(() => parseDevArguments(['restart', 'host']), /unknown restart target/);
});

test('runtime identity and state paths bind ownership to the current worktree', () => {
  const first = resolveRuntimeIdentity(rootDir);
  const second = resolveRuntimeIdentity(rootDir);
  assert.equal(first.runtimeId, second.runtimeId);
  assert.equal(first.worktree, rootDir);
  assert.match(first.runtimeId, /-[a-f0-9]{8}$/);
  assert.deepEqual(resolveRuntimePaths('/tmp/gian-worktree'), {
    runtimeDir: '/tmp/gian-worktree/.gian-runtime',
    logsDir: '/tmp/gian-worktree/.gian-runtime/logs',
    servicesState: '/tmp/gian-worktree/.gian-runtime/services.json',
    desktopState: '/tmp/gian-worktree/.gian-runtime/desktop.json',
    supervisorLog: '/tmp/gian-worktree/.gian-runtime/logs/supervisor.log',
    desktopLog: '/tmp/gian-worktree/.gian-runtime/logs/desktop.log',
  });
});

test('desktop clean invalidates incremental state before rebuilding', async () => {
  const source = await readFile(join(rootDir, 'packages/desktop/package.json'), 'utf8');
  const pkg = JSON.parse(source);
  assert.match(pkg.scripts.clean, /\*\.tsbuildinfo/);
});
