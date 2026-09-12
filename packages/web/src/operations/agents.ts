/**
 * UI Operation Layer — Agent-domain definitions. Kind-level operations
 * (official CLI / Proxy install, update check, the native CLI-path picker)
 * key on `agent:<proxy kind>`; saved-Agent operations key on
 * `agent:id:<uuid>`. All PENDING REST operations.
 *
 * Agent create/delete/path/Proxy-switch mutations take effect for future
 * Sessions immediately — they never restart Desktop. App-level
 * `agent.restartApp` stays available for onboarding/install completion only.
 */
import type {
  AgentInstallResult,
  AgentProxyDefaults,
  AgentProxyUpdateCheck,
  Executor,
  ProductExecutor,
  UserAgentStatus,
} from '@gian/shared';

import {
  checkAgentProxyUpdate,
  createAgent,
  deleteAgent,
  installAgentCli,
  installAgentProxy,
  pickAgentCliPath,
  pickAgentHome,
  updateAgent,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '../api.js';
import { desktopBridge } from '../desktop-bridge.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** Entity key for one Proxy kind's install/configuration operations. */
export function agentEntityKey(executor: Executor | string | null): string {
  return `agent:${executor ?? 'unknown'}`;
}

/** Entity key for one saved Agent's mutations. */
export function agentIdEntityKey(agentId: string): string {
  return `agent:id:${agentId}`;
}

/** Agent installs download/verify bundles — slower than a metadata write. */
const INSTALL_TIMEOUT_MS = 120_000;
/** REST round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const REST_TIMEOUT_MS = 30_000;
/** The native picker dialog can stay open for minutes. */
const PICK_TIMEOUT_MS = 300_000;

interface ExecutorInput {
  executor: Executor;
}

const agentInstallCli: OperationDefinition<ExecutorInput, AgentInstallResult['agent']> = {
  policy: 'pending',
  entityKey: input => agentEntityKey(input.executor),
  execute: async input => (await installAgentCli(input.executor)).agent,
  timeoutMs: INSTALL_TIMEOUT_MS,
};

const agentInstallProxy: OperationDefinition<ExecutorInput, AgentInstallResult['agent']> = {
  policy: 'pending',
  entityKey: input => agentEntityKey(input.executor),
  execute: async input => (await installAgentProxy(input.executor)).agent,
  timeoutMs: INSTALL_TIMEOUT_MS,
};

/** Read-only release-availability probe (issue #86). The result entity is
 *  the check itself (stored on `run.result`), NOT an AgentInstallStatus —
 *  nothing about the installed Proxy changes, so no agent cache refresh. */
const agentCheckProxyUpdate: OperationDefinition<ExecutorInput, AgentProxyUpdateCheck> = {
  policy: 'pending',
  entityKey: input => agentEntityKey(input.executor),
  execute: input => checkAgentProxyUpdate(input.executor),
  // GitHub release metadata via the Desktop broker / anonymous fetch can be
  // slower than a local REST round-trip but is far under the install budget.
  timeoutMs: REST_TIMEOUT_MS,
};

const agentPickCliPath: OperationDefinition<ExecutorInput, string | null> = {
  policy: 'pending',
  // Cancelable native dialog: a cancel resolves null — a confirmed no-op,
  // NOT a failure (the Browse button just re-enables).
  entityKey: input => `${agentEntityKey(input.executor)}:pick`,
  execute: input => pickAgentCliPath(input.executor),
  timeoutMs: PICK_TIMEOUT_MS,
};

const agentPickHome: OperationDefinition<{ agentId?: string }, string | null> = {
  policy: 'pending',
  entityKey: input => input.agentId
    ? `${agentIdEntityKey(input.agentId)}:pick-home`
    : 'pending:agent.pick-home',
  execute: input => pickAgentHome(input.agentId),
  timeoutMs: PICK_TIMEOUT_MS,
};

interface AgentIdInput {
  agentId: string;
}

/** Save a draft into agents.json. Takes effect for future Sessions
 *  immediately; no restart is requested or performed. */
export type CreateAgentOperationInput = CreateAgentInput;

export interface CreateAgentOperationResult {
  agent: UserAgentStatus;
}

const agentCreate: OperationDefinition<CreateAgentOperationInput, CreateAgentOperationResult> = {
  policy: 'pending',
  entityKey: () => `pending:agent.create:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  execute: async input => {
    const created = await createAgent({
      name: input.name,
      ...(input.pluginId !== undefined ? { pluginId: input.pluginId } : {}),
      ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
      ...(input.home !== undefined ? { home: input.home } : {}),
      ...(input.cliPath !== undefined ? { cliPath: input.cliPath } : {}),
      ...(input.defaults !== undefined ? { defaults: input.defaults } : {}),
    });
    return { agent: created };
  },
  timeoutMs: REST_TIMEOUT_MS,
};

/** Delete a saved Agent (immediate effect; no restart). */
export interface DeleteAgentOperationInput extends AgentIdInput {
  snapshot: {
    name: string;
    pluginId?: string;
    proxy: ProductExecutor | null;
    cliPath: string | null;
    defaults: AgentProxyDefaults;
  };
}

const agentDelete: OperationDefinition<DeleteAgentOperationInput, boolean> = {
  policy: 'pending',
  entityKey: input => agentIdEntityKey(input.agentId),
  execute: async input => {
    await deleteAgent(input.agentId);
    return true;
  },
  timeoutMs: REST_TIMEOUT_MS,
};

/** Write-through Agent patches: name and Defaults never touch the
 *  boot load set, so they never restart. */
export interface PatchAgentOperationInput extends AgentIdInput {
  patch: UpdateAgentInput;
}

const agentPatch: OperationDefinition<PatchAgentOperationInput, UserAgentStatus> = {
  policy: 'pending',
  entityKey: input => agentIdEntityKey(input.agentId),
  execute: input => updateAgent(input.agentId, input.patch),
  timeoutMs: REST_TIMEOUT_MS,
};

/** CLI path change (immediate effect; no restart). */
export interface SetAgentPathOperationInput extends AgentIdInput {
  path: string | null;
  previousPath: string | null;
}

const agentSetPath: OperationDefinition<SetAgentPathOperationInput, UserAgentStatus> = {
  policy: 'pending',
  entityKey: input => agentIdEntityKey(input.agentId),
  execute: async input => {
    const updated = await updateAgent(input.agentId, { cliPath: input.path });
    return updated;
  },
  timeoutMs: REST_TIMEOUT_MS,
};

/** Proxy-kind switch on a saved Agent (immediate effect; no restart). The
 *  caller retargets the CLI path in the same patch (the old kind's binary
 *  is never the right runtime for the new kind). */
export interface SwitchAgentProxyOperationInput extends AgentIdInput {
  proxy: ProductExecutor;
  cliPath: string | null;
  previousProxy: ProductExecutor;
  previousCliPath: string | null;
}

const agentSwitchProxy: OperationDefinition<SwitchAgentProxyOperationInput, UserAgentStatus> = {
  policy: 'pending',
  entityKey: input => agentIdEntityKey(input.agentId),
  execute: async input => {
    const updated = await updateAgent(input.agentId, { proxy: input.proxy, cliPath: input.cliPath });
    return updated;
  },
  timeoutMs: REST_TIMEOUT_MS,
};

const agentRestartApp: OperationDefinition<Record<string, never>, boolean> = {
  policy: 'pending',
  entityKey: () => 'agent:app:restart',
  execute: async () => {
    const restarting = await desktopBridge()?.restartApp?.() ?? false;
    if (!restarting) throw new Error('Restart failed');
    return true;
  },
  timeoutMs: REST_TIMEOUT_MS,
};

registry.register('agent.installCli', agentInstallCli);
registry.register('agent.installProxy', agentInstallProxy);
registry.register('agent.checkProxyUpdate', agentCheckProxyUpdate);
registry.register('agent.pickCliPath', agentPickCliPath);
registry.register('agent.pickHome', agentPickHome);
registry.register('agent.create', agentCreate);
registry.register('agent.delete', agentDelete);
registry.register('agent.patch', agentPatch);
registry.register('agent.setPath', agentSetPath);
registry.register('agent.switchProxy', agentSwitchProxy);
registry.register('agent.restartApp', agentRestartApp);
