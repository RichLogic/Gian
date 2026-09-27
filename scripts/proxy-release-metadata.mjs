import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { proxyDefinitions } from './build-proxy-artifacts.mjs';

import { zcodeRuntimeSource } from './zcode-runtime-source.mjs';

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
      distribution: 'native-binary',
      ...(definition.id === 'zcode' ? { source: zcodeRuntimeSource } : {}),
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
