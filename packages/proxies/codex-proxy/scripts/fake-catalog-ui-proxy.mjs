import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const manifest = require('../manifest.json');
process.env.GIAN_E2E_PROXY_VERSION = pkg.version;
process.env.GIAN_E2E_PROXY_SCOPE = manifest.process.scope;
process.env.GIAN_E2E_RUNTIME_ID = manifest.runtime.id;
process.env.GIAN_E2E_RUNTIME_NAME = manifest.runtime.displayName;
process.env.GIAN_E2E_RUNTIME_VERSION = manifest.runtime.verifiedVersions[0];

await import('../../../../scripts/fixtures/fake-catalog-ui-proxy.mjs');
