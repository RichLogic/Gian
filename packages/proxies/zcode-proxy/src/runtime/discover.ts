import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runBoundedCommand } from '@gian/proxy-protocol/node';

const SETUP_URL = 'https://zcode.z.ai';

export const ZCODE_CLI_CONFIG_READINESS_ISSUE = {
  code: 'zcode_cli_config_missing',
  message: 'ZCode CLI model configuration is missing at ~/.zcode/cli/config.json. '
    + 'Configure an explicit model provider for ZCode CLI, then retry. '
    + 'Gian will not create or modify this file.',
  repairable: true,
} as const;

function firstVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

function homeDir(): string {
  return process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir();
}

async function existsFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverZcodeRuntimes(): Promise<{
  candidates: Array<{ path: string; source: 'official-user' | 'official-system'; label?: string }>;
  setupActions: Array<
    | { id: string; kind: 'open_url'; label: string; url: string }
    | { id: string; kind: 'select_file'; label: string }
  >;
}> {
  const home = homeDir();
  const candidates: Array<{ path: string; source: 'official-user' | 'official-system'; label?: string }> = [];
  const user = join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  const system = join('/Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  if (await existsFile(user)) candidates.push({ path: user, source: 'official-user', label: 'ZCode CLI' });
  if (await existsFile(system)) candidates.push({ path: system, source: 'official-system', label: 'ZCode CLI' });
  return {
    candidates,
    setupActions: [
      { id: 'docs', kind: 'open_url', label: 'Open ZCode', url: SETUP_URL },
      { id: 'pick-binary', kind: 'select_file', label: 'Choose ZCode entry' },
    ],
  };
}

async function runVersion(path: string): Promise<string> {
  const result = await runBoundedCommand(path, ['--version'], { timeoutMs: 10_000 });
  const version = firstVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) throw new Error('`zcode --version` did not report a semantic version');
  return version;
}

export async function probeZcodeRuntime(path: string): Promise<{
  runtimeId: string;
  displayName: string;
  path: string;
  version: string;
  configHome: string | null;
  contentRoots: Array<{ path: string; mode: 'file' | 'directory' }>;
  readinessIssue?: { code: string; message: string; repairable: boolean };
}> {
  if (!isAbsolute(path)) throw new Error('ZCode runtime path must be absolute.');
  await access(path, constants.X_OK);
  const version = await runVersion(path);
  const configHome = join(homeDir(), '.zcode');
  const configPath = join(configHome, 'cli', 'config.json');
  let readinessIssue: { code: string; message: string; repairable: boolean } | undefined;
  try {
    const info = await stat(configPath);
    if (!info.isFile()) readinessIssue = { ...ZCODE_CLI_CONFIG_READINESS_ISSUE };
  } catch {
    readinessIssue = { ...ZCODE_CLI_CONFIG_READINESS_ISSUE };
  }
  return {
    runtimeId: 'zcode',
    displayName: 'ZCode CLI',
    path,
    version,
    configHome,
    contentRoots: [{ path, mode: 'file' }],
    ...(readinessIssue ? { readinessIssue } : {}),
  };
}
