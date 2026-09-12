import assert from 'node:assert/strict';
import { Hono } from 'hono';
import test from 'node:test';

import { CustomizationRequestError } from '../src/proxy/customization-inventory.js';
import { registerCustomizationRoutes } from '../src/web/routes/customizations.js';

function okResult(kind: string) {
  return {
    kind,
    status: 'ok',
    completeness: 'effective',
    observedAt: '2026-09-02T00:00:00.000Z',
    items: [],
    truncated: false,
    diagnostics: [],
  };
}

function makeApp(overrides: {
  inspectKinds?: (input: unknown) => Promise<unknown>;
  inspectDetail?: (input: unknown) => Promise<unknown>;
} = {}) {
  const app = new Hono();
  registerCustomizationRoutes(app, {
    inspectKinds: overrides.inspectKinds ?? (async () => ({
      agentId: 'agent-1',
      workspaceId: null,
      fetchedAt: '2026-09-02T00:00:00.000Z',
      kinds: { skill: okResult('skill'), mcp: okResult('mcp'), hook: okResult('hook'), rule: okResult('rule') },
    })),
    inspectDetail: overrides.inspectDetail ?? (async () => ({
      kind: 'skill',
      id: 'ci1_' + 'a'.repeat(32),
      status: 'ok',
      observedAt: '2026-09-02T00:00:00.000Z',
      text: '# skill',
      truncated: false,
    })),
  } as never);
  return app;
}

test('GET customizations defaults to all four kinds and forwards refresh', async () => {
  let seen: unknown = null;
  const app = makeApp({
    inspectKinds: async input => {
      seen = input;
      return {
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        fetchedAt: '2026-09-02T00:00:00.000Z',
        kinds: { rule: okResult('rule') },
      };
    },
  });
  const response = await app.request('/api/agents/agent-1/customizations?workspaceId=ws-1&refresh=1');
  assert.equal(response.status, 200);
  const body = await response.json() as { kinds: Record<string, unknown> };
  assert.equal(body.kinds.rule !== undefined, true);
  assert.deepEqual(seen, {
    agentId: 'agent-1',
    workspaceId: 'ws-1',
    kinds: ['skill', 'mcp', 'hook', 'rule'],
    refresh: true,
  });
});

test('GET customizations rejects unknown kinds with 400', async () => {
  const app = makeApp();
  const response = await app.request('/api/agents/a/customizations?kinds=skill,bogus');
  assert.equal(response.status, 400);
});

test('GET customizations turns request-level errors into 404/502', async () => {
  const notFound = makeApp({ inspectKinds: async () => { throw new CustomizationRequestError('workspace not found', 404); } });
  assert.equal((await notFound.request('/api/agents/a/customizations')).status, 404);

  const generic = makeApp({ inspectKinds: async () => { throw new Error('boom'); } });
  assert.equal((await generic.request('/api/agents/a/customizations')).status, 502);
});

test('GET detail validates kind and stable id shape before any lookup', async () => {
  const app = makeApp();
  assert.equal((await app.request('/api/agents/a/customizations/bogus/items/ci1_' + 'a'.repeat(32))).status, 404);
  assert.equal((await app.request('/api/agents/a/customizations/skill/items/not-an-id')).status, 404);
  const ok = await app.request('/api/agents/a/customizations/skill/items/ci1_' + 'a'.repeat(32));
  assert.equal(ok.status, 200);
  const body = await ok.json() as { text: string };
  assert.equal(body.text, '# skill');
});

test('GET detail maps service 404 and failures to HTTP statuses', async () => {
  const notFound = makeApp({ inspectDetail: async () => { throw new CustomizationRequestError('customization item not found', 404); } });
  assert.equal((await notFound.request('/api/agents/a/customizations/skill/items/ci1_' + 'a'.repeat(32))).status, 404);
  const failing = makeApp({ inspectDetail: async () => { throw new Error('proxy gone'); } });
  assert.equal((await failing.request('/api/agents/a/customizations/skill/items/ci1_' + 'a'.repeat(32))).status, 502);
});