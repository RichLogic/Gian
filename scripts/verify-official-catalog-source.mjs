#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileOfficialCatalogSource,
  ephemeralCatalogSigningKey,
  loadOfficialCatalogSource,
  verifyOfficialCatalogSource,
} from '../packages/proxy-catalog-contract/dist/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(root, 'catalog', 'official-source');

const plugins = await loadOfficialCatalogSource(sourceRoot);
verifyOfficialCatalogSource(plugins);
const signingKey = ephemeralCatalogSigningKey();
const first = await compileOfficialCatalogSource({
  sourceRoot,
  sequence: 1,
  issuedAt: '2026-09-02T00:00:00.000Z',
  signingKey,
});
const second = await compileOfficialCatalogSource({
  sourceRoot,
  sequence: 1,
  issuedAt: '2026-09-02T00:00:00.000Z',
  signingKey,
});
if (first.files.size !== second.files.size) {
  throw new Error('Official Catalog compile is not reproducible.');
}
for (const [path, bytes] of first.files) {
  const other = second.files.get(path);
  if (!other || !bytes.equals(other)) {
    throw new Error(`Official Catalog compile drifted at ${path}.`);
  }
}
if (plugins.some((plugin) => plugin.entry.pluginId === 'io.gian.fixture')) {
  throw new Error('Official Catalog source still contains the test fixture.');
}
console.log(`official Catalog source verified (${plugins.length} plugins, reproducible compile)`);
console.log('Publication remains an external gate: the pinned public key must correspond to a protected private key owned outside this repository.');
