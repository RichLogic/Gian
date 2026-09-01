import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  EXECUTOR_DEFS,
  EXECUTOR_IDS,
  PRODUCT_EXECUTORS,
  PRODUCT_EXECUTOR_IDS,
  executorRegistryParity,
  isExecutorId,
  isProductExecutor,
  supportsNativeSessions,
  usesCliCapabilitySurface,
  usesNativeExecutorConfig,
} from '../dist/index.js';

test('executor registry matches the product surface and hidden gating', () => {
  assert.deepEqual([...PRODUCT_EXECUTOR_IDS], ['claude', 'codex', 'kimi', 'dsh', 'zcode']);
  assert.deepEqual([...EXECUTOR_IDS], ['claude', 'codex', 'kimi', 'grok', 'dsh', 'zcode']);
  assert.equal(PRODUCT_EXECUTORS, PRODUCT_EXECUTOR_IDS);
  const visible = EXECUTOR_IDS.filter((id) => EXECUTOR_DEFS[id].productVisible);
  assert.deepEqual([...visible], [...PRODUCT_EXECUTOR_IDS]);
  assert.equal(EXECUTOR_DEFS.grok.productVisible, false, 'grok ships hidden');
});

test('registry definitions are well-formed', () => {
  const ids = new Set();
  const pluginIds = new Set();
  for (const id of EXECUTOR_IDS) {
    const def = EXECUTOR_DEFS[id];
    ids.add(def.id);
    pluginIds.add(def.pluginId);
    assert.equal(def.id, id);
    assert.match(def.entryEnvVar, /^GIAN_[A-Z0-9_]+_PROXY_ENTRY$/);
    assert.match(def.binEnvVar, /^[A-Z0-9_]+_BIN$/);
    assert.match(def.proxyPackageDir, /^[a-z0-9-]+-proxy$/);
    assert.match(def.proxyPackageName, /^@gian\/[a-z0-9-]+-proxy$/);
    assert.ok(def.displayName.length > 0);
    assert.ok(def.processScope === 'shared' || def.processScope === 'session');
    // pluginId matches the proxy-protocol pluginIdSchema: a reserved bare id
    // or a reverse-domain id.
    assert.match(
      def.pluginId,
      /^(?:claude|codex|kimi|grok|dsh|[a-z0-9]+(?:[.-][a-z0-9]+)+)$/,
    );
  }
  assert.equal(ids.size, EXECUTOR_IDS.length, 'executor ids are unique');
  assert.equal(pluginIds.size, EXECUTOR_IDS.length, 'plugin ids are unique');
});

test('guards stay in parity with the registry', () => {
  for (const entry of executorRegistryParity()) {
    assert.equal(entry.ok, true, `registry drift for ${entry.id}`);
  }
  assert.equal(usesCliCapabilitySurface('claude'), true);
  assert.equal(usesCliCapabilitySurface('zcode'), false, 'zcode is catalog-driven');
  assert.equal(usesNativeExecutorConfig('kimi'), true);
  assert.equal(usesNativeExecutorConfig('claude'), false);
  assert.equal(supportsNativeSessions('dsh'), false);
  assert.equal(supportsNativeSessions('claude'), true);
  assert.equal(isExecutorId('claude'), true);
  assert.equal(isExecutorId('zcode'), true, 'zcode registered in WP4');
  assert.equal(isProductExecutor('grok'), false);
  assert.equal(isProductExecutor('dsh'), true);
});

test('release matrix in build-proxy-artifacts.mjs stays inside the registry', () => {
  const source = readFileSync(
    new URL('../../../scripts/build-proxy-artifacts.mjs', import.meta.url),
    'utf8',
  );
  const ids = [...source.matchAll(/^\s+id: '([a-z0-9-]+)',$/gm)].map((m) => m[1]);
  assert.ok(ids.length > 0, 'release definitions not found');
  for (const id of ids) {
    assert.ok(
      EXECUTOR_IDS.includes(id),
      `release matrix id ${id} is not a registered executor`,
    );
  }
  const staged = [...source.matchAll(/\n    staged: true,/g)].length;
  assert.equal(staged, 1, 'only hidden Grok remains staged after ZCode WP7');
  assert.match(source, /definition\.staged !== true/, 'shipping filter moved off the staged flag');
});
