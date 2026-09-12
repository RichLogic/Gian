import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { proxyReleaseMetadata } from './proxy-release-metadata.mjs';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function prepareCatalogCoordinate({
  provider,
  artifactDir,
  repository = 'RichLogic/Gian',
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('repository must be an owner/name pair.');
  }
  const metadata = proxyReleaseMetadata(provider);
  const archivePath = resolve(artifactDir, metadata.asset);
  const manifestPath = `${archivePath}.manifest.json`;
  const [archive, manifest, archiveInfo, manifestInfo] = await Promise.all([
    readFile(archivePath),
    readFile(manifestPath),
    stat(archivePath),
    stat(manifestPath),
  ]);
  const base = `https://github.com/${repository}/releases/download/${metadata.tag}`;
  return {
    pluginVersion: metadata.version,
    manifest: {
      url: `${base}/${metadata.asset}.manifest.json`,
      sha256: digest(manifest),
      size: manifestInfo.size,
    },
    artifacts: {
      'darwin-arm64': {
        url: `${base}/${metadata.asset}`,
        sha256: digest(archive),
        size: archiveInfo.size,
      },
    },
  };
}

function parseArgs(argv) {
  const result = { repository: 'RichLogic/Gian', output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') result.provider = argv[++index];
    else if (arg === '--artifact-dir') result.artifactDir = argv[++index];
    else if (arg === '--repository') result.repository = argv[++index];
    else if (arg === '--output') result.output = argv[++index];
    else throw new Error(`Unknown Catalog coordinate argument ${arg}.`);
  }
  if (!result.provider) throw new Error('--provider is required.');
  if (!result.artifactDir) throw new Error('--artifact-dir is required.');
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const coordinate = await prepareCatalogCoordinate(options);
  const body = `${JSON.stringify(coordinate, null, 2)}\n`;
  if (options.output) await writeFile(resolve(options.output), body, 'utf8');
  else process.stdout.write(body);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
