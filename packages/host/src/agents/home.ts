import { constants, realpathSync } from 'node:fs';
import { access, chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  isCanonicalAbsolutePath,
  executorIdForPluginId,
  parseProxyPluginId,
  type AgentHomeBinding,
  type ProxyPluginId,
} from '@gian/shared';

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class AgentHomeError extends Error {
  readonly status: 400 | 409;

  constructor(readonly code: string, message: string, status: 400 | 409 = 400) {
    super(message);
    this.name = 'AgentHomeError';
    this.status = status;
  }
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function overlaps(left: string, right: string): boolean {
  return contained(left, right) || contained(right, left);
}

function isDefaultClaudeHome(home: string): boolean {
  const defaultHome = join(homedir(), '.claude');
  if (home === defaultHome) return true;
  try {
    return home === realpathSync(defaultHome);
  } catch {
    return false;
  }
}

export function providerHomeEnvironment(
  pluginId: ProxyPluginId,
  home: string,
): Readonly<Record<string, string>> {
  // Host-provided constrained universal path. Proxies above the
  // GIAN_AGENT_HOME gate translate it into their own provider variable
  // (GROK_HOME, DSH_HOME, ...) themselves; the per-provider entries below
  // are a compatibility bridge for Catalog-installed Proxies that predate
  // the gate and are removed once no installed generation needs them.
  const universal: Record<string, string> = { GIAN_AGENT_HOME: home };
  switch (executorIdForPluginId(pluginId)) {
    case 'claude':
      return isDefaultClaudeHome(home) ? universal : { ...universal, CLAUDE_CONFIG_DIR: home };
    case 'codex': return { ...universal, CODEX_HOME: home };
    case 'kimi': return { ...universal, KIMI_CODE_HOME: home };
    case 'dsh': return { ...universal, DSH_HOME: home };
    // ZCode's state root ends in .zcode; its CLI receives the parent of
    // that root as its process HOME (shared/agents.ts home contract).
    case 'zcode': return { ...universal, HOME: dirname(home) };
    // Grok migrated: its Proxy consumes GIAN_AGENT_HOME directly, so the
    // Host no longer fabricates GROK_HOME for it.
    default: return universal;
  }
}

export function providerRuntimeEnvironment(
  pluginId: ProxyPluginId,
  home: string,
): Readonly<Record<string, string>> {
  const base = providerHomeEnvironment(pluginId, home);
  switch (executorIdForPluginId(pluginId)) {
    case 'claude': return { ...base, DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' };
    case 'kimi': return { ...base, KIMI_CODE_NO_AUTO_UPDATE: '1' };
    case 'grok': return { ...base, GROK_DISABLE_AUTOUPDATER: '1' };  // GROK_HOME now mapped by the Proxy from GIAN_AGENT_HOME
    default: return base;
  }
}

/** Only Host-owned, fixed argv may start an Agent login terminal. */
export function agentLoginArgs(pluginId: ProxyPluginId): string[] | null {
  switch (executorIdForPluginId(pluginId)) {
    case 'claude': return ['auth', 'login'];
    case 'codex':
    case 'kimi':
    case 'grok': return ['login'];
    case 'zcode': return ['login'];
    default: return null;
  }
}

export class AgentHomeManager {
  private readonly root: string;

  constructor(
    dataDir: string,
    private readonly userHome = homedir(),
    private readonly kimiHome?: string,
  ) {
    this.root = join(dataDir, 'homes');
  }

  defaultPath(pluginId: ProxyPluginId): string | null {
    if (executorIdForPluginId(pluginId) === 'kimi' && this.kimiHome) return resolve(this.kimiHome);
    const directories: Record<string, string> = {
      claude: '.claude',
      codex: '.codex',
      kimi: '.kimi-code',
      grok: '.grok',
      dsh: '.dsh',
      zcode: '.zcode',
    };
    const directory = directories[executorIdForPluginId(pluginId) ?? ''];
    return directory ? join(this.userHome, directory) : null;
  }

  async useDefault(
    pluginId: ProxyPluginId,
    used: readonly { agentId: string; path: string }[],
  ): Promise<AgentHomeBinding | null> {
    const path = this.defaultPath(pluginId);
    if (!path) return null;
    await mkdir(path, { recursive: true, mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    return this.validateCustom(path, used, undefined, pluginId);
  }

  supports(_pluginId: ProxyPluginId): boolean {
    // Every current CLI Proxy has a HOME binding. ZCode receives its parent as HOME.
    return true;
  }

  managedPath(pluginId: ProxyPluginId, agentId: string): string {
    parseProxyPluginId(pluginId);
    if (!AGENT_ID.test(agentId)) {
      throw new AgentHomeError('AGENT_ID_INVALID', 'Agent id cannot identify a HOME directory.');
    }
    if (!this.supports(pluginId)) {
      throw new AgentHomeError('AGENT_HOME_UNSUPPORTED', 'This Proxy does not support a Gian-managed HOME.');
    }
    return executorIdForPluginId(pluginId) === 'zcode'
      ? join(this.root, pluginId, agentId, '.zcode')
      : join(this.root, pluginId, agentId);
  }

  async createManaged(pluginId: ProxyPluginId, agentId: string): Promise<AgentHomeBinding> {
    const path = this.managedPath(pluginId, agentId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(this.root);
    const pluginRoot = join(this.root, pluginId);
    await mkdir(pluginRoot, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const pluginMetadata = await lstat(pluginRoot);
    const canonicalPluginRoot = await realpath(pluginRoot);
    if (
      pluginMetadata.isSymbolicLink()
      || !pluginMetadata.isDirectory()
      || !contained(canonicalRoot, canonicalPluginRoot)
    ) {
      throw new AgentHomeError('AGENT_HOME_ESCAPE', 'Managed Agent HOME plugin root is unsafe.');
    }
    if (executorIdForPluginId(pluginId) === 'zcode') {
      const parent = dirname(path);
      await mkdir(parent, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      const parentMetadata = await lstat(parent);
      const canonicalParent = await realpath(parent);
      if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()
        || !contained(canonicalPluginRoot, canonicalParent)) {
        throw new AgentHomeError('AGENT_HOME_ESCAPE', 'Managed Agent HOME parent is unsafe.');
      }
    }
    await mkdir(path, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const metadata = await lstat(path);
    const canonical = await realpath(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || !contained(canonicalPluginRoot, canonical)) {
      throw new AgentHomeError('AGENT_HOME_ESCAPE', 'Managed Agent HOME escaped the Gian homes root.');
    }
    await chmod(path, 0o700);
    return { kind: 'managed', path };
  }

  async validateCustom(
    path: string,
    used: readonly { agentId: string; path: string }[],
    excludeAgentId?: string,
    pluginId?: ProxyPluginId,
  ): Promise<AgentHomeBinding> {
    if (!isCanonicalAbsolutePath(path)) {
      throw new AgentHomeError('AGENT_HOME_INVALID', 'Custom HOME must be a canonical absolute path.');
    }
    if (pluginId && executorIdForPluginId(pluginId) === 'zcode' && basename(path) !== '.zcode') {
      throw new AgentHomeError('AGENT_HOME_INVALID', 'ZCode HOME must point to a .zcode directory.');
    }
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AgentHomeError('AGENT_HOME_MISSING', 'Custom HOME does not exist.');
      }
      throw error;
    }
    if (!metadata.isDirectory()) {
      throw new AgentHomeError('AGENT_HOME_NOT_DIRECTORY', 'Custom HOME must be a directory.');
    }
    try {
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      throw new AgentHomeError('AGENT_HOME_NOT_WRITABLE', 'Custom HOME is not readable and writable by Gian.');
    }
    const canonical = await realpath(path);
    for (const candidate of used) {
      if (candidate.agentId === excludeAgentId) continue;
      const usedPath = await realpath(candidate.path).catch(() => candidate.path);
      if (overlaps(canonical, usedPath)) {
        throw new AgentHomeError(
          'AGENT_HOME_IN_USE',
          `Custom HOME overlaps the HOME of Agent ${candidate.agentId}.`,
          409,
        );
      }
    }
    return { kind: 'custom', path: canonical };
  }
}
