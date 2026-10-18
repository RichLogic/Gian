import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  McpDescriptorError,
  redactRuntimeData,
  toAcpMcpServers,
} from '../src/core/mcp.js';

const secret = 'super-secret-value';

function expectDescriptorError(value: unknown, index: number | null): McpDescriptorError {
  try {
    toAcpMcpServers(value);
  } catch (error) {
    assert.ok(error instanceof McpDescriptorError);
    assert.equal(error.domainCode, 'CONFIG_VALUE_INVALID');
    assert.equal(error.retryable, false);
    assert.equal(error.index, index);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('Bearer'), false);
    return error;
  }
  assert.fail('expected McpDescriptorError');
}

test('streamable HTTP descriptors keep exact ids, urls, and header order', () => {
  const servers = toAcpMcpServers([
    {
      id: 'docs',
      protocol: 'mcp',
      transport: { type: 'streamable-http', url: 'https://example.com/mcp' },
    },
    {
      id: 'local',
      protocol: 'mcp',
      transport: {
        type: 'streamable-http',
        url: 'http://127.0.0.1:9/mcp',
        headers: { Authorization: `Bearer ${secret}`, 'X-Trace': 'trace-1' },
      },
    },
    {
      id: 'userinfo',
      protocol: 'mcp',
      transport: {
        type: 'streamable-http',
        url: `https://user:${secret}@example.com/mcp`,
      },
    },
  ]);
  assert.equal(servers[0]?.headers.length, 0);
  assert.deepEqual(servers[1], {
    type: 'http',
    name: 'local',
    url: 'http://127.0.0.1:9/mcp',
    headers: [
      { name: 'Authorization', value: `Bearer ${secret}` },
      { name: 'X-Trace', value: 'trace-1' },
    ],
  });
  assert.equal(servers[2]?.url, `https://user:${secret}@example.com/mcp`);
  assert.deepEqual(toAcpMcpServers([]), []);
});

test('disallowed descriptors and duplicate ids fail without echoing secrets', () => {
  const header = { Authorization: `Bearer ${secret}` };
  expectDescriptorError([{
    id: 'bad',
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: 'file:///tmp/mcp', headers: header },
  }], 0);
  expectDescriptorError([{
    id: 'bad',
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: '/relative', headers: header },
  }], 0);
  expectDescriptorError([{
    id: 'bad',
    protocol: 'mcp',
    transport: { type: 'sse', url: 'https://example.com/mcp', headers: header },
  }], 0);
  expectDescriptorError([{
    id: 'bad',
    protocol: 'mcp',
    transport: { type: 'stdio', command: 'mcp', headers: header },
  }], 0);
  expectDescriptorError([{
    id: 'bad',
    transport: { type: 'streamable-http', url: 'https://example.com/mcp' },
  }], 0);
  expectDescriptorError([{
    id: 'bad',
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 1 } },
  }], 0);
  expectDescriptorError([{
    id: 'bad',
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: 'https://example.com/mcp' },
    extra: `Bearer ${secret}`,
  }], 0);
  expectDescriptorError(null, null);
  const duplicate = expectDescriptorError([
    {
      id: 'docs',
      protocol: 'mcp',
      transport: { type: 'streamable-http', url: 'https://example.com/mcp', headers: header },
    },
    {
      id: 'docs',
      protocol: 'mcp',
      transport: { type: 'streamable-http', url: 'https://example.com/other', headers: header },
    },
  ], 1);
  assert.equal(duplicate.message.includes("id 'docs'"), true);
});

