import assert from 'node:assert/strict';
import test from 'node:test';
import { externalProtocolLockfile, validateProtocolDependency, verifyProtocolArchive } from '../scripts/protocol-dependency.mjs';
import { protocolFixture, protocolBytes, protocolLockFixture } from './protocol-fixture.mjs';

test('protocol dependency is pinned to public Gian and exact verified archive bytes', () => {
  const coordinate = protocolFixture();
  assert.equal(verifyProtocolArchive(coordinate, protocolBytes), coordinate);
  for (const change of [{ repository: 'RichLogic/Gian-Dev' }, { url: coordinate.url.replace('/Gian/', '/Gian-Dev/') }, { url: coordinate.url + '?temporary=true' }, { integrity: 'sha512-invalid' }, { status: 'pending-publication' }, { dependencies: { zod: '^4.4.3' } }]) assert.throws(() => validateProtocolDependency({ ...coordinate, ...change }));
  assert.throws(() => verifyProtocolArchive(coordinate, Buffer.from('different bytes')), /differ/);
});

test('external protocol lock preserves registry pins and removes the protocol workspace', () => {
  const coordinate = protocolFixture();
  const directories = ['shared', 'chat-ui', 'remote-server', 'remote-web'].map(name => `packages/${name}`);
  const lock = externalProtocolLockfile(protocolLockFixture(), coordinate, directories);
  assert.ok(!lock.includes('packages/remote-protocol:'));
  assert.ok(!lock.includes('packages/host:'));
  assert.ok(!lock.includes('link:../remote-protocol'));
  assert.equal(lock.split(`specifier: "${coordinate.url}"`).length - 1, 2);
  assert.ok(lock.includes(coordinate.integrity));
  assert.ok(lock.includes('  zod@4.4.3:\n    resolution: {integrity: fixture-only}'));
  assert.ok(lock.includes('  zod@4.4.3: {}'));
  assert.throws(() => externalProtocolLockfile(protocolLockFixture(), { ...coordinate, dependencies: { zod: '99.0.0' } }, directories), /Update the source lockfile/);
});
