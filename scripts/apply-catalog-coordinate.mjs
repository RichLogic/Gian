#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { proxyReleaseMetadata } from './proxy-release-metadata.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function applyCatalogCoordinate({ provider, coordinatePath, sourceRoot = join(rootDir, 'catalog/official-source') }) {
  const metadata = proxyReleaseMetadata(provider);
  const path = join(sourceRoot, 'plugins', metadata.pluginId, 'entry.json');
  const [entry, coordinate] = await Promise.all([
    readFile(path, 'utf8').then(JSON.parse),
    readFile(resolve(coordinatePath), 'utf8').then(JSON.parse),
  ]);
  if (coordinate.pluginVersion !== metadata.version) {
    throw new Error(`${provider} coordinate version does not match the shipping Proxy.`);
  }
  entry.channels.stable = coordinate;
  await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  return path;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') options.provider = argv[++index];
    else if (arg === '--coordinate') options.coordinatePath = argv[++index];
    else throw new Error(`Unknown Catalog apply argument ${arg}.`);
  }
  if (!options.provider || !options.coordinatePath) throw new Error('--provider and --coordinate are required.');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyCatalogCoordinate(parseArgs(process.argv.slice(2))).then(path => {
    console.log(`updated ${path}`);
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