test('redaction keeps usage keys and removes env payloads without mutating input', () => {
  const input = {
    inputTokens: 15,
    outputTokens: 4,
    token: secret,
    access_token: secret,
    tokenCount: 9,
    authorization: `Bearer ${secret}`,
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: 'text/plain',
    },
    headerEntries: [
      { name: 'Authorization', value: `Bearer ${secret}` },
      { name: 'Accept', value: 'text/plain' },
    ],
    env: { PATH: '/secret/bin', CUSTOM_REGION: 'us-central1', API_TOKEN: secret },
    environ: { HOME: '/Users/hidden' },
    environment: 'plain-looking',
    environmentName: 'prod',
    note: `fetch https://user:${secret}@example.com/mcp?token=${secret}`,
    command: `Basic ${secret}`,
  };
  const snapshot = structuredClone(input);
  const redacted = redactRuntimeData(input) as Record<string, unknown>;
  assert.deepEqual(input, snapshot);
  assert.equal(redacted.inputTokens, 15);
  assert.equal(redacted.outputTokens, 4);
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.access_token, '[REDACTED]');
  assert.equal(redacted.tokenCount, 9);
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.deepEqual(redacted.headers, { Authorization: '[REDACTED]', Accept: '[REDACTED]' });
  assert.equal(redacted.env, '[REDACTED]');
  assert.equal(redacted.environ, '[REDACTED]');
  assert.equal(redacted.environment, '[REDACTED]');
  assert.equal(redacted.environmentName, 'prod');
  const serialized = JSON.stringify(redacted);
  for (const planted of [secret, '/secret/bin', 'us-central1', '/Users/hidden', 'plain-looking', 'API_TOKEN']) {
    assert.equal(serialized.includes(planted), false);
  }
  assert.equal(String(redacted.note).includes('user:'), false);
  assert.equal(String(redacted.note).includes('[REDACTED]'), true);
  assert.equal(redacted.command, 'Basic [REDACTED]');

  const cycle: Record<string, unknown> = { inputTokens: 1 };
  cycle.self = cycle;
  const cycled = redactRuntimeData(cycle) as Record<string, unknown>;
  assert.equal(cycled.inputTokens, 1);
  assert.equal(cycled.self, null);
  assert.equal(cycle.self, cycle);

  const servers = toAcpMcpServers([{
    id: 'local',
    protocol: 'mcp',
    transport: {
      type: 'streamable-http',
      url: `https://user:${secret}@example.com/mcp?token=${secret}`,
      headers: { Authorization: `Bearer ${secret}` },
    },
  }]);
  const originalHeader = servers[0]?.headers[0]?.value;
  const redactedServer = redactRuntimeData(servers[0]) as { headers: Array<{ name: string; value: string }>; url: string };
  assert.equal(servers[0]?.headers[0]?.value, originalHeader);
  assert.equal(redactedServer.headers[0]?.name, 'Authorization');
  assert.equal(redactedServer.headers[0]?.value, '[REDACTED]');
  assert.equal(redactedServer.url.includes(secret), false);
});

test('OAuth callback query values are redacted and structured state remains', () => {
  const code = 'synth-oauth-code';
  const oauthState = 'synth-oauth-state';
  const verifier = 'synth-code-verifier';
  const challenge = 'synth-code-challenge';
  const callback = `https://example.test/oauth/callback?code=${code}&state=${oauthState}&code_verifier=${verifier}&code_challenge=${challenge}&scope=openid`;
  const redactedUrl = redactRuntimeData(
    `authenticate failed: ${callback}#Code=${code}`,
  );
  assert.equal(redactedUrl, 'authenticate failed: https://example.test/oauth/callback?code=[REDACTED]&state=[REDACTED]&code_verifier=[REDACTED]&code_challenge=[REDACTED]&scope=openid#Code=[REDACTED]');
  assert.equal(String(redactedUrl).includes(code), false);
  assert.equal(String(redactedUrl).includes(oauthState), false);
  assert.equal(String(redactedUrl).includes(verifier), false);
  assert.equal(String(redactedUrl).includes(challenge), false);

  const machine = {
    state: 'awaiting_permission',
    code: 'session-phase',
    nested: { state: { phase: 'idle', attempt: 1 } },
    detail: callback,
  };
  const snapshot = structuredClone(machine);
  const redacted = redactRuntimeData(machine) as typeof machine;
  assert.deepEqual(machine, snapshot);
  assert.equal(redacted.state, 'awaiting_permission');
  assert.equal(redacted.code, 'session-phase');
  assert.deepEqual(redacted.nested, { state: { phase: 'idle', attempt: 1 } });
  assert.equal(redacted.detail.includes(code), false);
  assert.equal(redacted.detail.includes('scope=openid'), true);
});
