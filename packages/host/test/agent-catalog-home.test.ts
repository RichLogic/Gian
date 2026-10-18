import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { ProxyProtocolError } from '@gian/proxy-protocol';
import type { AgentProxyDefaults, ProxyCatalog } from '@gian/shared';
import { capabilityReasonFromRpcData, GENERIC_CAPABILITY_FAILURE } from '../src/logging/redact.js';
import { SessionManager } from '../src/session/manager.js';
import { registerProxyRoutes } from '../src/web/routes/proxy.js';
import { registerAgentRoutes, integrationErrorResponse } from '../src/web/routes/agents.js';
import { normalizeProtocolCatalog } from '../src/proxy/protocol-v2-session-client.js';
import { projectedCatalog } from '../../proxies/antigravity-proxy/test/fixtures/config-options.js';

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

test('Agent defaults save native Antigravity modes unchanged and reject unsupported pairs without writing', async () => {
  let defaults: AgentProxyDefaults = {
    model: 'gemini-3.8-flash', thinking: 'high', mode: 'default', options: {},
  };
  let writes = 0;
  const current = () => ({ id: 'agy', pluginId: 'io.gian.antigravity', proxy: null, defaults });
  const app = new Hono();
  registerAgentRoutes(app, {
    agents: {
      getAgent: current,
      updateAgent: async (_id: string, patch: { defaults?: Partial<AgentProxyDefaults> }) => {
        writes += 1;
        defaults = { ...defaults, ...patch.defaults };
        return current();
      },
      agentStatus: async () => current(),
    } as never,
    closeProxy: async () => undefined,
    capabilities: async () => normalizeProtocolCatalog(projectedCatalog()),
    resolveDefaultsCatalog: async (_plugin, _catalog, config) => normalizeProtocolCatalog(projectedCatalog(config.turnConfig)),
  });
  const patch = (value: Partial<AgentProxyDefaults>) => app.request('/api/agents/agy', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaults: value }),
  });
  for (const mode of ['auto_edit', 'yolo', 'default']) {
    const response = await patch({ mode });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).agent.defaults.mode, mode);
    assert.deepEqual(defaults, { model: 'gemini-3.8-flash', thinking: 'high', mode, options: {} });
  }
  const before = structuredClone(defaults);
  assert.notEqual((await patch({ thinking: 'max' })).status, 200);
  assert.notEqual((await patch({ mode: 'ask' })).status, 200);
  assert.equal(writes, 3);
  assert.deepEqual(defaults, before);
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

test('capability reason is one allowlisted token and drops provider text', () => {
  const secret = 'https://user:super-secret@provider.example/oauth?code=super-secret-token';
  assert.equal(capabilityReasonFromRpcData({
    domainCode: 'RUNTIME_ERROR',
    details: { reason: 'timeout', url: secret, token: 'sk-ant-secretvalue' },
  }), 'timeout');
  assert.equal(capabilityReasonFromRpcData({ details: { reason: 'constructor' } }), undefined);
  assert.equal(capabilityReasonFromRpcData({ details: { reason: '__proto__' } }), undefined);
  const inherited = Object.create({ reason: 'timeout' }) as { details?: unknown };
  inherited.details = Object.create({ reason: 'timeout' });
  assert.equal(capabilityReasonFromRpcData(inherited), undefined);
  assert.equal(capabilityReasonFromRpcData({ details: { url: secret } }), undefined);
});

test('capability failures return a generic message plus an allowlisted reason', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...parts: unknown[]) => {
    lines.push(parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' '));
  });
  const secret = 'https://user:super-secret@provider.example/oauth?code=super-secret-token HOME=/Users/secret TOKEN=sk-ant-secretvalue';
  const timeout = new ProxyProtocolError('RUNTIME_ERROR', `[RUNTIME_ERROR] ${secret}`, false);
  timeout.reason = 'timeout';
  const missing = new ProxyProtocolError('RUNTIME_UNAVAILABLE', secret, false);
  missing.reason = 'helper_missing';
  const constructorReason = new ProxyProtocolError('RUNTIME_ERROR', secret, false);
  constructorReason.reason = 'constructor';
  const protoReason = new ProxyProtocolError('RUNTIME_ERROR', secret, false);
  protoReason.reason = '__proto__';
  const cases: Array<{ error: unknown; reason?: string; code: string }> = [
    { error: timeout, reason: 'timeout', code: 'RUNTIME_ERROR' },
    { error: missing, reason: 'helper_missing', code: 'RUNTIME_UNAVAILABLE' },
    { error: constructorReason, code: 'RUNTIME_ERROR' },
    { error: protoReason, code: 'RUNTIME_ERROR' },
    {
      error: Object.assign(new Error(`fetch failed ${secret}\n    at Client.request (${secret})`), {
        code: 'https://provider.example/token',
        reason: 'timeout',
        details: { reason: 'timeout', url: secret },
      }),
      code: 'RUNTIME_ERROR',
    },
  ];
  let index = 0;
  const sessions = {
    agentCapabilities: async () => {
      throw cases[index]!.error;
    },
  } as unknown as SessionManager;
  const app = new Hono();
  registerProxyRoutes(app, {} as never, sessions, () => ({
    pluginId: 'claude',
    cliPath: '/bin/claude',
  }));
  for (const expected of cases) {
    lines.length = 0;
    const response = await app.request('/api/proxy/claude/capabilities?agent=mix');
    assert.equal(response.status, 500);
    const body = await response.json() as { error?: string; code?: string; reason?: string; details?: unknown };
    assert.equal(body.error, GENERIC_CAPABILITY_FAILURE);
    assert.equal(body.code, expected.code);
    assert.equal(body.reason, expected.reason);
    assert.equal(body.details, undefined);
    assert.equal(JSON.stringify(body).includes('super-secret'), false);
    assert.equal(JSON.stringify(body).includes('https://'), false);
    assert.equal(JSON.stringify(body).includes('sk-ant'), false);
    assert.equal(JSON.stringify(body).includes('constructor'), false);
    assert.equal(JSON.stringify(body).includes('__proto__'), false);
    assert.equal(lines.length, 1);
    const logged = lines[0] ?? '';
    assert.match(logged, /"pluginId":"claude"/);
    assert.match(logged, /"operation":"capabilities"/);
    assert.match(logged, new RegExp(`"code":"${expected.code}"`));
    if (expected.reason) assert.match(logged, new RegExp(`"reason":"${expected.reason}"`));
    else assert.equal(logged.includes('"reason"'), false);
    assert.equal(logged.includes('super-secret'), false);
    assert.equal(logged.includes('https://'), false);
    assert.equal(logged.includes('HOME='), false);
    assert.equal(logged.includes('sk-ant'), false);
    assert.equal(logged.includes('at Client'), false);
    assert.equal(logged.includes('stack'), false);
    assert.equal(logged.includes('constructor'), false);
    assert.equal(logged.includes('__proto__'), false);
    index += 1;
  }
});
