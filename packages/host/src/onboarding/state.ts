import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AgentInstallStatus,
  OnboardingState,
  OnboardingWorkspaceResult,
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

export function resolveOnboardingWorkspace(
  rawRoot: string,
  homeDir = homedir(),
): OnboardingWorkspaceResult {
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
  const workspaceRoot = compactHome(absolute, homeDir);
  return {
    workspaceRoot,
    workspaceDirectory: join(absolute, 'workspaces'),
  };
}

export function onboardingCompleted(db: Db): boolean {
  const row = db.prepare('SELECT value FROM config WHERE key = ?')
    .get(ONBOARDING_COMPLETED_KEY) as { value: string } | undefined;
  return row?.value === '1';
}

export async function saveOnboardingWorkspace(
  db: Db,
  rawRoot: string,
  homeDir = homedir(),
): Promise<OnboardingWorkspaceResult> {
  const paths = resolveOnboardingWorkspace(rawRoot, homeDir);
  const absoluteRoot = resolve(
    paths.workspaceRoot === '~'
      ? homeDir
      : paths.workspaceRoot.startsWith('~/')
        ? join(homeDir, paths.workspaceRoot.slice(2))
        : paths.workspaceRoot,
  );
  await mkdir(absoluteRoot, { recursive: true });
  await mkdir(paths.workspaceDirectory, { recursive: true });
  saveConfig(db, { workspace_root: paths.workspaceRoot });
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
  const paths = resolveOnboardingWorkspace(config.workspace_root || '~/Coding', homeDir);
  return {
    completed: onboardingCompleted(db),
    ...paths,
    agents,
  };
}
