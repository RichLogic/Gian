import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

export function providerHomeEnvironment(
  pluginId: ProxyPluginId,
  home: string,
): Readonly<Record<string, string>> {
  switch (executorIdForPluginId(pluginId)) {
    case 'claude': return { CLAUDE_CONFIG_DIR: home };
    case 'codex': return { CODEX_HOME: home };
    case 'kimi': return { KIMI_CODE_HOME: home };
    case 'grok': return { GROK_HOME: home };
    case 'dsh': return { DSH_HOME: home };
    default: return {};
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
    case 'grok': return { ...base, GROK_DISABLE_AUTOUPDATER: '1' };
    default: return base;
  }
}

export class AgentHomeManager {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'homes');
  }

  supports(pluginId: ProxyPluginId): boolean {
    return executorIdForPluginId(pluginId) !== 'zcode';
  }

  managedPath(pluginId: ProxyPluginId, agentId: string): string {
    parseProxyPluginId(pluginId);
    if (!AGENT_ID.test(agentId)) {
      throw new AgentHomeError('AGENT_ID_INVALID', 'Agent id cannot identify a HOME directory.');
    }
    if (!this.supports(pluginId)) {
      throw new AgentHomeError('AGENT_HOME_UNSUPPORTED', 'This external application owns its state directory.');
    }
    return join(this.root, pluginId, agentId);
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
  ): Promise<AgentHomeBinding> {
    if (!isCanonicalAbsolutePath(path)) {
      throw new AgentHomeError('AGENT_HOME_INVALID', 'Custom HOME must be a canonical absolute path.');
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
