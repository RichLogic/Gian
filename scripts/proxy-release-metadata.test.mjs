import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { shippingProxyIds } from './build-proxy-artifacts.mjs';
import { proxyReleaseMetadata } from './proxy-release-metadata.mjs';

test('release metadata is derived from every self-describing shipping package', () => {
  for (const id of shippingProxyIds) {
    const metadata = proxyReleaseMetadata(id);
    assert.equal(metadata.id, id);
    assert.match(metadata.pluginId, /^(?:claude|codex|kimi|grok|[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)$/);
    assert.match(metadata.version, /^\d+\.\d+\.\d+/);
    assert.ok(metadata.processScope === 'shared' || metadata.processScope === 'session');
    assert.equal(typeof metadata.runtime.id, 'string');
    assert.ok(metadata.runtime.verifiedVersions.length > 0);
    assert.equal(
      metadata.runtime.distribution,
      metadata.pluginId === 'com.zhipu.zcode' ? 'external-app' : 'native-binary',
    );
    assert.equal(metadata.tag, `proxy-${id}-v${metadata.version}`);
    assert.equal(metadata.asset, `gian-proxy-${id}-${metadata.version}-darwin-arm64.tar.gz`);
  }
});

test('hidden and unknown packages cannot enter release publication', () => {
  assert.throws(() => proxyReleaseMetadata('grok'), /not in the shipping/);
  assert.throws(() => proxyReleaseMetadata('unknown'), /not in the shipping/);
});
