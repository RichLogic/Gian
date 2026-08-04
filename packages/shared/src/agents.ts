import type { Executor } from './model.js';

export interface AgentProxyDefaults {
  /** Empty means the Proxy/CLI default. */
  model: string;
  /** Empty means the selected model's Proxy default. */
  thinking: string;
  /** Empty means the Proxy's default session mode. */
  mode: string;
}

export type AgentComponentState = 'ready' | 'missing' | 'invalid' | 'outdated';

export interface AgentCliStatus {
  state: AgentComponentState;
  path: string | null;
  version: string | null;
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
