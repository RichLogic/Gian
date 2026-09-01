import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
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
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import {
  HostProtocolValidator,
  PROTOCOL_NAME,
  PROTOCOL_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  manifestSchema,
  protocolRangeIncludes,
  readNdjsonLines,
  type ManifestV2,
  type ManifestV3,
} from '@gian/proxy-protocol';
import type {
  AgentCliStatus,
  AgentInstallResult,
  AgentInstallStatus,
  AgentProxyDefaults,
  AgentProxyStatus,
  AgentProxyUpdateCheck,
  AgentRuntimeProfile,
  Executor,
  ProductExecutor,
  ProxyCatalogEntry,
  UserAgent,
  UserAgentStatus,
} from '@gian/shared';
import {
  EXECUTOR_DEFS,
  EXECUTOR_IDS,
  isProductExecutor,
  migrateLegacyGrokProxyDefaults,
  PRODUCT_EXECUTORS,
} from '@gian/shared';
import { CommandRuntimeProvider } from '../runtime/command-provider.js';
import { ZCODE_CLI_CONFIG_READINESS_ISSUE, ZcodeRuntimeProvider } from '../runtime/zcode-provider.js';
import { DshRuntimeProvider } from '../runtime/dsh-provider.js';
import { DshRuntimeInstaller } from '../runtime/dsh-installer.js';
import { KimiSessionStoreRuntimeProvider } from '../runtime/kimi-session-store.js';
import { runProtectedCommand } from '../runtime/protected-command.js';
import type { CliRuntimeProvider, RuntimeProbe } from '../runtime/types.js';
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

const execFileAsync = promisify(execFile);
const CONFIG_FILE = 'agents.json';
const CONFIG_LOCK_AGENT_ID = '__agent-config__';
const PROXY_ENTRY = 'proxy.mjs';
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024;
const MAX_PROXY_BYTES = 64 * 1024 * 1024;
const MAX_PROXY_MANIFEST_BYTES = 64 * 1024;
const MAX_PROXY_LOGO_BYTES = 512 * 1024;
const MAX_PROXY_SKILL_BYTES = 512 * 1024;
const PROXY_SELF_TEST_TIMEOUT_MS = 5_000;
const PROXY_COMPATIBILITY_TIMEOUT_MS = 30_000;
const STATUS_CACHE_TTL_MS = 30_000;
const VERIFIED_CLI_VERSIONS: Record<Executor, string[]> = {
  claude: ['2.1.159'],
  codex: ['0.146.0'],
  // Only the CLI version with a completed real regression of the ACP
  // terminal capability; 0.31.1 never ran that regression (plan §0.8).
  kimi: ['0.38.0'],
  grok: ['1.0.4'],
  // Resolved from the official npm latest dist-tag at install/probe time;
  // this value is only a diagnostic fallback (plan §0).
  dsh: ['0.1.0-rc.7'],
  // WP0-verified exact version (Revision 2 §1.3: precise SemVer only).
  zcode: ['0.16.5'],
};

const DEVELOPMENT_PROCESS_SCOPE: Record<Executor, 'shared' | 'session'> =
  Object.fromEntries(
    EXECUTOR_IDS.map((id) => [id, EXECUTOR_DEFS[id].processScope]),
  ) as Record<Executor, 'shared' | 'session'>;

interface AgentDefinition {
  id: Executor;
  name: string;
  command: string;
  installerUrl: string;
  installerSha256: string;
  officialPaths: (home: string) => string[];
}

interface AgentConfigFileV1 {
  schemaVersion: 1;
  cliPaths: Partial<Record<Executor, string>>;
  proxyDefaults: Partial<Record<Executor, AgentProxyDefaults>>;
}

/** agents.json schema v3: Agents are user entities keyed by uuid. The Proxy
 *  kind catalog is NOT persisted here — it lives in the AGENTS definitions. */
interface AgentConfigFile {
  schemaVersion: 3;
  agents: UserAgent[];
}

interface LegacyProxyManifest {
  schemaVersion: 1;
  id: Executor;
  version: string;
  entry: typeof PROXY_ENTRY;
}

type ManagedProxyManifestV2 = Omit<ManifestV2, 'id'> & { id: Executor };
type ManagedProxyManifestV3 = Omit<ManifestV3, 'id'> & { id: Executor };
type ManagedProxyManifest = ManagedProxyManifestV2 | ManagedProxyManifestV3;
type ProxyManifest = LegacyProxyManifest | ManagedProxyManifest;
type ProxyWireProtocol = 'legacy' | typeof PROTOCOL_NAME;

