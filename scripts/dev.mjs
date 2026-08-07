export {
  DEFAULT_GITHUB_CLIENT_ID,
  DEV_HOST_URL,
  DEV_WEB_URL,
  main,
  parseDevArguments,
  resolveDevEnvironment,
  resolveRuntimeIdentity,
  resolveRuntimePaths,
} from './dev-runtime.mjs';

import { fileURLToPath } from 'node:url';
import { main } from './dev-runtime.mjs';

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch(error => {
    console.error(`[gian-dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
