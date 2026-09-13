#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileOfficialCatalogSource,
  writeCompiledCatalogBundle,
} from '../packages/proxy-catalog-contract/dist/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSourceRoot = join(root, 'catalog', 'official-source');

function requiredArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    console.error(`${name} is required for a reproducible Catalog compile.`);
    process.exit(2);
  }
  return process.argv[index + 1];
}

function optionalArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const pem = process.env.GIAN_CATALOG_SIGNING_KEY_PEM;
if (!pem) {
  console.error('GIAN_CATALOG_SIGNING_KEY_PEM is required. Production runtime must never generate a signing key.');
  process.exit(2);
}

const sequence = Number(requiredArg('--sequence'));
const issuedAt = requiredArg('--issued-at');
if (!Number.isSafeInteger(sequence) || sequence < 1) {
  console.error('--sequence must be a positive integer.');
  process.exit(2);
}
if (Number.isNaN(Date.parse(issuedAt))) {
  console.error('--issued-at must be an ISO-8601 timestamp.');
  process.exit(2);
}

const outDir = optionalArg('--out', join(root, 'catalog', 'official-source', 'dist'));
const sourceRoot = optionalArg('--source-root', defaultSourceRoot);
const bundle = await compileOfficialCatalogSource({
  sourceRoot,
  sequence,
  issuedAt,
  signingKey: {
    keyId: process.env.GIAN_CATALOG_KEY_ID || 'gian-official-catalog-2026-09',
    privateKey: pem,
  },
});
await writeCompiledCatalogBundle(outDir, bundle.files);
console.log(`wrote local Catalog bundle sequence ${sequence} to ${outDir}`);
console.log('GitHub publication is not authorized from this script.');
