import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Bridge package version. Compiled modules live in `dist/src/`, so this
 * resolves the bridge `package.json` rather than a workspace manifest.
 * Handshake defaults read this instead of a second hardcoded version.
 */
const manifest = require('../../package.json') as { version?: unknown };
if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
  throw new Error('@gian/dsh-bridge package.json is missing a version');
}

export const BRIDGE_PACKAGE_VERSION: string = manifest.version;
