import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import test from 'node:test';
import type { UserAgentStatus } from '@gian/shared';
import { AgentManager } from '../src/agents/manager.js';
import { registerAgentRoutes } from '../src/web/routes/agents.js';

async function executable(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o755);
}

async function makeApp(t: test.TestContext, environmentCliPaths?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'gian-agents-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxy = join(root, 'proxy.mjs');
  await writeFile(proxy, 'export {};\n');
  const agents = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { claude: proxy, codex: proxy, kimi: proxy, dsh: proxy },
    ...(environmentCliPaths ? { environmentCliPaths } : {}),
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes: { drain: async () => undefined, invalidate: () => true } as never,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'test',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
  });
  return { app, agents, root };
}

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
  const { app } = await makeApp(t);

  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'My Codex', proxy: 'codex' }),
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
    body: JSON.stringify({ name: 'my codex', proxy: 'kimi' }),
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
  assert.equal(grok.status, 400, 'Grok stays out of the product catalog');
});

test('PATCH /api/agents/:id renames; DELETE removes; 404 for unknown ids', async t => {
  const { app } = await makeApp(t);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'One', proxy: 'kimi' }),
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
  const { app } = await makeApp(t);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Solo', proxy: 'codex' }),
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

test('GET /api/proxies/:id/draft-defaults numbers names and copies the kind path', async t => {
  const claude = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-bin2-')), 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');
  const { app } = await makeApp(t, { claude });

  const second = await app.request('/api/proxies/claude/draft-defaults');
  assert.deepEqual(await second.json(), {
    name: 'Claude Code 2',
    cliPath: claude,
  });
  // dsh has nothing installed in the fixture home and an empty PATH —
  // the scan comes back empty and the draft starts pathless.
  const dsh = await app.request('/api/proxies/dsh/draft-defaults');
  assert.deepEqual(await dsh.json(), { name: 'DeepSeek Harness', cliPath: null });

  // A kind with no saved Agent and no copied path falls back to the local
  // scan (PATH / official install locations).
  const kimiBin = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-home-')), '.kimi-code', 'bin', 'kimi');
  await executable(kimiBin, 'kimi 0.31.1');
  const proxy2 = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-p2-')), 'proxy.mjs');
  await writeFile(proxy2, 'export {};\n');
  const homeDir = dirname(dirname(dirname(kimiBin))); // parent of .kimi-code
  const agents2 = await AgentManager.create({
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
    runtimes: { drain: async () => undefined, invalidate: () => true } as never,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'test',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
  });
  const kimi = await app2.request('/api/proxies/kimi/draft-defaults');
  assert.deepEqual(await kimi.json(), { name: 'Kimi Code', cliPath: kimiBin });

  const unknown = await app.request('/api/proxies/grok/draft-defaults');
  assert.equal(unknown.status, 404);
});
