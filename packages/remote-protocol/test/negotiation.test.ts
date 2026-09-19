import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { acceptRemoteHello, createRemoteHello, generateCanonicalId, validateRemoteHelloReply } from '../src/index.js';

test('business hello is bound to the authenticated device, connection and generation', () => {
  const identity = { deviceId: generateCanonicalId(), connectionId: generateCanonicalId(), hostGeneration: generateCanonicalId(), hostVersion: 'test-host' };
  const offer = createRemoteHello(identity.deviceId, 'test-web');
  const reply = acceptRemoteHello(offer, identity, 123);
  assert.equal(reply.negotiated_minor_version, 1);
  assert.ok(reply.negotiated_capabilities.includes('wire.transcript_page'));
  assert.deepEqual(validateRemoteHelloReply(reply, offer, identity.connectionId, identity.hostGeneration), reply);
  assert.throws(() => acceptRemoteHello({ ...offer, device_id: generateCanonicalId() }, identity), /authenticated route/);
  assert.throws(() => validateRemoteHelloReply(reply, offer, generateCanonicalId(), identity.hostGeneration), /authenticated connection/);
  assert.throws(() => validateRemoteHelloReply(reply, offer, identity.connectionId, generateCanonicalId()), /authenticated connection/);
});

test('unsupported versions reject and feature negotiation never invents a capability', () => {
  const identity = { deviceId: generateCanonicalId(), connectionId: generateCanonicalId(), hostGeneration: generateCanonicalId(), hostVersion: 'test-host' };
  const offer = { ...createRemoteHello(identity.deviceId, 'test-web'), capabilities: ['wire.snapshot_parts', 'wire.future'] };
  const reply = acceptRemoteHello(offer, identity);
  assert.deepEqual(reply.negotiated_capabilities, ['wire.snapshot_parts']);
  assert.throws(() => acceptRemoteHello({ ...offer, min_minor_version: 9, max_minor_version: 9 }, identity), /do not overlap/);
  assert.throws(() => validateRemoteHelloReply({ ...reply, negotiated_minor_version: 9 }, offer, identity.connectionId, identity.hostGeneration), /offered protocol/);
  assert.throws(() => validateRemoteHelloReply({ ...reply, negotiated_capabilities: ['wire.content_resume'] }, offer, identity.connectionId, identity.hostGeneration), /offered protocol/);
});
