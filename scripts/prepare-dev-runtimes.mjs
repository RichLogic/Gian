import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertExecutionAllowed } from './execution-policy.mjs';
import { prepareDevSourceRuntimeAssets } from './dev-runtime-source-assets.mjs';
import { prepareDevRuntimeAssets, readBundledDevRuntimeAsset } from '../packages/host/dist/runtime/dev-runtime-assets.js';
import { discoverDevelopmentProxyEntries } from '../packages/host/dist/runtime/development-proxy-source.js';
import { declarationsFromProxyEntries, provisionDevRuntimes, selectDevRuntimeCoordinates } from '../packages/host/dist/runtime/dev-runtime-provision.js';

assertExecutionAllowed(process.env.GIAN_ALLOW_LOCAL_DEV_PACKAGE === '1' ? 'dev-package-local' : 'package');
const [assetsDir, proxiesDir, verificationData] = process.argv.slice(2);
if (!assetsDir || !proxiesDir || !verificationData) throw new Error('Runtime preparation requires asset, Proxy and isolated verification directories.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entries = await discoverDevelopmentProxyEntries({ proxiesDir });
const declarations = await declarationsFromProxyEntries(entries);
const coordinates = selectDevRuntimeCoordinates(declarations);
if (coordinates.length === 0 || coordinates.length !== declarations.length) {
  throw new Error('Every source Proxy must have one pinned Runtime coordinate.');
}
const cache = join(root, '.gian-runtime', 'dev-runtime-asset-cache');
await prepareDevSourceRuntimeAssets({ root, coordinates, directory: cache,
  prepareAssets: prepareDevRuntimeAssets });
await prepareDevRuntimeAssets({ directory: cache, coordinates });
await mkdir(assetsDir, { recursive: true });
for (const coordinate of coordinates) {
  const name = `${coordinate.asset.sha256}.gz`;
  await copyFile(join(cache, name), join(assetsDir, name));
}
const installed = await provisionDevRuntimes({
  dataDir: verificationData, homeDir: homedir(), mode: 'isolated', declarations, coordinates,
  download: asset => readBundledDevRuntimeAsset(assetsDir, asset),
});
if (installed.length !== coordinates.length) throw new Error('Not all bundled Runtime CLIs passed installation and version validation.');
await writeFile(join(assetsDir, 'runtime-assets.json'), JSON.stringify({ schemaVersion: 1,
  runtimes: coordinates.map(item => ({ pluginId: item.pluginId, runtimeId: item.runtimeId,
    version: item.version, artifactSha256: item.asset.sha256, size: item.asset.size,
    ...(item.build ? { build: item.build } : {}) })),
}, null, 2) + '\n');
