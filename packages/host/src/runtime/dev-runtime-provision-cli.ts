import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { readBundledDevRuntimeAsset } from './dev-runtime-assets.js';
import {
  bundledDevProxyDirectory,
  declarationsFromProxyDirectory,
  devRuntimeDataDirectory,
  devRuntimeDeclarationsForCoordinates,
  provisionDevRuntimes,
} from './dev-runtime-provision.js';

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a path.`);
  }
  return value;
}

const homeDir = homedir();
const assetsFlag = flagValue('--assets');
const proxiesFlag = flagValue('--proxies');
const assets = assetsFlag === undefined ? undefined : resolve(assetsFlag);
// Packaged layout is `<assets>/../proxies`. An explicit --proxies path wins.
// There is no source-checkout or PATH fallback.
const proxiesDir = proxiesFlag !== undefined
  ? resolve(proxiesFlag)
  : assets !== undefined
    ? bundledDevProxyDirectory(assets)
    : undefined;
const declarations = proxiesDir === undefined
  ? undefined
  : devRuntimeDeclarationsForCoordinates(await declarationsFromProxyDirectory(proxiesDir));
const installed = await provisionDevRuntimes({
  dataDir: devRuntimeDataDirectory(homeDir),
  homeDir,
  mode: 'giandev',
  ...(declarations ? { declarations } : {}),
  ...(assets ? { download: (asset) => readBundledDevRuntimeAsset(assets, asset) } : {}),
});
for (const runtime of installed) {
  console.log(`[gian] ${runtime.pluginId} ${runtime.version} ${runtime.entryPath}`);
}
