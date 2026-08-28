/**
 * UI Operation Layer — Agent-domain definitions. Kind-level operations
 * (official CLI / Proxy install, update check, the native CLI-path picker)
 * key on `agent:<proxy kind>`; saved-Agent operations key on
 * `agent:id:<uuid>`. All PENDING (REST, plus the desktop bridge for the
 * restart).
 *
 * DESKTOP RESTART FLOW (preserved from the pre-Agent setCliPath flow):
 * changes to the boot load set — create, delete, CLI path, Proxy kind —
 * write agents.json and then restart Gian. The VIEW keeps the restart
 * confirm dialog and dispatches with `restart: true`; the executor writes,
 * asks the bridge to restart, and — when the restart can't happen — rolls
 * the write back (delete a created Agent, restore the previous path/kind,
 * re-create a deleted Agent from its snapshot) and fails the run with the
 * view-supplied localized message. Name/defaults are write-through
 * and never restart.
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
  updateAgent,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '../api.js';
import { desktopBridge } from '../desktop-bridge.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** Entity key for one Proxy kind's install/configuration operations. */
export function agentEntityKey(executor: Executor): string {
  return `agent:${executor}`;
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

interface AgentIdInput {
  agentId: string;
}

/** Save a draft into agents.json (load-set change → restart on desktop).
 *  Rollback on restart failure deletes the just-created Agent. */
export interface CreateAgentOperationInput extends CreateAgentInput {
  restart: boolean;
  restartFailedMessage?: string;
}

const agentCreate: OperationDefinition<CreateAgentOperationInput, UserAgentStatus> = {
  policy: 'pending',
  entityKey: () => `pending:agent.create:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  execute: async input => {
    const created = await createAgent({
      name: input.name,
      proxy: input.proxy,
      ...(input.cliPath !== undefined ? { cliPath: input.cliPath } : {}),
      ...(input.defaults !== undefined ? { defaults: input.defaults } : {}),
    });
    if (!input.restart) return created;
    const restarting = await desktopBridge()?.restartApp?.() ?? false;
    if (restarting) return created;
    await deleteAgent(created.id).catch(() => undefined);
    throw new Error(input.restartFailedMessage ?? 'Restart failed');
  },
  timeoutMs: REST_TIMEOUT_MS,
};

/** Delete a saved Agent (load-set change → restart on desktop). Rollback
 *  re-creates the Agent from the pre-delete snapshot (new id). */
export interface DeleteAgentOperationInput extends AgentIdInput {
  snapshot: {
    name: string;
    proxy: ProductExecutor;
    cliPath: string | null;
    defaults: AgentProxyDefaults;
  };
  restart: boolean;
  restartFailedMessage?: string;
}

const agentDelete: OperationDefinition<DeleteAgentOperationInput, boolean> = {
  policy: 'pending',
  entityKey: input => agentIdEntityKey(input.agentId),
  execute: async input => {
    await deleteAgent(input.agentId);
    if (!input.restart) return true;
    const restarting = await desktopBridge()?.restartApp?.() ?? false;
    if (restarting) return true;
    await createAgent({
      name: input.snapshot.name,
      proxy: input.snapshot.proxy,
      cliPath: input.snapshot.cliPath,
      defaults: input.snapshot.defaults,
    }).catch(() => undefined);
    throw new Error(input.restartFailedMessage ?? 'Restart failed');
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

/** CLI path change (load-set change → restart on desktop, rollback restores
 *  the previous path). */
export interface SetAgentPathOperationInput extends AgentIdInput {
  path: string | null;
  restart: boolean;
  previousPath: string | null;
  restartFailedMessage?: string;
}

const agentSetPath: OperationDefinition<SetAgentPathOperationInput, UserAgentStatus> = {
  policy: 'pending',
  entityKey: input => agentIdEntityKey(input.agentId),
  execute: async input => {
    const updated = await updateAgent(input.agentId, { cliPath: input.path });
    if (!input.restart) return updated;
    const restarting = await desktopBridge()?.restartApp?.() ?? false;
    if (restarting) return updated;
    await updateAgent(input.agentId, { cliPath: input.previousPath }).catch(() => updated);
    throw new Error(input.restartFailedMessage ?? 'Restart failed');
  },
  timeoutMs: REST_TIMEOUT_MS,
};

/** Proxy-kind switch on a saved Agent (load-set change → restart on
 *  desktop, rollback restores the previous kind). The caller retargets the
 *  CLI path in the same patch (the old kind's binary is never the right
 *  runtime for the new kind). */
export interface SwitchAgentProxyOperationInput extends AgentIdInput {
  proxy: ProductExecutor;
  cliPath: string | null;
  previousProxy: ProductExecutor;
  previousCliPath: string | null;
  restart: boolean;
  restartFailedMessage?: string;
}

const agentSwitchProxy: OperationDefinition<SwitchAgentProxyOperationInput, UserAgentStatus> = {
  policy: 'pending',
  entityKey: input => agentIdEntityKey(input.agentId),
  execute: async input => {
    const updated = await updateAgent(input.agentId, { proxy: input.proxy, cliPath: input.cliPath });
    if (!input.restart) return updated;
    const restarting = await desktopBridge()?.restartApp?.() ?? false;
    if (restarting) return updated;
    await updateAgent(input.agentId, {
      proxy: input.previousProxy,
      cliPath: input.previousCliPath,
    }).catch(() => updated);
    throw new Error(input.restartFailedMessage ?? 'Restart failed');
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
registry.register('agent.create', agentCreate);
registry.register('agent.delete', agentDelete);
registry.register('agent.patch', agentPatch);
registry.register('agent.setPath', agentSetPath);
registry.register('agent.switchProxy', agentSwitchProxy);
registry.register('agent.restartApp', agentRestartApp);
