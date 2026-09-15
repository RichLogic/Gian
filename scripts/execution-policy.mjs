import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertExecutionAllowed(kind, env = process.env) {
  const hosted = env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  if (kind === 'package') {
    if (!hosted) throw new Error('App packaging is restricted to GitHub-hosted CI. Download a CI artifact instead.');
  } else if (kind === 'desktop') {
    if (!hosted && env.GIAN_ALLOW_DESKTOP_E2E !== '1') {
      throw new Error('Desktop execution requires explicit user permission for this run (GIAN_ALLOW_DESKTOP_E2E=1).');
    }
  } else throw new Error(`Unknown execution policy: ${kind}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertExecutionAllowed(process.argv[2]);
}
