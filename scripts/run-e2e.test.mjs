import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createE2eEnvironment } from './run-e2e.mjs';

test('createE2eEnvironment replaces inherited Gian runtime configuration', () => {
  const env = createE2eEnvironment({
    FORCE_COLOR: '1',
    NO_COLOR: '0',
    PATH: '/bin',
    GIAN_DATA_DIR: '/Users/example/.gian',
    GIAN_DESKTOP_TOKEN: 'production-token',
    GIAN_PARENT_MANAGED: '1',
    GIAN_PORT: '8990',
  }, {
    dataDir: '/tmp/gian-e2e-test',
    hostPort: 41234,
    webPort: 41235,
  });

  assert.equal(env.PATH, '/bin');
  assert.equal(env.GIAN_DATA_DIR, '/tmp/gian-e2e-test');
  assert.equal(env.GIAN_E2E_DATA_DIR, '/tmp/gian-e2e-test');
  assert.equal(env.GIAN_E2E_EXTERNAL_SERVERS, '1');
  assert.equal(env.GIAN_E2E_ISOLATED, '1');
  assert.equal(env.GIAN_HOST_PORT, '41234');
  assert.equal(env.GIAN_PORT, '41234');
  assert.equal(env.GIAN_WEB_PORT, '41235');
  assert.equal(env.GIAN_DESKTOP_TOKEN, undefined);
  assert.equal(env.GIAN_PARENT_MANAGED, undefined);
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.NO_COLOR, undefined);
});

test('Playwright owns the real Host and Web processes rather than pnpm wrappers', async () => {
  const config = await readFile(new URL('../playwright.config.ts', import.meta.url), 'utf8');

  assert.match(config, /globalTimeout: CI \? 40 \* 60_000 : 15 \* 60_000/);
  assert.match(config, /workers: CI \? 4 : 1/);
  assert.match(config, /command: 'node dist\/index\.js'/);
  assert.match(config, /command: 'node node_modules\/vite\/bin\/vite\.js preview'/);
  assert.match(config, /reuseExistingServer: EXTERNAL_SERVERS \|\| \(!CI && !ISOLATED\)/);
  assert.doesNotMatch(config, /command: `[^`]*pnpm -F @gian\/(host|web)/);
});

test('the explicit Proxy mock profile uses the fixture entry and Git as the fake runtime', () => {
  const env = createE2eEnvironment({ PATH: '/bin' }, {
    dataDir: '/tmp/gian-e2e-mock',
    hostPort: 42234,
    webPort: 42235,
  }, { proxyMock: true });

  assert.equal(env.GIAN_E2E_PROXY_MOCK, '1');
  assert.match(env.GIAN_CODEX_PROXY_ENTRY, /codex-proxy\/scripts\/fake-catalog-ui-proxy\.mjs$/);
  assert.equal(env.CODEX_BIN, '/usr/bin/git');
});

test('the E2E runner always drains detached process groups', async () => {
  const runner = await readFile(new URL('./run-e2e.mjs', import.meta.url), 'utf8');

  assert.match(runner, /process\.kill\(-child\.pid, signal\)/);
  assert.match(runner, /stopProcess\(playwright\)/);
  assert.match(runner, /stopProcess\(web\)/);
  assert.match(runner, /stopProcess\(host\)/);
  assert.match(runner, /rmSync\(dataDir, \{ recursive: true, force: true \}\)/);
  assert.match(runner, /process\.once\('exit', onExit\)/);
  assert.match(runner, /startJanitor\(dataDir\)/);
});
