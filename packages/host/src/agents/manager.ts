import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  HostProtocolValidator,
  PROTOCOL_NAME,
  PROTOCOL_V2,
  PROTOCOL_V22,
  SUPPORTED_PROTOCOL_VERSIONS,
  manifestSchema,
  protocolRangeIncludes,
  type ManifestV2,
  type ManifestV3,
  type ManifestV4,
} from '@gian/proxy-protocol';
import type {
  AgentCliStatus,
  AgentInstallResult,
  AgentInstallStatus,
  AgentProxyDefaults,
  AgentProxyStatus,
  AgentProxyUpdateCheck,
  AgentHomeBinding,
  Executor,
  ProductExecutor,
  ProxyCatalogEntry,
  OpenRuntimeProfile,
  UserAgent,
  UserAgentStatus,
  LegacyExecutorId,
} from '@gian/shared';
import {
  isExecutorId,
  isProductExecutor,
  migrateLegacyGrokProxyDefaults,
  parseProxyPluginId,
  pluginIdForExecutorId,
  PRODUCT_EXECUTORS,
  productExecutorForPluginId,
  resolvePluginIdInput,
} from '@gian/shared';
import type { CatalogService } from '../catalog/service.js';
import { runNoRuntimeActivationHandshake } from '../plugin-store/initialize.js';
import { PluginStoreError } from '../plugin-store/errors.js';
import { isGenericRuntimeProtocol } from '../runtime/launch-mode.js';
import { openRuntimeIdentity, RuntimeResolver, RuntimeResolverError } from '../runtime/resolver.js';
import type { PluginStore } from '../plugin-store/store.js';
import { RuntimeReadinessCache } from '../runtime/readiness-cache.js';
import { ManagedRuntimeGenerationStore } from '../runtime/generation-store.js';
import { assertSavedAbsoluteRuntimePath } from '../runtime/saved-path.js';
import {
  launchFromPluginStore,
  loadDevelopmentTrustedLaunch,
  toOfficialPresence,
  TrustedLaunchError,
  validateStaticProxyPackage,
  type OfficialPresence,
  type TrustedLaunch,
} from '../runtime/trusted-launch.js';
import { runProtectedProxyChild, writeJsonRpc } from '../proxy/protected-handshake.js';
import { shutdownProxyProcess } from '../proxy/process-shutdown.js';
import {
  inspectManagedGianSkill,
  reconcileManagedGianSkill,
  type ManagedSkillResult,
  type ManagedSkillSource,
} from './managed-skill.js';
import {
  acquireAgentProxyUpdateLock,
  acquireAgentRuntimeUseLock,
  acquireAgentUpdateLock,
  type AgentUpdateLease,
} from './update-lock.js';
import { AgentHomeError, AgentHomeManager, providerRuntimeEnvironment } from './home.js';

const execFileAsync = promisify(execFile);
const CONFIG_FILE = 'agents.json';
const CONFIG_LOCK_AGENT_ID = '__agent-config__';
const PROXY_ENTRY = 'proxy.mjs';
const MAX_PROXY_BYTES = 64 * 1024 * 1024;
const MAX_PROXY_MANIFEST_BYTES = 64 * 1024;
const MAX_PROXY_LOGO_BYTES = 512 * 1024;
const MAX_PROXY_SKILL_BYTES = 512 * 1024;
const PROXY_SELF_TEST_TIMEOUT_MS = 5_000;
const PROXY_COMPATIBILITY_TIMEOUT_MS = 30_000;
const STATUS_CACHE_TTL_MS = 30_000;
const OFFICIAL_RUNTIME_IDS: Record<LegacyExecutorId, string> = {
  claude: 'claude',
  codex: 'codex',
  kimi: 'kimi',
  grok: 'grok',
  dsh: 'deepseek-harness',
  zcode: 'zcode',
};

const OFFICIAL_RUNTIME_DISPLAY: Record<LegacyExecutorId, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  kimi: 'Kimi Code',
  grok: 'Grok CLI',
  dsh: 'DeepSeek Harness',
  zcode: 'ZCode Runtime',
};

const VERIFIED_CLI_VERSIONS: Record<LegacyExecutorId, string[]> = {
  claude: ['2.1.159'],
  codex: ['0.146.0'],
  // Only the CLI version with a completed real regression of the ACP
  // terminal capability; 0.31.1 never ran that regression (plan §0.8).
  kimi: ['0.38.0'],
  grok: ['1.0.4'],
  // Resolved from the official npm latest dist-tag at install/probe time;
  // this value is only a diagnostic fallback (plan §0).
  dsh: ['0.1.1-rc.2'],
  // WP0-verified exact version (Revision 2 §1.3: precise SemVer only).
  zcode: ['0.16.5'],
};

interface AgentDefinition {
  id: LegacyExecutorId;
  name: string;
  command: string;
  installerUrl: string;
  installerSha256: string;
  officialPaths: (home: string) => string[];
}

interface AgentConfigFileV1 {
  schemaVersion: 1;
  cliPaths: Partial<Record<LegacyExecutorId, string>>;
  proxyDefaults: Partial<Record<LegacyExecutorId, AgentProxyDefaults>>;
}

/** agents.json schema v5: Agents are user entities keyed by uuid with an
 *  open pluginId. Official kind catalog metadata is not persisted here. */
interface AgentConfigFile {
  schemaVersion: 5;
  agents: UserAgent[];
}

interface LegacyProxyManifest {
  schemaVersion: 1;
  id: LegacyExecutorId;
  version: string;
  entry: typeof PROXY_ENTRY;
}

type ManagedProxyManifestV2 = Omit<ManifestV2, 'id'> & { id: LegacyExecutorId };
type ManagedProxyManifestV3 = Omit<ManifestV3, 'id'> & { id: LegacyExecutorId };
type ManagedProxyManifestV4 = Omit<ManifestV4, 'id'> & { id: LegacyExecutorId };
type ManagedProxyManifest = ManagedProxyManifestV2 | ManagedProxyManifestV3 | ManagedProxyManifestV4;
type ProxyManifest = LegacyProxyManifest | ManagedProxyManifest;
type ProxyWireProtocol = 'legacy' | typeof PROTOCOL_NAME;

interface LegacyRuntimeProbe {
  cli: Executor;
  binaryPath: string;
  version: string;
  source: 'override';
  env: Readonly<Record<string, string>>;
}

export interface ProxyLaunchDescriptor {
  entryPath: string;
  protocol?: {
    pluginVersion: string;
    processScope: ManagedProxyManifestV2['process']['scope'];
    schemaVersion?: 2 | 3 | 4;
    runtimeBootstrap?: boolean;
    runtimeId?: string;
    runtimeDisplayName?: string;
  };
}

export interface AgentManagerOptions {
  dataDir: string;
  releaseVersion: string;
  releaseRepository?: string;
  managedProxies: boolean;
  /** Production release channel for independently tagged Proxy plugins.
   * Kept opt-in so older release fixtures can still exercise schema v1. */
  independentProxyReleases?: boolean;
  /** GianDev-only trusted entries keyed by canonical pluginId (legacy aliases
   * are accepted during migration). Production packages come from PluginStore. */
  developmentProxyEntries?: Readonly<Record<string, string>>;
  environmentCliPaths?: Partial<Record<LegacyExecutorId, string>>;
  homeDir?: string;
  kimiCodeHome?: string;
  pathEnv?: string;
  fetchImpl?: typeof fetch;
  /** Test/release-audit override for the reviewed official installer pin. */
  officialInstallerSha256?: Partial<Record<LegacyExecutorId, string>>;
  /** One-time migration source for defaults previously stored in SystemConfig. */
  legacyProxyDefaults?: Partial<Record<LegacyExecutorId, Partial<AgentProxyDefaults>>>;
  /** v2 migration source: executors that appear in existing sessions. A kind
   *  with no configured path, no installed Proxy, and no session history does
   *  NOT get an auto-created Agent. */
  sessionExecutors?: () => Executor[] | Promise<Executor[]>;
  /** Test override for the production initialize + capabilities handshake.
   * Omitted in production so the candidate process and resolved vendor CLI
   * must complete the real stdio protocol before activation. */
  proxyActivationProbe?: (input: {
    id: LegacyExecutorId;
    version: string;
    entryPath: string;
    protocol: ProxyWireProtocol;
    processScope?: ManagedProxyManifestV2['process']['scope'];
    schemaVersion?: 2 | 3 | 4;
  }) => Promise<void>;
  /** Test seam for the single atomic activation commit. Production always
   * uses fs.rename; a rejection proves the prior pointer remains untouched. */
  proxyActivationSwap?: (temporary: string, current: string) => Promise<void>;
  /** Internal test seam for proving an already-empty compatibility process
   * never re-enters a signalling shutdown path. */
  shutdownProxyProcessImpl?: typeof shutdownProxyProcess;
  /** DSH home the bridge-managed `gian` profile is installed under. */
  dshHome?: string;
  /** Absolute directory containing the @gian/dsh-bridge package. */
  dshBridgePackageDir?: string;
  /** npm executable override (test seam for the DSH runtime installer). */
  npmPath?: string;
  /** npm registry URL override (test seam for the DSH runtime installer). */
  dshRegistry?: string;
  /** Generic RuntimeResolver. Official status/selection prefers this path. */
  runtimeResolver?: RuntimeResolver;
  /** Trusted Catalog packages for open pluginId Agents. */
  pluginStore?: PluginStore;
  /** Last explicit probe snapshot used by Catalog projection. */
  readinessCache?: RuntimeReadinessCache;
  /** Host Catalog authorization for create_agent. */
  catalogService?: CatalogService;
  /** Test seam. Production v4 create requires CatalogService. */
  allowCreateWithoutCatalog?: boolean;
  /** Certified global Runtime generations. Production constructs one store
   * below dataDir; tests may inject an initialized store. */
  generationStore?: ManagedRuntimeGenerationStore;
}

const AGENTS: Record<LegacyExecutorId, AgentDefinition> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    installerUrl: 'https://claude.ai/install.sh',
    // Reviewed 2026-08-08. The pinned bootstrap verifies the downloaded
    // platform binary against Anthropic's version manifest before execution.
    installerSha256: 'cde4f1702d3b1695f92b73d26888364e17bca476e17f0fd676484c951d36c125',
    officialPaths: home => [
      join(home, '.local', 'bin', 'claude'),
      join(home, '.claude', 'local', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ],
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    installerUrl: 'https://chatgpt.com/codex/install.sh',
    // Reviewed 2026-08-08. The pinned bootstrap verifies both the official
    // release digest and codex-package_SHA256SUMS before activation.
    installerSha256: 'ba92dd27e5c06f0d3bbc58bfa4b9cfb6599cd2742fbb1f92a2765e6c07dedb5a',
    officialPaths: home => [
      join(home, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ],
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi Code',
    command: 'kimi',
    installerUrl: 'https://code.kimi.com/kimi-code/install.sh',
    // Reviewed 2026-08-08. The pinned bootstrap verifies the selected binary
    // against Kimi's versioned manifest before installation.
    installerSha256: '638927825e96825edbb563de5e0cb06f8a0551c53e026ade8b717b0f25cb83d2',
    officialPaths: home => [
      join(home, '.kimi-code', 'bin', 'kimi'),
      join(home, '.local', 'bin', 'kimi'),
      '/opt/homebrew/bin/kimi',
      '/usr/local/bin/kimi',
    ],
  },
  grok: {
    id: 'grok',
    name: 'Grok Build',
    command: 'grok',
    installerUrl: 'https://x.ai/cli/install.sh',
    installerSha256: '43d0943123edade1383a476a4f778674877acee7c1f98a00f094c4a0f7349321',
    officialPaths: home => [
      join(home, '.grok', 'bin', 'grok'),
      join(home, '.local', 'bin', 'grok'),
      '/opt/homebrew/bin/grok',
      '/usr/local/bin/grok',
    ],
  },
  dsh: {
    id: 'dsh',
    name: 'DeepSeek Harness',
    command: 'dsh',
    // DSH has no shell installer; it resolves from the official npm registry
    // (plan §3.1). The URL documents the package entry for the settings
    // surface while Runtime setup is owned by the Proxy Manifest contract.
    installerUrl: 'https://www.npmjs.com/package/@deepseek-ai/dsh',
    installerSha256: '',
    officialPaths: home => [
      join(home, '.dsh', 'bin', 'dsh'),
      join(home, '.local', 'bin', 'dsh'),
      '/opt/homebrew/bin/dsh',
      '/usr/local/bin/dsh',
    ],
  },
  zcode: {
    id: 'zcode',
    name: 'ZCode',
    command: 'zcode',
    // ZCode ships only inside the ZCode.app bundle (Revision 2 §4.1); the
    // URL documents the official download page for the settings surface.
    // Gian never downloads, installs, mirrors, or upgrades ZCode.
    installerUrl: 'https://zcode.z.ai',
    installerSha256: '',
    officialPaths: home => [
      join('/Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
      join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
    ],
  },
};

function emptyConfig(): AgentConfigFile {
  return { schemaVersion: 5, agents: [] };
}

function officialKinds(...values: Array<ProductExecutor | null | undefined>): ProductExecutor[] {
  return [...new Set(values.filter((value): value is ProductExecutor => isProductExecutor(value)))];
}

export class PluginIdImmutableError extends Error {
  readonly code = 'PLUGIN_ID_IMMUTABLE';
  constructor() {
    super("A saved Agent's pluginId cannot change");
    this.name = 'PluginIdImmutableError';
  }
}

/** A missing/unreadable agents.json migrates from "empty v1" so the
 *  environment-CLI / installed-Proxy / session-history sources still produce
 *  the user's first default Agents. */
function emptyConfigV1(): AgentConfigFileV1 {
  return { schemaVersion: 1, cliPaths: {}, proxyDefaults: {} };
}

function emptyProxyDefaults(): AgentProxyDefaults {
  return { model: '', thinking: '', mode: '' };
}

function normalizeProxyDefaults(value: unknown): AgentProxyDefaults {
  const record = value && typeof value === 'object'
    ? value as Partial<Record<keyof AgentProxyDefaults, unknown>>
    : {};
  return {
    model: typeof record.model === 'string' ? record.model.trim() : '',
    thinking: typeof record.thinking === 'string' ? record.thinking.trim() : '',
    mode: typeof record.mode === 'string' ? record.mode.trim() : '',
  };
}

export function normalizeAgentName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Error thrown when a create/rename collides with a saved Agent name
 *  (case-insensitive, after trim). Routes map the code to 409. */
export class AgentNameTakenError extends Error {
  readonly code = 'AGENT_NAME_TAKEN';
  constructor(name: string) {
    super(`Agent name is already taken: ${name}`);
    this.name = 'AgentNameTakenError';
  }
}

export class AgentCreateError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409;

  constructor(code: string, message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = 'AgentCreateError';
    this.code = code;
    this.status = status;
  }
}

function normalizeCliPathInput(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isAbsolute(trimmed)) throw new Error('CLI path must be absolute');
  return trimmed;
}

function assertAgentNameAvailable(
  agents: readonly UserAgent[],
  name: string,
  excludeId?: string,
): void {
  const key = name.toLowerCase();
  if (agents.some(agent => agent.id !== excludeId && agent.name.toLowerCase() === key)) {
    throw new AgentNameTakenError(name);
  }
}

