import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyProbeCoordinate } from './verify-managed-runtime-candidates.mjs';

test('candidate verification binds Proxy probes to pinned product bytes, not a candidate flag', () => {
  const definitions = [{ id: 'fixture', pluginId: 'io.gian.fixture', runtime: { id: 'fixture-runtime' } }];
  const coordinate = { pluginId: 'io.gian.fixture', runtimeId: 'fixture-runtime', version: '1.0.0',
    format: 'tar.gz', entryRelativePath: 'server', probe: { kind: 'proxy' },
    asset: { sha256: 'a'.repeat(64), size: 123 } };
  const candidate = { provider: 'fixture', version: '1.0.0', format: 'tar.gz', entryRelativePath: 'server',
    asset: { ...coordinate.asset } };
  assert.equal(proxyProbeCoordinate(candidate, [coordinate], definitions)?.coordinate, coordinate);
  for (const changed of [
    { ...candidate, format: 'raw' },
    { ...candidate, entryRelativePath: 'other' },
    { ...candidate, asset: { ...candidate.asset, size: 124 } },
    { ...candidate, asset: { ...candidate.asset, sha256: 'b'.repeat(64) } },
  ]) assert.throws(() => proxyProbeCoordinate(changed, [coordinate], definitions), /differs from the pinned/);
  assert.throws(() => proxyProbeCoordinate({ ...candidate, version: '2.0.0', probe: { kind: 'proxy' } },
    [coordinate], definitions), /no pinned/);
  assert.equal(proxyProbeCoordinate({ provider: 'ordinary', version: '1.0.0' }, [], definitions), null);
});
