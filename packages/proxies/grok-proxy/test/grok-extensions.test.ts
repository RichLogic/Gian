import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extensionSupportFromInitialize,
  GROK_EXT_METHODS,
} from '../src/runtime/grok-extensions.js';

test('no x.ai method is claimed from initialize metadata alone', () => {
  // Live verification of the published 1.0.41 stdio binary showed it answers
  // -32601 "Method not found" for every x.ai/* request method even though
  // _meta advertises grokShell and a modern agentVersion. Version floors are
  // therefore proof of nothing: nothing may be claimed before a live
  // confirmation.
  const support = extensionSupportFromInitialize({ _meta: { grokShell: true, agentVersion: '1.0.41' } });
  assert.equal(support.grokShell, true);
  assert.equal(support.agentVersion, '1.0.41');
  for (const method of GROK_EXT_METHODS) {
    assert.equal(support.supports(method), false, method);
    assert.equal(support.state(method), 'unknown', method);
    assert.match(support.unsupportedReason(method), /never confirmed on this Grok runtime/);
  }
});

test('extension support is absent without grokShell even with a version', () => {
  const support = extensionSupportFromInitialize({ _meta: { agentVersion: '1.0.41' } });
  assert.equal(support.supports('x.ai/session/fork'), false);
  assert.match(support.unsupportedReason('x.ai/session/fork'), /stdio grok agent/);
});

test('a successful live call confirms a method for the attach', () => {
  const support = extensionSupportFromInitialize({ _meta: { grokShell: true, agentVersion: '1.0.41' } });
  assert.equal(support.mayAttempt('x.ai/session/rename'), true, 'an unknown method may be probed by its first real call');
  support.confirm('x.ai/session/rename');
  assert.equal(support.supports('x.ai/session/rename'), true);
  assert.equal(support.state('x.ai/session/rename'), 'confirmed');
});

test('a Method-not-found response refutes a method for the rest of the attach', () => {
  const support = extensionSupportFromInitialize({ _meta: { grokShell: true, agentVersion: '1.0.41' } });
  support.refute('x.ai/interject');
  assert.equal(support.supports('x.ai/interject'), false);
  assert.equal(support.mayAttempt('x.ai/interject'), false, 'a refuted method must fail fast instead of repeating the live misreport');
  assert.match(support.unsupportedReason('x.ai/interject'), /Method not found/);
  assert.equal(support.mayAttempt('x.ai/session/fork'), true, 'refutation is per method');
});

test('an explicit upstream per-method advertisement pre-confirms those methods', () => {
  const support = extensionSupportFromInitialize({
    _meta: { grokShell: true, agentVersion: '9.9.9', 'x.ai/extMethods': ['x.ai/session/fork', 'not-a-method'] },
  });
  assert.equal(support.supports('x.ai/session/fork'), true);
  assert.equal(support.supports('x.ai/interject'), false, 'unadvertised methods stay unknown');
});

test('missing _meta degrades to no extension support', () => {
  const support = extensionSupportFromInitialize(null);
  assert.equal(support.supports('x.ai/session/fork'), false);
  assert.equal(support.mayAttempt('x.ai/session/fork'), false, 'no grokShell identity means no probing at all');
  assert.match(support.unsupportedReason('x.ai/session/fork'), /stdio grok agent/);
});
