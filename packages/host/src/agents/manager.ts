import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
import type { CliRuntimeProvider } from '../runtime/types.js';

const execFileAsync = promisify(execFile);
const CONFIG_FILE = 'agents.json';
const PROXY_ENTRY = 'proxy.mjs';
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024;
const MAX_PROXY_BYTES = 64 * 1024 * 1024;
const PROXY_SELF_TEST_TIMEOUT_MS = 5_000;

interface AgentDefinition {
  id: Executor;
  name: string;
  command: string;
  installerUrl: string;
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

export interface AgentManagerOptions {
  dataDir: string;
  releaseVersion: string;
  releaseRepository?: string;
  managedProxies: boolean;
  developmentProxyEntries?: Partial<Record<Executor, string>>;
  environmentCliPaths?: Partial<Record<Executor, string>>;
  homeDir?: string;
  pathEnv?: string;
  fetchImpl?: typeof fetch;
  /** One-time migration source for defaults previously stored in SystemConfig. */
  legacyProxyDefaults?: Partial<Record<Executor, Partial<AgentProxyDefaults>>>;
}

const AGENTS: Record<Executor, AgentDefinition> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    installerUrl: 'https://claude.ai/install.sh',
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

function normalizeRepository(value: string): string {
  const trimmed = value.trim();
  if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(trimmed)) {
    throw new Error('release repository must use owner/name format');
  }
  return trimmed;
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
  private readonly fetchImpl: typeof fetch;
  private readonly releaseVersion: string;
  private readonly releaseRepository: string;
  private readonly providers = new Map<Executor, CommandRuntimeProvider>();
  private readonly operations = new Map<string, Promise<AgentInstallResult>>();
  private readonly proxySelfTests = new Map<string, Promise<void>>();
  private config: AgentConfigFile = emptyConfig();

