import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import test from 'node:test';
import type { UserAgentStatus } from '@gian/shared';
import { AgentManager } from '../src/agents/manager.js';
import { registerAgentRoutes } from '../src/web/routes/agents.js';
import { developmentEntries, testResolver } from './runtime-test-harness.js';

async function executable(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o755);
}

async function makeApp(
  t: test.TestContext,
  environmentCliPaths?: Record<string, string>,
  pickHome?: () => Promise<
    | { kind: 'ok'; path: string }
    | { kind: 'canceled' }
    | { kind: 'error'; error: string }
  >,
) {
  const root = await mkdtemp(join(tmpdir(), 'gian-agents-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bins = {
    claude: join(root, 'bin', 'claude'),
    codex: join(root, 'bin', 'codex'),
    kimi: join(root, 'bin', 'kimi'),
    dsh: join(root, 'bin', 'dsh'),
  };
  await executable(bins.claude, 'claude 2.1.159');
  await executable(bins.codex, 'codex 0.146.0');
  await executable(bins.kimi, 'kimi 0.38.0');
  await executable(bins.dsh, 'dsh 0.1.1-rc.2');
  const agents = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: await developmentEntries(root),
    runtimeResolver: testResolver(root),
    ...(environmentCliPaths ? { environmentCliPaths } : {}),
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'test',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
    ...(pickHome ? { pickHome } : {}),
  });
  return { app, agents, root, bins };
}

test('POST /api/agents/pick-home supports a draft before an Agent id exists', async t => {
  const { app } = await makeApp(t, undefined, async () => ({
    kind: 'ok',
    path: '/Users/test/custom-home',
  }));
  const response = await app.request('/api/agents/pick-home', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: '/Users/test/custom-home' });
});

test('GET /api/proxies returns static catalog metadata only', async t => {
  const { app } = await makeApp(t);
  const response = await app.request('/api/proxies');
  assert.equal(response.status, 200);
  const body = await response.json() as {
    proxies: Array<{ id: string; name: string; logo: { light: string; dark: string } }>;
  };
  assert.deepEqual(body.proxies.map(entry => [entry.id, entry.name, entry.logo]), [
    ['claude', 'Claude Code', { light: '/api/proxies/claude/logo/light', dark: '/api/proxies/claude/logo/dark' }],
    ['codex', 'Codex', { light: '/api/proxies/codex/logo/light', dark: '/api/proxies/codex/logo/dark' }],
    ['kimi', 'Kimi Code', { light: '/api/proxies/kimi/logo/light', dark: '/api/proxies/kimi/logo/dark' }],
    ['dsh', 'DeepSeek Harness', { light: '/api/proxies/dsh/logo/light', dark: '/api/proxies/dsh/logo/dark' }],
    ['zcode', 'ZCode', { light: '/api/proxies/zcode/logo/light', dark: '/api/proxies/zcode/logo/dark' }],
  ]);
});

test('GET /api/proxies/:id/logo/:variant serves validated Proxy-owned bytes', async t => {
  const { app, agents } = await makeApp(t);
  agents.proxyLogo = async (id, variant) => id === 'kimi' && variant === 'light'
    ? { bytes: Buffer.from('official-kimi-logo'), mediaType: 'image/png', sha256: 'a'.repeat(64) }
    : null;

  const response = await app.request('/api/proxies/kimi/logo/light');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('etag'), `"${'a'.repeat(64)}"`);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('utf8'), 'official-kimi-logo');
  assert.equal((await app.request('/api/proxies/kimi/logo/dark')).status, 404);
  assert.equal((await app.request('/api/proxies/grok/logo/light')).status, 404);
});

test('GET /api/agents returns saved Agents only, never unsaved catalog kinds', async t => {
  const claude = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-bin-')), 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');
  const { app } = await makeApp(t, { claude });

  const initial = await app.request('/api/agents');
  const initialBody = await initial.json() as { agents: UserAgentStatus[] };
  // The environment CLI migrated exactly one Agent; codex/kimi/dsh catalog
  // kinds are NOT listed even though their development proxies exist.
  assert.deepEqual(initialBody.agents.map(agent => [agent.name, agent.proxy]), [
    ['Claude Code', 'claude'],
  ]);
  assert.equal(initialBody.agents[0]!.ready, true);
});

test('POST /api/agents creates a draft into a saved Agent; duplicate names 409', async t => {
  const { app, bins } = await makeApp(t);

  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'My Codex', proxy: 'codex', cliPath: bins.codex }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { agent: UserAgentStatus };
  assert.equal(createdBody.agent.name, 'My Codex');
  assert.equal('color' in createdBody.agent, false);
  assert.equal(createdBody.agent.proxy, 'codex');
  // (No readiness assertion: a path-less Agent auto-resolves official install
  // locations, which differ per machine.)

  const duplicate = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'my codex', proxy: 'kimi', cliPath: bins.kimi }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(
    (await duplicate.json() as { code?: string }).code,
    'AGENT_NAME_TAKEN',
  );

  const empty = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '   ', proxy: 'kimi' }),
  });
  assert.equal(empty.status, 400);

  const grok = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Grok', proxy: 'grok' }),
  });
  assert.equal(grok.status, 400, 'Grok stays out of the legacy product fallback');

});

