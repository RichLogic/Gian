import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fromWireExtensionMethod,
  GrokExtBusinessError,
  isInterjectSessionMissing,
  isWireMethodNotFound,
  toWireExtensionMethod,
  unwrapExtMethodResult,
} from '../src/runtime/acp-wire.js';

test('extension methods gain one wire underscore and inbound names lose it once', () => {
  assert.equal(toWireExtensionMethod('x.ai/interject'), '_x.ai/interject');
  assert.equal(toWireExtensionMethod('_x.ai/interject'), '_x.ai/interject');
  assert.equal(toWireExtensionMethod('session/prompt'), 'session/prompt');
  assert.equal(fromWireExtensionMethod('_x.ai/interject'), 'x.ai/interject');
  assert.equal(fromWireExtensionMethod('__x.ai/interject'), '__x.ai/interject');
  assert.equal(fromWireExtensionMethod('x.ai/interject'), 'x.ai/interject');
  assert.equal(fromWireExtensionMethod('session/update'), 'session/update');
});

test('only a numeric -32601 refutes a method', () => {
  assert.equal(isWireMethodNotFound({ code: -32601, message: 'Method not found' }), true);
  assert.equal(isWireMethodNotFound(new Error('Method not found')), false);
  assert.equal(isWireMethodNotFound({ code: -32602, message: 'session not found' }), false);
  assert.equal(isInterjectSessionMissing({
    code: -32602,
    message: 'Invalid params',
    data: 'session not found: gian-probe-missing-session',
  }), true);
  assert.equal(isInterjectSessionMissing({ code: -32602, message: 'Invalid params', data: 'bad text' }), false);
  assert.equal(isInterjectSessionMissing({ code: -32601, message: 'session not found' }), false);
});

test('extension envelopes unwrap business results and surface business errors', () => {
  assert.deepEqual(unwrapExtMethodResult('x.ai/interject', { result: { status: 'queued' } }), {
    status: 'queued',
  });
  assert.deepEqual(unwrapExtMethodResult('x.ai/mcp/list', { servers: [] }), { servers: [] });
  assert.throws(
    () => unwrapExtMethodResult('x.ai/interject', { result: null, error: { message: 'queued later' } }),
    (error: unknown) => error instanceof GrokExtBusinessError && /queued later/.test(error.message),
  );
});
