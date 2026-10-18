import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import {
  runtimeDiscoverResultSchema,
  runtimeProbeResultSchema,
  type RuntimeDiscoverResult,
  type RuntimeProbeResult,
} from '@gian/proxy-protocol';

import { AntigravityAcpClient } from './acp-client.js';
import { AntigravityRuntimeError } from './errors.js';
import { resolveGeminiHome } from './home.js';
import {
  ANTIGRAVITY_AGENT_NAME,
  ANTIGRAVITY_RUNTIME_DISPLAY_NAME,
  ANTIGRAVITY_RUNTIME_ID,
  assertServerExecutable,
  resolvePairedHarness,
  serverBasenames,
  tryResolvePairedHarness,
} from './layout.js';

const SETUP_URL = 'https://antigravity.google/docs/ide/extensions/zed/';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PROBE_STARTUP_TIMEOUT_MS = 15_000;
const PROBE_GRACEFUL_STOP_MS = 1_000;

export type RuntimeCandidateSource = 'official-user' | 'official-system' | 'path';

export function candidateSource(directory: string, home: string): RuntimeCandidateSource {
  if (directory === join(home, '.local', 'bin')) return 'official-user';
  if (directory === '/opt/homebrew/bin' || directory === '/usr/local/bin') return 'official-system';
  return 'path';
}

/**
 * Explicit extracted server/harness pairs. A server is a candidate only when
 * its paired harness is in the same directory. Host-managed installations
 * use the exact provisioned path, not this PATH discovery list.
 */
export async function discoverAntigravityRuntimes(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeDiscoverResult> {
  const home = absoluteHome(env);
  const seen = new Set<string>();
  const candidates: RuntimeDiscoverResult['candidates'] = [];
  for (const directory of searchDirectories(env, home)) {
    for (const name of serverBasenames()) {
      const path = resolve(directory, name);
      if (!isAbsolute(path) || seen.has(path)) continue;
      if (!(await pairedServer(path))) continue;
      seen.add(path);
      candidates.push({
        path,
        source: candidateSource(directory, home),
        label: ANTIGRAVITY_RUNTIME_DISPLAY_NAME,
      });
      if (candidates.length === 32) break;
    }
    if (candidates.length === 32) break;
  }
  return runtimeDiscoverResultSchema.parse({
    candidates,
    setupActions: [
      { id: 'docs', kind: 'open_url', label: 'Antigravity ACP server', url: SETUP_URL },
      { id: 'pick-server', kind: 'select_file', label: 'Choose extracted ACP server' },
    ],
  });
}

/**
 * Validates the server file and the sibling harness, then performs one bounded
 * ACP `initialize`. The peer must report `agentInfo.name` `antigravity-acp`.
 * Another protocol-compatible executable is not this Runtime, even at 1.3.0.
 * It does not call `--version`, authenticate, or open a session.
 */
export async function probeAntigravityRuntime(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeProbeResult> {
  if (!isAbsolute(path)) {
    throw new AntigravityRuntimeError('Antigravity runtime path must be absolute.');
  }
  await assertServerExecutable(path);
  const harnessPath = await resolvePairedHarness(path);
  const client = new AntigravityAcpClient({
    binaryPath: path,
    cwd: dirname(path),
    env,
    startupTimeoutMs: PROBE_STARTUP_TIMEOUT_MS,
    gracefulStopMs: PROBE_GRACEFUL_STOP_MS,
  });
  try {
    const initialized = await client.ensureStarted();
    const agentName = initialized.agentInfo?.name;
    if (agentName !== ANTIGRAVITY_AGENT_NAME) {
      throw new AntigravityRuntimeError(
        `Antigravity ACP initialize reported agentInfo.name ${JSON.stringify(agentName ?? null)}; expected ${ANTIGRAVITY_AGENT_NAME}.`,
      );
    }
    const version = initialized.agentInfo?.version;
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      throw new AntigravityRuntimeError('Antigravity ACP initialize did not report a SemVer agentInfo.version.');
    }
    return runtimeProbeResultSchema.parse({
      runtimeId: ANTIGRAVITY_RUNTIME_ID,
      displayName: ANTIGRAVITY_RUNTIME_DISPLAY_NAME,
      path,
      version,
      configHome: resolveGeminiHome(env),
      contentRoots: [
        { path, mode: 'file' },
        { path: harnessPath, mode: 'file' },
      ],
    });
  } finally {
    await client.stop();
  }
}

async function pairedServer(path: string): Promise<boolean> {
  try {
    await assertServerExecutable(path);
  } catch (error) {
    if (error instanceof AntigravityRuntimeError) return false;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
  return (await tryResolvePairedHarness(path)) !== null;
}

function searchDirectories(env: NodeJS.ProcessEnv, home: string): string[] {
  const directories = [join(home, '.local', 'bin')];
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry.trim() === '') continue;
    directories.push(resolve(entry));
  }
  return [...new Set(directories)];
}

function absoluteHome(env: NodeJS.ProcessEnv): string {
  if (typeof env.HOME === 'string' && isAbsolute(env.HOME)) return env.HOME;
  return homedir();
}
