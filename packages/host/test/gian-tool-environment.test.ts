// GIAN-TOOL-001: a Gian-launched Proxy/Provider does not inherit the external
// Tool control surface, even when the parent Host process was given such vars.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { proxyChildEnvironment } from '../src/proxy/protocol-v2-client.js';

test('GIAN-TOOL-001: Proxy child environment strips all GIAN_TOOL_* values', () => {
  const env = proxyChildEnvironment({
    PATH: '/usr/bin',
    GIAN_TOOL_SOCKET: '/tmp/do-not-inherit.sock',
    GIAN_TOOL_CALLER_ID: 'recursive-caller',
  }, {
    CLAUDE_BIN: '/test/claude',
    GIAN_TOOL_OVERRIDE: 'also-strip',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    CLAUDE_BIN: '/test/claude',
  });
});

test('Proxy child environment drops inherited Claude discovery variables', () => {
  const env = proxyChildEnvironment({
    PATH: '/usr/bin',
    CLAUDE_CONFIG_DIR: '/inherited/claude',
    ANTHROPIC_API_KEY: 'inherited-key',
    ANTHROPIC_BASE_URL: 'https://inherited.example',
  }, {
    CLAUDE_CONFIG_DIR: '/agent/claude',
    ANTHROPIC_AUTH_TOKEN: 'agent-token',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/agent/claude');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'agent-token');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
});
