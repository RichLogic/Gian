import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertProxySelfTest, assertRuntimeManifest, buildProxyBundle, canonicalRelativePath,
  copyManifestReference, proxyDefinitions } from './build-proxy-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function prepareDevProxyPackages(directory, sourceSha, options = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Dev inputs require a precise source SHA.');
  const proxies = [];
  for (const definition of proxyDefinitions) {
    assertRuntimeManifest(definition.manifest);
    const packageDir = join(directory, definition.directory);
    await mkdir(packageDir, { recursive: true });
    const entry = join(packageDir, 'proxy.mjs');
    await buildProxyBundle(options.sourceEntry?.(definition) ?? definition.sourceEntry, entry,
      { name: definition.packageName, version: definition.pluginVersion });
    await chmod(entry, 0o755);
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: definition.packageName, version: definition.pluginVersion, type: 'module', main: './proxy.mjs',
    }, null, 2) + '\n');
    for (const companion of definition.bundlePackages) {
      if (!/^[a-z][a-z0-9-]+$/.test(companion.directory ?? '')
        || !canonicalRelativePath(companion.path) || !Array.isArray(companion.files) || companion.files.length === 0) {
        throw new Error('Invalid Dev companion package metadata.');
      }
      for (const file of companion.files) {
        if (!canonicalRelativePath(file)) throw new Error('Invalid Dev companion file path.');
        await cp(join(root, 'packages/proxies', companion.directory, file),
          join(packageDir, companion.path, file), { recursive: true, errorOnExist: true, force: false });
      }
    }
    for (const ref of [...Object.values(definition.manifest.branding?.logo ?? {}),
      ...(definition.manifest.skills ?? [])].filter(Boolean)) {
      await copyManifestReference(definition, packageDir, ref);
    }
    const manifest = JSON.stringify(definition.manifest, null, 2) + '\n';
    await writeFile(join(packageDir, 'manifest.json'), manifest);
    await assertProxySelfTest(entry, definition.manifest);
    proxies.push({ pluginId: definition.pluginId, pluginVersion: definition.pluginVersion,
      directory: definition.directory, manifestSha256: createHash('sha256').update(manifest).digest('hex'),
      runtime: definition.manifest.runtime });
  }
  if (proxies.length === 0) throw new Error('A GianDev package cannot omit source Proxies.');
  return { sourceSha, proxies };
}