const PROXY_TAGLINES: Record<ProductExecutor, string> = {
  claude: 'Anthropic Claude Code agent',
  codex: 'OpenAI Codex agent',
  kimi: 'Moonshot Kimi Code agent',
  dsh: 'DeepSeek Harness agent',
  zcode: 'Z.ai ZCode coding agent',
};

function persistableAgent(agent: UserAgent): UserAgent {
  return {
    id: agent.id,
    name: agent.name,
    pluginId: agent.pluginId,
    proxy: agent.proxy,
    home: agent.home ? { ...agent.home } : null,
    cliPath: agent.cliPath,
    defaults: { ...agent.defaults },
  };
}

/** Lenient read-side normalization of one persisted Agent. Returns null for
 *  entries that cannot identify a usable Agent at all (bad id/name/pluginId). */
function normalizeUserAgent(value: unknown): UserAgent | null {
  const record = objectRecord(value);
  if (!record) return null;
  const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
  const name = normalizeAgentName(record['name']);
  const pluginId = resolvePluginIdInput(record['pluginId'])
    ?? resolvePluginIdInput(record['proxy']);
  if (!id || !name || !pluginId) return null;
  const cliPath = typeof record['cliPath'] === 'string' && isAbsolute(record['cliPath'])
    ? record['cliPath']
    : null;
  const rawHome = objectRecord(record['home']);
  const home = rawHome
    && (rawHome['kind'] === 'managed' || rawHome['kind'] === 'custom')
    && typeof rawHome['path'] === 'string'
    && isAbsolute(rawHome['path'])
    ? { kind: rawHome['kind'], path: rawHome['path'] } as AgentHomeBinding
    : null;
  return persistableAgent({
    id,
    name,
    pluginId,
    proxy: productExecutorForPluginId(pluginId),
    home,
    cliPath,
    defaults: normalizeProxyDefaults(record['defaults']),
  });
}

function parseConfigV2(parsed: { agents?: unknown }): AgentConfigFile {
  const agents: UserAgent[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const candidate of Array.isArray(parsed.agents) ? parsed.agents : []) {
    const agent = normalizeUserAgent(candidate);
    if (!agent || seenIds.has(agent.id)) continue;
    const nameKey = agent.name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenIds.add(agent.id);
    seenNames.add(nameKey);
    agents.push(agent);
  }
  return { schemaVersion: 5, agents };
}

function parseConfigV1(parsed: Partial<AgentConfigFileV1>): AgentConfigFileV1 {
  const cliPaths: Partial<Record<LegacyExecutorId, string>> = {};
  const proxyDefaults: Partial<Record<LegacyExecutorId, AgentProxyDefaults>> = {};
  for (const id of Object.keys(AGENTS) as LegacyExecutorId[]) {
    const path = parsed.cliPaths?.[id];
    if (typeof path === 'string' && isAbsolute(path)) cliPaths[id] = path;
    if (parsed.proxyDefaults?.[id]) {
      proxyDefaults[id] = normalizeProxyDefaults(parsed.proxyDefaults[id]);
    }
  }
  return { schemaVersion: 1, cliPaths, proxyDefaults };
}

function parseConfig(raw: string): AgentConfigFile | AgentConfigFileV1 {
  const parsed = JSON.parse(raw) as { schemaVersion?: unknown };
  return parsed?.schemaVersion === 2 || parsed?.schemaVersion === 3
    || parsed?.schemaVersion === 4 || parsed?.schemaVersion === 5
    ? parseConfigV2(parsed as { agents?: unknown })
    : parseConfigV1(parsed as Partial<AgentConfigFileV1>);
}

function safeReleaseValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[0-9A-Za-z._-]+$/.test(trimmed)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return trimmed;
}

function isLegacyProxyManifest(manifest: ProxyManifest): manifest is LegacyProxyManifest {
  return manifest.schemaVersion === 1;
}

function proxyManifestVersion(manifest: ProxyManifest): string {
  return isLegacyProxyManifest(manifest) ? manifest.version : manifest.pluginVersion;
}

export function verifiedCliVersionsFromManifest(
  manifest: ProxyManifest | null | undefined,
  id: LegacyExecutorId,
): string[] {
  if (manifest && !isLegacyProxyManifest(manifest) && manifest.runtime) {
    if (manifest.schemaVersion === 4) {
      if (manifest.runtime.kind === 'external' && manifest.runtime.verifiedVersions.length > 0) {
        return [...manifest.runtime.verifiedVersions];
      }
    } else {
      const verified = manifest.runtime.verifiedCliVersions;
      if (verified && verified.length > 0) return [...verified];
      const recommended = manifest.runtime.recommendedCliVersion;
      if (typeof recommended === 'string' && recommended.length > 0) return [recommended];
    }
  }
  return isExecutorId(id) ? [...VERIFIED_CLI_VERSIONS[id]] : [];
}

export function recommendedCliVersionFromManifest(
  manifest: ProxyManifest | null | undefined,
  id: LegacyExecutorId,
): string {
  return verifiedCliVersionsFromManifest(manifest, id)[0]!;
}

function proxyManifestProtocol(manifest: ProxyManifest): ProxyWireProtocol {
  return isLegacyProxyManifest(manifest) ? 'legacy' : manifest.protocol.name;
}

function isCompatibleProxyManifest(
  manifest: ProxyManifest,
  _releaseVersion: string,
): boolean {
  if (isLegacyProxyManifest(manifest)) return false;
  if (SUPPORTED_PROTOCOL_VERSIONS.some(version => (
    protocolRangeIncludes(manifest.protocol.range, version)
  ))) {
    return true;
  }
  return manifest.schemaVersion === 4
    && protocolRangeIncludes(manifest.protocol.range, PROTOCOL_V22);
}

function normalizeRepository(value: string): string {
  const trimmed = value.trim();
  if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(trimmed)) {
    throw new Error('release repository must use owner/name format');
  }
  return trimmed;
}


async function pluginVersionFromEntry(entryPath: string): Promise<string> {
  let dir = dirname(entryPath);
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (
        typeof pkg.version === 'string'
        && typeof pkg.name === 'string'
        && pkg.name.startsWith('@gian/')
        && pkg.name.endsWith('-proxy')
      ) {
        return pkg.version;
      }
    } catch {
      // Keep walking toward the package root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not resolve pluginVersion from ${entryPath}`);
}

async function pluginPackageDirectoryFromEntry(entryPath: string): Promise<string> {
  let dir = dirname(entryPath);
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (
        typeof pkg.name === 'string'
        && pkg.name.startsWith('@gian/')
        && pkg.name.endsWith('-proxy')
      ) return dir;
    } catch {
      // Keep walking toward the package root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not resolve Proxy package from ${entryPath}`);
}

/** Parse the checksum for one exact immutable release asset. Accepting an
 * unrelated 64-hex token from the checksum body could verify the archive
 * against the wrong line in a multi-asset manifest. */
export function parseArtifactChecksum(raw: string, filename: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})[ \t]+[* ]?([^\s]+)[ \t]*$/.exec(line);
    if (match?.[2] === filename) return match[1]!.toLowerCase();
  }
  throw new Error(`Proxy checksum does not contain the expected asset: ${filename}`);
}

export function assertOfficialInstallerIntegrity(
  script: Buffer,
  expectedSha256: string,
): void {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('Official installer integrity pin is invalid.');
  }
  const actual = createHash('sha256').update(script).digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(
      'The official installer changed and has not been reviewed by this Gian release. '
      + 'Install it manually from the official URL or update Gian before retrying.',
    );
  }
}

export function parseReleaseAssetDigests(
  value: unknown,
  expectedTag: string,
  filenames: readonly string[],
): ReadonlyMap<string, string> {
  const release = objectRecord(value);
  if (release?.['tag_name'] !== expectedTag || !Array.isArray(release['assets'])) {
    throw new Error(`GitHub release integrity metadata is invalid for ${expectedTag}.`);
  }
  const required = new Set(filenames);
  const digests = new Map<string, string>();
  for (const candidate of release['assets']) {
    const asset = objectRecord(candidate);
    const name = asset?.['name'];
    const digest = asset?.['digest'];
    if (typeof name !== 'string' || !required.has(name)) continue;
    if (digests.has(name)) {
      throw new Error(`GitHub release contains duplicate integrity metadata for ${name}.`);
    }
    if (typeof digest !== 'string' || !/^sha256:[0-9a-fA-F]{64}$/.test(digest)) {
      throw new Error(`GitHub release omitted the SHA-256 digest for ${name}.`);
    }
    digests.set(name, digest.slice('sha256:'.length).toLowerCase());
  }
  for (const filename of filenames) {
    if (!digests.has(filename)) {
      throw new Error(`GitHub release omitted integrity metadata for ${filename}.`);
    }
  }
  return digests;
}

interface ProxyRelease {
  tag: string;
  version: string;
}

interface ProxyReleaseCandidate extends ProxyRelease {
  metadata: Record<string, unknown>;
  semver: ParsedSemver;
}

interface ParsedSemver {
  core: [number, number, number];
  prerelease: Array<number | string>;
}

function parseSemver(value: string): ParsedSemver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]
      ? match[4].split('.').map(part => /^\d+$/.test(part) ? Number(part) : part)
      : [],
  };
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index]! - right.core[index]!;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      return leftPart - rightPart;
    }
    if (typeof leftPart === 'number') return -1;
    if (typeof rightPart === 'number') return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function parseIndependentProxyReleaseCandidates(
  value: unknown,
  id: LegacyExecutorId,
): ProxyReleaseCandidate[] {
  if (!Array.isArray(value)) {
    throw new Error('GitHub Proxy release listing is invalid.');
  }
  const prefix = `proxy-${id}-v`;
  const candidates: ProxyReleaseCandidate[] = [];
  for (const candidate of value) {
    const release = objectRecord(candidate);
    if (!release) continue;
    const tag = release['tag_name'];
    if (
      typeof tag !== 'string'
      || !tag.startsWith(prefix)
      || release['draft'] === true
      || release['prerelease'] === true
    ) continue;
    const version = tag.slice(prefix.length);
    const semver = parseSemver(version);
    if (!semver || semver.prerelease.length > 0) continue;
    candidates.push({ tag, version, metadata: release, semver });
  }
  candidates.sort((left, right) => compareSemver(right.semver, left.semver));
  if (candidates.length === 0) {
    throw new Error(`No stable independent ${id} Proxy release was found.`);
  }
  return candidates;
}

