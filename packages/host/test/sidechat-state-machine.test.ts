import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { nextPersistedSidechatState } from '../src/session/sidechat-store.js';

function event(method: string, state?: string): unknown {
  return state
    ? { method, params: { data: { state } } }
    : { method };
}

test('nextPersistedSidechatState prefers an explicit reported state', () => {
  assert.equal(nextPersistedSidechatState('idle', event('turn.started', 'stale')), 'stale');
});

test('nextPersistedSidechatState maps lifecycle methods when state is absent', () => {
  assert.equal(nextPersistedSidechatState('idle', event('turn.started')), 'running');
  assert.equal(nextPersistedSidechatState('running', event('interaction.requested')), 'waiting_interaction');
  assert.equal(nextPersistedSidechatState('waiting_interaction', event('interaction.resolved')), 'running');
  assert.equal(nextPersistedSidechatState('idle', event('interaction.resolved')), 'idle');
  assert.equal(nextPersistedSidechatState('running', event('turn.completed')), 'idle');
  assert.equal(nextPersistedSidechatState('running', event('turn.failed')), 'error');
});

test('nextPersistedSidechatState keeps the current state for unknown input', () => {
  assert.equal(nextPersistedSidechatState('running', event('session.updated')), 'running');
  assert.equal(nextPersistedSidechatState('idle', null), 'idle');
  assert.equal(nextPersistedSidechatState('error', 'nope'), 'error');
});