test('POST /api/agents reuses an explicit GianDev runtime path without exposing a path field', async t => {
  const claude = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-bin-')), 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');
  const { app } = await makeApp(t, { claude });
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Claude second', pluginId: 'claude', home: { kind: 'managed' } }),
  });
  assert.equal(created.status, 201);
  const body = await created.json() as { agent: UserAgentStatus };
  assert.equal(body.agent.cliPath, claude);
  assert.equal(body.agent.home?.kind, 'managed');
});

test('PATCH /api/agents/:id renames; DELETE removes; 404 for unknown ids', async t => {
  const { app, bins } = await makeApp(t);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'One', proxy: 'kimi', cliPath: bins.kimi }),
  });
  const { agent } = await created.json() as { agent: UserAgentStatus };

  const renamed = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Two' }),
  });
  assert.equal(renamed.status, 200);
  const renamedBody = await renamed.json() as { agent: UserAgentStatus };
  assert.equal(renamedBody.agent.name, 'Two');
  assert.equal('color' in renamedBody.agent, false);

  const missing = await app.request('/api/agents/nope', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Three' }),
  });
  assert.equal(missing.status, 404);
  // Kind literals are not Agent ids.
  const kindLiteral = await app.request('/api/agents/kimi', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Three' }),
  });
  assert.equal(kindLiteral.status, 404);

  const deleted = await app.request(`/api/agents/${agent.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const after = await app.request('/api/agents');
  assert.deepEqual((await after.json() as { agents: unknown[] }).agents, []);
});

test('GET /api/agents/:id serves kind status for drafts and Agent status for saved Agents', async t => {
  const { app, bins } = await makeApp(t);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Solo', proxy: 'codex', cliPath: bins.codex }),
  });
  const { agent } = await created.json() as { agent: UserAgentStatus };

  const kindStatus = await app.request('/api/agents/codex');
  assert.equal(kindStatus.status, 200);
  const kindBody = await kindStatus.json() as { id: string; name: string };
  assert.equal(kindBody.id, 'codex');
  assert.equal(kindBody.name, 'Codex');

  const agentStatus = await app.request(`/api/agents/${agent.id}`);
  assert.equal(agentStatus.status, 200);
  const agentBody = await agentStatus.json() as UserAgentStatus;
  assert.equal(agentBody.id, agent.id);
  assert.equal(agentBody.proxyName, 'Codex');

  const unknown = await app.request('/api/agents/not-an-agent');
  assert.equal(unknown.status, 404);
});

test('GET /api/proxies/:id/draft-defaults numbers names and exposes HOME plus read-only active path', async t => {
  const claude = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-bin2-')), 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');
  const { app } = await makeApp(t, { claude });

  const second = await app.request('/api/proxies/claude/draft-defaults');
  assert.deepEqual(await second.json(), {
    name: 'Claude Code 2',
    home: { kind: 'managed', path: null },
    cliPath: claude,
  });
  const dsh = await app.request('/api/proxies/dsh/draft-defaults');
  assert.deepEqual(await dsh.json(), {
    name: 'DeepSeek Harness',
    home: { kind: 'managed', path: null },
    cliPath: null,
  });

  // Official-user / PATH locations are not Host-scanned. A draft without a
  // saved Agent or readiness snapshot stays pathless until Runtime discover.
  const kimiBin = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-home-')), '.kimi-code', 'bin', 'kimi');
  await executable(kimiBin, 'kimi 0.31.1');
  const proxy2 = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-p2-')), 'proxy.mjs');
  await writeFile(proxy2, 'export {};\n');
  const homeDir = dirname(dirname(dirname(kimiBin)));
  const agents2 = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir: join(await mkdtemp(join(tmpdir(), 'gian-agents-route-data-')), 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { kimi: proxy2 },
    homeDir,
    pathEnv: '',
  });
  const app2 = new Hono();
  registerAgentRoutes(app2, {
    agents: agents2,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'test',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
  });
  const kimi = await app2.request('/api/proxies/kimi/draft-defaults');
  assert.deepEqual(await kimi.json(), {
    name: 'Kimi Code',
    home: { kind: 'managed', path: null },
    cliPath: null,
  });

  const unknown = await app.request('/api/proxies/grok/draft-defaults');
  assert.equal(unknown.status, 404);
});

test('POST /api/agents rejects an uninstalled reverse-domain pluginId', async t => {
  const { app, root } = await makeApp(t);
  const response = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Fixture', pluginId: 'io.gian.fixture' }),
  });
  assert.equal(response.status, 404);
  const body = await response.json() as { code?: string };
  assert.equal(body.code, 'PLUGIN_NOT_FOUND');
  const persisted = JSON.parse(await readFile(join(root, 'data', 'agents.json'), 'utf8')) as {
    agents: unknown[];
  };
  assert.equal(persisted.agents.length, 0);
});
