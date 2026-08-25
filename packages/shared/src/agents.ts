import type { AgentColor, Executor, ProductExecutor } from './model.js';

export type { AgentColor } from './model.js';

export interface AgentProxyDefaults {
  /** Empty means the Proxy/CLI default. */
  model: string;
  /** Empty means the selected model's Proxy default. */
  thinking: string;
  /** Empty means the Proxy's default session mode. */
  mode: string;
}

/** Stable user-Agent primary key (uuid). Agents live in `agents.json`
 *  (schema v2), not in SQLite — sessions reference them by plain text. */
export type AgentId = string;

export const AGENT_COLORS: readonly AgentColor[] = [
  'rose', 'ember', 'citron', 'moss', 'teal', 'azure', 'ink', 'plum',
];

/** Default color for the first saved Agent of each Proxy kind. */
export const DEFAULT_AGENT_COLORS: Readonly<Record<ProductExecutor, AgentColor>> = {
  claude: 'ember',
  codex: 'ink',
  kimi: 'citron',
  dsh: 'teal',
};

export function isAgentColor(value: unknown): value is AgentColor {
  return typeof value === 'string' && (AGENT_COLORS as readonly string[]).includes(value);
}

/** A user-owned Agent: a named, colored configuration on top of one Proxy
 *  kind. Multiple Agents may share a kind; the kind's official CLI / GitHub
 *  Proxy is still installed once per kind. */
export interface UserAgent {
  id: AgentId;
  /** Trimmed, case-insensitively unique across saved Agents; never empty. */
  name: string;
  color: AgentColor;
  proxy: ProductExecutor;
  /** Absolute CLI path chosen by the user; null = resolve via the kind's
   *  environment override, PATH, then official install locations. */
  cliPath: string | null;
  defaults: AgentProxyDefaults;
}

/** Static catalog metadata for one Proxy kind. Served without spawning or
 *  probing anything (draft Agents have no id yet but may need this). */
export interface ProxyCatalogEntry {
  id: ProductExecutor;
  /** Display name, e.g. "Claude Code". */
  name: string;
  defaultColor: AgentColor;
  /** One-line product description. */
  tagline: string;
  officialInstallUrl: string;
}

/** A saved Agent plus its live path/Proxy probe status. */
export interface UserAgentStatus extends UserAgent {
  /** Display name of the Proxy kind (read-only on a saved card). */
  proxyName: string;
  ready: boolean;
  cli: AgentCliStatus;
  /** Installed Proxy (plugin) status of the Agent's kind. A kind has exactly
   *  one installed Proxy no matter how many Agents reference it. */
  plugin: AgentProxyStatus;
  officialInstallUrl: string;
}

export type AgentComponentState = 'ready' | 'missing' | 'invalid' | 'outdated';

export interface AgentCliStatus {
  state: AgentComponentState;
  path: string | null;
  version: string | null;
  recommendedVersion?: string | null;
  source: 'override' | 'official-user' | 'path' | null;
  error?: string;
}

export interface AgentProxyStatus {
  state: AgentComponentState;
  path: string | null;
  version: string | null;
  source: 'github-release' | 'development' | null;
  defaults: AgentProxyDefaults;
  error?: string;
}

/** Result of a read-only "is a newer compatible Proxy release available?"
 *  check against the release repository (issue #86). */
export interface AgentProxyUpdateCheck {
  /** false for development proxies — there is no managed update channel. */
  managed: boolean;
  /** Installed Proxy version; null when none is installed. */
  currentVersion: string | null;
  /** Newest release compatible with this App's protocol; null in dev mode. */
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface AgentInstallStatus {
  id: Executor;
  name: string;
  ready: boolean;
  cli: AgentCliStatus;
  proxy: AgentProxyStatus;
  officialInstallUrl: string;
}

export interface AgentInstallResult {
  agent: AgentInstallStatus;
  output?: string;
}

export function migrateLegacyGrokProxyDefaults(
  defaults: AgentProxyDefaults,
): AgentProxyDefaults {
  if (
    defaults.mode === 'default'
    || defaults.mode === 'auto'
    || defaults.mode === 'always_approve'
    || defaults.mode === ''
  ) {
    return defaults;
  }
  const effortLike = /^(none|minimal|low|medium|high|xhigh|max)$/i.test(defaults.mode);
  return {
    model: defaults.model,
    thinking: defaults.thinking || (effortLike ? defaults.mode : ''),
    mode: 'default',
  };
}
