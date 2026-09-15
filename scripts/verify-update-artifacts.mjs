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

async function sha256Hex(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
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

export async function verifyGithubReleaseAssets({
  releaseDir,
  version,
  releaseJsonPath,
  productName = 'Gian',
  arch = 'arm64',
}) {
  if (!releaseJsonPath) throw new Error('releaseJsonPath is required');
  const directory = resolve(releaseDir);
  const expectedArtifactNames = [
    `${productName}-${version}-${arch}.dmg`,
    `${productName}-${version}-${arch}.dmg.blockmap`,
    `${productName}-${version}-${arch}.zip`,
    `${productName}-${version}-${arch}.zip.blockmap`,
    'latest-mac.yml',
  ];
  const expectedReleaseNames = [...expectedArtifactNames, 'SHA256SUMS'];

  const release = JSON.parse(await readFile(resolve(releaseJsonPath), 'utf8'));
  if (release.tagName !== `v${version}`) {
    throw new Error(`release tag ${release.tagName ?? '<missing>'} does not match v${version}`);
  }
  if (release.isDraft !== true) throw new Error('release must remain draft during verification');
  if (release.isPrerelease !== false) throw new Error('stable release draft must not be a prerelease');
  if (!Array.isArray(release.assets)) throw new Error('release assets must be an array');

  const assets = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset !== 'object' || typeof asset.name !== 'string') {
      throw new Error('release contains a malformed asset');
    }
    if (assets.has(asset.name)) throw new Error(`release contains duplicate asset ${asset.name}`);
    assets.set(asset.name, asset);
  }
  const actualNames = [...assets.keys()].sort();
  const expectedNames = [...expectedReleaseNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `release asset set mismatch: expected ${expectedNames.join(', ')}; got ${actualNames.join(', ')}`,
    );
  }

  const checksumLines = (await readFile(resolve(directory, 'SHA256SUMS'), 'utf8'))
    .split(/\r?\n/u)
    .filter(Boolean);
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})\s{2}([^/\\]+)$/u.exec(line);
    if (!match) throw new Error(`SHA256SUMS contains a malformed line: ${line}`);
    const [, digest, name] = match;
    if (checksums.has(name)) throw new Error(`SHA256SUMS contains duplicate ${name}`);
    checksums.set(name, digest);
  }
  const checksumNames = [...checksums.keys()].sort();
  const expectedChecksumNames = [...expectedArtifactNames].sort();
  if (JSON.stringify(checksumNames) !== JSON.stringify(expectedChecksumNames)) {
    throw new Error('SHA256SUMS must contain exactly the update artifacts and metadata');
  }

  const verified = [];
  for (const name of expectedReleaseNames) {
    const path = resolve(directory, name);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`release artifact is not a file: ${name}`);
    const digest = await sha256Hex(path);
    const asset = assets.get(name);
    if (asset.state !== 'uploaded') throw new Error(`release asset is not uploaded: ${name}`);
    if (asset.size !== metadata.size) {
      throw new Error(`release size mismatch for ${name}: remote=${asset.size} local=${metadata.size}`);
    }
    if (asset.digest !== `sha256:${digest}`) {
      throw new Error(`release digest mismatch for ${name}`);
    }
    if (name !== 'SHA256SUMS' && checksums.get(name) !== digest) {
      throw new Error(`SHA256SUMS digest mismatch for ${name}`);
    }
    verified.push({ name, size: metadata.size, sha256: digest });
  }

  return { tag: release.tagName, artifacts: verified };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (![
      '--release-dir',
      '--version',
      '--product-name',
      '--arch',
      '--manifest',
      '--github-release-json',
    ].includes(flag)) {
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
    if (flag === '--github-release-json') options.releaseJsonPath = value;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await verifyUpdateArtifacts(options);
  console.log(
    `verified ${result.manifest} for ${result.version}: ${result.artifacts
      .map(artifact => `${artifact.name} (${artifact.size} bytes)`)
      .join(', ')}`,
  );
  if (options.releaseJsonPath) {
    const release = await verifyGithubReleaseAssets(options);
    console.log(`verified draft ${release.tag}: ${release.artifacts.length} exact release assets`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`update artifact verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
