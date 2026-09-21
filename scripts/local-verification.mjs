import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertExecutionAllowed } from './execution-policy.mjs';
import { acquireQualityLock, QUALITY_LOCK_ENV } from './quality-lock.mjs';

export const LOCAL_VERIFICATION_TOKEN = 'GIAN_LOCAL_VERIFICATION_TOKEN';
export const LOCAL_VERIFICATION_ALLOW = 'GIAN_ALLOW_LOCAL_VERIFICATION';

export function isHostedVerification(env = process.env) {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
}

// Shared by all checkouts for the current OS user, not a worktree-local lock.
// Separate from preview/package's quality lock, so nested gates can coexist.
export function acquireLocalVerification(command, env = process.env, rootDir =
  join(tmpdir(), `gian-local-verification-${process.getuid?.() ?? 'user'}`)) {
  assertExecutionAllowed('verification', env);
  if (isHostedVerification(env)) return { env, release() {} };
  const lease = acquireQualityLock({
    command,
    rootDir,
    env: { ...env, [QUALITY_LOCK_ENV]: env[LOCAL_VERIFICATION_TOKEN] },
  });
  return {
    env: { ...env, [LOCAL_VERIFICATION_TOKEN]: lease.token },
    release: lease.release,
  };
}

// Synchronous runners only. Keep the lease until every child command returns.
export function withLocalVerification(command, run, env = process.env) {
  const lease = acquireLocalVerification(command, env);
  try { return run(lease.env); } finally { lease.release(); }
}

export function localNodeTestArgs(env) {
  return isHostedVerification(env) ? [] : ['--test-concurrency=1'];
}

export function localVitestArgs(env) {
  return isHostedVerification(env) ? [] : ['--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism'];
}
