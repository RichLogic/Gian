import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { proxyDefinitions } from './build-proxy-artifacts.mjs';

/**
 * Exact external-App Runtime identities admitted by code review. These are not
 * downloadable Gian assets and hosted certification does not claim to execute
 * them. Host still discovers, hashes, and version-probes the local App before
 * activation.
 */
export const reviewedExternalRuntimeCandidates = Object.freeze({
  zcode: Object.freeze({
    source: 'reviewed-external-app',
    version: '0.16.5',
    sha256: 'e9f1868c0fdb863537ed910ee3828b9be96b8c2fd805473f63b439e1113266b8',
    size: 12615227,
    bundleEntry: 'Contents/Resources/glm/zcode.cjs',
  }),
});

export function proxyReleaseMetadata(releaseId) {
  const definition = proxyDefinitions.find(item => item.id === releaseId);
  if (!definition || !definition.shipping) {
    throw new Error(`Proxy ${String(releaseId)} is not in the shipping package set.`);
  }
  return {
    id: definition.id,
    pluginId: definition.pluginId,
    packageName: definition.packageName,
    version: definition.pluginVersion,
    processScope: definition.manifest.process.scope,
    runtime: {
      id: definition.runtime.id,
      verifiedVersions: [...definition.runtime.verifiedCliVersions],
      distribution: definition.pluginId === 'com.zhipu.zcode' ? 'external-app' : 'native-binary',
    },
    tag: `proxy-${definition.id}-v${definition.pluginVersion}`,
    asset: `gian-proxy-${definition.id}-${definition.pluginVersion}-darwin-arm64.tar.gz`,
  };
}

export function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--provider');
  const provider = index >= 0 ? argv[index + 1] : null;
  if (!provider) throw new Error('--provider is required.');
  process.stdout.write(`${JSON.stringify(proxyReleaseMetadata(provider))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
