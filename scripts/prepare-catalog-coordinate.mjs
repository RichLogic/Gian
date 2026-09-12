import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { proxyReleaseMetadata } from './proxy-release-metadata.mjs';
import { validateProxyReleaseCertificate } from './verify-proxy-release-certificate.mjs';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('\\')
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function certifiedProvider(certificate, provider) {
  const packageCandidate = certificate.candidatePackages
    ?.find(candidate => candidate.provider === provider);
  const tuple = certificate.candidateTuple
    ?.find(candidate => candidate.provider === provider);
  if (!packageCandidate || !tuple) {
    throw new Error(`${provider} is absent from the certified candidate tuple.`);
  }
  return { packageCandidate, tuple };
}

export async function prepareCatalogCoordinate({
  provider,
  artifactDir,
  certificatePath,
  runtimeAsset = null,
  runtimeEntry = null,
  repository = 'RichLogic/Gian',
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('repository must be an owner/name pair.');
  }
  const metadata = proxyReleaseMetadata(provider);
  if (!certificatePath) throw new Error('certificatePath is required.');
  const archivePath = resolve(artifactDir, metadata.asset);
  const manifestPath = `${archivePath}.manifest.json`;
  const [archive, manifest, archiveInfo, manifestInfo, certificateBytes] = await Promise.all([
    readFile(archivePath),
    readFile(manifestPath),
    stat(archivePath),
    stat(manifestPath),
    readFile(resolve(certificatePath)),
  ]);
  const certificate = JSON.parse(certificateBytes.toString('utf8'));
  const certificateIssues = validateProxyReleaseCertificate(certificate, {
    revision: certificate.revision,
    provider,
    version: metadata.version,
  });
  if (certificateIssues.length > 0) {
    throw new Error(`Release certificate rejected:\n- ${certificateIssues.join('\n- ')}`);
  }
  const { packageCandidate, tuple } = certifiedProvider(certificate, provider);
  if (packageCandidate.pluginId !== metadata.pluginId
    || packageCandidate.runtime?.id !== metadata.runtime.id) {
    throw new Error(`${provider} certificate package identity differs from release metadata.`);
  }
  const archiveSha256 = digest(archive);
  if (archiveSha256 !== tuple.proxy.sha256) {
    throw new Error(`${provider} Proxy artifact differs from the certified candidate.`);
  }

  const base = `https://github.com/${repository}/releases/download/${metadata.tag}`;
  let runtime;
  if (metadata.runtime.distribution === 'external-app') {
    if (runtimeAsset || runtimeEntry) {
      throw new Error(`${provider} uses an external App Runtime and must not publish a CLI asset.`);
    }
    runtime = {
      kind: 'external-app',
      runtimeId: metadata.runtime.id,
      version: tuple.cli.version,
      artifactSha256: tuple.cli.sha256,
    };
  } else {
    if (!runtimeAsset) throw new Error('runtimeAsset is required for a managed CLI Runtime.');
    if (basename(runtimeAsset) !== runtimeAsset) {
      throw new Error('runtimeAsset must be a filename inside artifactDir.');
    }
    if (!canonicalRelativePath(runtimeEntry)) {
      throw new Error('runtimeEntry must be a canonical relative path.');
    }
    const runtimePath = resolve(artifactDir, runtimeAsset);
    const [runtimeBytes, runtimeInfo] = await Promise.all([
      readFile(runtimePath),
      stat(runtimePath),
    ]);
    const runtimeSha256 = digest(runtimeBytes);
    if (runtimeSha256 !== tuple.cli.sha256 || runtimeInfo.size !== tuple.cli.size) {
      throw new Error(`${provider} Runtime asset differs from the certified CLI candidate.`);
    }
    runtime = {
      kind: 'native-binary',
      runtimeId: metadata.runtime.id,
      version: tuple.cli.version,
      asset: {
        url: `${base}/${runtimeAsset}`,
        sha256: runtimeSha256,
        size: runtimeInfo.size,
      },
      entryRelativePath: runtimeEntry,
    };
  }
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
        sha256: archiveSha256,
        size: archiveInfo.size,
      },
    },
    combination: {
      generationId: `${metadata.id}-${metadata.version}-runtime-${tuple.cli.version}`,
      certificate: {
        id: certificate.certificateId,
        sha256: digest(certificateBytes),
      },
      runtime,
      companions: [],
    },
  };
}

function parseArgs(argv) {
  const result = {
    repository: 'RichLogic/Gian',
    output: null,
    certificatePath: null,
    runtimeAsset: null,
    runtimeEntry: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') result.provider = argv[++index];
    else if (arg === '--artifact-dir') result.artifactDir = argv[++index];
    else if (arg === '--certificate') result.certificatePath = argv[++index];
    else if (arg === '--runtime-asset') result.runtimeAsset = argv[++index];
    else if (arg === '--runtime-entry') result.runtimeEntry = argv[++index];
    else if (arg === '--repository') result.repository = argv[++index];
    else if (arg === '--output') result.output = argv[++index];
    else throw new Error(`Unknown Catalog coordinate argument ${arg}.`);
  }
  if (!result.provider) throw new Error('--provider is required.');
  if (!result.artifactDir) throw new Error('--artifact-dir is required.');
  if (!result.certificatePath) throw new Error('--certificate is required.');
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
