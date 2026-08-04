import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AgentInstallStatus,
  OnboardingState,
  OnboardingProjectRootResult,
} from '@gian/shared';
import type { Db } from '../storage/db.js';
import { loadConfig, saveConfig } from '../storage/config.js';
import { expandHome } from '../workspace/index.js';

const ONBOARDING_COMPLETED_KEY = 'onboarding_completed';

function compactHome(path: string, homeDir: string): string {
  if (path === homeDir) return '~';
  return path.startsWith(`${homeDir}/`)
    ? `~/${path.slice(homeDir.length + 1)}`
    : path;
}

export function resolveOnboardingProjectRoot(
  rawRoot: string,
  homeDir = homedir(),
): OnboardingProjectRootResult {
  const trimmed = rawRoot.trim();
  if (!trimmed) throw new Error('Project directory is required.');
  const expanded = trimmed === '~'
    ? homeDir
    : trimmed.startsWith('~/')
      ? join(homeDir, trimmed.slice(2))
      : expandHome(trimmed);
  if (!isAbsolute(expanded)) {
    throw new Error('Project directory must be absolute or start with ~.');
  }
  const absolute = resolve(expanded);
  if (absolute === '/') throw new Error('Project directory cannot be the filesystem root.');
  return { projectRoot: compactHome(absolute, homeDir) };
}

export function onboardingCompleted(db: Db): boolean {
  const row = db.prepare('SELECT value FROM config WHERE key = ?')
    .get(ONBOARDING_COMPLETED_KEY) as { value: string } | undefined;
  return row?.value === '1';
}

export function hasReadyAgent(agents: AgentInstallStatus[]): boolean {
  return agents.some(agent => agent.ready);
}

export async function saveOnboardingProjectRoot(
  db: Db,
  rawRoot: string,
  homeDir = homedir(),
): Promise<OnboardingProjectRootResult> {
  const paths = resolveOnboardingProjectRoot(rawRoot, homeDir);
  const absoluteRoot = resolve(
    paths.projectRoot === '~'
      ? homeDir
      : paths.projectRoot.startsWith('~/')
        ? join(homeDir, paths.projectRoot.slice(2))
        : paths.projectRoot,
  );
  await mkdir(absoluteRoot, { recursive: true });
  saveConfig(db, { workspace_root: paths.projectRoot });
  return paths;
}

export function markOnboardingComplete(db: Db): void {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(ONBOARDING_COMPLETED_KEY, '1');
}

export function resetOnboarding(db: Db): void {
  db.prepare('DELETE FROM config WHERE key = ?').run(ONBOARDING_COMPLETED_KEY);
}

export async function buildOnboardingState(
  db: Db,
  agents: AgentInstallStatus[],
  homeDir = homedir(),
): Promise<OnboardingState> {
  const config = loadConfig(db);
  const paths = resolveOnboardingProjectRoot(config.workspace_root || '~/Coding', homeDir);
  return {
    completed: onboardingCompleted(db),
    ...paths,
    agents,
  };
}
