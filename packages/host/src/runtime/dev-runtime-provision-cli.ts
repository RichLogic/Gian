import { homedir } from 'node:os';

import { devRuntimeDataDirectory, provisionDevRuntimes } from './dev-runtime-provision.js';
import { readBundledDevRuntimeAsset } from './dev-runtime-assets.js';

const homeDir = homedir();
const assetsIndex = process.argv.indexOf('--assets');
const assets = assetsIndex >= 0 ? process.argv[assetsIndex + 1] : undefined;
if (assetsIndex >= 0 && !assets) throw new Error('--assets requires a Runtime asset directory.');
const installed = await provisionDevRuntimes({
  dataDir: devRuntimeDataDirectory(homeDir),
  homeDir,
  mode: 'giandev',
  ...(assets ? { download: asset => readBundledDevRuntimeAsset(assets, asset) } : {}),
});
for (const runtime of installed) {
  console.log(`[gian] ${runtime.pluginId} ${runtime.version} ${runtime.entryPath}`);
}
