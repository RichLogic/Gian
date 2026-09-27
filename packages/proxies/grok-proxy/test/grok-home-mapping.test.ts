/** HOME mapping regression: the Host provides the constrained universal
 *  GIAN_AGENT_HOME; the owning Proxy translates it into GROK_HOME for its
 *  CLI child. A stale machine-wide GROK_HOME never wins over it, and with
 *  neither variable set the child simply inherits (machine HOME semantics). */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { agentHome, grokChildHomeEnv } from '../src/runtime/grok-acp-client.js';

test('GIAN_AGENT_HOME wins over an inherited GROK_HOME', () => {
  const env = { GIAN_AGENT_HOME: '/home/agent-a', GROK_HOME: '/home/stale' };
  assert.equal(agentHome(env), '/home/agent-a');
  assert.deepEqual(grokChildHomeEnv(env), { GROK_HOME: '/home/agent-a' });
});

test('GROK_HOME alone is honored as a pre-gate compatibility fallback', () => {
  assert.deepEqual(grokChildHomeEnv({ GROK_HOME: '/home/legacy-host' }), {
    GROK_HOME: '/home/legacy-host',
  });
});

test('empty GIAN_AGENT_HOME falls through to GROK_HOME, then to inheritance', () => {
  assert.equal(agentHome({ GIAN_AGENT_HOME: '', GROK_HOME: '/home/legacy' }), '/home/legacy');
  assert.deepEqual(grokChildHomeEnv({}), {});
  const inherited = grokChildHomeEnv({ HOME: '/home/user' });
  assert.deepEqual(inherited, {});
});
