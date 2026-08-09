import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const defaultGuardModule = join(
  rootDir,
  'packages/host/dist/runtime/kimi-session-store.js',
);

function firstVersion(text) {
  return text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

export async function runKimiStorePreflight(options = {}) {
  const kimiCodeHome = options.kimiCodeHome
    ?? process.env.KIMI_CODE_HOME
    ?? join(homedir(), '.kimi-code');
  if (!isAbsolute(kimiCodeHome)) {
    throw new Error('KIMI_CODE_HOME must be an absolute path.');
  }
  const binaryPath = options.binaryPath ?? join(kimiCodeHome, 'bin', 'kimi');
  if (!isAbsolute(binaryPath)) throw new Error('Kimi binary path must be absolute.');
  const run = options.execFileImpl ?? execFileAsync;
  const result = await run(binaryPath, ['--version'], {
    timeout: 8_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      KIMI_CODE_HOME: kimiCodeHome,
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    },
  });
  const version = firstVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.ok(version, '`kimi --version` did not report a semantic version.');

  const GuardClass = options.GuardClass
    ?? (await import(defaultGuardModule)).KimiSessionStoreGuard;
  const guard = new GuardClass(kimiCodeHome);
  const sessionDataPresent = await guard.hasSessionData();
  // This command always probes the official binary inside the same data root,
  // so its version is the only safe bootstrap when Gian has no prior marker.
  await guard.assertCompatible(version, version);

  return {
    protocolOnly: true,
    modelTurnSent: false,
    storeMutated: false,
    kimiCodeHome,
    binaryPath,
    candidateVersion: version,
    sessionDataPresent,
    compatible: true,
  };
}

export async function main() {
  const summary = await runKimiStorePreflight();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`Kimi session-store preflight failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
