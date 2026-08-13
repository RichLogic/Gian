import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function scalar(value, context) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${context} must not be empty`);
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${context} contains an invalid quoted value: ${error.message}`);
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) throw new Error(`${context} contains an invalid quoted value`);
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function setOnce(target, key, value, context) {
  if (target[key] !== undefined) throw new Error(`${context} contains duplicate ${key}`);
  target[key] = value;
}

/**
 * Parse only the deterministic subset emitted by electron-builder for
 * latest-mac.yml. Keeping this parser local avoids relying on a transitive
 * YAML package in the release trust boundary.
 */
export function parseLatestMacManifest(source) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('latest-mac.yml is empty');
  }
  if (source.includes('\t')) throw new Error('latest-mac.yml must not contain tabs');

  const manifest = { files: [] };
  let inFiles = false;
  let filesSeen = false;
  let currentFile;

  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const context = `latest-mac.yml line ${index + 1}`;

    if (indent === 0) {
      currentFile = undefined;
      const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
      if (!match) throw new Error(`${context} is malformed`);
      const [, key, rawValue = ''] = match;
      inFiles = key === 'files';
      if (inFiles) {
        if (filesSeen) throw new Error(`${context} contains duplicate files`);
        filesSeen = true;
        if (rawValue.trim()) throw new Error(`${context} must start a YAML list`);
        continue;
      }
      if (key === 'version' || key === 'path' || key === 'sha512') {
        setOnce(manifest, key, scalar(rawValue, `${context} ${key}`), context);
      }
      continue;
    }

    if (!inFiles) continue;
    if (indent === 2 && line.startsWith('- ')) {
      const match = /^-\s+url:\s*(.+)$/u.exec(line);
      if (!match) throw new Error(`${context} must start an artifact with url`);
      currentFile = {};
      setOnce(currentFile, 'url', scalar(match[1], `${context} url`), context);
      manifest.files.push(currentFile);
      continue;
    }
    if (indent >= 4 && currentFile) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/u.exec(line);
      if (!match) throw new Error(`${context} is malformed`);
      const [, key, rawValue] = match;
      if (key === 'url' || key === 'sha512') {
        setOnce(currentFile, key, scalar(rawValue, `${context} ${key}`), context);
      } else if (key === 'size') {
        const value = scalar(rawValue, `${context} ${key}`);
        if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${context} size must be positive`);
        const size = Number(value);
        if (!Number.isSafeInteger(size)) throw new Error(`${context} size is not a safe integer`);
        setOnce(currentFile, key, size, context);
      }
      continue;
    }
    throw new Error(`${context} is outside the expected files list shape`);
  }

  if (!manifest.version) throw new Error('latest-mac.yml is missing version');
  if (!manifest.path) throw new Error('latest-mac.yml is missing path');
  if (!manifest.sha512) throw new Error('latest-mac.yml is missing top-level sha512');
  if (manifest.files.length === 0) throw new Error('latest-mac.yml has no files');
  for (const file of manifest.files) {
    if (!file.url || !file.sha512 || !file.size) {
      throw new Error(`latest-mac.yml artifact ${file.url ?? '<unknown>'} is missing url, size, or sha512`);
    }
  }
  return manifest;
}

async function sha512Base64(path) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('base64');
}

export async function verifyUpdateArtifacts({
  releaseDir,
  version,
  productName = 'Gian',
  arch = 'arm64',
  manifestName = 'latest-mac.yml',
}) {
  if (!releaseDir) throw new Error('releaseDir is required');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? '')) {
    throw new Error(`invalid release version: ${version ?? '<missing>'}`);
  }
  if (manifestName !== basename(manifestName) || manifestName.includes('\\')) {
    throw new Error(`manifest must be a local basename: ${manifestName}`);
  }

  const directory = resolve(releaseDir);
  const manifestPath = resolve(directory, manifestName);
  const manifest = parseLatestMacManifest(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== version) {
    throw new Error(`manifest version ${manifest.version} does not match release version ${version}`);
  }

  const expectedNames = [
    `${productName}-${version}-${arch}.zip`,
    `${productName}-${version}-${arch}.dmg`,
  ];
  if (manifest.files.length !== expectedNames.length) {
    throw new Error(`manifest must contain exactly ${expectedNames.length} update artifacts`);
  }

  const entries = new Map();
  for (const entry of manifest.files) {
    if (entry.url !== basename(entry.url) || entry.url.includes('\\')) {
      throw new Error(`manifest artifact URL must be a local basename: ${entry.url}`);
    }
    if (entries.has(entry.url)) throw new Error(`manifest contains duplicate artifact URL: ${entry.url}`);
    entries.set(entry.url, entry);
  }

  for (const expectedName of expectedNames) {
    if (!entries.has(expectedName)) throw new Error(`manifest is missing expected artifact URL: ${expectedName}`);
  }
  const unexpected = [...entries.keys()].filter(name => !expectedNames.includes(name));
  if (unexpected.length > 0) throw new Error(`manifest contains unexpected artifact URL: ${unexpected.join(', ')}`);

  const zipName = expectedNames[0];
  if (manifest.path !== zipName) {
    throw new Error(`manifest path ${manifest.path} does not select expected ZIP ${zipName}`);
  }
  if (manifest.sha512 !== entries.get(zipName).sha512) {
    throw new Error('manifest top-level sha512 does not match the ZIP entry');
  }

  const verified = [];
  for (const expectedName of expectedNames) {
    const entry = entries.get(expectedName);
    const artifactPath = resolve(directory, expectedName);
    const metadata = await stat(artifactPath);
    if (!metadata.isFile()) throw new Error(`update artifact is not a file: ${expectedName}`);
    if (metadata.size !== entry.size) {
      throw new Error(`size mismatch for ${expectedName}: manifest=${entry.size} actual=${metadata.size}`);
    }
    const digest = await sha512Base64(artifactPath);
    if (digest !== entry.sha512) throw new Error(`sha512 mismatch for ${expectedName}`);
    verified.push({ name: expectedName, size: metadata.size, sha512: digest });
  }

  return { version, manifest: manifestName, artifacts: verified };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--release-dir', '--version', '--product-name', '--arch', '--manifest'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--release-dir') options.releaseDir = value;
    if (flag === '--version') options.version = value;
    if (flag === '--product-name') options.productName = value;
    if (flag === '--arch') options.arch = value;
    if (flag === '--manifest') options.manifestName = value;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await verifyUpdateArtifacts(parseArgs(argv));
  console.log(
    `verified ${result.manifest} for ${result.version}: ${result.artifacts
      .map(artifact => `${artifact.name} (${artifact.size} bytes)`)
      .join(', ')}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`update artifact verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
