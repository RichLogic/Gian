import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { AntigravityRuntimeError } from './errors.js';

export const ANTIGRAVITY_RUNTIME_ID = 'antigravity-acp';
/**
 * Official ACP `initialize` `agentInfo.name`.
 * Probe treats any other name as a different peer, even at version 1.3.0.
 */
export const ANTIGRAVITY_AGENT_NAME = 'antigravity-acp';
/** Manifest Runtime displayName. Host RuntimeResolver requires this exact string. */
export const ANTIGRAVITY_RUNTIME_DISPLAY_NAME = 'Antigravity ACP Server';
/** Manifest plugin id. The plugin display name is `Antigravity`, not the Runtime display name. */
export const ANTIGRAVITY_PLUGIN_ID = 'io.gian.antigravity';
export const ANTIGRAVITY_PLUGIN_DISPLAY_NAME = 'Antigravity';
export const POSIX_SERVER_ENTRY = 'agy_acp_server.par';
export const WINDOWS_SERVER_ENTRY = 'agy_acp_server.exe';
export const PAIRED_HARNESS_ENTRY = 'localharness_external';

const POSIX_HARNESS_NAMES = [PAIRED_HARNESS_ENTRY, 'localharness'] as const;
const WINDOWS_HARNESS_NAMES = ['localharness_external.exe', 'localharness.exe'] as const;

export function serverBasenames(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform === 'win32') return [WINDOWS_SERVER_ENTRY, POSIX_SERVER_ENTRY];
  return [POSIX_SERVER_ENTRY];
}

export function harnessBasenames(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform === 'win32') return WINDOWS_HARNESS_NAMES;
  return POSIX_HARNESS_NAMES;
}

/**
 * Absolute path of the required harness file beside `serverPath`.
 * Official startup looks only in the server directory, `localharness_external`
 * before `localharness`. A symlink whose target leaves that directory is not
 * that required file.
 * Same-directory placement does not certify that the two files are one version.
 * Immutable byte identity belongs to the Host content fingerprint and the
 * managed artifact digest.
 */
export async function resolvePairedHarness(
  serverPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (!isAbsolute(serverPath)) {
    throw new AntigravityRuntimeError('Antigravity server path must be absolute.');
  }
  const directory = dirname(serverPath);
  const names = harnessBasenames(platform);
  for (const name of names) {
    const paired = await usablePairedFile(directory, join(directory, name));
    if (paired) return paired;
  }
  throw new AntigravityRuntimeError(
    `Required localharness file is not in ${directory}. Expected ${names.join(' or ')} beside the server.`,
  );
}

export async function tryResolvePairedHarness(
  serverPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  try {
    return await resolvePairedHarness(serverPath, platform);
  } catch (error) {
    if (error instanceof AntigravityRuntimeError) return null;
    throw error;
  }
}

export async function assertServerExecutable(serverPath: string): Promise<void> {
  if (!isAbsolute(serverPath) || serverPath.includes('\0')) {
    throw new AntigravityRuntimeError('Antigravity server path must be an absolute path.');
  }
  const info = await stat(serverPath);
  if (!info.isFile()) {
    throw new AntigravityRuntimeError('Antigravity server path is not a file.');
  }
  if (process.platform !== 'win32') {
    try {
      await access(serverPath, constants.X_OK);
    } catch {
      throw new AntigravityRuntimeError(`${serverPath} is not executable.`);
    }
  }
}

async function usablePairedFile(directory: string, candidate: string): Promise<string | null> {
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let resolved = candidate;
  if (info.isSymbolicLink()) {
    resolved = await realpath(candidate);
    const realDirectory = await realpath(directory);
    if (dirname(resolved) !== realDirectory) return null;
    info = await stat(resolved);
  }
  if (!info.isFile()) return null;
  if (process.platform !== 'win32') {
    try {
      await access(resolved, constants.X_OK);
    } catch {
      throw new AntigravityRuntimeError(`${resolved} is not executable.`);
    }
  }
  return resolved;
}