export function parseIndependentProxyRelease(
  value: unknown,
  id: LegacyExecutorId,
): ProxyRelease {
  const selected = parseIndependentProxyReleaseCandidates(value, id)[0]!;
  return { tag: selected.tag, version: selected.version };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Product executor alias to Gian plugin id. `dsh` maps to the reverse-domain
 * `ai.deepseek.harness` required by the integration plan; every other executor
 * keeps its short id. Managed Manifest identity must match initialize.
 */
export function pluginIdFor(id: LegacyExecutorId): string {
  if (!isExecutorId(id)) throw new Error(`unsupported legacy executor: ${id}`);
  return pluginIdForExecutorId(id);
}

function validateProxyInitialize(id: LegacyExecutorId, value: unknown): void {
  const result = objectRecord(value);
  const protocol = objectRecord(result?.['protocol']);
  const plugin = objectRecord(result?.['plugin']);
  const process = objectRecord(result?.['process']);
  if (
    !result
    || protocol?.['name'] !== PROTOCOL_NAME
    || !SUPPORTED_PROTOCOL_VERSIONS.some(version => protocol?.['version'] === version)
    || typeof plugin?.['id'] !== 'string'
    || plugin['id'] !== pluginIdFor(id)
    || typeof plugin?.['version'] !== 'string'
    || (process?.['scope'] !== 'shared' && process?.['scope'] !== 'session')
  ) {
    throw new Error(`${id} Proxy initialize handshake is incompatible.`);
  }
}

async function existsReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export class AgentManager {
  private readonly configPath: string;
  private readonly homeDir: string;
  private readonly agentHomes: AgentHomeManager;
  private readonly kimiCodeHome: string;
  private readonly fetchImpl: typeof fetch;
  private readonly releaseVersion: string;
  private readonly releaseRepository: string;
  private readonly operations = new Map<string, Promise<AgentInstallResult>>();
  private readonly statusCache = new Map<Executor, { value: AgentInstallStatus; expiresAt: number }>();
  private readonly statusProbes = new Map<Executor, {
    generation: number;
    promise: Promise<AgentInstallStatus>;
  }>();
  private readonly statusGenerations = new Map<Executor, number>();
  private readonly agentStatusCache = new Map<string, { value: UserAgentStatus; expiresAt: number }>();
  private readonly agentStatusProbes = new Map<string, {
    generation: number;
    promise: Promise<UserAgentStatus>;
  }>();
  private readonly agentStatusGenerations = new Map<string, number>();
  private readonly lastOpenRuntimeProfiles = new Map<string, OpenRuntimeProfile>();
  private configMutationTail: Promise<void> = Promise.resolve();
  private config: AgentConfigFile = emptyConfig();

  private constructor(private readonly options: AgentManagerOptions) {
    this.configPath = join(options.dataDir, CONFIG_FILE);
    this.homeDir = options.homeDir ?? homedir();
    this.agentHomes = new AgentHomeManager(options.dataDir);
    this.kimiCodeHome = options.kimiCodeHome
      ?? process.env.KIMI_CODE_HOME
      ?? join(this.homeDir, '.kimi-code');
    if (!isAbsolute(this.kimiCodeHome)) {
      throw new Error('KIMI_CODE_HOME must be an absolute path.');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.releaseVersion = safeReleaseValue(options.releaseVersion, 'release version');
    this.releaseRepository = normalizeRepository(
      options.releaseRepository ?? 'RichLogic/Gian',
    );
  }

  static async create(options: AgentManagerOptions): Promise<AgentManager> {
    const generationStore = options.generationStore
      ?? new ManagedRuntimeGenerationStore(options.dataDir);
    await generationStore.initialize();
    await generationStore.recoverFreshActivations();
    const manager = new AgentManager({
      ...options,
      generationStore,
      readinessCache: options.readinessCache
        ?? (options.runtimeResolver ? new RuntimeReadinessCache() : undefined),
    });
    await mkdir(options.dataDir, { recursive: true });
    let persisted: AgentConfigFile | AgentConfigFileV1;
    let needsSave = false;
    try {
      const raw = await readFile(manager.configPath, 'utf8');
      const source = JSON.parse(raw) as { schemaVersion?: unknown };
      needsSave = source.schemaVersion !== 5;
      persisted = parseConfig(raw);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      persisted = emptyConfigV1();
    }
    if (persisted.schemaVersion === 5) {
      manager.config = persisted;
      if (needsSave) await manager.saveConfig();
    } else {
      manager.config = await manager.migrateV1(persisted);
      await manager.saveConfig();
    }
    await manager.ensureAgentHomes();
    await manager.migrateDshManagedPath();
    return manager;
  }

  private async ensureAgentHomes(): Promise<void> {
    let changed = false;
    const agents: UserAgent[] = [];
    const used: Array<{ agentId: string; path: string }> = [];
    for (const current of this.config.agents) {
      let home: AgentHomeBinding | null;
      if (!this.agentHomes.supports(current.pluginId)) {
        home = null;
      } else if (current.home?.kind === 'custom') {
        home = await this.agentHomes.validateCustom(current.home.path, used, current.id);
      } else {
        home = await this.agentHomes.createManaged(current.pluginId, current.id);
      }
      if (JSON.stringify(home) !== JSON.stringify(current.home ?? null)) changed = true;
      if (home) used.push({ agentId: current.id, path: home.path });
      agents.push(persistableAgent({ ...current, home }));
    }
    if (!changed) return;
    await this.saveConfig({ schemaVersion: 5, agents });
    this.config = { schemaVersion: 5, agents };
  }

  /** One-time migration of a former Gian-managed DSH current path onto Agent.cliPath. */
  private async migrateDshManagedPath(): Promise<void> {
    if (this.options.managedProxies) return;
    const current = join(this.options.dataDir, 'runtimes', 'deepseek-harness', 'current');
    let migrated: string | null = null;
    try {
      const target = await realpath(current);
      const binary = join(target, 'node_modules', '.bin', 'dsh');
      await assertSavedAbsoluteRuntimePath(binary);
      migrated = binary;
    } catch {
      return;
    }
    const next = this.config.agents.map((agent) => (
      agent.proxy === 'dsh' && agent.cliPath === null
        ? persistableAgent({ ...agent, cliPath: migrated })
        : agent
    ));
    if (next.every((agent, index) => agent.cliPath === this.config.agents[index]?.cliPath)) return;
    await this.saveConfig({ schemaVersion: 5, agents: next });
    this.config = { schemaVersion: 5, agents: next };
  }

  /** v1 → v2 migration. Each PRODUCT kind gets at most one default Agent,
   *  sourced from (first hit wins for the path): v1 cliPaths, the environment
   *  CLI override; the Agent is created when any of these hold: a path/defaults
   *  were configured, a Proxy is installed, or the kind appears in existing
   *  sessions. Kinds the user never touched get NO Agent — no setup-required
   *  empty rows migrate. Grok is out of the product catalog and never migrates. */
  private async migrateV1(v1: AgentConfigFileV1): Promise<AgentConfigFile> {
    const sessionExecutors = new Set(
      (await this.options.sessionExecutors?.() ?? []).filter(isProductExecutor),
    );
    const agents: UserAgent[] = [];
    for (const kind of PRODUCT_EXECUTORS) {
      const envPath = this.options.environmentCliPaths?.[kind];
      const legacyPath = v1.cliPaths[kind]
        ?? (!this.options.managedProxies && typeof envPath === 'string' && isAbsolute(envPath)
          ? envPath
          : null)
        ?? null;
      const cliPath = this.options.managedProxies ? null : legacyPath;
      const legacy = this.options.legacyProxyDefaults?.[kind];
      const defaults = v1.proxyDefaults[kind]
        ?? (legacy ? normalizeProxyDefaults(legacy) : emptyProxyDefaults());
      const configured = legacyPath !== null
        || defaults.model !== '' || defaults.thinking !== '' || defaults.mode !== '';
      if (
        !configured
        && !await this.hasInstalledProxy(kind)
        && !sessionExecutors.has(kind)
      ) {
        continue;
      }
      agents.push({
        id: randomUUID(),
        name: AGENTS[kind].name,
        pluginId: pluginIdForExecutorId(kind),
        proxy: kind,
        cliPath,
        defaults,
      });
    }
    return { schemaVersion: 5, agents };
  }

  private async hasInstalledProxy(id: ProductExecutor): Promise<boolean> {
    // Development proxy entries are the vendored in-tree packages, not a
    // user installation — they carry no signal for the v2 migration.
    if (!this.options.managedProxies) return false;
    try {
      await lstat(join(this.options.dataDir, 'plugins', id, 'current'));
      return true;
    } catch {
      return false;
    }
  }

  setRuntimeResolver(resolver: RuntimeResolver): void {
    this.options.runtimeResolver = resolver;
  }

  setPluginStore(store: PluginStore): void {
    this.options.pluginStore = store;
  }

  setReadinessCache(cache: RuntimeReadinessCache): void {
    this.options.readinessCache = cache;
  }

  setCatalogService(service: CatalogService): void {
    this.options.catalogService = service;
  }

  async officialPresence(pluginId: string): Promise<OfficialPresence | null> {
    if (this.options.managedProxies && this.options.pluginStore) {
      const installed = await this.options.pluginStore.inspect(pluginId);
      const current = installed.versions.find(item => item.version === installed.currentVersion);
      // Receipt-owned packages are Catalog installations. A validated
      // pre-PluginStore official directory stays on the bounded legacy path;
      // never fabricate a receipt or let Catalog overwrite it in place.
      if (current?.state !== 'legacy') return null;
    }
    const launch = await this.trustedLaunch(pluginId);
    return launch ? toOfficialPresence(launch) : null;
  }

  async trustedLaunch(pluginId: string): Promise<TrustedLaunch | null> {
    const installed = await this.options.pluginStore?.currentLaunch(pluginId);
    if (installed) return launchFromPluginStore(installed);
    const official = productExecutorForPluginId(pluginId) ?? (
      isProductExecutor(pluginId) ? pluginId : null
    );
    if (!official) {
      return null;
    }
    return this.trustedOfficialLaunch(official);
  }

  /** Resolve a version named only by pre-binding Session data. New exact
   * Sessions use resolveExactTrustedLaunch with a required Manifest digest. */
  async trustedLaunchVersion(
    pluginId: string,
    pluginVersion: string | null,
  ): Promise<TrustedLaunch | null> {
    if (!pluginVersion) return this.trustedLaunch(pluginId);
    const installed = await this.options.pluginStore?.inspect(pluginId);
    const receipt = installed?.versions.find(item => (
      item.version === pluginVersion && item.state === 'valid'
    ))?.receipt;
    if (receipt) {
      const exact = await this.options.pluginStore!.resolveExactLaunch({
        pluginId,
        pluginVersion,
        expectedManifestSha256: receipt.manifestSha256,
      });
      return launchFromPluginStore(exact);
    }
    const official = productExecutorForPluginId(pluginId) ?? (
      isProductExecutor(pluginId) ? pluginId : null
    );
    if (!official) return null;
    if (this.options.managedProxies) {
      try {
        return await validateStaticProxyPackage({
          directory: join(this.options.dataDir, 'plugins', official, pluginVersion),
          expectedId: pluginIdForExecutorId(official),
          expectedVersion: pluginVersion,
          source: 'official-managed',
        });
      } catch {
        return null;
      }
    }
    const current = await this.trustedOfficialLaunch(official);
    return current?.pluginVersion === pluginVersion ? current : null;
  }

  async resolveExactTrustedLaunch(input: {
    pluginId: string;
    pluginVersion: string;
    expectedManifestSha256: string;
  }): Promise<TrustedLaunch> {
    const official = productExecutorForPluginId(input.pluginId) ?? (
      isProductExecutor(input.pluginId) ? input.pluginId : null
    );
    if (!official) {
      const exact = await this.options.pluginStore?.resolveExactLaunch(input);
      if (!exact) {
        throw new TrustedLaunchError(
          'TRUSTED_LAUNCH_PACKAGE',
          `Exact package ${input.pluginId}@${input.pluginVersion} is not installed.`,
        );
      }
      return {
        pluginId: exact.pluginId,
        pluginVersion: exact.pluginVersion,
        manifestSha256: exact.manifestSha256,
        protocolRange: exact.protocolRange,
        entryPath: exact.entryPath,
        processScope: exact.processScope,
        schemaVersion: 4,
        runtime: exact.runtime.kind === 'none'
          ? { kind: 'none' }
          : {
            kind: 'external',
            id: exact.runtime.id,
            displayName: exact.runtime.displayName,
            verifiedVersions: exact.runtime.verifiedVersions,
          },
        source: 'plugin-store',
      };
    }
    if (this.options.managedProxies) {
      try {
        const directory = join(this.options.dataDir, 'plugins', official, input.pluginVersion);
        const launch = await validateStaticProxyPackage({
          directory,
          expectedId: pluginIdForExecutorId(official),
          expectedVersion: input.pluginVersion,
          source: 'official-managed',
        });
        if (launch.manifestSha256 !== input.expectedManifestSha256) {
          throw new TrustedLaunchError(
            'TRUSTED_LAUNCH_DIGEST',
            'Retained official package digest does not match the Session binding.',
          );
        }
        return launch;
      } catch (error) {
        if (error instanceof TrustedLaunchError) throw error;
        throw new TrustedLaunchError(
          'TRUSTED_LAUNCH_PACKAGE',
          `Retained official package ${input.pluginId}@${input.pluginVersion} is unavailable.`,
        );
      }
    }
    const current = await this.trustedOfficialLaunch(official);
    if (
      !current
      || current.pluginVersion !== input.pluginVersion
      || current.manifestSha256 !== input.expectedManifestSha256
    ) {
      throw new TrustedLaunchError(
        'DEVELOPMENT_BINDING_UNAVAILABLE',
        'GianDev can only reattach the current in-tree Manifest generation.',
      );
    }
    return current;
  }

  private async trustedOfficialLaunch(id: LegacyExecutorId): Promise<TrustedLaunch | null> {
    const expectedId = pluginIdForExecutorId(id);
    if (this.options.managedProxies) {
      try {
        const agentRoot = join(this.options.dataDir, 'plugins', id);
        const current = await realpath(join(agentRoot, 'current'));
        const contained = await this.assertDirectProxyDirectory(agentRoot, current);
        return await validateStaticProxyPackage({
          directory: contained,
          expectedId,
          expectedVersion: basename(contained),
          source: 'official-managed',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return null;
        }
      }
    }
    const entry = this.options.developmentProxyEntries?.[expectedId]
      ?? this.options.developmentProxyEntries?.[id];
    if (!entry) return null;
    try {
      return await loadDevelopmentTrustedLaunch(entry, expectedId);
    } catch {
      return null;
    }
  }

  updateLockDataDir(): string {
    return this.options.dataDir;
  }

  proxyEntry(id: LegacyExecutorId): string {
    if (!this.options.managedProxies) {
      const entry = this.options.developmentProxyEntries?.[pluginIdFor(id)]
        ?? this.options.developmentProxyEntries?.[id];
      if (!entry) throw new Error(`development proxy entry is not configured: ${id}`);
      return entry;
    }
    return join(this.options.dataDir, 'plugins', id, 'current', PROXY_ENTRY);
  }

  async proxyLaunchDescriptor(id: LegacyExecutorId, version?: string | null): Promise<ProxyLaunchDescriptor> {
    if (!this.options.managedProxies) {
      const launch = await this.trustedOfficialLaunch(id);
      if (!launch) throw new Error(`development proxy entry is not configured: ${id}`);
      if (version && version !== launch.pluginVersion) {
        throw new Error(`${id} development Proxy ${version} is not available (current ${launch.pluginVersion})`);
      }
      return this.descriptorFromTrustedLaunch(launch);
    }
    const agentRoot = join(this.options.dataDir, 'plugins', id);
    let current: string;
    try {
      current = await realpath(version ? join(agentRoot, version) : join(agentRoot, 'current'));
    } catch (error) {
      if (version) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await lstat(join(agentRoot, 'current'));
        } catch (currentError) {
          if ((currentError as NodeJS.ErrnoException).code === 'ENOENT') {
            // A fresh profile has no managed Proxy yet. The Host still needs
            // to reach onboarding, where installation is offered; this
            // nominal path is not spawned until the Agent becomes ready.
            return { entryPath: this.proxyEntry(id) };
          }
          throw currentError;
        }
      }
      throw error;
    }
    const contained = await this.assertDirectProxyDirectory(agentRoot, current);
    const manifest = await this.validateProxyDirectory(contained, id);
    return this.descriptorFromValidatedManifest(id, contained, manifest);
  }

  private descriptorFromTrustedLaunch(launch: TrustedLaunch): ProxyLaunchDescriptor {
    return {
      entryPath: launch.entryPath,
      protocol: {
        pluginVersion: launch.pluginVersion,
        processScope: launch.processScope,
        schemaVersion: launch.schemaVersion,
        runtimeBootstrap: launch.schemaVersion === 4,
        ...(launch.runtime.id ? { runtimeId: launch.runtime.id } : {}),
        ...(launch.runtime.displayName ? { runtimeDisplayName: launch.runtime.displayName } : {}),
      },
    };
  }

  private descriptorFromValidatedManifest(
    id: LegacyExecutorId,
    directory: string,
    manifest: ProxyManifest,
  ): ProxyLaunchDescriptor {
    if (isLegacyProxyManifest(manifest)) {
      return { entryPath: join(directory, manifest.entry) };
    }
    const runtime = manifest.schemaVersion === 4 && manifest.runtime.kind === 'external'
      ? {
        runtimeId: manifest.runtime.id,
        runtimeDisplayName: manifest.runtime.displayName,
      }
      : manifest.schemaVersion === 4
        ? {}
        : {
          runtimeId: OFFICIAL_RUNTIME_IDS[id],
          runtimeDisplayName: OFFICIAL_RUNTIME_DISPLAY[id],
        };
    return {
      entryPath: join(directory, manifest.entry),
      protocol: {
        pluginVersion: manifest.pluginVersion,
        processScope: manifest.process.scope,
        schemaVersion: manifest.schemaVersion === 4 ? 4 : 3,
        runtimeBootstrap: manifest.schemaVersion === 4,
        ...runtime,
      },
    };
  }

  /** Kind-level statuses for the PRODUCT catalog (no Grok). Used by draft
   *  Agents and onboarding; saved-Agent statuses go through agentStatus(). */
  async list(refresh = false): Promise<AgentInstallStatus[]> {
    return Promise.all(PRODUCT_EXECUTORS.map(id => this.status(id, refresh)));
  }

  async status(id: LegacyExecutorId, refresh = false): Promise<AgentInstallStatus> {
    return this.statusInternal(id, refresh);
  }

  private async statusInternal(
    id: LegacyExecutorId,
    refresh: boolean,
    updateOwner?: AgentUpdateLease,
  ): Promise<AgentInstallStatus> {
    const definition = AGENTS[id];
    if (!definition) throw new Error(`unsupported agent: ${id}`);
    if (refresh) this.invalidateStatus(id);
    const generation = this.statusGenerations.get(id) ?? 0;
    const cached = this.statusCache.get(id);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.statusProbes.get(id);
    if (!refresh && pending?.generation === generation) return pending.promise;
    const probe = Promise.all([this.cliStatus(id, updateOwner), this.proxyStatus(id)])
      .then(([cli, proxy]) => {
        const value: AgentInstallStatus = {
          id,
          name: definition.name,
          ready: cli.state === 'ready' && proxy.state === 'ready',
          cli,
          proxy: { ...proxy, defaults: this.proxyDefaults(id) },
          officialInstallUrl: definition.installerUrl,
        };
        if ((this.statusGenerations.get(id) ?? 0) === generation) {
          this.statusCache.set(id, { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
        }
        return value;
      })
      .finally(() => {
        if (this.statusProbes.get(id)?.promise === probe) this.statusProbes.delete(id);
      });
    this.statusProbes.set(id, { generation, promise: probe });
    return probe;
  }

  /** Kind-level configured CLI override (environment only). A saved Agent's
   *  own path is resolved per Agent and reaches the runtime through
   *  `CliRuntimeManager.acquire(kind, path)` — never through this global. */
  configuredPath(id: LegacyExecutorId): string | null {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    return this.options.environmentCliPaths?.[id] ?? null;
  }

  /** Kind-level defaults view used by legacy callers (session creation until
   *  it resolves the Session's own Agent, and the kind status payload): the
   *  first saved Agent of the kind wins. */
  proxyDefaults(id: LegacyExecutorId): AgentProxyDefaults {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    const agent = isProductExecutor(id)
      ? this.config.agents.find(candidate => candidate.proxy === id)
      : undefined;
    const defaults = { ...(agent?.defaults ?? emptyProxyDefaults()) };
    return id === 'grok' ? migrateLegacyGrokProxyDefaults(defaults) : defaults;
  }

  legacyProxyDefaults(id: string): AgentProxyDefaults | undefined {
    return isExecutorId(id) ? this.proxyDefaults(id) : undefined;
  }

  // ------------------------------------------------------------------
  // User Agents (agents.json schema v5)
  // ------------------------------------------------------------------

  listAgents(): UserAgent[] {
    return this.config.agents.map(agent => ({
      ...agent,
      home: agent.home ? { ...agent.home } : null,
      // Production never projects a historical user-selected executable as
      // active configuration. The path survives only in agents.json during
      // the bounded migration window.
      cliPath: this.options.managedProxies ? null : agent.cliPath,
      defaults: { ...agent.defaults },
    }));
  }

  getAgent(id: string): UserAgent {
    const agent = this.config.agents.find(candidate => candidate.id === id);
    if (!agent) throw new Error(`agent not found: ${id}`);
    return {
      ...agent,
      home: agent.home ? { ...agent.home } : null,
      cliPath: this.options.managedProxies ? null : agent.cliPath,
      defaults: { ...agent.defaults },
    };
  }

  agentDefaults(id: string): AgentProxyDefaults {
    return { ...this.getAgent(id).defaults };
  }

  /** Resolved runtime CLI path for one saved Agent. Production reads only the
   * globally active certified generation; GianDev retains the legacy path
   * seam for isolated fixtures and migration verification. */
  agentRuntimePath(id: string): {
    pluginId: string;
    proxy: ProductExecutor | null;
    cliPath: string | null;
  } {
    const agent = this.getAgent(id);
    return {
      pluginId: agent.pluginId,
      proxy: agent.proxy,
      cliPath: this.options.managedProxies
        ? this.options.generationStore?.activeCached(agent.pluginId)?.runtime?.entryPath ?? null
        : agent.cliPath
          ?? (agent.proxy ? this.options.environmentCliPaths?.[agent.proxy] ?? null : null),
    };
  }

  agentHome(id: string): AgentHomeBinding | null {
    const home = this.config.agents.find(agent => agent.id === id)?.home ?? null;
    if (!home) return null;
    return { ...home };
  }

  managesRuntimePaths(): boolean {
    return this.options.managedProxies;
  }

  async managedRuntimeStatus(pluginId: string): Promise<import('@gian/shared').ManagedRuntimeStatus> {
    const id = parseProxyPluginId(pluginId);
    const generations = await this.options.generationStore?.list(id) ?? [];
    return {
      pluginId: id,
      active: this.options.generationStore?.activeCached(id) ?? null,
      staged: generations.filter(generation => generation.state === 'staged'),
    };
  }

  managedRuntimeGenerationStore(): ManagedRuntimeGenerationStore {
    if (!this.options.generationStore) {
      throw new Error('Managed Runtime generation store is unavailable.');
    }
    return this.options.generationStore;
  }

  managedRuntimeActivated(pluginId: string): void {
    const id = parseProxyPluginId(pluginId);
    this.options.readinessCache?.invalidate(id);
    for (const agent of this.config.agents) {
      if (agent.pluginId === id) this.invalidateAgentStatus(agent.id);
    }
    const legacy = productExecutorForPluginId(id);
    if (legacy) this.invalidateStatus(legacy);
  }

  async prepareAgentCliTerminal(agentId: string): Promise<{
    executable: string;
    args: string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    reservation: import('./update-lock.js').AgentProcessGroupReservation;
    release: () => Promise<void>;
  }> {
    const agent = this.getAgent(agentId);
    const home = agent.home;
    if (!home) {
      throw new AgentHomeError(
        'AGENT_HOME_UNSUPPORTED',
        'This Agent does not expose a Gian-managed CLI HOME.',
      );
    }
    const executable = this.agentRuntimePath(agentId).cliPath;
    if (!executable) {
      throw new AgentCreateError(
        'RUNTIME_NOT_INSTALLED',
        'The certified Runtime is not installed.',
        409,
      );
    }
    await access(executable, constants.X_OK);
    const lease = await acquireAgentRuntimeUseLock(
      this.updateLockDataDir(),
      agent.pluginId,
      `${agent.pluginId} Agent CLI terminal`,
    );
    try {
      return {
        executable,
        args: [],
        cwd: home.path,
        env: providerRuntimeEnvironment(agent.pluginId, home.path),
        reservation: await lease.reserveProcessGroup(),
        release: () => lease.release(),
      };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  /** Draft prefill only: a saved Agent path, readiness-cache path, or
   *  environment override. Never PATH-scans or runs `--version`. */
  async scannedCliPath(id: ProductExecutor): Promise<string | null> {
    if (this.options.managedProxies) {
      return this.options.generationStore?.activeCached(pluginIdForExecutorId(id))?.runtime?.entryPath ?? null;
    }
    const existing = this.config.agents.find((agent) => agent.proxy === id && agent.cliPath);
    if (existing?.cliPath) return existing.cliPath;
    const launch = await this.trustedOfficialLaunch(id);
    if (launch && isGenericRuntimeProtocol({
      schemaVersion: launch.schemaVersion,
      runtimeBootstrap: launch.schemaVersion === 4,
    })) {
      return this.options.readinessCache?.get(pluginIdForExecutorId(id), launch.pluginVersion)?.profile?.path
        ?? null;
    }
    return this.options.environmentCliPaths?.[id] ?? null;
  }

  /** The kind's default runtime path — its first saved Agent's resolved
   *  path, or the environment override when the kind has no Agent. */
  firstAgentPath(id: Executor): string | null {
    if (this.options.managedProxies) {
      const pluginId = resolvePluginIdInput(id);
      return pluginId
        ? this.options.generationStore?.activeCached(pluginId)?.runtime?.entryPath ?? null
        : null;
    }
    const legacy = isExecutorId(id) ? id : productExecutorForPluginId(id);
    const agent = this.config.agents.find(candidate => (
      candidate.pluginId === id || (legacy !== null && candidate.proxy === legacy)
    ));
    if (agent) return this.agentRuntimePath(agent.id).cliPath;
    return legacy ? this.options.environmentCliPaths?.[legacy] ?? null : null;
  }

  /** Static Proxy-kind catalog. Pure metadata — never spawns or probes. */
  proxiesCatalog(): ProxyCatalogEntry[] {
    return PRODUCT_EXECUTORS.map(id => ({
      id,
      name: AGENTS[id].name,
      logo: {
        light: `/api/proxies/${id}/logo/light`,
        dark: `/api/proxies/${id}/logo/dark`,
      },
      tagline: PROXY_TAGLINES[id],
      officialInstallUrl: AGENTS[id].installerUrl,
    }));
  }

  async proxyLogo(
    id: ProductExecutor,
    variant: 'light' | 'dark',
  ): Promise<{ bytes: Buffer; mediaType: 'image/png' | 'image/webp'; sha256: string } | null> {
    if (!this.options.managedProxies) {
      try {
        const packageDir = await pluginPackageDirectoryFromEntry(this.proxyEntry(id));
        const path = join(packageDir, 'assets', `logo-${variant}.png`);
        const bytes = await readFile(path);
        if (bytes.length === 0 || bytes.length > MAX_PROXY_LOGO_BYTES) return null;
        return {
          bytes,
          mediaType: 'image/png',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      } catch {
        return null;
      }
    }
    try {
      const agentRoot = join(this.options.dataDir, 'plugins', id);
      const current = await realpath(join(agentRoot, 'current'));
      const contained = await this.assertDirectProxyDirectory(agentRoot, current);
      const manifest = await this.validateProxyDirectory(contained, id, undefined, false);
      if (manifest.schemaVersion !== 3 && manifest.schemaVersion !== 4) return null;
      const descriptor = variant === 'dark'
        ? manifest.branding.logo.dark ?? manifest.branding.logo.light
        : manifest.branding.logo.light;
      return this.readProxyLogoAsset(contained, descriptor);
    } catch {
      return null;
    }
  }

  /** Default name for a new draft Agent of the kind: the Proxy display name,
   *  or "<name> N" when the plain name is already taken. */
  nextAgentName(proxy: ProductExecutor): string {
    const base = AGENTS[proxy].name;
    const taken = new Set(this.config.agents.map(agent => agent.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base} ${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  async createAgent(input: {
    name: string;
    pluginId?: string;
    proxy?: ProductExecutor;
    cliPath?: string | null;
    home?: { kind: 'managed' } | { kind: 'custom'; path: string };
    defaults?: Partial<AgentProxyDefaults>;
  }): Promise<UserAgent> {
    const fromPlugin = input.pluginId !== undefined ? resolvePluginIdInput(input.pluginId) : null;
    const fromProxy = input.proxy !== undefined ? resolvePluginIdInput(input.proxy) : null;
    if (input.pluginId !== undefined && !fromPlugin) {
      throw new Error(`unsupported pluginId: ${String(input.pluginId)}`);
    }
    if (input.proxy !== undefined && !fromProxy) {
      throw new Error(`unsupported proxy: ${String(input.proxy)}`);
    }
    if (fromPlugin && fromProxy && fromPlugin !== fromProxy) {
      throw new Error('pluginId does not match proxy');
    }
    const pluginId = fromPlugin ?? fromProxy;
    if (!pluginId) throw new Error('pluginId or proxy is required');
    const proxy = productExecutorForPluginId(pluginId);
    const name = normalizeAgentName(input.name);
    if (!name) throw new Error('Agent name must not be empty');
    if (this.options.managedProxies && input.cliPath !== undefined) {
      throw new AgentCreateError(
        'CLI_PATH_MANAGED',
        'CLI path is managed globally by Gian and cannot be configured per Agent.',
        400,
      );
    }
    let cliPath = this.options.managedProxies ? null : normalizeCliPathInput(input.cliPath);
    if (!this.options.managedProxies && cliPath === null && proxy) {
      // GianDev keeps CLI paths out of the product form too, but may reuse its
      // explicit development environment path or another saved Agent's path.
      cliPath = await this.scannedCliPath(proxy);
    }
    const agentId = randomUUID();
    const launch = await this.trustedLaunch(pluginId);
    if (!launch) {
      const catalogItem = await this.options.catalogService?.get(pluginId) ?? null;
      const mayInstall = this.options.managedProxies
        && catalogItem?.compatibility.state === 'compatible'
        && catalogItem.availableActions.some(action => (
          action === 'install_runtime' || action === 'install_proxy' || action === 'update_proxy'
        ));
      if (!mayInstall) {
        throw new AgentCreateError(
          'PLUGIN_NOT_FOUND',
          `No trusted compatible package is available for ${pluginId}.`,
          404,
        );
      }
    }
    const generic = launch ? isGenericRuntimeProtocol({
      schemaVersion: launch.schemaVersion,
      runtimeBootstrap: launch.schemaVersion === 4,
    }) : false;
    if (generic && !this.options.catalogService && !this.options.allowCreateWithoutCatalog) {
      throw new AgentCreateError(
        'CATALOG_UNAVAILABLE',
        `CatalogService is required to create a v4 Agent for ${pluginId}.`,
        409,
      );
    }
    if (this.options.catalogService) {
      const item = await this.options.catalogService.get(pluginId);
      const mayCreate = item?.availableActions.includes('create_agent')
        || (!this.options.managedProxies && launch !== null && item === null)
        || (this.options.managedProxies && item?.availableActions.some(action => (
          action === 'install_runtime' || action === 'install_proxy' || action === 'update_proxy'
        )));
      if (!mayCreate) {
        throw new AgentCreateError(
          'CATALOG_CREATE_FORBIDDEN',
          `Catalog does not authorize create_agent for ${pluginId}.`,
          409,
        );
      }
    }
    if (generic && launch?.runtime.kind === 'none' && cliPath !== null) {
      throw new AgentCreateError(
        'RUNTIME_NONE_HAS_PATH',
        'A none Runtime cannot carry an external path.',
        400,
      );
    }
    if (!this.options.managedProxies && generic && launch?.runtime.kind === 'external' && cliPath === null) {
      throw new AgentCreateError(
        'RUNTIME_PATH_REQUIRED',
        'An external Runtime requires a selected path.',
        400,
      );
    }
    // The per-kind claim excludes updater/path writers while the candidate
    // path is being probed; a path-less create only needs the config claim.
    const kinds = cliPath !== null && proxy ? [proxy] : [];
    const agent = await this.withAgentConfigLock(kinds, 'Agent create', async (current) => {
      assertAgentNameAvailable(current.agents, name);
      let home: AgentHomeBinding | null;
      if (!this.agentHomes.supports(pluginId)) {
        if (input.home?.kind === 'custom') {
          throw new AgentCreateError(
            'AGENT_HOME_UNSUPPORTED',
            'This external application owns its state directory.',
            400,
          );
        }
        home = null;
      } else if (input.home?.kind === 'custom') {
        home = await this.agentHomes.validateCustom(
          input.home.path,
          current.agents.flatMap(agent => agent.home
            ? [{ agentId: agent.id, path: agent.home.path }]
            : []),
        );
      } else {
        home = await this.agentHomes.createManaged(pluginId, agentId);
      }
      if (generic && launch?.runtime.kind === 'none') {
        await this.publishNoneRuntime(pluginId, launch, agentId);
      } else if (cliPath !== null) {
        await this.probeAgentRuntimePath(pluginId, cliPath);
      }
      const agent: UserAgent = {
        id: agentId,
        name,
        pluginId,
        proxy,
        home,
        cliPath,
        defaults: normalizeProxyDefaults(input.defaults),
      };
      await this.commitConfig(
        { schemaVersion: 5, agents: [...current.agents, persistableAgent(agent)] },
        [agent.id],
        officialKinds(proxy),
      );
      if (launch) this.rewritePublishedAgentId(pluginId, launch.pluginVersion, cliPath, agent.id);
      return agent;
    });
    if (agent.proxy === 'codex') await this.reconcileManagedSkills();
    return agent;
  }

  async updateAgent(id: string, patch: {
    name?: string;
    cliPath?: string | null;
    home?: { kind: 'managed' } | { kind: 'custom'; path: string };
    pluginId?: string;
    proxy?: ProductExecutor;
    defaults?: Partial<AgentProxyDefaults>;
  }): Promise<UserAgent> {
    const existing = this.getAgent(id);
    if (patch.pluginId !== undefined) {
      const nextPluginId = resolvePluginIdInput(patch.pluginId);
      if (nextPluginId !== existing.pluginId) throw new PluginIdImmutableError();
    }
    if (patch.proxy !== undefined) {
      const nextPluginId = resolvePluginIdInput(patch.proxy);
      if (nextPluginId !== existing.pluginId) throw new PluginIdImmutableError();
    }
    const name = patch.name !== undefined ? normalizeAgentName(patch.name) : existing.name;
    if (!name) throw new Error('Agent name must not be empty');
    if (this.options.managedProxies && patch.cliPath !== undefined) {
      throw new AgentCreateError(
        'CLI_PATH_MANAGED',
        'CLI path is managed globally by Gian and cannot be configured per Agent.',
        400,
      );
    }
    const cliPath = patch.cliPath !== undefined
      ? normalizeCliPathInput(patch.cliPath)
      : existing.cliPath;
    const pathChanged = !this.options.managedProxies && patch.cliPath !== undefined;
    const official = existing.proxy;
    // Name/defaults stay write-through under the config claim only —
    // they never touch the runtime load set, so they must not queue behind
    // a kind updater. Path changes take the kind claim for the probe.
    const claimKinds = pathChanged && official ? [official] : [];
    const agent = await this.withAgentConfigLock(claimKinds, 'Agent update', async (current) => {
      assertAgentNameAvailable(current.agents, name, id);
      const index = current.agents.findIndex(candidate => candidate.id === id);
      if (index === -1) throw new Error(`agent not found: ${id}`);
      const previous = current.agents[index]!;
      let home = previous.home ?? null;
      if (patch.home) {
        if (!this.agentHomes.supports(previous.pluginId)) {
          throw new AgentHomeError(
            'AGENT_HOME_UNSUPPORTED',
            'This external application owns its state directory.',
          );
        }
        home = patch.home.kind === 'custom'
          ? await this.agentHomes.validateCustom(
            patch.home.path,
            current.agents.flatMap(candidate => candidate.home
              ? [{ agentId: candidate.id, path: candidate.home.path }]
              : []),
            id,
          )
          : await this.agentHomes.createManaged(previous.pluginId, previous.id);
      }
      if (pathChanged && previous.cliPath && previous.cliPath !== cliPath) {
        const previousLaunch = await this.trustedLaunch(previous.pluginId);
        if (previousLaunch) {
          this.options.readinessCache?.invalidate(
            previous.pluginId,
            previousLaunch.pluginVersion,
            previous.cliPath,
          );
        }
        this.options.runtimeResolver?.invalidate(previous.pluginId, previous.cliPath);
      }
      if (pathChanged && cliPath !== null) {
        await this.probeAgentRuntimePath(previous.pluginId, cliPath);
      }
      const agent: UserAgent = persistableAgent({
        ...previous,
        name,
        home,
        cliPath,
        defaults: patch.defaults
          ? normalizeProxyDefaults({ ...previous.defaults, ...patch.defaults })
          : previous.defaults,
      });
      const agents = [...current.agents];
      agents[index] = agent;
      // The kind-level status view carries the first-Agent defaults/path, so
      // every committed update invalidates both touched kinds — even a
      // write-through defaults rename.
      await this.commitConfig(
        { schemaVersion: 5, agents },
        [id],
        officialKinds(official),
      );
      if (pathChanged) {
        const launch = await this.trustedLaunch(previous.pluginId);
        if (launch) {
          this.rewritePublishedAgentId(
            previous.pluginId,
            launch.pluginVersion,
            cliPath,
            agent.id,
          );
        }
      }
      return agent;
    });
    if (agent.proxy === 'codex') await this.reconcileManagedSkills();
    return agent;
  }

  async deleteAgent(id: string): Promise<void> {
    const existing = this.getAgent(id);
    await this.withAgentConfigLock([], 'Agent delete', async current => {
      const agents = current.agents.filter(candidate => candidate.id !== id);
      if (agents.length === current.agents.length) throw new Error(`agent not found: ${id}`);
      await this.commitConfig({ schemaVersion: 5, agents }, [id], officialKinds(existing.proxy));
    });
  }

  /** Live Runtime/Proxy status for one saved Agent. Production projects only
   * the active certified generation; GianDev keeps the legacy path probe for
   * compatibility fixtures. */
  async agentStatus(id: string, refresh = false): Promise<UserAgentStatus> {
    const agent = this.getAgent(id);
    if (refresh) this.invalidateAgentStatus(id);
    const generation = this.agentStatusGenerations.get(id) ?? 0;
    const cached = this.agentStatusCache.get(id);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.agentStatusProbes.get(id);
    if (!refresh && pending?.generation === generation) return pending.promise;
    if (this.options.managedProxies) {
      const value = await this.managedGenerationAgentStatus(agent);
      this.agentStatusCache.set(id, { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
      return value;
    }
    const trusted = await this.trustedLaunch(agent.pluginId);
    if (!agent.proxy || trusted?.schemaVersion === 4) {
      const value = await this.catalogOnlyAgentStatus(agent);
      this.agentStatusCache.set(id, { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
      return value;
    }
    const kind = agent.proxy;
    const probe = Promise.all([
      this.cliStatus(kind, undefined, agent.cliPath ?? undefined),
      this.proxyStatus(kind),
    ]).then(async ([cli, plugin]) => {
      const skill = kind === 'codex' && plugin.state === 'ready' && plugin.version
        ? await inspectManagedGianSkill(this.homeDir, plugin.version)
        : null;
      const launch = await this.trustedOfficialLaunch(kind);
      const cached = this.lastOpenRuntimeProfiles.get(`${kind}\0${cli.path ?? ''}`)
        ?? this.lastOpenRuntimeProfiles.get(`${agent.pluginId}\0${cli.path ?? ''}`)
        ?? this.lastOpenRuntimeProfiles.get(`${kind}\0`)
        ?? this.lastOpenRuntimeProfiles.get(`${agent.pluginId}\0`)
        ?? null;
      const runtimeProfile = cached
        ? { ...cached, agentId: agent.id }
        : launch?.runtime.kind === 'none'
          ? null
          : cli.state === 'ready' && cli.path && cli.version
            ? {
              id: openRuntimeIdentity(agent.pluginId, cli.path, cli.contentFingerprint ?? null),
              agentId: agent.id,
              pluginId: agent.pluginId,
              runtimeId: OFFICIAL_RUNTIME_IDS[kind],
              path: cli.path,
              version: cli.version,
              configHome: null,
              contentFingerprint: cli.contentFingerprint ?? null,
              verifiedVersions: cli.verifiedVersions ?? plugin.verifiedCliVersions ?? [],
              verification: (cli.verifiedVersions ?? plugin.verifiedCliVersions ?? []).includes(cli.version)
                ? 'verified' as const
                : 'unverified' as const,
            }
            : null;
      const generic = Boolean(launch && isGenericRuntimeProtocol({
        schemaVersion: launch.schemaVersion,
        runtimeBootstrap: launch.schemaVersion === 4,
      }));
      const value: UserAgentStatus = {
        ...agent,
        proxyName: AGENTS[kind].name,
        ready: cli.state === 'ready'
          && plugin.state === 'ready'
          && (
            !generic
            || (
              runtimeProfile !== null
              && (launch!.runtime.kind === 'none' || cli.version !== null)
            )
          ),
        cli,
        plugin: { ...plugin, defaults: { ...agent.defaults } },
        runtimeProfile,
        skill: kind === 'codex'
          ? {
            name: 'gian-session',
            version: plugin.version ?? 'unknown',
            state: skill?.state ?? 'missing',
          }
          : null,
        officialInstallUrl: AGENTS[kind].installerUrl,
      };
      if ((this.agentStatusGenerations.get(id) ?? 0) === generation) {
        this.agentStatusCache.set(id, { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
      }
      return value;
    }).finally(() => {
      if (this.agentStatusProbes.get(id)?.promise === probe) this.agentStatusProbes.delete(id);
    });
    this.agentStatusProbes.set(id, { generation, promise: probe });
    return probe;
  }

  private async managedGenerationAgentStatus(agent: UserAgent): Promise<UserAgentStatus> {
    const active = this.options.generationStore?.activeCached(agent.pluginId) ?? null;
    const trusted = await this.trustedLaunch(agent.pluginId);
    const fallbackPlugin: Omit<AgentProxyStatus, 'defaults'> = trusted
      ? {
        state: 'ready',
        path: trusted.entryPath,
        version: trusted.pluginVersion,
        verifiedCliVersions: [...(trusted.runtime.verifiedVersions ?? [])],
        source: trusted.source === 'official-development' ? 'development' : 'github-release',
      }
      : agent.proxy ? await this.proxyStatus(agent.proxy) : {
        state: 'missing',
        path: null,
        version: null,
        source: null,
      };
    if (!active) {
      return {
        ...agent,
        cliPath: null,
        proxyName: agent.proxy ? AGENTS[agent.proxy].name : agent.pluginId,
        ready: false,
        cli: {
          state: 'missing',
          path: null,
          version: null,
          source: null,
          readinessIssue: {
            code: 'RUNTIME_NOT_INSTALLED',
            message: 'The certified Runtime and Proxy combination is not installed.',
            repairable: true,
          },
        },
        plugin: { ...fallbackPlugin, defaults: { ...agent.defaults } },
        runtimeProfile: null,
        skill: null,
        officialInstallUrl: agent.proxy ? AGENTS[agent.proxy].installerUrl : '',
      };
    }

    const proxyReady = await existsReadable(active.proxy.entryPath);
    const runtimeReady = active.runtime === null || await existsReadable(active.runtime.entryPath);
    const home = agent.home ?? null;
    const profile: OpenRuntimeProfile = {
      id: createHash('sha256').update(JSON.stringify([
        active.generationId,
        home?.path ?? null,
      ])).digest('hex'),
      agentId: agent.id,
      pluginId: agent.pluginId,
      runtimeId: active.runtime?.runtimeId ?? null,
      path: active.runtime?.entryPath ?? null,
      version: active.runtime?.version ?? null,
      configHome: home?.path ?? null,
      contentFingerprint: active.runtime?.artifactSha256 ?? null,
      verifiedVersions: active.runtime ? [active.runtime.version] : [],
      verification: 'verified',
    };
    return {
      ...agent,
      cliPath: null,
      proxyName: agent.proxy ? AGENTS[agent.proxy].name : agent.pluginId,
      ready: proxyReady && runtimeReady,
      cli: runtimeReady
        ? {
          state: 'ready',
          path: active.runtime?.entryPath ?? null,
          version: active.runtime?.version ?? null,
          verifiedVersions: active.runtime ? [active.runtime.version] : [],
          contentFingerprint: active.runtime?.artifactSha256 ?? null,
          source: 'managed',
        }
        : {
          state: 'invalid',
          path: active.runtime?.entryPath ?? null,
          version: active.runtime?.version ?? null,
          source: 'managed',
          error: 'The active Runtime entry is missing.',
        },
      plugin: {
        state: proxyReady ? 'ready' : 'invalid',
        path: active.proxy.entryPath,
        version: active.proxy.pluginVersion,
        verifiedCliVersions: active.runtime ? [active.runtime.version] : [],
        source: 'github-release',
        defaults: { ...agent.defaults },
        ...(!proxyReady ? { error: 'The active Proxy entry is missing.' } : {}),
      },
      runtimeProfile: profile,
      skill: null,
      officialInstallUrl: agent.proxy ? AGENTS[agent.proxy].installerUrl : '',
    };
  }

  async listAgentStatuses(refresh = false): Promise<UserAgentStatus[]> {
    return Promise.all(this.config.agents.map(agent => this.agentStatus(agent.id, refresh)));
  }

  private async managedGianSkillSource(): Promise<ManagedSkillSource | null> {
    const descriptor = await this.proxyLaunchDescriptor('codex');
    if (!descriptor.protocol) return null;
    const packageDir = dirname(descriptor.entryPath);
    if (!this.options.managedProxies) {
      const source = join(
        await pluginPackageDirectoryFromEntry(descriptor.entryPath),
        'skills',
        'gian-session',
        'SKILL.md',
      );
      const bytes = await readFile(source);
      return {
        name: 'gian-session',
        version: descriptor.protocol.pluginVersion,
        path: source,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
    const manifest = await this.validateProxyDirectory(packageDir, 'codex');
    if (isLegacyProxyManifest(manifest)) return null;
    const skill = manifest.skills?.find(candidate => candidate.name === 'gian-session');
    if (!skill) return null;
    return {
      name: 'gian-session',
      version: manifest.pluginVersion,
      path: join(packageDir, skill.path),
      sha256: skill.sha256,
    };
  }

  /** Reconcile the static internal Skill only when a saved Codex Agent uses a
   * ready Proxy. This never writes Agent instruction files or user-owned Skill
   * collisions. */
  async reconcileManagedSkills(): Promise<ManagedSkillResult[]> {
    if (!this.config.agents.some(agent => agent.proxy === 'codex')) return [];
    try {
      const source = await this.managedGianSkillSource();
      if (!source) return [];
      const result = await reconcileManagedGianSkill(this.homeDir, source);
      for (const agent of this.config.agents.filter(candidate => candidate.proxy === 'codex')) {
        this.invalidateAgentStatus(agent.id);
      }
      return [result];
    } catch (error) {
      return [{
        name: 'gian-session',
        version: 'unknown',
        path: join(this.homeDir, '.agents', 'skills', 'gian-session'),
        state: 'invalid',
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      }];
    }
  }

  private async probeAgentRuntimePath(pluginId: string, path: string): Promise<void> {
    const launch = await this.trustedLaunch(pluginId);
    if (!launch) {
      // Onboarding may select an already-installed Runtime before its Proxy
      // package is installed. Persist only a regular absolute file here;
      // nothing is executed until the trusted Manifest is available and the
      // RuntimeResolver can apply its version and fingerprint policy.
      await assertSavedAbsoluteRuntimePath(path);
      return;
    }
    if (!isGenericRuntimeProtocol({
      schemaVersion: launch.schemaVersion,
      runtimeBootstrap: launch.schemaVersion === 4,
    })) {
      await assertSavedAbsoluteRuntimePath(path);
      return;
    }
    if (!this.options.runtimeResolver) {
      throw new Error('RuntimeResolver is required for this v4/2.2 package.');
    }
    if (launch.runtime.kind !== 'external' || !launch.runtime.id || !launch.runtime.displayName) {
      throw new Error('Trusted Manifest Runtime facts are incomplete.');
    }
    const resolved = await this.options.runtimeResolver.resolve({
      pluginId: parseProxyPluginId(launch.pluginId),
      pluginVersion: launch.pluginVersion,
      agentId: launch.pluginId,
      entryPath: launch.entryPath,
      processScope: launch.processScope,
      runtime: {
        kind: 'external',
        id: launch.runtime.id,
        displayName: launch.runtime.displayName,
        verifiedVersions: [...(launch.runtime.verifiedVersions ?? [])],
      },
      selectedPath: path,
    });
    await resolved.lease?.release();
    this.lastOpenRuntimeProfiles.set(`${pluginId}\0${path}`, resolved.profile);
    this.lastOpenRuntimeProfiles.set(`${launch.pluginId}\0${path}`, resolved.profile);
    this.options.readinessCache?.publish({
      pluginId: launch.pluginId,
      pluginVersion: launch.pluginVersion,
      selectedPath: path,
      profileIdentity: resolved.profile.id,
      state: resolved.readinessIssue
        ? 'invalid'
        : resolved.profile.verification === 'incompatible'
          ? 'invalid'
          : resolved.profile.verification === 'unverified'
            ? 'unverified'
            : 'ready',
      displayName: launch.runtime.displayName ?? null,
      ...(resolved.readinessIssue ? { readinessIssue: resolved.readinessIssue } : {}),
      profile: resolved.profile,
      ...(resolved.observation ? { observation: resolved.observation } : {}),
    });
    if (resolved.readinessIssue) {
      throw new Error(resolved.readinessIssue.message);
    }
    if (resolved.profile.verification === 'incompatible') {
      throw new Error('Selected Runtime is incompatible with the trusted Manifest.');
    }
  }

  private async publishNoneRuntime(
    pluginId: string,
    launch: TrustedLaunch,
    agentId: string,
  ): Promise<void> {
    if (!this.options.runtimeResolver) {
      throw new AgentCreateError(
        'RUNTIME_RESOLVER_REQUIRED',
        'RuntimeResolver is required for this v4/2.2 package.',
        400,
      );
    }
    const resolved = await this.options.runtimeResolver.resolve({
      pluginId: parseProxyPluginId(launch.pluginId),
      pluginVersion: launch.pluginVersion,
      agentId,
      entryPath: launch.entryPath,
      processScope: launch.processScope,
      runtime: { kind: 'none' },
      selectedPath: null,
    });
    this.lastOpenRuntimeProfiles.set(`${pluginId}\0`, resolved.profile);
    this.options.readinessCache?.publish({
      pluginId: launch.pluginId,
      pluginVersion: launch.pluginVersion,
      selectedPath: null,
      profileIdentity: resolved.profile.id,
      state: 'not_required',
      displayName: launch.runtime.displayName ?? null,
      profile: resolved.profile,
    });
  }

  private rewritePublishedAgentId(
    pluginId: string,
    pluginVersion: string,
    selectedPath: string | null,
    agentId: string,
  ): void {
    const cached = this.options.readinessCache?.get(pluginId, pluginVersion, selectedPath);
    if (!cached?.profile) return;
    const profile = { ...cached.profile, agentId };
    this.options.readinessCache?.publish({
      ...cached,
      profile,
    });
    this.lastOpenRuntimeProfiles.set(`${pluginId}\0${selectedPath ?? ''}`, profile);
  }

  private async commitConfig(
    next: AgentConfigFile,
    invalidateAgentIds: readonly string[] = [],
    invalidateKinds: readonly LegacyExecutorId[] = [],
  ): Promise<void> {
    // Persistence is the commit point. Invalidate immediately so a later
    // claim-retirement failure cannot leave stale statuses cached.
    await this.saveConfig(next);
    this.config = next;
    for (const id of invalidateAgentIds) {
      this.invalidateAgentStatus(id);
    }
    for (const kind of invalidateKinds) this.invalidateStatus(kind);
  }

  /** Serialize agents.json writers in this Host, then across Hosts via the
   *  shared config claim; per-kind claims additionally exclude updater/path
   *  writers while a CLI path is being validated. The callback re-reads the
   *  persisted config so an older snapshot can never overwrite a newer one. */
  private async withAgentConfigLock<T>(
    kinds: readonly LegacyExecutorId[],
    operation: string,
    run: (
      current: AgentConfigFile,
      leases: ReadonlyMap<Executor, AgentUpdateLease>,
    ) => Promise<T>,
  ): Promise<T> {
    const finishMutation = await this.acquireConfigMutationTurn();
    try {
      const claims: AgentUpdateLease[] = [];
      const leases = new Map<Executor, AgentUpdateLease>();
      let result: T | undefined;
      let operationFailed = false;
      let operationError: unknown;
      try {
        claims.push(await acquireAgentProxyUpdateLock(
          this.updateLockDataDir(),
          CONFIG_LOCK_AGENT_ID,
          operation,
        ));
        for (const kind of [...new Set(kinds)].sort()) {
          const lease = await acquireAgentProxyUpdateLock(
            this.updateLockDataDir(),
            kind,
            operation,
          );
          claims.push(lease);
          leases.set(kind, lease);
        }
        const current = await this.readPersistedConfig();
        result = await run(current, leases);
      } catch (error) {
        operationFailed = true;
        operationError = error;
      }
      const cleanupErrors: unknown[] = [];
      for (const claim of claims.reverse()) {
        try {
          await claim.release();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (operationFailed || cleanupErrors.length > 0) {
        if (cleanupErrors.length === 0) throw operationError;
        throw new AggregateError(
          operationFailed ? [operationError, ...cleanupErrors] : cleanupErrors,
          `${operation} failed or retained one of its coordination claims.`,
        );
      }
      return result as T;
    } finally {
      finishMutation();
    }
  }

  installOfficialCli(_id: LegacyExecutorId): Promise<AgentInstallResult> {
    return Promise.reject(Object.assign(
      new Error(
        'Runtime setup uses Proxy documentation and typed open/select actions; Host no longer executes installers.',
      ),
      { code: 'HOST_RUNTIME_INSTALLER_REMOVED' },
    ));
  }

    /** Read-only "is a newer compatible Proxy release available?" check (issue
   *  #86). No update lock, no filesystem or process side effects: the current
   *  version comes from the status probe and the latest compatible release
   *  from the same resolution the installer uses. */
  async checkProxyUpdate(id: LegacyExecutorId): Promise<AgentProxyUpdateCheck> {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    if (!this.options.managedProxies) {
      return {
        managed: false,
        currentVersion: (await this.proxyStatus(id)).version,
        latestVersion: null,
        updateAvailable: false,
      };
    }
    const current = (await this.proxyStatus(id)).version;
    const latest = (await this.resolveProxyRelease(id)).version;
    const currentSemver = current ? parseSemver(current) : null;
    const latestSemver = parseSemver(latest);
    let updateAvailable: boolean;
    if (current === null || latestSemver === null || currentSemver === null) {
      // Nothing installed, or a non-SemVer version string: fall back to plain
      // inequality rather than guessing an ordering.
      updateAvailable = current !== latest;
    } else {
      updateAvailable = compareSemver(latestSemver, currentSemver) > 0;
    }
    return {
      managed: true,
      currentVersion: current,
      latestVersion: latest,
      updateAvailable,
    };
  }

  installProxy(id: LegacyExecutorId): Promise<AgentInstallResult> {
    return this.runOperation(`proxy:${id}`, () => this.withAgentUpdateLock(
      id,
      'Proxy install',
      async updateOwner => {
      if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
      if (!this.options.managedProxies) {
        return { agent: await this.status(id, true) };
      }
      if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        throw new Error('Managed proxy packages support macOS Apple Silicon only.');
      }

      const release = await this.resolveProxyRelease(id);
      const filename = `gian-proxy-${id}-${release.version}-darwin-arm64.tar.gz`;
      const baseUrl = `https://github.com/${this.releaseRepository}/releases/download/${release.tag}`;
      const checksumFilename = `${filename}.sha256`;
      const officialDigests = await this.releaseAssetDigests(
        release.tag,
        [filename, checksumFilename],
      );
      const [archive, checksumFile] = await Promise.all([
        this.download(`${baseUrl}/${filename}`, MAX_PROXY_BYTES),
        this.download(`${baseUrl}/${checksumFilename}`, 4_096),
      ]);
      const checksumDigest = createHash('sha256').update(checksumFile).digest('hex');
      if (checksumDigest !== officialDigests.get(checksumFilename)) {
        throw new Error('Proxy checksum asset failed official release integrity verification.');
      }
      const expected = parseArtifactChecksum(checksumFile.toString('utf8'), filename);
      const actual = createHash('sha256').update(archive).digest('hex');
      if (actual !== expected || actual !== officialDigests.get(filename)) {
        throw new Error('Proxy archive failed official release integrity verification.');
      }

      const agentRoot = join(this.options.dataDir, 'plugins', id);
      const staging = join(agentRoot, `.staging-${randomUUID()}`);
      const archivePath = join(staging, filename);
      const extracted = join(staging, 'package');
      await mkdir(extracted, { recursive: true });
      try {
        await writeFile(archivePath, archive);
        await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', extracted], {
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        const extractedManifest = await this.validateProxyDirectory(extracted, id);
        if (isLegacyProxyManifest(extractedManifest) && (
          this.options.independentProxyReleases
          || extractedManifest.version !== this.releaseVersion
        )) {
          throw new Error(`Invalid ${id} proxy manifest.`);
        }
        if (
          !isLegacyProxyManifest(extractedManifest)
          && this.options.independentProxyReleases
          && extractedManifest.pluginVersion !== release.version
        ) {
          throw new Error(`${id} Proxy manifest version does not match release ${release.tag}.`);
        }
        if (!isCompatibleProxyManifest(extractedManifest, this.releaseVersion)) {
          throw new Error(`${id} Proxy does not support ${PROTOCOL_NAME}/${PROTOCOL_V2}.`);
        }
        const candidateVersion = safeReleaseValue(
          proxyManifestVersion(extractedManifest),
          `${id} Proxy version`,
        );
        const finalDir = join(agentRoot, candidateVersion);
        try {
          await rename(extracted, finalDir);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
          await this.validateProxyDirectory(finalDir, id, candidateVersion);
        }
        await this.activateProxy(agentRoot, id, candidateVersion, updateOwner);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      this.invalidateStatus(id);
      if (id === 'codex') await this.reconcileManagedSkills();
      return { agent: await this.status(id, true) };
      },
      'proxy-update',
    ));
  }

  private async cliStatus(
    id: LegacyExecutorId,
    updateOwner?: AgentUpdateLease,
    overridePath?: string,
  ): Promise<AgentCliStatus> {
    const claim = updateOwner ?? await acquireAgentRuntimeUseLock(
      this.updateLockDataDir(),
      id,
      `${id} CLI status probe`,
    );
    let result: AgentCliStatus | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      result = await this.cliStatusWithClaim(id, claim, overridePath);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    const cleanupErrors: unknown[] = [];
    if (!updateOwner) {
      try {
        await claim.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (operationFailed || cleanupErrors.length > 0) {
      if (cleanupErrors.length === 0) throw operationError;
      throw new AggregateError(
        operationFailed ? [operationError, ...cleanupErrors] : cleanupErrors,
        `${id} CLI status probe cleanup failed.`,
      );
    }
    return result!;
  }

  private async cliStatusWithClaim(
    id: LegacyExecutorId,
    _claim: AgentUpdateLease,
    overridePath?: string,
  ): Promise<AgentCliStatus> {
    const resolved = await this.tryGenericCliStatus(id, overridePath);
    if (resolved) return resolved;
    const configured = overridePath ?? this.configuredPath(id);
    if (!configured) {
      return { state: 'missing', path: null, version: null, source: null };
    }
    try {
      await assertSavedAbsoluteRuntimePath(configured);
      return {
        state: 'ready',
        path: configured,
        version: null,
        source: 'override',
      };
    } catch (error) {
      return {
        state: 'invalid',
        path: configured,
        version: null,
        source: 'override',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async catalogOnlyAgentStatus(agent: UserAgent): Promise<UserAgentStatus> {
    const unavailable = (readinessIssue: { code: string; message: string; repairable: boolean }): UserAgentStatus => ({
      ...agent,
      proxyName: agent.pluginId,
      ready: false,
      cli: {
        state: 'missing',
        path: agent.cliPath,
        version: null,
        source: null,
        readinessIssue,
      },
      plugin: {
        state: 'missing',
        path: null,
        version: null,
        source: null,
        defaults: { ...agent.defaults },
      },
      runtimeProfile: null,
      officialInstallUrl: '',
    });
    const launch = await this.trustedLaunch(agent.pluginId);
    if (!launch) {
      return unavailable({
        code: 'CATALOG_PLUGIN_UNVERIFIED',
        message: 'Catalog, package, and Runtime readiness are not available for this pluginId.',
        repairable: false,
      });
    }
    const pluginSource = launch.source === 'official-development'
      ? 'development' as const
      : 'github-release' as const;
    if (!isGenericRuntimeProtocol({ schemaVersion: launch.schemaVersion, runtimeBootstrap: launch.schemaVersion === 4 })) {
      return unavailable({
        code: 'CATALOG_PLUGIN_LEGACY',
        message: 'This installed package is not a v4/2.2 Runtime package.',
        repairable: false,
      });
    }
    try {
      const cached = this.options.readinessCache?.get(
        launch.pluginId,
        launch.pluginVersion,
        agent.cliPath,
      );
      if (this.options.readinessCache?.isInvalidated(launch.pluginId, launch.pluginVersion, agent.cliPath)) {
        return unavailable({
          code: 'RUNTIME_MUTATED',
          message: 'Runtime content changed after the last trusted probe.',
          repairable: true,
        });
      }
      if (cached?.profile && !cached.invalidated) {
        this.lastOpenRuntimeProfiles.set(`${agent.pluginId}\0${cached.profile.path ?? ''}`, cached.profile);
        const cli: AgentCliStatus = cached.readinessIssue
          ? {
            state: 'invalid',
            path: cached.profile.path,
            version: cached.profile.version,
            source: null,
            readinessIssue: cached.readinessIssue,
          }
          : launch.runtime.kind === 'none'
            ? {
              state: 'ready',
              path: null,
              version: cached.profile.version,
              verifiedVersions: cached.profile.verifiedVersions,
              contentFingerprint: cached.profile.contentFingerprint,
              source: null,
            }
            : !cached.profile.path || !cached.profile.version
              ? {
                state: 'missing',
                path: agent.cliPath,
                version: null,
                source: null,
                readinessIssue: {
                  code: 'setup_required',
                  message: 'Select or install a Runtime, then retry.',
                  repairable: true,
                },
              }
              : {
                state: cached.profile.verification === 'incompatible' ? 'invalid' : 'ready',
                path: cached.profile.path,
                version: cached.profile.version,
                verifiedVersions: cached.profile.verifiedVersions,
                contentFingerprint: cached.profile.contentFingerprint,
                source: agent.cliPath ? 'override' : 'path',
              };
        const ready = cli.state === 'ready'
          && cached.profile !== undefined
          && (launch.runtime.kind === 'none' || (cli.version !== null && cached.profile !== null));
        return {
          ...agent,
          proxyName: launch.displayName ?? agent.pluginId,
          ready,
          cli,
          plugin: {
            state: 'ready',
            path: launch.entryPath,
            version: launch.pluginVersion,
            source: pluginSource,
            defaults: { ...agent.defaults },
          },
          runtimeProfile: { ...cached.profile, agentId: agent.id },
          officialInstallUrl: '',
        };
      }
      const probed = await this.resolveSavedAgentStatus(agent.pluginId, launch, agent.id, agent.cliPath);
      return {
        ...agent,
        proxyName: launch.displayName ?? agent.pluginId,
        ready: probed.ready,
        cli: probed.cli,
        plugin: {
          state: 'ready',
          path: launch.entryPath,
          version: launch.pluginVersion,
          source: pluginSource,
          defaults: { ...agent.defaults },
        },
        runtimeProfile: probed.runtimeProfile,
        officialInstallUrl: '',
      };
    } catch (error) {
      return {
        ...unavailable({
          code: error instanceof RuntimeResolverError ? error.code : 'RUNTIME_RESOLVE_FAILED',
          message: error instanceof Error ? error.message : String(error),
          repairable: true,
        }),
        cli: {
          state: 'invalid',
          path: agent.cliPath,
          version: null,
          source: null,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async tryGenericCliStatus(
    id: LegacyExecutorId,
    overridePath?: string,
  ): Promise<AgentCliStatus | null> {
    const launch = await this.trustedOfficialLaunch(id);
    if (!launch || !isGenericRuntimeProtocol({
      schemaVersion: launch.schemaVersion,
      runtimeBootstrap: launch.schemaVersion === 4,
    })) {
      return null;
    }
    const configured = overridePath ?? this.configuredPath(id) ?? null;
    if (launch.runtime.kind === 'none') {
      if (configured !== null) {
        return {
          state: 'invalid',
          path: configured,
          version: null,
          source: 'override',
          error: 'A none Runtime cannot carry an external path.',
        };
      }
      if (this.options.readinessCache?.isInvalidated(launch.pluginId, launch.pluginVersion, null)) {
        return {
          state: 'invalid',
          path: null,
          version: null,
          source: null,
          readinessIssue: {
            code: 'RUNTIME_MUTATED',
            message: 'Runtime content changed after the last trusted probe.',
            repairable: true,
          },
        };
      }
      const noneCached = this.options.readinessCache?.get(launch.pluginId, launch.pluginVersion, null) ?? null;
      if (noneCached?.profile && !noneCached.invalidated) {
        this.lastOpenRuntimeProfiles.set(`${id}\0`, noneCached.profile);
        this.lastOpenRuntimeProfiles.set(`${launch.pluginId}\0`, noneCached.profile);
        return {
          state: 'ready',
          path: null,
          version: noneCached.profile.version,
          verifiedVersions: noneCached.profile.verifiedVersions,
          contentFingerprint: noneCached.profile.contentFingerprint,
          source: null,
        };
      }
      const probed = await this.resolveSavedAgentStatus(launch.pluginId, launch, id, null);
      if (probed.runtimeProfile) {
        this.lastOpenRuntimeProfiles.set(`${id}\0`, probed.runtimeProfile);
        this.lastOpenRuntimeProfiles.set(`${launch.pluginId}\0`, probed.runtimeProfile);
      }
      return probed.cli;
    }
    if (launch.runtime.kind !== 'external' || !launch.runtime.id || !launch.runtime.displayName) {
      return {
        state: 'invalid',
        path: configured,
        version: null,
        source: null,
        error: 'Trusted Manifest Runtime facts are incomplete.',
      };
    }
    if (this.options.readinessCache?.isInvalidated(launch.pluginId, launch.pluginVersion, configured)) {
      return {
        state: 'invalid',
        path: configured,
        version: null,
        source: configured ? 'override' : null,
        readinessIssue: {
          code: 'RUNTIME_MUTATED',
          message: 'Runtime content changed after the last trusted probe.',
          repairable: true,
        },
      };
    }
    const cached = this.options.readinessCache?.get(
      launch.pluginId,
      launch.pluginVersion,
      configured,
    ) ?? null;
    if (cached?.profile && !cached.invalidated) {
      this.lastOpenRuntimeProfiles.set(`${id}\0${cached.profile.path ?? ''}`, cached.profile);
      if (cached.readinessIssue) {
        return {
          state: 'invalid',
          path: cached.profile.path,
          version: cached.profile.version,
          verifiedVersions: cached.profile.verifiedVersions,
          contentFingerprint: cached.profile.contentFingerprint,
          source: configured ? 'override' : 'path',
          readinessIssue: cached.readinessIssue,
        };
      }
      if (!cached.profile.path || !cached.profile.version) {
        return {
          state: 'missing',
          path: configured,
          version: null,
          source: null,
          readinessIssue: {
            code: 'setup_required',
            message: 'Select or install a Runtime, then retry.',
            repairable: true,
          },
        };
      }
      return {
        state: cached.profile.verification === 'incompatible' ? 'invalid' : 'ready',
        path: cached.profile.path,
        version: cached.profile.version,
        verifiedVersions: cached.profile.verifiedVersions,
        contentFingerprint: cached.profile.contentFingerprint,
        source: configured ? 'override' : 'path',
      };
    }
    const probed = await this.resolveSavedAgentStatus(launch.pluginId, launch, id, configured);
    return probed.cli;
  }

  private async resolveSavedAgentStatus(
    pluginId: string,
    launch: TrustedLaunch,
    agentId: string,
    selectedPath: string | null,
  ): Promise<{ ready: boolean; cli: AgentCliStatus; runtimeProfile: OpenRuntimeProfile | null }> {
    if (!this.options.runtimeResolver) {
      return {
        ready: false,
        cli: {
          state: 'missing',
          path: selectedPath,
          version: null,
          source: null,
          readinessIssue: {
            code: 'RUNTIME_RESOLVER_REQUIRED',
            message: 'RuntimeResolver is required for this v4/2.2 package.',
            repairable: false,
          },
        },
        runtimeProfile: null,
      };
    }
    if (launch.runtime.kind === 'none') {
      if (selectedPath) {
        return {
          ready: false,
          cli: {
            state: 'invalid',
            path: selectedPath,
            version: null,
            source: 'override',
            error: 'A none Runtime cannot carry an external path.',
          },
          runtimeProfile: null,
        };
      }
      const resolved = await this.options.runtimeResolver.resolve({
        pluginId: parseProxyPluginId(launch.pluginId),
        pluginVersion: launch.pluginVersion,
        agentId,
        entryPath: launch.entryPath,
        processScope: launch.processScope,
        runtime: { kind: 'none' },
        selectedPath: null,
      });
      const profile = { ...resolved.profile, agentId };
      this.lastOpenRuntimeProfiles.set(`${pluginId}\0`, profile);
      this.lastOpenRuntimeProfiles.set(`${launch.pluginId}\0`, profile);
      this.options.readinessCache?.publish({
        pluginId: launch.pluginId,
        pluginVersion: launch.pluginVersion,
        selectedPath: null,
        profileIdentity: resolved.profile.id,
        state: 'not_required',
        displayName: launch.runtime.displayName ?? null,
        profile,
      });
      return {
        ready: true,
        cli: {
          state: 'ready',
          path: null,
          version: resolved.profile.version,
          verifiedVersions: resolved.profile.verifiedVersions,
          contentFingerprint: resolved.profile.contentFingerprint,
          source: null,
        },
        runtimeProfile: profile,
      };
    }
    if (!selectedPath) {
      return {
        ready: false,
        cli: {
          state: 'missing',
          path: null,
          version: null,
          source: null,
          readinessIssue: {
            code: 'setup_required',
            message: 'Select or install a Runtime, then retry.',
            repairable: true,
          },
        },
        runtimeProfile: null,
      };
    }
    if (launch.runtime.kind !== 'external' || !launch.runtime.id || !launch.runtime.displayName) {
      return {
        ready: false,
        cli: {
          state: 'invalid',
          path: selectedPath,
          version: null,
          source: 'override',
          error: 'Trusted Manifest Runtime facts are incomplete.',
        },
        runtimeProfile: null,
      };
    }
    try {
      const resolved = await this.options.runtimeResolver.resolve({
        pluginId: parseProxyPluginId(launch.pluginId),
        pluginVersion: launch.pluginVersion,
        agentId,
        entryPath: launch.entryPath,
        processScope: launch.processScope,
        runtime: {
          kind: 'external',
          id: launch.runtime.id,
          displayName: launch.runtime.displayName,
          verifiedVersions: [...(launch.runtime.verifiedVersions ?? [])],
        },
        selectedPath,
      });
      await resolved.lease?.release();
      const profile = { ...resolved.profile, agentId };
      this.lastOpenRuntimeProfiles.set(`${pluginId}\0${selectedPath}`, profile);
      this.options.readinessCache?.publish({
        pluginId: launch.pluginId,
        pluginVersion: launch.pluginVersion,
        selectedPath,
        profileIdentity: profile.id,
        state: resolved.readinessIssue
          ? 'invalid'
          : profile.verification === 'incompatible'
            ? 'invalid'
            : profile.verification === 'unverified'
              ? 'unverified'
              : 'ready',
        displayName: launch.runtime.displayName,
        ...(resolved.readinessIssue ? { readinessIssue: resolved.readinessIssue } : {}),
        profile,
        ...(resolved.observation ? { observation: resolved.observation } : {}),
      });
      if (resolved.readinessIssue || profile.verification === 'incompatible' || !profile.path || !profile.version) {
        return {
          ready: false,
          cli: {
            state: 'invalid',
            path: profile.path,
            version: profile.version,
            verifiedVersions: profile.verifiedVersions,
            contentFingerprint: profile.contentFingerprint,
            source: 'override',
            ...(resolved.readinessIssue ? { readinessIssue: resolved.readinessIssue } : {}),
          },
          runtimeProfile: profile,
        };
      }
      return {
        ready: true,
        cli: {
          state: 'ready',
          path: profile.path,
          version: profile.version,
          verifiedVersions: profile.verifiedVersions,
          contentFingerprint: profile.contentFingerprint,
          source: 'override',
        },
        runtimeProfile: profile,
      };
    } catch (error) {
      return {
        ready: false,
        cli: {
          state: 'invalid',
          path: selectedPath,
          version: null,
          source: 'override',
          error: error instanceof Error ? error.message : String(error),
        },
        runtimeProfile: null,
      };
    }
  }

  private async verifiedCliVersions(id: LegacyExecutorId): Promise<string[]> {
    if (!this.options.managedProxies) return [...VERIFIED_CLI_VERSIONS[id]];
    try {
      const agentRoot = join(this.options.dataDir, 'plugins', id);
      const current = await realpath(join(agentRoot, 'current'));
      const contained = await this.assertDirectProxyDirectory(agentRoot, current);
      const manifest = await this.validateProxyDirectory(contained, id, undefined, false);
      return verifiedCliVersionsFromManifest(manifest, id);
    } catch {
      return [...VERIFIED_CLI_VERSIONS[id]];
    }
  }

  private async proxyStatus(id: LegacyExecutorId): Promise<Omit<AgentProxyStatus, 'defaults'>> {
    const path = this.proxyEntry(id);
    if (!this.options.managedProxies) {
      if (!(await existsReadable(path))) {
        return {
          state: 'missing',
          path,
          version: null,
          source: 'development',
        };
      }
      // Development mode: report the vendored Proxy package's own version
      // (e.g. @gian/cc-proxy 0.2.1), never the App's release version.
      let version = this.releaseVersion;
      try {
        version = await pluginVersionFromEntry(path);
      } catch {
        // Entry without a resolvable @gian/*-proxy package (test fixtures)
        // keeps the App version as a diagnostic fallback.
      }
      return {
        state: 'ready',
        path,
        version,
        verifiedCliVersions: await this.verifiedCliVersions(id),
        source: 'development',
      };
    }
    try {
      const agentRoot = join(this.options.dataDir, 'plugins', id);
      const current = await realpath(join(agentRoot, 'current'));
      const contained = await this.assertDirectProxyDirectory(agentRoot, current);
      const manifest = await this.validateProxyDirectory(contained, id, undefined, false);
      const version = proxyManifestVersion(manifest);
      return {
        state: isCompatibleProxyManifest(manifest, this.releaseVersion)
          ? 'ready'
          : 'outdated',
        path: join(contained, manifest.entry),
        version,
        verifiedCliVersions: verifiedCliVersionsFromManifest(manifest, id),
        source: 'github-release',
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        state: code === 'ENOENT' ? 'missing' : 'invalid',
        path,
        version: null,
        source: 'github-release',
        ...(code === 'ENOENT'
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      };
    }
  }

  private async validateProxyDirectory(
    directory: string,
    id: LegacyExecutorId,
    expectedVersion?: string,
    selfTest = true,
  ): Promise<ProxyManifest> {
    const raw = await readFile(join(directory, 'manifest.json'), 'utf8');
    const candidate = JSON.parse(raw) as unknown;
    let validated: ProxyManifest;
    const legacy = objectRecord(candidate);
    if (legacy?.['schemaVersion'] === 1) {
      if (
        legacy['id'] !== id
        || legacy['entry'] !== PROXY_ENTRY
        || typeof legacy['version'] !== 'string'
        || (expectedVersion && legacy['version'] !== expectedVersion)
      ) {
        throw new Error(`Invalid ${id} proxy manifest.`);
      }
      validated = candidate as LegacyProxyManifest;
    } else {
      const parsed = manifestSchema.safeParse(candidate);
      if (
        !parsed.success
        || parsed.data.id !== pluginIdFor(id)
        || (expectedVersion && parsed.data.pluginVersion !== expectedVersion)
      ) {
        throw new Error(`Invalid ${id} proxy manifest.`);
      }
      validated = parsed.data as ManagedProxyManifest;
    }
    if (validated.id !== pluginIdFor(id)) {
      throw new Error(`Invalid ${id} proxy manifest.`);
    }
    const resolvedDirectory = await realpath(directory);
    const entry = join(resolvedDirectory, validated.entry);
    const entryInfo = await lstat(entry);
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) {
      throw new Error(`Invalid ${id} proxy entry.`);
    }
    const resolvedEntry = await realpath(entry);
    if (relative(resolvedDirectory, resolvedEntry) !== validated.entry) {
      throw new Error(`Unsafe ${id} proxy entry.`);
    }
    await access(resolvedEntry, constants.R_OK);
    if (validated.schemaVersion === 3 || validated.schemaVersion === 4) {
      await this.readProxyLogoAsset(resolvedDirectory, validated.branding.logo.light);
      if (validated.branding.logo.dark) {
        await this.readProxyLogoAsset(resolvedDirectory, validated.branding.logo.dark);
      }
    }
    if (!isLegacyProxyManifest(validated)) {
      for (const skill of validated.skills ?? []) {
        const candidate = join(resolvedDirectory, skill.path);
        const info = await lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_PROXY_SKILL_BYTES) {
          throw new Error('Invalid Proxy Skill asset.');
        }
        const resolved = await realpath(candidate);
        if (relative(resolvedDirectory, resolved) !== skill.path) {
          throw new Error('Unsafe Proxy Skill asset.');
        }
        const sha256 = createHash('sha256').update(await readFile(resolved)).digest('hex');
        if (sha256 !== skill.sha256) throw new Error('Proxy Skill checksum mismatch.');
      }
    }
    if (selfTest) await this.runProxySelfTest(resolvedDirectory, validated);
    return validated;
  }

  private async readProxyLogoAsset(
    directory: string,
    descriptor: ManagedProxyManifestV3['branding']['logo']['light'],
  ): Promise<{ bytes: Buffer; mediaType: 'image/png' | 'image/webp'; sha256: string }> {
    const candidate = join(directory, descriptor.path);
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_PROXY_LOGO_BYTES) {
      throw new Error('Invalid Proxy logo asset.');
    }
    const resolved = await realpath(candidate);
    if (relative(directory, resolved) !== descriptor.path) {
      throw new Error('Unsafe Proxy logo asset.');
    }
    const bytes = await readFile(resolved);
    const validPng = descriptor.mediaType === 'image/png'
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const validWebp = descriptor.mediaType === 'image/webp'
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!validPng && !validWebp) throw new Error('Proxy logo media type mismatch.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== descriptor.sha256) throw new Error('Proxy logo checksum mismatch.');
    return { bytes, mediaType: descriptor.mediaType, sha256 };
  }

  private async runProxySelfTest(
    directory: string,
    manifest: ProxyManifest,
  ): Promise<void> {
    const entry = join(directory, manifest.entry);
    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync(process.execPath, [entry, '--self-test'], {
        timeout: PROXY_SELF_TEST_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
            ...(!isLegacyProxyManifest(manifest)
              ? {
                GIAN_PLUGIN_ID: manifest.id,
                GIAN_PROTOCOL_VERSIONS: manifest.schemaVersion === 4
                  ? PROTOCOL_V22
                  : SUPPORTED_PROTOCOL_VERSIONS.join(','),
              }
              : {}),
        },
      });
      stdout = String(result.stdout).trim();
      stderr = String(result.stderr).trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${manifest.id} proxy self-test failed: ${detail}`);
    }

    let response: {
      schemaVersion?: unknown;
      id?: unknown;
      pluginVersion?: unknown;
      ok?: unknown;
    };
    try {
      response = JSON.parse(stdout) as typeof response;
    } catch {
      throw new Error(
        `${manifest.id} proxy self-test returned invalid JSON${stderr ? `: ${stderr}` : '.'}`,
      );
    }
    const validLegacy = isLegacyProxyManifest(manifest)
      && response.schemaVersion === 1;
    const validV2 = !isLegacyProxyManifest(manifest)
      && response.schemaVersion === manifest.schemaVersion
      && response.pluginVersion === manifest.pluginVersion;
    if ((!validLegacy && !validV2) || response.id !== manifest.id || response.ok !== true) {
      throw new Error(`${manifest.id} proxy self-test returned an invalid result.`);
    }
  }

  private async activateProxy(
    agentRoot: string,
    id: LegacyExecutorId,
    version: string,
    updateOwner: AgentUpdateLease,
  ): Promise<void> {
    const current = join(agentRoot, 'current');
    const temporary = join(agentRoot, `.current-${randomUUID()}`);
    const previousVersion = await this.previousValidatedProxyVersion(agentRoot, current, id);
    const candidate = join(agentRoot, version);
    const resolvedCandidate = await this.assertDirectProxyDirectory(agentRoot, candidate);
    const manifest = await this.validateProxyDirectory(resolvedCandidate, id, version);
    if (!isCompatibleProxyManifest(manifest, this.releaseVersion)) {
      throw new Error(`${id} Proxy does not support ${PROTOCOL_NAME}/${PROTOCOL_V2}.`);
    }
    // Compatibility is a gate before the atomic pointer swap. While this is
    // pending or failing, every reader continues to resolve the old `current`.
    const activationProbe = this.options.proxyActivationProbe ?? (
      input => this.runProxyCompatibilityProbe(input, updateOwner)
    );
    const probeInput = {
      id,
      version: proxyManifestVersion(manifest),
      entryPath: join(resolvedCandidate, manifest.entry),
      protocol: proxyManifestProtocol(manifest),
      ...(!isLegacyProxyManifest(manifest)
        ? { processScope: manifest.process.scope, schemaVersion: manifest.schemaVersion }
        : {}),
    };
    await activationProbe(probeInput);

    await symlink(version, temporary, 'dir');
    try {
      // On the supported platform rename replaces the existing symlink in one
      // atomic namespace operation. Readers therefore observe either the old
      // validated immutable version or the new validated version, never a
      // missing path or a version whose compatibility probe is still pending.
      await (this.options.proxyActivationSwap ?? rename)(temporary, current);
      this.options.readinessCache?.invalidate(pluginIdForExecutorId(id));
    } catch (error) {
      throw new Error(
        `${id} Proxy activation failed; ${previousVersion
          ? 'kept the previous validated version.'
          : 'active target was not changed.'}`,
        { cause: error },
      );
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async previousValidatedProxyVersion(
    agentRoot: string,
    current: string,
    id: LegacyExecutorId,
  ): Promise<string | null> {
    try {
      const info = await lstat(current);
      if (!info.isSymbolicLink()) {
        throw new Error(`Refusing to replace non-symlink plugin path: ${current}`);
      }
      const version = await readlink(current);
      if (
        !version
        || isAbsolute(version)
        || basename(version) !== version
        || version === '.'
        || version === '..'
      ) {
        throw new Error(`Refusing unsafe active Proxy target: ${version}`);
      }
      const directory = join(agentRoot, version);
      try {
        const resolved = await this.assertDirectProxyDirectory(agentRoot, directory);
        await this.validateProxyDirectory(resolved, id, version);
        return version;
      } catch {
        // A lexically safe but missing, escaped, or failed target is not LKG.
        // A valid replacement may repair it, but it is never promised as the
        // rollback target or described as a validated prior version.
        return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async assertDirectProxyDirectory(
    agentRoot: string,
    directory: string,
  ): Promise<string> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Proxy version is not an immutable directory: ${directory}`);
    }
    const [resolvedRoot, resolvedDirectory] = await Promise.all([
      realpath(agentRoot),
      realpath(directory),
    ]);
    const rel = relative(resolvedRoot, resolvedDirectory);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || basename(rel) !== rel) {
      throw new Error(`Proxy version escapes its Agent root: ${directory}`);
    }
    return resolvedDirectory;
  }

  private async resolveCompatibilityRuntime(
    id: LegacyExecutorId,
    _updateOwner: AgentUpdateLease,
  ): Promise<LegacyRuntimeProbe> {
    const path = this.firstAgentPath(id) ?? this.configuredPath(id);
    if (!path) {
      throw new Error(`${id} CLI must be selected before its Proxy can be activated.`);
    }
    await assertSavedAbsoluteRuntimePath(path);
    return {
      cli: id,
      binaryPath: path,
      version: '0.0.0',
      source: 'override',
      env: Object.freeze({}),
    };
  }

  private async runProxyCompatibilityProbe(input: {
    id: LegacyExecutorId;
    version: string;
    entryPath: string;
    protocol: ProxyWireProtocol;
    processScope?: ManagedProxyManifestV2['process']['scope'];
    schemaVersion?: 2 | 3 | 4;
  }, updateOwner: AgentUpdateLease, exactRuntime?: LegacyRuntimeProbe): Promise<void> {
    const generic = input.schemaVersion === 4;
    if (generic) {
      try {
        await runNoRuntimeActivationHandshake({
          pluginId: pluginIdFor(input.id),
          pluginVersion: input.version,
          processScope: input.processScope ?? 'session',
          entryPath: input.entryPath,
          dataDir: this.options.dataDir,
          hostVersion: this.releaseVersion,
          protector: updateOwner,
          label: `${input.id} Proxy compatibility process`,
          timeoutMs: PROXY_COMPATIBILITY_TIMEOUT_MS,
          ...(this.options.shutdownProxyProcessImpl
            ? { shutdownProcess: this.options.shutdownProxyProcessImpl }
            : {}),
        });
      } catch (error) {
        if (error instanceof PluginStoreError) {
          throw new Error(error.message);
        }
        throw error;
      }
      return;
    }
    const offered = [...SUPPORTED_PROTOCOL_VERSIONS];
    const runtime = exactRuntime ?? await this.resolveCompatibilityRuntime(input.id, updateOwner);
    const probeDirectory = join(
      this.options.dataDir,
      'compatibility-probes',
      `${input.id}-${randomUUID()}`,
    );
    await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
    if (input.protocol !== PROTOCOL_NAME) {
      throw new Error(`${input.id} Proxy must speak ${PROTOCOL_NAME}/${PROTOCOL_V2}.`);
    }
    const validator = new HostProtocolValidator({
      pluginId: pluginIdFor(input.id),
      pluginVersion: input.version,
      ...(input.processScope ? { processScope: input.processScope } : {}),
    });
    await runProtectedProxyChild({
      label: `${input.id} Proxy compatibility process`,
      args: [input.entryPath],
      env: {
        ...process.env,
        ...(runtime?.env ?? {}),
        GIAN_PLUGIN_ID: pluginIdFor(input.id),
        GIAN_PLUGIN_DATA_DIR: probeDirectory,
        ...(runtime ? { GIAN_RUNTIME_BIN: runtime.binaryPath } : {}),
        GIAN_PROTOCOL_VERSIONS: offered.join(','),
      },
      protector: updateOwner,
      timeoutMs: PROXY_COMPATIBILITY_TIMEOUT_MS,
      probeDirectory,
      shutdownProcess: this.options.shutdownProxyProcessImpl,
      work: async (context) => {
        const request = async (
          id: string,
          method: string,
          params: Record<string, unknown> = {},
        ): Promise<unknown> => {
          const payload = { jsonrpc: '2.0', id, method, params };
          validator.registerRequest(payload);
          if (context.isExited()) {
            throw new Error(`${input.id} Proxy compatibility process stopped: ${context.processFailureDetail()}`);
          }
          await writeJsonRpc(context.child, payload, context.deadline);
          while (true) {
            const next = await Promise.race([context.iterator.next(), context.deadline]);
            if (next.done) {
              throw new Error(`${input.id} Proxy compatibility process stopped: ${context.processFailureDetail()}`);
            }
            const accepted = validator.acceptLine(next.value);
            if (accepted === null || !('id' in accepted)) continue;
            if (accepted.id !== id) continue;
            if (accepted.error !== undefined) {
              const error = objectRecord(accepted.error);
              throw new Error(
                `${input.id} Proxy ${method} failed: ${String(error?.['message'] ?? error?.['code'])}`,
              );
            }
            return accepted.result;
          }
        };
        const initialized = await request('req-1', 'initialize', {
          protocol: {
            name: PROTOCOL_NAME,
            versions: [...offered],
          },
          host: { name: 'Gian', version: this.releaseVersion },
        });
        validateProxyInitialize(input.id, initialized);
        if (validator.initializeResult?.plugin.version !== input.version) {
          throw new Error(`${input.id} Proxy handshake version does not match its manifest.`);
        }
        await request('req-2', 'catalog.list');
        await request('req-3', 'shutdown');
      },
    });
  }

  private async download(url: string, maxBytes: number): Promise<Buffer> {
    const response = await this.fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
      headers: { accept: 'application/octet-stream' },
    });
    if (!response.ok) {
      throw new Error(`Download failed (${response.status}): ${url}`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error(`Download is too large: ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > maxBytes) {
      throw new Error(`Download size is invalid: ${url}`);
    }
    return buffer;
  }

  private async resolveProxyRelease(id: LegacyExecutorId): Promise<ProxyRelease> {
    if (!this.options.independentProxyReleases) {
      return { tag: `v${this.releaseVersion}`, version: this.releaseVersion };
    }
    const url = `https://api.github.com/repos/${this.releaseRepository}/releases?per_page=100`;
    const response = await this.fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub Proxy release lookup failed (${response.status}): ${url}`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 512 * 1024) {
      throw new Error(`GitHub Proxy release metadata is too large: ${url}`);
    }
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length === 0 || raw.length > 512 * 1024) {
      throw new Error(`GitHub Proxy release metadata size is invalid: ${url}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      throw new Error(`GitHub Proxy release metadata is not valid JSON: ${url}`);
    }
    const candidates = parseIndependentProxyReleaseCandidates(parsed, id);
    for (const candidate of candidates) {
      const archiveName = `gian-proxy-${id}-${candidate.version}-darwin-arm64.tar.gz`;
      const manifestName = `${archiveName}.manifest.json`;
      const digests = parseReleaseAssetDigests(candidate.metadata, candidate.tag, [manifestName]);
      const manifestUrl = `https://github.com/${this.releaseRepository}/releases/download/${candidate.tag}/${manifestName}`;
      const manifestBody = await this.download(manifestUrl, MAX_PROXY_MANIFEST_BYTES);
      const actualDigest = createHash('sha256').update(manifestBody).digest('hex');
      if (actualDigest !== digests.get(manifestName)) {
        throw new Error(`${id} Proxy release manifest failed official integrity verification.`);
      }
      let manifestValue: unknown;
      try {
        manifestValue = JSON.parse(manifestBody.toString('utf8')) as unknown;
      } catch {
        throw new Error(`${id} Proxy release manifest is not valid JSON.`);
      }
      const manifest = manifestSchema.safeParse(manifestValue);
      if (
        !manifest.success
        || manifest.data.id !== pluginIdFor(id)
        || manifest.data.pluginVersion !== candidate.version
      ) {
        throw new Error(`${id} Proxy release manifest does not match ${candidate.tag}.`);
      }
      if (isCompatibleProxyManifest(manifest.data as ManagedProxyManifest, this.releaseVersion)) {
        return { tag: candidate.tag, version: candidate.version };
      }
    }
    throw new Error(
      `No stable ${id} Proxy release supports ${PROTOCOL_NAME}/${SUPPORTED_PROTOCOL_VERSIONS.join(',')}.`,
    );
  }

  private async releaseAssetDigests(
    tag: string,
    filenames: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const url = `https://api.github.com/repos/${this.releaseRepository}/releases/tags/${tag}`;
    const response = await this.fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub release integrity lookup failed (${response.status}): ${url}`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 512 * 1024) {
      throw new Error(`GitHub release integrity metadata is too large: ${url}`);
    }
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length === 0 || raw.length > 512 * 1024) {
      throw new Error(`GitHub release integrity metadata size is invalid: ${url}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      throw new Error(`GitHub release integrity metadata is not valid JSON: ${url}`);
    }
    return parseReleaseAssetDigests(parsed, tag, filenames);
  }

  private async readPersistedConfig(): Promise<AgentConfigFile> {
    try {
      const parsed = parseConfig(await readFile(this.configPath, 'utf8'));
      // A v1 file can still appear here when an older Host wrote it after
      // this Host migrated in memory. Migrate it again on the fly; the next
      // successful commit persists v5.
      return parsed.schemaVersion === 5 ? parsed : await this.migrateV1(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
      throw error;
    }
  }

  private async acquireConfigMutationTurn(): Promise<() => void> {
    const previous = this.configMutationTail;
    let finish!: () => void;
    const current = new Promise<void>(resolve => { finish = resolve; });
    this.configMutationTail = previous.then(() => current);
    await previous;
    return finish;
  }

  private async saveConfig(config: AgentConfigFile = this.config): Promise<void> {
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    const persisted = this.options.managedProxies
      ? {
        ...config,
        agents: config.agents.map(({ cliPath: _legacyCliPath, ...agent }) => agent),
      }
      : config;
    try {
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, this.configPath);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Agent configuration save failed and its temporary file could not be removed.',
        );
      }
      throw error;
    }
  }

  private async withAgentUpdateLock<T>(
    id: LegacyExecutorId,
    operation: string,
    run: (owner: AgentUpdateLease) => Promise<T>,
    scope: 'cli-update' | 'proxy-update' = 'cli-update',
  ): Promise<T> {
    // Vendor CLIs live under the user's HOME and are shared by GianDev,
    // packaged Gian, and worktree profiles with different data directories.
    // Use one HOME-scoped namespace for CLI use and both updater kinds. The
    // scope matrix blocks CLI mutation against every runtime while permitting
    // a read-only Proxy compatibility probe alongside CLI use.
    const lease = await (scope === 'proxy-update'
      ? acquireAgentProxyUpdateLock(this.updateLockDataDir(), id, operation)
      : acquireAgentUpdateLock(this.updateLockDataDir(), id, operation));
    try {
      return await run(lease);
    } finally {
      await lease.release();
    }
  }

  private runOperation(
    key: string,
    operation: () => Promise<AgentInstallResult>,
  ): Promise<AgentInstallResult> {
    const existing = this.operations.get(key);
    if (existing) return existing;
    const pending = operation().finally(() => {
      if (this.operations.get(key) === pending) this.operations.delete(key);
    });
    this.operations.set(key, pending);
    return pending;
  }

  private invalidateStatus(id: LegacyExecutorId): void {
    this.statusCache.delete(id);
    this.statusGenerations.set(id, (this.statusGenerations.get(id) ?? 0) + 1);
  }

  private invalidateAgentStatus(id: string): void {
    this.agentStatusCache.delete(id);
    this.agentStatusGenerations.set(id, (this.agentStatusGenerations.get(id) ?? 0) + 1);
  }
}
