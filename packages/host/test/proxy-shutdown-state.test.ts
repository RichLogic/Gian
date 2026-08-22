import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createProxyProcessShutdownState } from '../src/proxy/process-shutdown.js';

test('beginEscalation succeeds once and then refuses', () => {
  const state = createProxyProcessShutdownState();
  assert.equal(state.escalationAttempted, false);
  assert.equal(state.beginEscalation(), true);
  assert.equal(state.escalationAttempted, true);
  assert.equal(state.beginEscalation(), false);
});

test('observeAbsence blocks a later escalation attempt', () => {
  const state = createProxyProcessShutdownState();
  state.observeAbsence();
  assert.equal(state.absenceObserved, true);
  assert.equal(state.beginEscalation(), false);
  assert.equal(state.escalationAttempted, false);
});

test('absence after escalation keeps both flags', () => {
  const state = createProxyProcessShutdownState();
  assert.equal(state.beginEscalation(), true);
  state.observeAbsence();
  assert.equal(state.absenceObserved, true);
  assert.equal(state.escalationAttempted, true);
  assert.equal(state.beginEscalation(), false);
});
