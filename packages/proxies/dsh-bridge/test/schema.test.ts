import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_METHODS,
  BRIDGE_NOTIFICATIONS,
  BRIDGE_PROTOCOL_NAME,
  BRIDGE_PROTOCOL_VERSION,
  validateBridgeNotification,
  validateBridgeRequest,
} from '../src/schema.js';

test('bridge protocol identity is frozen', () => {
  assert.equal(BRIDGE_PROTOCOL_NAME, 'gian.dsh.bridge');
  assert.equal(BRIDGE_PROTOCOL_VERSION, '1.0');
  assert.equal(BRIDGE_METHODS.includes('initialize'), true);
  assert.equal(BRIDGE_METHODS.includes('shutdown'), true);
  assert.equal(BRIDGE_NOTIFICATIONS.includes('session.event'), true);
  assert.equal(BRIDGE_NOTIFICATIONS.includes('runtime.error'), true);
});

test('request validation rejects non-string id', () => {
  const result = validateBridgeRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocol: { versions: ['1.0'] } },
  });
  assert.equal(result.ok, false);
});

test('request validation rejects unknown method', () => {
  const result = validateBridgeRequest({
    jsonrpc: '2.0',
    id: 'r1',
    method: 'not.a.method',
    params: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown bridge method/);
});

test('notification validation rejects id presence', () => {
  const result = validateBridgeNotification({
    jsonrpc: '2.0',
    id: 'nope',
    method: 'agent.status',
    params: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /must omit id/);
});

test('notification validation accepts a session.event', () => {
  const result = validateBridgeNotification({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId: 's1', nativeSeq: 0, type: 'turn/start', data: { turn: 0 } },
  });
  assert.equal(result.ok, true);
});
