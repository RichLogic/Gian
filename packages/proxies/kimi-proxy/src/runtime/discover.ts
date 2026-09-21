import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { runBoundedCommand } from '@gian/proxy-protocol/node';

import { KimiDataVersionError, KimiSessionStoreGuard } from './session-store.js';

const COMMAND = 'kimi';
const SETUP_URL = 'https://code.kimi.com/kimi-code/install.sh';

type KimiStoreMode = 'read-only' | 'activation';

interface KimiStoreDecision {
  version: string;
}

const activationMemo = new Map<string, Promise<void>>();

function firstVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

function homeDir(): string {
  return process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir();
}

function kimiCodeHome(): string {
  const configured = process.env.KIMI_CODE_HOME;
  return configured && isAbsolute(configured) ? configured : join(homeDir(), '.kimi-code');
}

async function existsExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverKimiRuntimes(): Promise<{
  candidates: Array<{ path: string; source: 'official-user' | 'official-system' | 'path'; label?: string }>;
  setupActions: Array<
    | { id: string; kind: 'open_url'; label: string; url: string }
    | { id: string; kind: 'select_file'; label: string }
  >;
}> {
  const home = homeDir();
  const seen = new Set<string>();
  const candidates: Array<{ path: string; source: 'official-user' | 'official-system' | 'path'; label?: string }> = [];
  const officialUser = join(kimiCodeHome(), 'bin', COMMAND);
  if (await existsExecutable(officialUser)) {
    seen.add(officialUser);
    candidates.push({ path: officialUser, source: 'official-user', label: 'Kimi Code' });
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory.trim()) continue;
    const path = resolve(directory, COMMAND);
    if (!isAbsolute(path) || seen.has(path) || !(await existsExecutable(path))) continue;
    seen.add(path);
    candidates.push({ path, source: 'path', label: 'Kimi Code' });
  }
  for (const official of [
    { path: join(home, '.local', 'bin', COMMAND), source: 'official-user' as const },
    { path: `/opt/homebrew/bin/${COMMAND}`, source: 'official-system' as const },
    { path: `/usr/local/bin/${COMMAND}`, source: 'official-system' as const },
  ]) {
    if (seen.has(official.path) || !(await existsExecutable(official.path))) continue;
    seen.add(official.path);
    candidates.push({ ...official, label: 'Kimi Code' });
  }
  return {
    candidates,
    setupActions: [
      { id: 'docs', kind: 'open_url', label: 'Install Kimi Code', url: SETUP_URL },
      { id: 'pick-binary', kind: 'select_file', label: 'Choose Kimi binary' },
    ],
  };
}

async function runVersion(path: string): Promise<string> {
  const result = await runBoundedCommand(path, ['--version'], {
    timeoutMs: 8_000,
    env: { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CODE_HOME: kimiCodeHome() },
  });
  const version = firstVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) throw new Error('`kimi --version` did not report a semantic version');
  return version;
}

function warnStoreGuard(message: string): void {
  console.error(`[kimi-proxy:session-store] ${message}`);
}

async function observeStoreOwnerVersion(
  selectedPath: string,
  candidateVersion: string,
  configHome: string,
): Promise<string | undefined> {
  const officialBinary = join(configHome, 'bin', COMMAND);
  const [candidateReal, officialReal] = await Promise.all([
    realpath(selectedPath),
    realpath(officialBinary),
  ]);
  return candidateReal === officialReal
    ? candidateVersion
    : await runVersion(officialBinary);
}

async function evaluateKimiStore(
  path: string,
  mode: KimiStoreMode,
): Promise<KimiStoreDecision> {
  if (!isAbsolute(path) || !(await existsExecutable(path))) {
    throw new KimiDataVersionError(
      'KIMI_ACTIVATION_UNPROBEABLE',
      'Selected Kimi binary is missing or not executable.',
    );
  }
  let version: string;
  try {
    version = await runVersion(path);
  } catch (error) {
    throw new KimiDataVersionError(
      'KIMI_ACTIVATION_UNPROBEABLE',
      error instanceof Error ? error.message : String(error),
    );
  }
  const configHome = kimiCodeHome();
  // The session-store guard is Gian's own bookkeeping. It still records the
  // activation floor and still detects store conditions, but it never blocks
  // a session: the CLI's own session/new or session/load verdict decides
  // (ADR-0080). Conditions are logged for observability only.
  try {
    const guard = new KimiSessionStoreGuard(configHome);
    const officialBinary = join(configHome, 'bin', COMMAND);
    let observedStoreOwnerVersion: string | undefined;
    if (await guard.hasSessionData()) {
      if (!(await existsExecutable(officialBinary))) {
        warnStoreGuard('Kimi session data exists, but the official KIMI_CODE_HOME binary is missing.');
      } else {
        try {
          observedStoreOwnerVersion = await observeStoreOwnerVersion(path, version, configHome);
        } catch (error) {
          warnStoreGuard(
            `Kimi session-store owner could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    for (const condition of await guard.evaluateCompatibility(version, observedStoreOwnerVersion)) {
      warnStoreGuard(`${condition.kind}: ${condition.message}`);
    }
    if (mode === 'activation') {
      try {
        await guard.recordActivation(version);
      } catch (error) {
        warnStoreGuard(
          `Kimi session-store floor could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    warnStoreGuard(
      `Kimi session-store guard failed and was ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { version };
}

export async function probeKimiRuntime(path: string): Promise<{
  runtimeId: string;
  displayName: string;
  path: string;
  version: string;
  configHome: string | null;
  contentRoots: Array<{ path: string; mode: 'file' | 'directory' }>;
}> {
  if (!isAbsolute(path)) throw new Error('Kimi runtime path must be absolute.');
  await access(path, constants.X_OK);
  const decision = await evaluateKimiStore(path, 'read-only');
  return {
    runtimeId: 'kimi',
    displayName: 'Kimi Code',
    path,
    version: decision.version,
    configHome: kimiCodeHome(),
    contentRoots: [{ path, mode: 'file' }],
  };
}

function activationKey(path: string): string {
  return `${kimiCodeHome()}\0${path}`;
}

export function resetKimiActivationMemoForTests(): void {
  activationMemo.clear();
}

export async function recordSelectedKimiActivation(path: string): Promise<void> {
  const key = activationKey(path);
  const pending = activationMemo.get(key);
  if (pending) return pending;
  const run = (async () => {
    try {
      await evaluateKimiStore(path, 'activation');
    } catch (error) {
      activationMemo.delete(key);
      throw error instanceof KimiDataVersionError
        ? error
        : new KimiDataVersionError(
          'KIMI_ACTIVATION_UNPROBEABLE',
          error instanceof Error ? error.message : String(error),
        );
    }
  })();
  activationMemo.set(key, run);
  await run;
}
