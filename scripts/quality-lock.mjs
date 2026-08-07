import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const QUALITY_LOCK_ENV = 'GIAN_QUALITY_LOCK_TOKEN';

function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function acquireQualityLock({
  command,
  env = process.env,
  isProcessAlive = processIsAlive,
  pid = process.pid,
  rootDir,
  token = randomUUID(),
}) {
  const qualityDir = join(rootDir, 'output', 'quality');
  const lockPath = join(qualityDir, '.gate.lock');
  const inheritedToken = env[QUALITY_LOCK_ENV]?.trim();
  mkdirSync(qualityDir, { recursive: true });

  if (inheritedToken) {
    const current = readLock(lockPath);
    if (current?.token !== inheritedToken) {
      throw new Error(`quality gate lock inheritance is invalid: ${lockPath}`);
    }
    return { lockPath, owner: false, release() {}, token: inheritedToken };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, 'wx');
      writeFileSync(descriptor, `${JSON.stringify({
        command,
        pid,
        startedAt: new Date().toISOString(),
        token,
      })}\n`);
      closeSync(descriptor);
      descriptor = undefined;

      return {
        lockPath,
        owner: true,
        token,
        release() {
          const current = readLock(lockPath);
          if (current?.token === token) unlinkSync(lockPath);
        },
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== 'EEXIST') throw error;

      const current = readLock(lockPath);
      if (!current || !Number.isInteger(current.pid)) {
        throw new Error(`quality gate lock is unreadable; inspect and remove ${lockPath}`);
      }
      if (isProcessAlive(current.pid)) {
        throw new Error(
          `quality gate already running: ${current.command} (pid ${current.pid}, since ${current.startedAt})`,
        );
      }
      unlinkSync(lockPath);
    }
  }

  throw new Error(`could not acquire quality gate lock: ${lockPath}`);
}
