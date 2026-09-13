#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyCatalogBundleFiles } from '../packages/proxy-catalog-contract/dist/src/index.js';
import { officialCatalogSourcePolicy } from '../packages/shared/dist/index.js';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function collectFiles(root, directory = root, result = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Catalog bundle cannot contain symlinks.');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(root, path, result);
    else if (entry.isFile()) result.set(relative(root, path).split(sep).join('/'), await readFile(path));
    else throw new Error('Catalog bundle contains a special file.');
  }
  return result;
}

export async function stageOfficialCatalogRelease({ bundleDir, outputDir }) {
  const source = resolve(bundleDir);
  if (!(await lstat(source)).isDirectory()) throw new Error('Catalog bundle path is not a directory.');
  const files = await collectFiles(source);
  const policy = officialCatalogSourcePolicy();
  const index = verifyCatalogBundleFiles({
    files,
    pinnedPublicKeys: policy.pinnedPublicKeys,
    expectedSourceId: policy.sourceId,
  });
  const target = resolve(outputDir);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  const names = new Set();
  for (const [path, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    const name = path.replaceAll('/', '__');
    if (names.has(name)) throw new Error(`Catalog release asset collision: ${name}`);
    names.add(name);
    await writeFile(join(target, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  return { sequence: index.sequence, files: names.size };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--bundle') options.bundleDir = argv[++index];
    else if (arg === '--output') options.outputDir = argv[++index];
    else throw new Error(`Unknown Catalog staging argument ${arg}.`);
  }
  if (!options.bundleDir || !options.outputDir) throw new Error('--bundle and --output are required.');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageOfficialCatalogRelease(parseArgs(process.argv.slice(2))).then(result => {
    console.log(`staged Catalog sequence ${result.sequence} (${result.files} assets)`);
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