export interface ProxyLaunchDescriptor {
  entryPath: string;
  protocol?: {
    pluginVersion: string;
    processScope: ManagedProxyManifestV2['process']['scope'];
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
  developmentProxyEntries?: Partial<Record<Executor, string>>;
  environmentCliPaths?: Partial<Record<Executor, string>>;
  homeDir?: string;
  kimiCodeHome?: string;
  pathEnv?: string;
  fetchImpl?: typeof fetch;
  /** Test/release-audit override for the reviewed official installer pin. */
  officialInstallerSha256?: Partial<Record<Executor, string>>;
  /** One-time migration source for defaults previously stored in SystemConfig. */
  legacyProxyDefaults?: Partial<Record<Executor, Partial<AgentProxyDefaults>>>;
  /** v2 migration source: executors that appear in existing sessions. A kind
   *  with no configured path, no installed Proxy, and no session history does
   *  NOT get an auto-created Agent. */
  sessionExecutors?: () => Executor[] | Promise<Executor[]>;
  /** Test override for the production initialize + capabilities handshake.
   * Omitted in production so the candidate process and resolved vendor CLI
   * must complete the real stdio protocol before activation. */
  proxyActivationProbe?: (input: {
    id: Executor;
    version: string;
    entryPath: string;
    protocol: ProxyWireProtocol;
    processScope?: ManagedProxyManifestV2['process']['scope'];
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
}

const AGENTS: Record<Executor, AgentDefinition> = {
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
    // surface while actual install goes through DshRuntimeProvider.
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
  return { schemaVersion: 3, agents: [] };
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

/** Lenient read-side normalization of one persisted Agent. Returns null for
 *  entries that cannot identify a usable Agent at all (bad id/name/kind). */
function normalizeUserAgent(value: unknown): UserAgent | null {
  const record = objectRecord(value);
  if (!record) return null;
  const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
  const name = normalizeAgentName(record['name']);
  const proxy = record['proxy'];
  if (!id || !name || !isProductExecutor(proxy)) return null;
  const cliPath = typeof record['cliPath'] === 'string' && isAbsolute(record['cliPath'])
    ? record['cliPath']
    : null;
  return {
    id,
    name,
    proxy,
    cliPath,
    defaults: normalizeProxyDefaults(record['defaults']),
  };
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
  return { schemaVersion: 3, agents };
}

function parseConfigV1(parsed: Partial<AgentConfigFileV1>): AgentConfigFileV1 {
  const cliPaths: Partial<Record<Executor, string>> = {};
  const proxyDefaults: Partial<Record<Executor, AgentProxyDefaults>> = {};
  for (const id of Object.keys(AGENTS) as Executor[]) {
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
  id: Executor,
): string[] {
  if (manifest && !isLegacyProxyManifest(manifest)) {
    const verified = manifest.runtime?.verifiedCliVersions;
    if (verified && verified.length > 0) return [...verified];
    const recommended = manifest.runtime?.recommendedCliVersion;
    if (typeof recommended === 'string' && recommended.length > 0) return [recommended];
  }
  return [...VERIFIED_CLI_VERSIONS[id]];
}

export function recommendedCliVersionFromManifest(
  manifest: ProxyManifest | null | undefined,
  id: Executor,
): string {
  return verifiedCliVersionsFromManifest(manifest, id)[0]!;
}

function runtimeProfileId(input: Omit<AgentRuntimeProfile, 'id'>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function proxyManifestProtocol(manifest: ProxyManifest): ProxyWireProtocol {
  return isLegacyProxyManifest(manifest) ? 'legacy' : manifest.protocol.name;
}

function isCompatibleProxyManifest(
  manifest: ProxyManifest,
  _releaseVersion: string,
): boolean {
  return !isLegacyProxyManifest(manifest)
    && SUPPORTED_PROTOCOL_VERSIONS.some(version => (
      protocolRangeIncludes(manifest.protocol.range, version)
    ));
}

function normalizeRepository(value: string): string {
  const trimmed = value.trim();
  if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(trimmed)) {
    throw new Error('release repository must use owner/name format');
  }
  return trimmed;
}

function managedRuntimeEnvironment(id: Executor): Readonly<Record<string, string>> {
  if (id === 'claude') {
    return { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' };
  }
  if (id === 'kimi') return { KIMI_CODE_NO_AUTO_UPDATE: '1' };
  if (id === 'grok') {
    return {
      GROK_DISABLE_AUTOUPDATER: '1',
      GROK_SANDBOX: 'workspace',
    };
  }
  if (id === 'dsh') {
    return {
      // Telemetry stays opt-out and stdout stays bridge-pure.
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };
  }
  return {};
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
  id: Executor,
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
  id: Executor,
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
export function pluginIdFor(id: Executor): string {
  return EXECUTOR_DEFS[id].pluginId;
}

function validateProxyInitialize(id: Executor, value: unknown): void {
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
  private readonly kimiCodeHome: string;
  private readonly fetchImpl: typeof fetch;
  private readonly releaseVersion: string;
  private readonly releaseRepository: string;
  private readonly providers = new Map<Executor, CliRuntimeProvider>();
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
  private configMutationTail: Promise<void> = Promise.resolve();
  private config: AgentConfigFile = emptyConfig();

  private constructor(private readonly options: AgentManagerOptions) {
    this.configPath = join(options.dataDir, CONFIG_FILE);
    this.homeDir = options.homeDir ?? homedir();
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
    for (const definition of Object.values(AGENTS)) {
      const defaultKimiBinary = join(this.kimiCodeHome, 'bin', 'kimi');
      const officialPaths = () => definition.id === 'kimi'
        ? [
          defaultKimiBinary,
          ...definition.officialPaths(this.homeDir).filter(path => path !== defaultKimiBinary),
        ]
        : definition.officialPaths(this.homeDir);
      const commandProvider = new CommandRuntimeProvider({
        id: definition.id,
        command: definition.command,
        // The closure only consults the environment override. A saved Agent's
        // explicit path reaches the provider through inspectInstalled(path) /
        // CliRuntimeManager.acquire(kind, path), never through this global.
        configuredPath: () => this.options.environmentCliPaths?.[definition.id],
        officialPaths,
        pathEnv: () => options.pathEnv ?? process.env.PATH,
        env: {
          ...managedRuntimeEnvironment(definition.id),
          ...(definition.id === 'kimi' ? { KIMI_CODE_HOME: this.kimiCodeHome } : {}),
        },
      });
      this.providers.set(
        definition.id,
        definition.id === 'kimi'
          ? new KimiSessionStoreRuntimeProvider(commandProvider, this.kimiCodeHome)
          : definition.id === 'dsh'
            ? new DshRuntimeProvider({
                dataDir: join(options.dataDir, 'runtimes', 'deepseek-harness'),
                overridePath: options.environmentCliPaths?.dsh,
                pathEnv: options.pathEnv,
              })
            : definition.id === 'zcode'
              ? new ZcodeRuntimeProvider({
                  overridePath: options.environmentCliPaths?.zcode,
                  ...(options.pathEnv !== undefined ? { pathEnv: options.pathEnv } : {}),
                  // Keep the config-readiness check inside the manager's HOME
                  // boundary so tests (and packaged runs) stay hermetic.
                  ...(options.homeDir !== undefined ? { home: options.homeDir } : {}),
                })
              : commandProvider,
      );
    }
  }

  static async create(options: AgentManagerOptions): Promise<AgentManager> {
    const manager = new AgentManager(options);
    await mkdir(options.dataDir, { recursive: true });
    let persisted: AgentConfigFile | AgentConfigFileV1;
    let needsSave = false;
    try {
      const raw = await readFile(manager.configPath, 'utf8');
      const source = JSON.parse(raw) as { schemaVersion?: unknown };
      needsSave = source.schemaVersion !== 3;
      persisted = parseConfig(raw);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      persisted = emptyConfigV1();
    }
    if (persisted.schemaVersion === 3) {
      manager.config = persisted;
      if (needsSave) await manager.saveConfig();
      return manager;
    }
    manager.config = await manager.migrateV1(persisted);
    await manager.saveConfig();
    return manager;
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
      const cliPath = v1.cliPaths[kind]
        ?? (typeof envPath === 'string' && isAbsolute(envPath) ? envPath : null)
        ?? null;
      const legacy = this.options.legacyProxyDefaults?.[kind];
      const defaults = v1.proxyDefaults[kind]
        ?? (legacy ? normalizeProxyDefaults(legacy) : emptyProxyDefaults());
      const configured = cliPath !== null
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
        proxy: kind,
        cliPath,
        defaults,
      });
    }
    return { schemaVersion: 3, agents };
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

  runtimeProviders(): CliRuntimeProvider[] {
    return Array.from(this.providers.values());
  }

  updateLockDataDir(): string {
    return join(this.homeDir, '.gian');
  }

  proxyEntry(id: Executor): string {
    if (!this.options.managedProxies) {
      const entry = this.options.developmentProxyEntries?.[id];
      if (!entry) throw new Error(`development proxy entry is not configured: ${id}`);
      return entry;
    }
    return join(this.options.dataDir, 'plugins', id, 'current', PROXY_ENTRY);
  }

  async proxyLaunchDescriptor(id: Executor, version?: string | null): Promise<ProxyLaunchDescriptor> {
    if (!this.options.managedProxies) {
      const entryPath = this.proxyEntry(id);
      const pluginVersion = await pluginVersionFromEntry(entryPath);
      if (version && version !== pluginVersion) {
        throw new Error(`${id} development Proxy ${version} is not available (current ${pluginVersion})`);
      }
      return {
        entryPath,
        protocol: {
          pluginVersion,
          processScope: DEVELOPMENT_PROCESS_SCOPE[id],
        },
      };
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
    return {
      entryPath: join(contained, manifest.entry),
      ...(!isLegacyProxyManifest(manifest)
        ? {
            protocol: {
              pluginVersion: manifest.pluginVersion,
              processScope: manifest.process.scope,
            },
          }
        : {}),
    };
  }

  /** Kind-level statuses for the PRODUCT catalog (no Grok). Used by draft
   *  Agents and onboarding; saved-Agent statuses go through agentStatus(). */
  async list(refresh = false): Promise<AgentInstallStatus[]> {
    return Promise.all(PRODUCT_EXECUTORS.map(id => this.status(id, refresh)));
  }

  async status(id: Executor, refresh = false): Promise<AgentInstallStatus> {
    return this.statusInternal(id, refresh);
  }

  private async statusUnderUpdateLock(
    id: Executor,
    owner: AgentUpdateLease,
  ): Promise<AgentInstallStatus> {
    return this.statusInternal(id, true, owner);
  }

  private async statusInternal(
    id: Executor,
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
  configuredPath(id: Executor): string | null {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    return this.options.environmentCliPaths?.[id] ?? null;
  }

  /** Kind-level defaults view used by legacy callers (session creation until
   *  it resolves the Session's own Agent, and the kind status payload): the
   *  first saved Agent of the kind wins. */
  proxyDefaults(id: Executor): AgentProxyDefaults {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    const agent = isProductExecutor(id)
      ? this.config.agents.find(candidate => candidate.proxy === id)
      : undefined;
    const defaults = { ...(agent?.defaults ?? emptyProxyDefaults()) };
    return id === 'grok' ? migrateLegacyGrokProxyDefaults(defaults) : defaults;
  }

  // ------------------------------------------------------------------
  // User Agents (agents.json schema v3)
  // ------------------------------------------------------------------

  listAgents(): UserAgent[] {
    return this.config.agents.map(agent => ({ ...agent, defaults: { ...agent.defaults } }));
  }

  getAgent(id: string): UserAgent {
    const agent = this.config.agents.find(candidate => candidate.id === id);
    if (!agent) throw new Error(`agent not found: ${id}`);
    return { ...agent, defaults: { ...agent.defaults } };
  }

  agentDefaults(id: string): AgentProxyDefaults {
    return { ...this.getAgent(id).defaults };
  }

  /** Resolved runtime CLI path for one saved Agent: its own path, then the
   *  kind's environment override, then null (provider auto-scan). */
  agentRuntimePath(id: string): { proxy: ProductExecutor; cliPath: string | null } {
    const agent = this.getAgent(id);
    return {
      proxy: agent.proxy,
      cliPath: agent.cliPath ?? this.options.environmentCliPaths?.[agent.proxy] ?? null,
    };
  }

  /** First locally detected CLI candidate for a kind (PATH then official
   *  install locations). Filesystem scan only — never spawns a probe. Used
   *  to prefill a draft Agent's Path. */
  async scannedCliPath(id: Executor): Promise<string | null> {
    const provider = this.providers.get(id);
    if (!provider) return null;
    try {
      const installed = await provider.inspectInstalled();
      return installed[0]?.binaryPath ?? null;
    } catch {
      return null;
    }
  }

  /** The kind's default runtime path — its first saved Agent's resolved
   *  path, or the environment override when the kind has no Agent. */
  firstAgentPath(id: Executor): string | null {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    if (isProductExecutor(id)) {
      const agent = this.config.agents.find(candidate => candidate.proxy === id);
      if (agent) return this.agentRuntimePath(agent.id).cliPath;
    }
    return this.options.environmentCliPaths?.[id] ?? null;
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
      if (manifest.schemaVersion !== 3) return null;
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
    proxy: ProductExecutor;
    cliPath?: string | null;
    defaults?: Partial<AgentProxyDefaults>;
  }): Promise<UserAgent> {
    if (!isProductExecutor(input.proxy)) {
      throw new Error(`unsupported proxy: ${String(input.proxy)}`);
    }
    const proxy = input.proxy;
    const name = normalizeAgentName(input.name);
    if (!name) throw new Error('Agent name must not be empty');
    const cliPath = normalizeCliPathInput(input.cliPath);
    // The per-kind claim excludes updater/path writers while the candidate
    // path is being probed; a path-less create only needs the config claim.
    const kinds = cliPath !== null ? [proxy] : [];
    const agent = await this.withAgentConfigLock(kinds, 'Agent create', async (current, leases) => {
      assertAgentNameAvailable(current.agents, name);
      if (cliPath !== null) {
        await this.probeAgentCliPath(proxy, cliPath, leases.get(proxy)!);
      }
      const agent: UserAgent = {
        id: randomUUID(),
        name,
        proxy,
        cliPath,
        defaults: normalizeProxyDefaults(input.defaults),
      };
      await this.commitConfig(
        { schemaVersion: 3, agents: [...current.agents, agent] },
        [agent.id],
        [proxy],
      );
      return agent;
    });
    if (agent.proxy === 'codex') await this.reconcileManagedSkills();
    return agent;
  }

  async updateAgent(id: string, patch: {
    name?: string;
    cliPath?: string | null;
    proxy?: ProductExecutor;
    defaults?: Partial<AgentProxyDefaults>;
  }): Promise<UserAgent> {
    const existing = this.getAgent(id);
    const nextProxy = patch.proxy ?? existing.proxy;
    if (!isProductExecutor(nextProxy)) {
      throw new Error(`unsupported proxy: ${String(patch.proxy)}`);
    }
    const name = patch.name !== undefined ? normalizeAgentName(patch.name) : existing.name;
    if (!name) throw new Error('Agent name must not be empty');
    const cliPath = patch.cliPath !== undefined
      ? normalizeCliPathInput(patch.cliPath)
      : existing.cliPath;
    const pathOrProxyChanged = patch.cliPath !== undefined || patch.proxy !== undefined;
    // Name/defaults stay write-through under the config claim only —
    // they never touch the runtime load set, so they must not queue behind
    // a kind updater. Path/Proxy changes take the kind claim for the probe.
    const claimKinds = pathOrProxyChanged
      ? [...new Set<Executor>([existing.proxy, nextProxy])]
      : [];
    const agent = await this.withAgentConfigLock(claimKinds, 'Agent update', async (current, leases) => {
      assertAgentNameAvailable(current.agents, name, id);
      const index = current.agents.findIndex(candidate => candidate.id === id);
      if (index === -1) throw new Error(`agent not found: ${id}`);
      const previous = current.agents[index]!;
      if (pathOrProxyChanged && cliPath !== null) {
        await this.probeAgentCliPath(nextProxy, cliPath, leases.get(nextProxy)!);
      }
      const agent: UserAgent = {
        ...previous,
        name,
        proxy: nextProxy,
        cliPath,
        defaults: patch.defaults
          ? normalizeProxyDefaults({ ...previous.defaults, ...patch.defaults })
          : previous.defaults,
      };
      const agents = [...current.agents];
      agents[index] = agent;
      // The kind-level status view carries the first-Agent defaults/path, so
      // every committed update invalidates both touched kinds — even a
      // write-through defaults rename.
      await this.commitConfig(
        { schemaVersion: 3, agents },
        [id],
        [...new Set<Executor>([existing.proxy, nextProxy])],
      );
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
      await this.commitConfig({ schemaVersion: 3, agents }, [id], [existing.proxy]);
    });
  }

  /** Live path/Proxy probe status for one saved Agent. The CLI probe resolves
   *  the Agent's own path first (then the kind's environment override, PATH,
   *  and official install locations); the Proxy side stays kind-level because
   *  a kind has exactly one installed Proxy. */
  async agentStatus(id: string, refresh = false): Promise<UserAgentStatus> {
    const agent = this.getAgent(id);
    if (refresh) this.invalidateAgentStatus(id);
    const generation = this.agentStatusGenerations.get(id) ?? 0;
    const cached = this.agentStatusCache.get(id);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.agentStatusProbes.get(id);
    if (!refresh && pending?.generation === generation) return pending.promise;
    const probe = Promise.all([
      this.cliStatus(agent.proxy, undefined, agent.cliPath ?? undefined),
      this.proxyStatus(agent.proxy),
    ]).then(async ([cli, plugin]) => {
      const skill = agent.proxy === 'codex' && plugin.state === 'ready' && plugin.version
        ? await inspectManagedGianSkill(this.homeDir, plugin.version)
        : null;
      const runtimeProfile = agent.proxy === 'codex'
        && cli.state === 'ready'
        && cli.path && cli.version
        && plugin.state === 'ready' && plugin.version
        ? (() => {
            const verifiedCliVersions = plugin.verifiedCliVersions ?? [];
            const profile: Omit<AgentRuntimeProfile, 'id'> = {
              agentId: agent.id,
              proxy: agent.proxy,
              cliPath: cli.path,
              cliVersion: cli.version,
              configHome: process.env.CODEX_HOME && isAbsolute(process.env.CODEX_HOME)
                ? process.env.CODEX_HOME
                : cli.source === 'override' ? null : join(this.homeDir, '.codex'),
              cliFingerprint: cli.contentFingerprint ?? null,
              proxyVersion: plugin.version,
              verifiedCliVersions,
              verification: verifiedCliVersions.includes(cli.version) ? 'verified' : 'unverified',
              skill: {
                name: 'gian-session',
                version: plugin.version,
                state: skill?.state ?? 'missing',
              },
            };
            return { id: runtimeProfileId(profile), ...profile };
          })()
        : null;
      const value: UserAgentStatus = {
        ...agent,
        proxyName: AGENTS[agent.proxy].name,
        ready: cli.state === 'ready' && plugin.state === 'ready',
        cli,
        plugin: { ...plugin, defaults: { ...agent.defaults } },
        runtimeProfile,
        officialInstallUrl: AGENTS[agent.proxy].installerUrl,
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

  private async probeAgentCliPath(
    kind: ProductExecutor,
    path: string,
    claim: AgentUpdateLease,
  ): Promise<void> {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`CLI runtime provider is not configured: ${kind}`);
    const runtime = await provider.probe({ cli: kind, binaryPath: path, source: 'override' }, claim);
    if (kind !== 'codex' || !this.options.managedProxies) return;
    try {
      const descriptor = await this.proxyLaunchDescriptor(kind);
      if (!descriptor.protocol) return;
      await this.runProxyCompatibilityProbe({
        id: kind,
        version: descriptor.protocol.pluginVersion,
        entryPath: descriptor.entryPath,
        protocol: PROTOCOL_NAME,
        processScope: descriptor.protocol.processScope,
      }, claim, runtime);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async commitConfig(
    next: AgentConfigFile,
    invalidateAgentIds: readonly string[] = [],
    invalidateKinds: readonly Executor[] = [],
  ): Promise<void> {
    // Persistence is the commit point. Invalidate immediately so a later
    // claim-retirement failure cannot leave stale statuses cached.
    await this.saveConfig(next);
    this.config = next;
    for (const id of invalidateAgentIds) this.invalidateAgentStatus(id);
    for (const kind of invalidateKinds) this.invalidateStatus(kind);
  }

  /** Serialize agents.json writers in this Host, then across Hosts via the
   *  shared config claim; per-kind claims additionally exclude updater/path
   *  writers while a CLI path is being validated. The callback re-reads the
   *  persisted config so an older snapshot can never overwrite a newer one. */
  private async withAgentConfigLock<T>(
    kinds: readonly Executor[],
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

  installOfficialCli(id: Executor): Promise<AgentInstallResult> {
    return this.runOperation(`cli:${id}`, () => this.withAgentUpdateLock(
      id,
      'official CLI install',
      async updateOwner => {
      const definition = AGENTS[id];
      if (!definition) throw new Error(`unsupported agent: ${id}`);
      if (id === 'dsh') {
        return this.installDshRuntime(id, updateOwner);
      }
      if (id === 'zcode') {
        // Unmanaged runtime: direct the user to the official channel instead
        // of downloading anything (Revision 2 §4.1 / frozen D3).
        throw new Error(
          'ZCode is not installed through Gian. Download ZCode.app from https://zcode.z.ai, then configure an explicit model provider for the ZCode CLI (Gian will not create or modify ~/.zcode) and retry.',
        );
      }
      const script = await this.download(definition.installerUrl, MAX_INSTALLER_BYTES);
      assertOfficialInstallerIntegrity(
        script,
        this.options.officialInstallerSha256?.[id] ?? definition.installerSha256,
      );
      const directory = join(tmpdir(), `gian-${id}-installer-${randomUUID()}`);
      const scriptPath = join(directory, 'install.sh');
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(scriptPath, script, { mode: 0o700 });
        const result = await this.runOfficialInstaller(id, scriptPath, updateOwner);
        this.invalidateStatus(id);
        // This private path reuses the already-owned cli-update claim. Calling
        // public status() here would correctly conflict with our own writer.
        const agent = await this.statusUnderUpdateLock(id, updateOwner);
        if (agent.cli.state !== 'ready') {
          throw new Error(
            `The official installer finished, but ${definition.command} was not found. Configure its path manually.`,
          );
        }
        return {
          agent,
          output: `${result.stdout}\n${result.stderr}`.trim().slice(-12_000),
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      },
    ));
  }

  private async installDshRuntime(
    id: Executor,
    updateOwner: AgentUpdateLease,
  ): Promise<AgentInstallResult> {
    const dshHome = this.options.dshHome
      ?? process.env.DSH_HOME
      ?? join(homedir(), '.dsh');
    if (typeof this.options.dshBridgePackageDir !== 'string') {
      throw new Error(
        'dshBridgePackageDir is required to install the @gian/dsh-bridge bundle into the gian profile.',
      );
    }
    const bridgePackageDir = this.options.dshBridgePackageDir;
    const installer = new DshRuntimeInstaller({
      runtimesRoot: join(this.options.dataDir, 'runtimes', 'deepseek-harness'),
      dshHome,
      bridgePackageDir,
      ...(this.options.npmPath ? { npmPath: this.options.npmPath } : {}),
      ...(this.options.dshRegistry ? { registry: this.options.dshRegistry } : {}),
    });
    const result = await installer.installLatest();
    await installer.recordUpdateCheck();
    this.invalidateStatus(id);
    const agent = await this.statusUnderUpdateLock(id, updateOwner);
    if (agent.cli.state !== 'ready') {
      throw new Error(
        `DSH runtime installed, but @deepseek-ai/dsh was not usable. ${agent.cli.error ?? ''}`,
      );
    }
    return {
      agent,
      output: `resolved @deepseek-ai/dsh@${result.resolvedVersion}\n${result.output}`.trim().slice(-12_000),
    };
  }

    /** Read-only "is a newer compatible Proxy release available?" check (issue
   *  #86). No update lock, no filesystem or process side effects: the current
   *  version comes from the status probe and the latest compatible release
   *  from the same resolution the installer uses. */
  async checkProxyUpdate(id: Executor): Promise<AgentProxyUpdateCheck> {
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

  installProxy(id: Executor): Promise<AgentInstallResult> {
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
    id: Executor,
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
    id: Executor,
    claim: AgentUpdateLease,
    overridePath?: string,
  ): Promise<AgentCliStatus> {
    const provider = this.providers.get(id)!;
    const configured = overridePath ?? this.configuredPath(id) ?? undefined;
    let installed;
    try {
      installed = await provider.inspectInstalled(configured);
    } catch (error) {
      return {
        state: 'invalid',
        path: configured ?? null,
        version: null,
        source: configured ? 'override' : null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (installed.length === 0) {
      return {
        state: 'missing',
        path: null,
        version: null,
        source: null,
      };
    }
    const failures: string[] = [];
    for (const candidate of installed) {
      try {
        const probe = await provider.probe(candidate, claim);
        const contentFingerprint = provider.snapshot
          ? await provider.snapshot(probe)
          : null;
        // WP0 G1 (frozen O2): the ZCode CLI needs its own model-provider
        // config; Gian reports generic repair guidance, never writes ~/.zcode.
        if (
          id === 'zcode'
          && provider instanceof ZcodeRuntimeProvider
          && (await provider.configReady()) === false
        ) {
          return {
            state: 'invalid',
            path: probe.binaryPath,
            version: probe.version,
            contentFingerprint,
            source: probe.source,
            readinessIssue: { ...ZCODE_CLI_CONFIG_READINESS_ISSUE },
          };
        }
        return {
          state: 'ready',
          path: probe.binaryPath,
          version: probe.version,
          contentFingerprint,
          source: probe.source,
        };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        if (candidate.source === 'override') break;
      }
    }
    return {
      state: 'invalid',
      path: installed[0]?.binaryPath ?? null,
      version: null,
      source: installed[0]?.source === 'managed'
        ? 'official-user'
        : installed[0]?.source ?? null,
      error: failures.join(' | '),
    };
  }

  private async verifiedCliVersions(id: Executor): Promise<string[]> {
    if (!this.options.managedProxies) return [...VERIFIED_CLI_VERSIONS[id]];
    try {
      const agentRoot = join(this.options.dataDir, 'plugins', id);
      const current = await realpath(join(agentRoot, 'current'));
      const contained = await this.assertDirectProxyDirectory(agentRoot, current);
      const manifest = await this.validateProxyDirectory(contained, id);
      return verifiedCliVersionsFromManifest(manifest, id);
    } catch {
      return [...VERIFIED_CLI_VERSIONS[id]];
    }
  }

  private async proxyStatus(id: Executor): Promise<Omit<AgentProxyStatus, 'defaults'>> {
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
      const manifest = await this.validateProxyDirectory(contained, id);
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
    id: Executor,
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
    if (validated.schemaVersion === 3) {
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
                GIAN_PROTOCOL_VERSIONS: SUPPORTED_PROTOCOL_VERSIONS.join(','),
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
    id: Executor,
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
        ? { processScope: manifest.process.scope }
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
    id: Executor,
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
    id: Executor,
    updateOwner: AgentUpdateLease,
  ): Promise<RuntimeProbe> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`CLI runtime provider is not configured: ${id}`);
    const installed = await provider.inspectInstalled();
    if (installed.length === 0) {
      throw new Error(`${id} CLI must be installed before its Proxy can be activated.`);
    }
    const failures: string[] = [];
    for (const candidate of installed) {
      try {
        return await provider.probe(candidate, updateOwner);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        // An explicit override is a contract, never a fallback hint.
        if (candidate.source === 'override') break;
      }
    }
    throw new Error(`No compatible ${id} CLI is available. ${failures.join(' | ')}`);
  }

  private async runProxyCompatibilityProbe(input: {
    id: Executor;
    version: string;
    entryPath: string;
    protocol: ProxyWireProtocol;
    processScope?: ManagedProxyManifestV2['process']['scope'];
  }, updateOwner: AgentUpdateLease, exactRuntime?: RuntimeProbe): Promise<void> {
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
    const args = [input.entryPath];
    let reservation: Awaited<ReturnType<AgentUpdateLease['reserveProcessGroup']>>;
    try {
      reservation = await updateOwner.reserveProcessGroup();
    } catch (error) {
      try {
        await rm(probeDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${input.id} Proxy compatibility reservation cleanup failed.`,
        );
      }
      throw error;
    }
    let child;
    try {
      child = spawn(process.execPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...process.env,
          ...runtime.env,
          GIAN_PLUGIN_ID: pluginIdFor(input.id),
          GIAN_PLUGIN_DATA_DIR: probeDirectory,
          GIAN_RUNTIME_BIN: runtime.binaryPath,
          GIAN_PROTOCOL_VERSIONS: SUPPORTED_PROTOCOL_VERSIONS.join(','),
        },
      });
    } catch (error) {
      await reservation.cancelBeforeSpawn();
      await rm(probeDirectory, { recursive: true, force: true });
      throw error;
    }
    const groupId = child.pid;
    let registered = false;
    let registrationAlreadyEmpty = false;
    let exited = false;
    let spawnFailed = false;
    let spawnError: Error | null = null;
    let stdinError: Error | null = null;
    let stderr = '';
    child.once('error', error => {
      spawnFailed = true;
      spawnError = error;
      exited = true;
    });
    child.stdin.on('error', error => { stdinError = error; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.once('exit', () => {
      exited = true;
    });
    const iterator = readNdjsonLines(child.stdout)[Symbol.asyncIterator]();
    let timeout!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(
        `${input.id} Proxy compatibility handshake timed out.`,
      )), PROXY_COMPATIBILITY_TIMEOUT_MS);
    });
    const processFailureDetail = (): string => {
      const spawnFailure = spawnError as Error | null;
      const pipeFailure = stdinError as Error | null;
      return spawnFailure?.message || pipeFailure?.message || stderr.trim() || 'process exited';
    };
    const validator = new HostProtocolValidator({
      pluginId: pluginIdFor(input.id),
      pluginVersion: input.version,
      ...(input.processScope ? { processScope: input.processScope } : {}),
    });

    const request = async (
      id: string,
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<unknown> => {
      const payload = { jsonrpc: '2.0', id, method, params };
      validator.registerRequest(payload);
      const frame = `${JSON.stringify(payload)}\n`;
      if (exited || spawnError || stdinError) {
        throw new Error(`${input.id} Proxy compatibility process stopped: ${processFailureDetail()}`);
      }
      if (!child.stdin.write(frame)) {
        await Promise.race([once(child.stdin, 'drain').then(() => undefined), deadline]);
      }
      while (true) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next.done) {
          throw new Error(`${input.id} Proxy compatibility process stopped: ${processFailureDetail()}`);
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

    let operationFailed = false;
    let operationError: unknown;
    try {
      if (groupId === undefined || groupId <= 0) {
        throw new Error(`${input.id} Proxy compatibility process group is unavailable.`);
      }
      const registration = await reservation.register(groupId);
      registered = registration === 'registered';
      registrationAlreadyEmpty = registration === 'already-empty';
      if (registration === 'already-empty') {
        throw new Error(`${input.id} Proxy compatibility process exited before registration.`);
      }
      const initialized = await request('req-1', 'initialize', {
        protocol: {
          name: PROTOCOL_NAME,
          versions: [...SUPPORTED_PROTOCOL_VERSIONS],
        },
        host: { name: 'Gian', version: this.releaseVersion },
      });
      validateProxyInitialize(input.id, initialized);
      if (validator.initializeResult?.plugin.version !== input.version) {
        throw new Error(`${input.id} Proxy handshake version does not match its manifest.`);
      }
      await request('req-2', 'catalog.list');
      await request('req-3', 'shutdown');
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    clearTimeout(timeout);
    await iterator.return?.(undefined);
    try { child.stdin.end(); } catch { /* pipe already closed */ }
    const cleanupErrors: unknown[] = [];
    let groupConfirmedEmpty = registrationAlreadyEmpty;
    if (!groupConfirmedEmpty) {
      try {
        await (this.options.shutdownProxyProcessImpl ?? shutdownProxyProcess)({
          child,
          isExited: () => exited,
          label: `${input.id} Proxy compatibility process`,
        });
        groupConfirmedEmpty = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (groupConfirmedEmpty) {
      try {
        if (registered) await reservation.release();
        else if (groupId !== undefined) await reservation.releaseUnregistered(groupId);
        else if (spawnFailed) await reservation.cancelBeforeSpawn();
        else throw new Error(
          `${input.id} Proxy compatibility child has no verifiable process group; retaining its pending reservation.`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(probeDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (operationFailed || cleanupErrors.length > 0) {
      if (cleanupErrors.length === 0) throw operationError;
      throw new AggregateError(
        operationFailed ? [operationError, ...cleanupErrors] : cleanupErrors,
        `${input.id} Proxy compatibility cleanup failed.`,
      );
    }
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

  private async runOfficialInstaller(
    id: Executor,
    scriptPath: string,
    updateOwner: AgentUpdateLease,
  ): Promise<{ stdout: string; stderr: string }> {
    return runProtectedCommand({
      command: '/bin/bash',
      args: [scriptPath],
      timeoutMs: 5 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      label: `Official ${id} installer`,
      protector: updateOwner,
      env: {
        ...process.env,
        ...managedRuntimeEnvironment(id),
        // Install into the same home whose official paths AgentManager probes.
        // This is normally process HOME, while packaged/acceptance harnesses
        // deliberately supply an isolated home so vendor installers cannot
        // leak files into the invoking user's profile.
        HOME: this.homeDir,
        NON_INTERACTIVE: '1',
      },
    });
  }

  private async resolveProxyRelease(id: Executor): Promise<ProxyRelease> {
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
      // successful commit persists v3.
      return parsed.schemaVersion === 3 ? parsed : await this.migrateV1(parsed);
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
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
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
    id: Executor,
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

  private invalidateStatus(id: Executor): void {
    this.statusCache.delete(id);
    this.statusGenerations.set(id, (this.statusGenerations.get(id) ?? 0) + 1);
  }

  private invalidateAgentStatus(id: string): void {
    this.agentStatusCache.delete(id);
    this.agentStatusGenerations.set(id, (this.agentStatusGenerations.get(id) ?? 0) + 1);
  }
}
