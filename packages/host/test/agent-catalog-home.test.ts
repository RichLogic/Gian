import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { ProxyCatalog } from '@gian/shared';
import { SessionManager } from '../src/session/manager.js';
import { registerProxyRoutes } from '../src/web/routes/proxy.js';
import { registerAgentRoutes, integrationErrorResponse } from '../src/web/routes/agents.js';

function catalog(model: string): ProxyCatalog {
  return {
    catalogRevision: model, input: [{ type: 'text' }], slashCommands: [],
    configOptions: [{
      id: 'model', displayName: 'Model', role: 'model', binding: 'turn', control: 'select',
      required: true, defaultValue: model, choices: [{ value: model, displayName: model }],
    }],
  };
}

test('Agent catalog and resolution preserve identity when two HOMEs share one CLI', async () => {
  const seen: string[] = [];
  const released: string[] = [];
  const context = {
    proxy: {
      acquireInspectionHost: async (pluginId: string, options: { agentId: string }) => {
        assert.equal(pluginId, 'claude');
        const id = options.agentId;
        seen.push(id);
        return {
          host: {
            initialize: async () => ({ capabilities: { 'catalog.resolve': 1 } }),
            catalog: async () => catalog(id === 'mix' ? 'router-glm' : 'sonnet'),
            request: async (_method: string, params: { catalogRevision: string }) => {
              assert.equal(params.catalogRevision, id === 'mix' ? 'router-glm' : 'sonnet');
              return catalog(params.catalogRevision);
            },
          },
          release: async () => { released.push(id); },
        };
      },
    },
  } as unknown as SessionManager;
  const sessions = {
    agentCapabilities: SessionManager.prototype.agentCapabilities.bind(context),
    resolveAgentCatalog: SessionManager.prototype.resolveAgentCatalog.bind(context),
    warmCapabilities: async () => { throw new Error('must not use kind-only model cache'); },
  } as unknown as SessionManager;
  const app = new Hono();
  registerProxyRoutes(app, {} as never, sessions, id => {
    if (!['mix', 'default'].includes(id)) throw new Error('unknown Agent');
    return { pluginId: 'claude', cliPath: '/same/managed/claude' };
  });
  for (const [agent, model] of [['mix', 'router-glm'], ['default', 'sonnet'], ['mix', 'router-glm']]) {
    const response = await app.request(`/api/proxy/claude/capabilities?agent=${agent}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).configOptions[0].choices[0].value, model);
    const resolved = await app.request(`/api/proxy/claude/catalog/resolve?agent=${agent}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalogRevision: model, turnConfig: { model } }),
    });
    assert.equal(resolved.status, 200);
  }
  assert.deepEqual(seen, released);
  assert.equal((await app.request('/api/proxy/claude/capabilities?agent=missing')).status, 404);
});

test('inspection failure releases the Agent borrow instead of using another HOME', async () => {
  let released = false;
  const context = {
    proxy: { acquireInspectionHost: async () => ({
      host: { initialize: async () => { throw new Error('profile unavailable'); } },
      release: async () => { released = true; },
    }) },
  } as unknown as SessionManager;
  await assert.rejects(SessionManager.prototype.agentCapabilities.call(context, 'claude', 'mix'), /profile unavailable/);
  assert.equal(released, true);
});

test('saving Agent defaults validates against that Agent catalog and resolve context', async () => {
  const current = { id: 'mix', pluginId: 'claude', proxy: 'claude', defaults: { model: '', thinking: '', mode: '' } };
  const contexts: Array<string | undefined> = [];
  const app = new Hono();
  registerAgentRoutes(app, {
    agents: {
      getAgent: () => current,
      updateAgent: async (_id: string, patch: object) => ({ ...current, ...patch }),
      agentStatus: async () => current,
    } as never,
    closeProxy: async () => undefined,
    capabilities: async (_kind, agentId) => { contexts.push(agentId); return catalog('router-glm'); },
    resolveDefaultsCatalog: async (_kind, value, _config, agentId) => { contexts.push(agentId); return value; },
  });
  const response = await app.request('/api/agents/mix', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { model: 'router-glm' } }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(contexts, ['mix', 'mix']);
});

test('Integration failures log stage, identity and error code with credentials redacted', t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...parts: unknown[]) => lines.push(parts.join(' ')));
  const error = new Error('ANTHROPIC_AUTH_TOKEN=do-not-log https://user:pass@example.test?api_key=hidden');
  const result = integrationErrorResponse(error, { pluginId: 'claude', operation: 'runtime.install', stage: 'runtime-verify' });
  assert.equal(result.error, error.message);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /runtime-verify/);
  assert.match(lines[0]!, /claude/);
  assert.doesNotMatch(lines[0]!, /do-not-log|user:pass|hidden/);
});
