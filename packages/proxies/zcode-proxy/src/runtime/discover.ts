import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runBoundedCommand } from '@gian/proxy-protocol/node';

const SETUP_URL = 'https://zcode.z.ai';

export const ZCODE_CLI_CONFIG_READINESS_ISSUE = {
  code: 'zcode_cli_config_missing',
  message: 'ZCode model configuration is missing at ~/.zcode/cli/config.json. '
    + 'Configure an explicit model provider in ZCode, then retry. '
    + 'Gian will not create or modify this file.',
  repairable: true,
} as const;

export const ZCODE_BUILTIN_PROVIDER_CONFIG_READINESS_ISSUE = {
  code: 'zcode_builtin_provider_config_missing',
  message: 'ZCode builtin provider config (zcode-builtin.json) is not reachable from the CLI '
    + "entry's own lookup paths, so a standalone-spawned app-server exits at startup. "
    + 'ZCode.app 3.12.3 (2026-09-16) ships it under Contents/Resources/config/provider/, '
    + 'which the embedded CLI cannot resolve for bundle-path launches. '
    + 'Select a ZCode build whose standalone CLI works, or retry after ZCode fixes standalone '
    + 'embedding (Gian-Dev #163).',
  repairable: true,
} as const;

/** Mirror the embedded CLI's own bundled-config resolution
 * (`resolveBundledZCodeBuiltinProviderConfig` in zcode.cjs): next to the
 * entry, then five levels up plus config/provider. A file anywhere else is
 * invisible to a standalone spawn and the app-server exits at startup. */
export function builtinProviderConfigCandidates(entryPath: string): [string, string] {
  const dir = dirname(resolve(entryPath));
  return [
    join(dir, 'provider', 'zcode-builtin.json'),
    resolve(dir, '../../../../../config/provider/zcode-builtin.json'),
  ];
}

export async function locateBuiltinProviderConfig(entryPath: string): Promise<string | null> {
  for (const candidate of builtinProviderConfigCandidates(entryPath)) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Candidate absent; try the next lookup path.
    }
  }
  return null;
}

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
  if (await existsFile(user)) candidates.push({ path: user, source: 'official-user', label: 'ZCode.app' });
  if (await existsFile(system)) candidates.push({ path: system, source: 'official-system', label: 'ZCode.app' });
  return {
    candidates,
    setupActions: [
      { id: 'docs', kind: 'open_url', label: 'Open ZCode', url: SETUP_URL },
      { id: 'pick-binary', kind: 'select_file', label: 'Choose ZCode entry' },
    ],
  };
}

async function runVersion(path: string): Promise<string> {
  const result = await runBoundedCommand(process.execPath, [path, '--version'], { timeoutMs: 10_000 });
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
  // The builtin provider config gates startup itself: without it the
  // app-server exits before serving any request, so it outranks the
  // model-config check.
  if (await locateBuiltinProviderConfig(path) === null) {
    readinessIssue = { ...ZCODE_BUILTIN_PROVIDER_CONFIG_READINESS_ISSUE };
  } else {
    try {
      const info = await stat(configPath);
      if (!info.isFile()) readinessIssue = { ...ZCODE_CLI_CONFIG_READINESS_ISSUE };
    } catch {
      readinessIssue = { ...ZCODE_CLI_CONFIG_READINESS_ISSUE };
    }
  }
  return {
    runtimeId: 'zcode',
    displayName: 'ZCode Runtime',
    path,
    version,
    configHome,
    contentRoots: [{ path, mode: 'file' }],
    ...(readinessIssue ? { readinessIssue } : {}),
  };
}
