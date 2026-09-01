#!/usr/bin/env node
/**
 * Explicit canary entrypoint: real ZCode app-server platform-compatibility
 * verification (NOT part of the default deterministic suite).
 *
 * Builds @gian/zcode-proxy, then runs the compiled canary
 * dist/test/real-app-server-lifecycle.canary.js via node --test.
 *
 * Behavior:
 *  - ZCode 0.16.5 present (default /Applications/ZCode.app path, or
 *    ZCODE_CJS override): session/create + session/read against the
 *    code-generated synthetic config in a throwaway HOME — no session/send,
 *    no provider request, no quota, no user data.
 *  - ZCode binary missing: the canary reports unavailable and SKIPS
 *    (honest not-executed; never a fake PASS).
 *
 * Catalog: test/catalog.json specialEntrypoint `zcode-real-app-server-canary`
 * (scope canary; purposes compatibility, regression; sideEffects
 * temporary-filesystem, child-process, platform-tool).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(rootDir, 'packages', 'proxies', 'zcode-proxy');
const canaryPath = join(packageDir, 'dist', 'test', 'real-app-server-lifecycle.canary.js');
const runtimeBin = process.env.ZCODE_CJS
  ?? '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    stdio: 'inherit',
    shell: false,
    ...(options.env ? { env: options.env } : {}),
  });
  if (result.status !== 0) {
    console.error(`[zcode-real-app-server-canary] ${label} exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log('[zcode-real-app-server-canary] building @gian/zcode-proxy…');
run('build', 'pnpm', ['run', '--filter', '@gian/zcode-proxy', 'build']);

if (!existsSync(canaryPath)) {
  console.error(`[zcode-real-app-server-canary] compiled canary missing: ${canaryPath}`);
  process.exit(1);
}

console.log(
  `[zcode-real-app-server-canary] runtime binary: ${runtimeBin} `
  + `(${existsSync(runtimeBin) ? 'present' : 'MISSING — the canary will report unavailable and skip'})`,
);
run('canary', process.execPath, ['--test', canaryPath], { cwd: packageDir });
