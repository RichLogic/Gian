import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runBoundedCommand } from '@gian/proxy-protocol/node';
import source from './source.json' with { type: 'json' };

const SETUP_URL = 'https://github.com/zai-org/ZCode';

export const ZCODE_CLI_CONFIG_READINESS_ISSUE = {
  code: 'zcode_cli_config_missing',
  message: 'ZCode model configuration is missing. Configure a provider with the installed '
    + 'ZCode CLI (login/TUI), then retry. Gian does not create or modify provider credentials.',
  repairable: true,
} as const;

export const ZCODE_BUILTIN_PROVIDER_CONFIG_READINESS_ISSUE = {
  code: 'zcode_builtin_provider_config_missing',
  message: 'ZCode builtin provider config (zcode-builtin.json) is not reachable from the CLI '
    + "entry's own lookup paths, so a standalone-spawned app-server exits at startup. "
    + 'Reinstall the certified ZCode CLI Runtime package, including its provider directory.',
  repairable: true,
} as const;

export const ZCODE_SOURCE_READINESS_ISSUE = {
  code: 'zcode_runtime_source_mismatch',
  message: 'ZCode CLI Runtime does not match this Proxy\'s pinned Git source. Install the matching Runtime from Gian.',
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

export async function discoverZcodeRuntimes(): Promise<{
  candidates: Array<{ path: string; source: 'official-user' | 'official-system'; label?: string }>;
  setupActions: Array<
    | { id: string; kind: 'open_url'; label: string; url: string }
    | { id: string; kind: 'select_file'; label: string }
  >;
}> {
  // Host resolves its content-addressed managed installation. Do not silently
  // substitute an App bundle or a floating PATH installation for this source pin.
  return {
    candidates: [],
    setupActions: [
      { id: 'docs', kind: 'open_url', label: 'ZCode CLI source', url: SETUP_URL },
      { id: 'pick-binary', kind: 'select_file', label: 'Choose certified ZCode CLI entry' },
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
  const runtimeRoot = resolve(dirname(path), '..');
  let sourceMatches = false;
  try {
    const provenance: unknown = JSON.parse(await readFile(join(runtimeRoot, 'gian-source.json'), 'utf8'));
    sourceMatches = version === source.cliVersion && typeof provenance === 'object' && provenance !== null
      && Object.keys(provenance).length === Object.keys(source).length
      && Object.entries(source).every(([key, value]) => (provenance as Record<string, unknown>)[key] === value);
    const integration = JSON.parse(await readFile(join(runtimeRoot, 'gian-integration.json'), 'utf8')) as Record<string, unknown>;
    sourceMatches = sourceMatches && integration.schemaVersion === source.integrationVersion
      && integration.upstreamEntrypointSha256 === source.protocolEntrypointSha256
      && typeof integration.integratedEntrypointSha256 === 'string' && /^[a-f0-9]{64}$/.test(integration.integratedEntrypointSha256)
      && typeof integration.catalogProjectionSha256 === 'string' && /^[a-f0-9]{64}$/.test(integration.catalogProjectionSha256);
  } catch { sourceMatches = false; /* A manual/old App entry has no certified source provenance. */ }
  let readinessIssue: { code: string; message: string; repairable: boolean } | undefined;
  // The builtin provider config gates startup itself: without it the
  // app-server exits before serving any request, so it outranks the
  // model-config check.
  if (await locateBuiltinProviderConfig(path) === null) {
    readinessIssue = { ...ZCODE_BUILTIN_PROVIDER_CONFIG_READINESS_ISSUE };
  } else if (!sourceMatches) {
    readinessIssue = { ...ZCODE_SOURCE_READINESS_ISSUE };
  } else {
    const configPaths = [join(configHome, 'v2', 'provider_config.json'), join(configHome, 'cli', 'config.json')];
    const configured = await Promise.all(configPaths.map(configPath => stat(configPath).then(info => info.isFile(), () => false)));
    if (!configured.some(Boolean)) {
      readinessIssue = { ...ZCODE_CLI_CONFIG_READINESS_ISSUE };
    }
  }
  return {
    runtimeId: 'zcode',
    displayName: 'ZCode Runtime',
    path,
    version,
    configHome,
    contentRoots: sourceMatches ? [{ path: runtimeRoot, mode: 'directory' }] : [{ path, mode: 'file' }],
    ...(readinessIssue ? { readinessIssue } : {}),
  };
}