  private constructor(private readonly options: AgentManagerOptions) {
    this.configPath = join(options.dataDir, CONFIG_FILE);
    this.homeDir = options.homeDir ?? homedir();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.releaseVersion = safeReleaseValue(options.releaseVersion, 'release version');
    this.releaseRepository = normalizeRepository(
      options.releaseRepository ?? 'RichLogic/Gian',
    );
    for (const definition of Object.values(AGENTS)) {
      this.providers.set(definition.id, new CommandRuntimeProvider({
        id: definition.id,
        command: definition.command,
        configuredPath: () => (
          this.config.cliPaths[definition.id] ??
          this.options.environmentCliPaths?.[definition.id]
        ),
        officialPaths: () => definition.officialPaths(this.homeDir),
        pathEnv: () => options.pathEnv ?? process.env.PATH,
      }));
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

  proxyEntry(id: Executor): string {
    if (!this.options.managedProxies) {
      const entry = this.options.developmentProxyEntries?.[id];
      if (!entry) throw new Error(`development proxy entry is not configured: ${id}`);
      return entry;
    }
    return join(this.options.dataDir, 'plugins', id, 'current', PROXY_ENTRY);
  }

  async list(): Promise<AgentInstallStatus[]> {
    return Promise.all((Object.keys(AGENTS) as Executor[]).map(id => this.status(id)));
  }

  async status(id: Executor): Promise<AgentInstallStatus> {
    const definition = AGENTS[id];
    if (!definition) throw new Error(`unsupported agent: ${id}`);
    const [cli, proxy] = await Promise.all([
      this.cliStatus(id),
      this.proxyStatus(id),
    ]);
    return {
      id,
      name: definition.name,
      ready: cli.state === 'ready' && proxy.state === 'ready',
      cli,
      proxy: { ...proxy, defaults: this.proxyDefaults(id) },
      officialInstallUrl: definition.installerUrl,
    };
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
    const current = this.proxyDefaults(id);
    this.config.proxyDefaults[id] = normalizeProxyDefaults({ ...current, ...patch });
    await this.saveConfig();
    return this.status(id);
  }

  async setCliPath(id: Executor, path: string | null): Promise<AgentInstallStatus> {
    if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
    const previous = this.config.cliPaths[id];
    if (path === null || path.trim() === '') {
      delete this.config.cliPaths[id];
    } else {
      const normalized = path.trim();
      if (!isAbsolute(normalized)) throw new Error('CLI path must be absolute');
      this.config.cliPaths[id] = normalized;
      const status = await this.cliStatus(id);
      if (status.state !== 'ready') {
        if (previous) this.config.cliPaths[id] = previous;
        else delete this.config.cliPaths[id];
        throw new Error(status.error ?? 'CLI path is not usable');
      }
    }
    await this.saveConfig();
    return this.status(id);
  }

  installOfficialCli(id: Executor): Promise<AgentInstallResult> {
    return this.runOperation(`cli:${id}`, async () => {
      const definition = AGENTS[id];
      if (!definition) throw new Error(`unsupported agent: ${id}`);
      const script = await this.download(definition.installerUrl, MAX_INSTALLER_BYTES);
      const directory = join(tmpdir(), `gian-${id}-installer-${randomUUID()}`);
      const scriptPath = join(directory, 'install.sh');
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(scriptPath, script, { mode: 0o700 });
        const result = await execFileAsync('/bin/bash', [scriptPath], {
          timeout: 5 * 60_000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            NON_INTERACTIVE: '1',
          },
        });
        const agent = await this.status(id);
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
    });
  }

  installProxy(id: Executor): Promise<AgentInstallResult> {
    return this.runOperation(`proxy:${id}`, async () => {
      if (!AGENTS[id]) throw new Error(`unsupported agent: ${id}`);
      if (!this.options.managedProxies) {
        return { agent: await this.status(id) };
      }
      if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        throw new Error('Managed proxy packages support macOS Apple Silicon only.');
      }

      const filename = `gian-proxy-${id}-${this.releaseVersion}-darwin-arm64.tar.gz`;
      const baseUrl = `https://github.com/${this.releaseRepository}/releases/download/v${this.releaseVersion}`;
      const [archive, checksumFile] = await Promise.all([
        this.download(`${baseUrl}/${filename}`, MAX_PROXY_BYTES),
        this.download(`${baseUrl}/${filename}.sha256`, 4_096),
      ]);
      const expected = checksumFile.toString('utf8').match(/\b[0-9a-fA-F]{64}\b/)?.[0]?.toLowerCase();
      if (!expected) throw new Error('Proxy checksum file is invalid.');
      const actual = createHash('sha256').update(archive).digest('hex');
      if (actual !== expected) throw new Error('Proxy checksum verification failed.');

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
        await this.activateProxy(agentRoot, this.releaseVersion);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return { agent: await this.status(id) };
    });
  }

  private async cliStatus(id: Executor): Promise<AgentCliStatus> {
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
        const probe = await provider.probe(candidate);
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
      const current = await realpath(join(this.options.dataDir, 'plugins', id, 'current'));
      const manifest = await this.validateProxyDirectory(current, id);
      return {
        state: manifest.version === this.releaseVersion ? 'ready' : 'outdated',
        path: join(current, manifest.entry),
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
    await access(join(directory, validated.entry), constants.R_OK);
    await this.ensureProxySelfTest(directory, validated);
    return validated;
  }

  private ensureProxySelfTest(
    directory: string,
    manifest: ProxyManifest,
  ): Promise<void> {
    const key = `${directory}\0${manifest.id}\0${manifest.version}`;
    const existing = this.proxySelfTests.get(key);
    if (existing) return existing;

    const pending = this.runProxySelfTest(directory, manifest);
    this.proxySelfTests.set(key, pending);
    return pending;
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

  private async activateProxy(agentRoot: string, version: string): Promise<void> {
    const current = join(agentRoot, 'current');
    const temporary = join(agentRoot, `.current-${randomUUID()}`);
    await symlink(version, temporary, 'dir');
    try {
      try {
        const info = await lstat(current);
        if (!info.isSymbolicLink()) {
          throw new Error(`Refusing to replace non-symlink plugin path: ${current}`);
        }
        await rm(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(temporary, current);
    } finally {
      await rm(temporary, { force: true });
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

  private async saveConfig(): Promise<void> {
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.config, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.configPath);
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
}
