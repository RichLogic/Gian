import type { Executor, ProductExecutor } from './model.js';

export interface AgentProxyDefaults {
  /** Empty means the Proxy/CLI default. */
  model: string;
  /** Empty means the selected model's Proxy default. */
  thinking: string;
  /** Empty means the Proxy's default session mode. */
  mode: string;
}

/** Stable user-Agent primary key (uuid). Agents live in `agents.json`
 *  (schema v3), not in SQLite — sessions reference them by plain text. */
export type AgentId = string;

/** A user-owned Agent: a named configuration on top of one Proxy
 *  kind. Multiple Agents may share a kind; the kind's official CLI / GitHub
 *  Proxy is still installed once per kind. */
export interface UserAgent {
  id: AgentId;
  /** Trimmed, case-insensitively unique across saved Agents; never empty. */
  name: string;
  proxy: ProductExecutor;
  /** Absolute CLI path chosen by the user; null = resolve via the kind's
   *  environment override, PATH, then official install locations. */
  cliPath: string | null;
  defaults: AgentProxyDefaults;
}

export type AgentRuntimeVerification = 'verified' | 'unverified' | 'incompatible';

/** Immutable facts selected for one Agent generation. Sessions snapshot this
 * object so a later Agent path change cannot retarget their native runtime. */
export interface AgentRuntimeProfile {
  id: string;
  agentId: AgentId;
  proxy: ProductExecutor;
  cliPath: string;
  cliVersion: string;
  /** Runtime state/config root when Gian can resolve it without guessing a
   * wrapper's private environment. */
  configHome: string | null;
  /** Provider-owned launcher/runtime content identity when available. */
  cliFingerprint: string | null;
  proxyVersion: string;
  verifiedCliVersions: string[];
  verification: AgentRuntimeVerification;
  skill: {
    name: 'gian-session';
    version: string;
    state: 'ready' | 'missing' | 'conflict' | 'invalid';
  };
}

/** Static catalog metadata for one Proxy kind. Served without spawning or
 *  probing anything (draft Agents have no id yet but may need this). */
export interface ProxyCatalogEntry {
  id: ProductExecutor;
  /** Display name, e.g. "Claude Code". */
  name: string;
  logo: {
    light: string;
    dark: string;
  };
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
  runtimeProfile: AgentRuntimeProfile | null;
  officialInstallUrl: string;
}

export type AgentComponentState = 'ready' | 'missing' | 'invalid' | 'outdated';

export interface AgentCliStatus {
  state: AgentComponentState;
  path: string | null;
  version: string | null;
  /** Exact versions covered by release regression for the selected Proxy. */
  verifiedVersions?: string[];
  /** Stable launcher/runtime identity used by immutable Session profiles. */
  contentFingerprint?: string | null;
  source: 'managed' | 'override' | 'official-user' | 'official-system' | 'path' | null;
  error?: string;
  /** Generic, actionable repair hint when state is not ready (Revision 2
   * §13.2). Providers stay anonymous; the Web never matches error strings. */
  readinessIssue?: { code: string; message: string; repairable: boolean };
}

export interface AgentProxyStatus {
  state: AgentComponentState;
  path: string | null;
  version: string | null;
  verifiedCliVersions?: string[];
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
