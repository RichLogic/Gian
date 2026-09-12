import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createE2eEnvironment, seedProxyMockAgent } from './run-e2e.mjs';
import { proxyDefinitions, shippingProxyIds } from './build-proxy-artifacts.mjs';

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

test('the explicit Proxy mock profile uses one generic pluginId entry map', () => {
  const env = createE2eEnvironment({ PATH: '/bin' }, {
    dataDir: '/tmp/gian-e2e-mock',
    hostPort: 42234,
    webPort: 42235,
  }, { proxyMock: true });

  assert.equal(env.GIAN_E2E_PROXY_MOCK, '1');
  assert.equal(env.GIAN_E2E_PROXY_PROVIDER, 'codex');
  assert.equal(env.GIAN_E2E_PROXY_AGENT_ID, 'e2e-codex-agent');
  assert.equal(env.GIAN_E2E_PROXY_PLUGIN_ID, 'codex');
  assert.equal(env.GIAN_E2E_PROXY_PROCESS_SCOPE, 'shared');
  const entries = JSON.parse(env.GIAN_DEV_PROXY_ENTRIES);
  assert.deepEqual(Object.keys(entries), ['codex']);
  assert.match(entries.codex, /codex-proxy\/scripts\/fake-catalog-ui-proxy\.mjs$/);
  assert.equal(env.GIAN_DEV_PROXY_OVERRIDES_ONLY, '1');
  assert.equal(env.GIAN_CODEX_PROXY_ENTRY, undefined);
  assert.equal(env.CODEX_BIN, undefined);
});

test('the Proxy mock profile is derived for every shipping package', () => {
  for (const provider of shippingProxyIds) {
    const definition = proxyDefinitions.find(item => item.id === provider);
    const env = createE2eEnvironment({ PATH: '/bin' }, {
      dataDir: `/tmp/gian-e2e-${provider}`,
      hostPort: 43234,
      webPort: 43235,
    }, { proxyMock: true, proxyProvider: provider });
    assert.equal(env.GIAN_E2E_PROXY_PROVIDER, provider);
    assert.equal(env.GIAN_E2E_PROXY_AGENT_ID, `e2e-${provider}-agent`);
    assert.equal(env.GIAN_E2E_PROXY_PLUGIN_ID, definition.pluginId);
    assert.equal(env.GIAN_E2E_PROXY_PROCESS_SCOPE, definition.manifest.process.scope);
    assert.deepEqual(
      Object.keys(JSON.parse(env.GIAN_DEV_PROXY_ENTRIES)),
      [definition.pluginId],
    );
    assert.ok(JSON.parse(env.GIAN_E2E_PROXY_CAPABILITIES).length > 0);
  }
});

test('Proxy mock Agent seed uses open pluginId and no legacy kind', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-e2e-agent-seed-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await seedProxyMockAgent(dataDir, 'zcode');
  const config = JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8'));
  assert.equal(config.agents[0].pluginId, 'com.zhipu.zcode');
  assert.equal(config.agents[0].proxy, null);
  assert.equal(config.agents[0].cliPath, '/usr/bin/git');
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

test('the Proxy UI fixture recognizes the frozen no-Runtime bootstrap marker', async () => {
  const fixture = await readFile(
    new URL('./fixtures/fake-catalog-ui-proxy.mjs', import.meta.url),
    'utf8',
  );
  assert.match(fixture, /GIAN_RUNTIME_BOOTSTRAP === '1'/);
  assert.doesNotMatch(fixture, /runtime-bootstrap-v1/);
});
