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
import { basename, isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { promisify } from 'node:util';
import type {
  AgentCliStatus,
  AgentInstallResult,
  AgentInstallStatus,
  AgentProxyDefaults,
  AgentProxyStatus,
  Executor,
} from '@gian/shared';
import { CommandRuntimeProvider } from '../runtime/command-provider.js';
import { KimiSessionStoreRuntimeProvider } from '../runtime/kimi-session-store.js';
import { runProtectedCommand } from '../runtime/protected-command.js';
import type { CliRuntimeProvider, RuntimeProbe } from '../runtime/types.js';
import { shutdownProxyProcess } from '../proxy/process-shutdown.js';
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
const PROXY_SELF_TEST_TIMEOUT_MS = 5_000;
const PROXY_COMPATIBILITY_TIMEOUT_MS = 30_000;
const STATUS_CACHE_TTL_MS = 30_000;
const REQUIRED_PROXY_METHODS: Record<Executor, readonly string[]> = {
  claude: [
    'initialize', 'capabilities.list', 'slash.list', 'session.create',
    'turn.start', 'turn.interrupt', 'approval.respond', 'session.close', 'shutdown',
  ],
  codex: [
    'initialize', 'capabilities.list', 'slash.list', 'session.create',
    'turn.start', 'turn.interrupt', 'turn.steer', 'approval.respond',
    'session.setName', 'session.close', 'shutdown',
  ],
  kimi: [
    'initialize', 'capabilities.list', 'slash.list', 'session.create',
    'session.snapshot', 'session.config.set', 'session.listNative',
    'turn.start', 'turn.interrupt', 'approval.respond', 'session.close', 'shutdown',
  ],
};

interface AgentDefinition {
  id: Executor;
  name: string;
  command: string;
  installerUrl: string;
  installerSha256: string;
  officialPaths: (home: string) => string[];
}

interface AgentConfigFile {
  schemaVersion: 1;
  cliPaths: Partial<Record<Executor, string>>;
  proxyDefaults: Partial<Record<Executor, AgentProxyDefaults>>;
}

interface ProxyManifest {
  schemaVersion: 1;
  id: Executor;
  version: string;
  entry: typeof PROXY_ENTRY;
}

interface ProxyProtocolResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export interface AgentManagerOptions {
  dataDir: string;
  releaseVersion: string;
  releaseRepository?: string;
  managedProxies: boolean;
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
  /** Test override for the production initialize + capabilities handshake.
   * Omitted in production so the candidate process and resolved vendor CLI
   * must complete the real stdio protocol before activation. */
  proxyActivationProbe?: (input: {
    id: Executor;
    version: string;
    entryPath: string;
  }) => Promise<void>;
  /** Test seam for the single atomic activation commit. Production always
   * uses fs.rename; a rejection proves the prior pointer remains untouched. */
  proxyActivationSwap?: (temporary: string, current: string) => Promise<void>;
  /** Internal test seam for proving an already-empty compatibility process
   * never re-enters a signalling shutdown path. */
  shutdownProxyProcessImpl?: typeof shutdownProxyProcess;
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
};

function emptyConfig(): AgentConfigFile {
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

function safeReleaseValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[0-9A-Za-z._-]+$/.test(trimmed)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return trimmed;
}

function isCompatibleProxyVersion(proxyVersion: string, releaseVersion: string): boolean {
  if (proxyVersion === releaseVersion) return true;

  // A -hotfix release is reserved for app-only fixes. Its Proxy protocol and
  // bundles remain those of the base release, so an existing base Proxy stays
  // usable instead of disabling every Agent after the app update.
  const hotfixMatch = /^(.*)-hotfix$/.exec(releaseVersion);
  return hotfixMatch?.[1] === proxyVersion;
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
  return {};
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateProxyInitialize(id: Executor, value: unknown): void {
  const result = objectRecord(value);
  const expectedProtocol = id === 'kimi' ? 'acp/1' : '0.1.0';
  const methods = result?.['methods'];
  if (
    !result
    || result['mode'] !== 'spawn'
    || result['protocolVersion'] !== expectedProtocol
    || !Array.isArray(methods)
    || !REQUIRED_PROXY_METHODS[id].every(method => methods.includes(method))
  ) {
    throw new Error(`${id} Proxy initialize handshake is incompatible.`);
  }
}

function validateProxyCapabilities(id: Executor, value: unknown): void {
  const result = objectRecord(value);
  const protocol = result?.['protocolVersion'];
  const compatibleProtocol = id === 'kimi'
    ? protocol === 1 || protocol === 'acp/1'
    : protocol === '0.1.0';
  if (
    !result
    || !compatibleProtocol
    || !Array.isArray(result['models'])
    || !Array.isArray(result['modes'])
  ) {
    throw new Error(`${id} Proxy capabilities handshake is incompatible.`);
  }
}

function parseConfig(raw: string): AgentConfigFile {
  const parsed = JSON.parse(raw) as Partial<AgentConfigFile>;
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
        configuredPath: () => (
          this.config.cliPaths[definition.id] ??
          this.options.environmentCliPaths?.[definition.id]
        ),
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
          : commandProvider,
      );
    }
  }

  static async create(options: AgentManagerOptions): Promise<AgentManager> {
    const manager = new AgentManager(options);
    await mkdir(options.dataDir, { recursive: true });
    try {
      manager.config = parseConfig(await readFile(manager.configPath, 'utf8'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      manager.config = emptyConfig();
    }
    let migrated = false;
    for (const id of Object.keys(AGENTS) as Executor[]) {
      const legacy = options.legacyProxyDefaults?.[id];
      if (!manager.config.proxyDefaults[id] && legacy) {
        manager.config.proxyDefaults[id] = normalizeProxyDefaults(legacy);
        migrated = true;
      }
    }
    if (migrated) await manager.saveConfig();
    return manager;
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

  async list(refresh = false): Promise<AgentInstallStatus[]> {
    return Promise.all((Object.keys(AGENTS) as Executor[]).map(id => this.status(id, refresh)));
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

  configuredPath(id: Executor): string | null {
    return (
      this.config.cliPaths[id] ??
      this.options.environmentCliPaths?.[id] ??
      null
    );
  }

  proxyDefaults(id: Executor): AgentProxyDefaults {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    return { ...(this.config.proxyDefaults[id] ?? emptyProxyDefaults()) };
  }

  async setProxyDefaults(
    id: Executor,
    patch: Partial<AgentProxyDefaults>,
  ): Promise<AgentInstallStatus> {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    const finishMutation = await this.acquireConfigMutationTurn();
    try {
    const claim = await acquireAgentProxyUpdateLock(
      this.updateLockDataDir(),
      CONFIG_LOCK_AGENT_ID,
      'Agent configuration update',
    );
    let operationFailed = false;
    let operationError: unknown;
    try {
      const currentConfig = await this.readPersistedConfig();
      const current = currentConfig.proxyDefaults[id] ?? emptyProxyDefaults();
      const nextConfig: AgentConfigFile = {
        ...currentConfig,
        cliPaths: { ...currentConfig.cliPaths },
        proxyDefaults: {
          ...currentConfig.proxyDefaults,
          [id]: normalizeProxyDefaults({ ...current, ...patch }),
        },
      };
      await this.saveConfig(nextConfig);
      this.config = nextConfig;
      // Persistence is the commit point. Invalidate immediately so a later
      // claim-retirement failure cannot leave the old defaults cached.
      this.invalidateStatus(id);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try {
      await claim.release();
    } catch (cleanupError) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, cleanupError],
          `${id} Proxy defaults update failed and its configuration claim was retained.`,
        );
      }
      throw cleanupError;
    }
    if (operationFailed) throw operationError;
    return this.status(id, true);
    } finally {
      finishMutation();
    }
  }

  async setCliPath(id: Executor, path: string | null): Promise<AgentInstallStatus> {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    const finishMutation = await this.acquireConfigMutationTurn();
    try {
    const nextPath = path === null || path.trim() === '' ? undefined : path.trim();
    if (nextPath !== undefined && !isAbsolute(nextPath)) {
      throw new Error('CLI path must be absolute');
    }

    // Serialize the shared agents.json across Agents and Hosts, then exclude
    // updater/path writers for this Agent without blocking ordinary runtime
    // users. Both claims stay owned through validation, persistence, and the
    // returned final status.
    const configClaim = await acquireAgentProxyUpdateLock(
      this.updateLockDataDir(),
      CONFIG_LOCK_AGENT_ID,
      'Agent configuration update',
    );
    let claim: AgentUpdateLease;
    try {
      claim = await acquireAgentProxyUpdateLock(
        this.updateLockDataDir(),
        id,
        `${id} CLI path update`,
      );
    } catch (error) {
      try {
        await configClaim.release();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${id} CLI path update could not release its configuration claim.`,
        );
      }
      throw error;
    }

    let previousConfig: AgentConfigFile | undefined;
    let nextConfig: AgentConfigFile | undefined;
    let persisted = false;
    let rolledBack = false;
    let result: AgentInstallStatus | undefined;
    let operationFailed = false;
    let operationError: unknown;
    let releaseWasPrimaryFailure = false;
    const cleanupErrors: unknown[] = [];
    const restorePrevious = async (): Promise<void> => {
      if (rolledBack || !previousConfig) return;
      if (persisted) await this.saveConfig(previousConfig);
      this.config = previousConfig;
      rolledBack = true;
      this.invalidateStatus(id);
    };

    try {
      // Reload under the cross-Host claim so an older Host cannot overwrite
      // another Host's newer config with its stale in-memory snapshot.
      previousConfig = await this.readPersistedConfig();
      const cliPaths = { ...previousConfig.cliPaths };
      if (nextPath === undefined) delete cliPaths[id];
      else cliPaths[id] = nextPath;
      nextConfig = {
        ...previousConfig,
        cliPaths,
        proxyDefaults: { ...previousConfig.proxyDefaults },
      };

      if (nextPath !== undefined) {
        const provider = this.providers.get(id)!;
        await provider.probe({
          cli: id,
          binaryPath: nextPath,
          source: 'override',
        }, claim);
      }
      await this.saveConfig(nextConfig);
      persisted = true;
      this.config = nextConfig;
      this.invalidateStatus(id);
      result = await this.statusInternal(id, true, claim);
      if (nextPath !== undefined && result.cli.state !== 'ready') {
        throw new Error(result.cli.error ?? 'CLI path is not usable');
      }
    } catch (error) {
      operationFailed = true;
      operationError = error;
      try {
        await restorePrevious();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    try {
      await claim.release();
    } catch (error) {
      if (operationFailed) {
        cleanupErrors.push(error);
      } else {
        operationFailed = true;
        operationError = error;
        releaseWasPrimaryFailure = true;
      }
    }

    try {
      await configClaim.release();
    } catch (error) {
      if (operationFailed) {
        cleanupErrors.push(error);
      } else {
        operationFailed = true;
        operationError = error;
        releaseWasPrimaryFailure = true;
      }
    }

    if (operationFailed) {
      if (cleanupErrors.length === 0 && !releaseWasPrimaryFailure) throw operationError;
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        `${id} CLI path update failed or retained one of its coordination claims.`,
      );
    }
    return result!;
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

      const filename = `gian-proxy-${id}-${this.releaseVersion}-darwin-arm64.tar.gz`;
      const baseUrl = `https://github.com/${this.releaseRepository}/releases/download/v${this.releaseVersion}`;
      const checksumFilename = `${filename}.sha256`;
      const officialDigests = await this.releaseAssetDigests([filename, checksumFilename]);
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
      const finalDir = join(agentRoot, this.releaseVersion);
      await mkdir(extracted, { recursive: true });
      try {
        await writeFile(archivePath, archive);
        await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', extracted], {
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        await this.validateProxyDirectory(extracted, id, this.releaseVersion);
        try {
          await rename(extracted, finalDir);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
          await this.validateProxyDirectory(finalDir, id, this.releaseVersion);
        }
        await this.activateProxy(agentRoot, id, this.releaseVersion, updateOwner);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      this.invalidateStatus(id);
      return { agent: await this.status(id, true) };
      },
      'proxy-update',
    ));
  }

  private async cliStatus(
    id: Executor,
    updateOwner?: AgentUpdateLease,
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
      result = await this.cliStatusWithClaim(id, claim);
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
  ): Promise<AgentCliStatus> {
    const provider = this.providers.get(id)!;
    let installed;
    try {
      installed = await provider.inspectInstalled();
    } catch (error) {
      return {
        state: 'invalid',
        path: this.configuredPath(id),
        version: null,
        source: this.configuredPath(id) ? 'override' : null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (installed.length === 0) {
      return { state: 'missing', path: null, version: null, source: null };
    }
    const failures: string[] = [];
    for (const candidate of installed) {
      try {
        const probe = await provider.probe(candidate, claim);
        return {
          state: 'ready',
          path: probe.binaryPath,
          version: probe.version,
          source: probe.source === 'managed' ? 'official-user' : probe.source,
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

  private async proxyStatus(id: Executor): Promise<Omit<AgentProxyStatus, 'defaults'>> {
    const path = this.proxyEntry(id);
    if (!this.options.managedProxies) {
      return await existsReadable(path)
        ? {
            state: 'ready',
            path,
            version: this.releaseVersion,
            source: 'development',
          }
        : {
            state: 'missing',
            path,
            version: null,
            source: 'development',
          };
    }
    try {
      const agentRoot = join(this.options.dataDir, 'plugins', id);
      const current = await realpath(join(agentRoot, 'current'));
      const contained = await this.assertDirectProxyDirectory(agentRoot, current);
      const manifest = await this.validateProxyDirectory(contained, id);
      return {
        state: isCompatibleProxyVersion(manifest.version, this.releaseVersion)
          ? 'ready'
          : 'outdated',
        path: join(contained, manifest.entry),
        version: manifest.version,
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
  ): Promise<ProxyManifest> {
    const raw = await readFile(join(directory, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as Partial<ProxyManifest>;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.id !== id ||
      manifest.entry !== PROXY_ENTRY ||
      typeof manifest.version !== 'string' ||
      (expectedVersion && manifest.version !== expectedVersion)
    ) {
      throw new Error(`Invalid ${id} proxy manifest.`);
    }
    const validated = manifest as ProxyManifest;
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
    await this.runProxySelfTest(resolvedDirectory, validated);
    return validated;
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
      });
      stdout = String(result.stdout).trim();
      stderr = String(result.stderr).trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${manifest.id} proxy self-test failed: ${detail}`);
    }

    let response: { schemaVersion?: unknown; id?: unknown; ok?: unknown };
    try {
      response = JSON.parse(stdout) as typeof response;
    } catch {
      throw new Error(
        `${manifest.id} proxy self-test returned invalid JSON${stderr ? `: ${stderr}` : '.'}`,
      );
    }
    if (
      response.schemaVersion !== 1
      || response.id !== manifest.id
      || response.ok !== true
    ) {
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
    // Compatibility is a gate before the atomic pointer swap. While this is
    // pending or failing, every reader continues to resolve the old `current`.
    const activationProbe = this.options.proxyActivationProbe ?? (
      input => this.runProxyCompatibilityProbe(input, updateOwner)
    );
    const probeInput = {
      id,
      version,
      entryPath: join(resolvedCandidate, manifest.entry),
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
  }, updateOwner: AgentUpdateLease): Promise<void> {
    const runtime = await this.resolveCompatibilityRuntime(input.id, updateOwner);
    const probeDirectory = join(
      this.options.dataDir,
      'compatibility-probes',
      `${input.id}-${randomUUID()}`,
    );
    await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
    const args = [input.entryPath];
    if (input.id === 'claude') {
      args.push('--data-dir', probeDirectory);
    } else if (input.id === 'codex') {
      args.push('--data-dir', probeDirectory, '--codex-bin', runtime.binaryPath);
    } else {
      args.push('--kimi-bin', runtime.binaryPath);
    }
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
          ...(input.id === 'claude' ? { CLAUDE_BIN: runtime.binaryPath } : {}),
          ...(input.id === 'codex' ? { CODEX_BIN: runtime.binaryPath } : {}),
          ...(input.id === 'kimi' ? { KIMI_BIN: runtime.binaryPath } : {}),
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
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
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

    const request = async (id: number, method: string): Promise<unknown> => {
      const frame = `${JSON.stringify({ id, method })}\n`;
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
        let response: ProxyProtocolResponse;
        try {
          response = JSON.parse(next.value) as ProxyProtocolResponse;
        } catch {
          throw new Error(`${input.id} Proxy emitted non-protocol stdout during compatibility probe.`);
        }
        if (response.id !== id) continue;
        if (response.error) {
          throw new Error(
            `${input.id} Proxy ${method} failed: ${String(response.error.message ?? response.error.code)}`,
          );
        }
        if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
          throw new Error(`${input.id} Proxy ${method} response omitted result.`);
        }
        return response.result;
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
      validateProxyInitialize(input.id, await request(1, 'initialize'));
      validateProxyCapabilities(input.id, await request(2, 'capabilities.list'));
      await request(3, 'shutdown');
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    clearTimeout(timeout);
    lines.close();
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

  private async releaseAssetDigests(
    filenames: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const tag = `v${this.releaseVersion}`;
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
      return parseConfig(await readFile(this.configPath, 'utf8'));
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
}
