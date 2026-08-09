import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

export function validateDataDir(dataDir) {
  const resolved = resolve(dataDir);
  if (dirname(resolved) !== resolve(tmpdir()) || !resolved.startsWith(join(resolve(tmpdir()), 'gian-e2e-'))) {
    throw new Error(`refusing to clean non-E2E directory: ${resolved}`);
  }
  return resolved;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export async function cleanAfterParent({
  dataDir,
  parentPid,
  graceMs = 1_000,
  maxWaitMs = 60 * 60_000,
  pollMs = 250,
}) {
  const target = validateDataDir(dataDir);
  const deadline = Date.now() + maxWaitMs;
  while (processAlive(parentPid) && Date.now() < deadline) await delay(pollMs);
  if (processAlive(parentPid)) return false;
  await delay(graceMs);
  await rm(target, { recursive: true, force: true });
  return true;
}

async function main(args = process.argv.slice(2)) {
  const parentIndex = args.indexOf('--parent');
  const dataIndex = args.indexOf('--data-dir');
  const parentPid = Number(args[parentIndex + 1]);
  const dataDir = args[dataIndex + 1];
  if (parentIndex < 0 || dataIndex < 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0 || !dataDir) {
    throw new Error('usage: e2e-janitor.mjs --parent <pid> --data-dir <path>');
  }
  await cleanAfterParent({ dataDir, parentPid });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error('[e2e-janitor] cleanup failed', error);
    process.exitCode = 1;
  });
}
