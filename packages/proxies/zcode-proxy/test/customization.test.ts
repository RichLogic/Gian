import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { startHarness, type Harness } from './harness.js';

async function initialize(h: Harness, versions: string[]): Promise<Record<string, unknown>> {
  const response = await h.request('initialize', {
    protocol: { name: 'gian.proxy', versions },
    host: { name: 'Gian', version: '0.0.0-test' },
  });
  assert.equal(response.kind, 'result', `initialize failed: ${JSON.stringify(response)}`);
  return (response.payload as { result: Record<string, unknown> }).result;
}

const SKILLS = [
  {
    id: 'glm:workspace:/tmp/zcode-ws/.zcode/skills/deploy/SKILL.md',
    name: 'deploy',
    description: 'Ship the current workspace.',
    path: '/tmp/zcode-ws/.zcode/skills/deploy/SKILL.md',
    scope: 'workspace',
    enabled: true,
  },
  {
    id: 'glm:user:/Users/rich/.zcode/skills/commit/SKILL.md',
    name: 'commit',
    description: 'Write a commit.',
    path: '/Users/rich/.zcode/skills/commit/SKILL.md',
    scope: 'user',
    enabled: true,
  },
];

const MCP_STATUSES = {
  image_search: {
    status: 'connected',
    transport: 'stdio',
    toolCount: 3,
    updatedAt: '2026-09-24T00:00:00.000Z',
  },
  broken_server: {
    status: 'failed',
    transport: 'http',
    toolCount: 0,
    updatedAt: '2026-09-24T00:00:00.000Z',
    failureKind: 'connect_timeout',
  },
};

test('2.3 customization.list projects the provider skill catalog read-only', async () => {
  const harness = startHarness({ scenario: { skills: SKILLS } });
  try {
    const result = await initialize(harness, ['2.3', '2.1']);
    assert.equal((result.protocol as { version: string }).version, '2.3');
    assert.equal((result.capabilities as Record<string, number>)['customization.list'], 1);

    const listed = await harness.request('customization.list', { kind: 'skill', cwd: '/tmp/zcode-ws' });
    assert.equal(listed.kind, 'result', JSON.stringify(listed));
    const payload = (listed.payload as { result: {
      kind: string;
      status: string;
      completeness: string;
      items: Array<Record<string, unknown>>;
      truncated: boolean;
      diagnostics: unknown[];
    } }).result;
    assert.equal(payload.kind, 'skill');
    assert.equal(payload.status, 'ok');
    assert.equal(payload.completeness, 'effective');
    assert.equal(payload.items.length, 2);
    assert.equal(payload.truncated, false);

    const deploy = payload.items.find((item) => item.name === 'deploy')!;
    assert.match(deploy.id as string, /^ci1_[0-9a-f]{32}$/, 'ids use the stable ci1_ hex form');
    assert.equal(deploy.activation, 'enabled');
    assert.equal((deploy.scope as { level: string }).level, 'workspace');
    assert.equal((deploy.origin as { kind: string }).kind, 'project_file');
    assert.equal((deploy.discovery as { method: string }).method, 'provider_api');
    assert.equal((deploy.skill as { invocation: string }).invocation, 'deploy');

    // The scan is read-only: only the reference catalog call is made.
    const calls = harness.fakeLog().filter((entry) => entry.method === 'skills/referenceCatalog');
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.params as { sessionId?: string }).sessionId, undefined, 'no session is attached for the scan');
  } finally {
    await harness.close();
  }
});

test('2.3 customization.list projects MCP statuses without connecting', async () => {
  const harness = startHarness({ scenario: { mcpStatuses: MCP_STATUSES } });
  try {
    await initialize(harness, ['2.3', '2.1']);
    const listed = await harness.request('customization.list', { kind: 'mcp', cwd: '/tmp/zcode-ws' });
    assert.equal(listed.kind, 'result', JSON.stringify(listed));
    const payload = (listed.payload as { result: {
      status: string;
      items: Array<Record<string, unknown>>;
    } }).result;
    assert.equal(payload.status, 'ok');
    assert.equal(payload.items.length, 2);
    const imageSearch = payload.items.find((item) => item.name === 'image_search')!;
    assert.equal(imageSearch.activation, 'enabled');
    assert.equal((imageSearch.mcp as { transport: string; toolCount: number }).transport, 'stdio');
    assert.equal((imageSearch.mcp as { toolCount: number }).toolCount, 3);
    const broken = payload.items.find((item) => item.name === 'broken_server')!;
    assert.equal(broken.activation, 'invalid');

    // mode:"status" only — the read-only surface never connects.
    const mcpCalls = harness.fakeLog().filter((entry) => entry.method === 'mcp/list');
    assert.equal(mcpCalls.length, 1);
    assert.equal((mcpCalls[0]!.params as { mode: string }).mode, 'status');
  } finally {
    await harness.close();
  }
});

test('hooks and rules are proxy_unsupported with the upstream evidence', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness, ['2.3', '2.1']);
    const hooks = await harness.request('customization.list', { kind: 'hook' });
    const hookPayload = (hooks.payload as { result: {
      status: string;
      completeness: string;
      items: unknown[];
      diagnostics: Array<{ code: string; message: string }>;
    } }).result;
    assert.equal(hookPayload.status, 'proxy_unsupported');
    assert.equal(hookPayload.completeness, 'none');
    assert.deepEqual(hookPayload.items, []);
    assert.equal(hookPayload.diagnostics[0]!.code, 'SOURCE_NOT_ENUMERABLE');
    assert.match(hookPayload.diagnostics[0]!.message, /no hook enumeration method/i);

    const rules = await harness.request('customization.list', { kind: 'rule' });
    assert.equal(
      ((rules.payload as { result: { status: string } }).result.status),
      'proxy_unsupported',
    );
  } finally {
    await harness.close();
  }
});

test('customization.detail returns provider metadata for skills and unavailable for unknown ids', async () => {
  const harness = startHarness({ scenario: { skills: SKILLS } });
  try {
    await initialize(harness, ['2.3', '2.1']);
    const listed = await harness.request('customization.list', { kind: 'skill', cwd: '/tmp/zcode-ws' });
    const items = ((listed.payload as { result: { items: Array<{ id: string; name: string }> } }).result.items);
    const deployId = items.find((item) => item.name === 'deploy')!.id;

    const detail = await harness.request('customization.detail', { kind: 'skill', id: deployId, cwd: '/tmp/zcode-ws' });
    assert.equal(detail.kind, 'result');
    const detailResult = (detail.payload as { result: { status: string; text: string; truncated: boolean } }).result;
    assert.equal(detailResult.status, 'ok');
    assert.ok(detailResult.text.includes('deploy'), 'detail text is the provider metadata');
    assert.equal(detailResult.truncated, false);

    const missing = await harness.request('customization.detail', {
      kind: 'skill',
      id: 'ci1_' + 'a'.repeat(32),
      cwd: '/tmp/zcode-ws',
    });
    assert.equal(missing.kind, 'result');
    const missingResult = (missing.payload as { result: { status: string; text: string } }).result;
    assert.equal(missingResult.status, 'unavailable');
    assert.equal(missingResult.text, '');
  } finally {
    await harness.close();
  }
});

test('ZCode Proxy downgrades to 2.1 without customization when 2.3 is not offered', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    const result = await initialize(harness, ['2.1', '2.0']);
    assert.equal((result.protocol as { version: string }).version, '2.1');
    const capabilities = result.capabilities as Record<string, number>;
    assert.equal(capabilities['customization.list'], undefined);
    await harness.request('shutdown', {});
  } finally {
    harness.close?.();
  }
});
