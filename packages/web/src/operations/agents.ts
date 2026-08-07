/**
 * UI Operation Layer — Agent-domain definitions (Phase 3b of
 * `docs/proposals/ui-operation-layer.md`): executor CLI/proxy install, CLI
 * path, proxy defaults, the native CLI-path picker, and the desktop restart.
 * All PENDING (REST, plus the desktop bridge for the restart) — the result
 * entity (`AgentInstallStatus`) is recorded on the run (`run.result`, Phase
 * 3a) and the views refresh their agent query state once the run confirms.
 *
 * Entity keys are `agent:<executor>` so two operations on the SAME executor
 * serialize per operation name (the duplicate pending guard), while work on
 * different executors proceeds concurrently. The picker uses a per-run
 * `pending:` key — a cancel is a confirmed no-op (`result.path` null), never
 * a failure (same convention as `workspace.pickFolder`).
 *
 * DESKTOP RESTART FLOW (pre-migration SettingsBody :565-596, preserved):
 * changing the CLI path inside the desktop app requires an app restart. The
 * VIEW keeps the user interaction (the restart confirm dialog) and dispatches
 * `agent.setCliPath` with `restart: true`; the executor then sets the path,
 * asks the bridge to restart, and — when the restart can't happen — restores
 * the previous CLI path (so the running app and the stored config agree) and
 * fails the run with the view-supplied localized message.
 *
 * `agent.restartApp` is registered for the bridge→operation map (inventory
 * §2) but has no direct UI entry: the only restart today happens INSIDE the
 * `agent.setCliPath` flow above, which must sequence path-set → restart →
 * rollback as one operation.
 */
import type { AgentInstallStatus, AgentProxyDefaults, Executor } from '@gian/shared';

import {
  installAgentCli,
  installAgentProxy,
  pickAgentCliPath,
  setAgentCliPath,
  setAgentProxyDefaults,
} from '../api.js';
import { desktopBridge } from '../desktop-bridge.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** Entity key for one executor's install/configuration operations. */
export function agentEntityKey(executor: Executor): string {
  return `agent:${executor}`;
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

const agentInstallCli: OperationDefinition<ExecutorInput, AgentInstallStatus> = {
  policy: 'pending',
  entityKey: input => agentEntityKey(input.executor),
  execute: async input => (await installAgentCli(input.executor)).agent,
  timeoutMs: INSTALL_TIMEOUT_MS,
};

const agentInstallProxy: OperationDefinition<ExecutorInput, AgentInstallStatus> = {
  policy: 'pending',
  entityKey: input => agentEntityKey(input.executor),
  execute: async input => (await installAgentProxy(input.executor)).agent,
  timeoutMs: INSTALL_TIMEOUT_MS,
};

export interface SetCliPathInput extends ExecutorInput {
  path: string | null;
  /** Desktop flow (see header): restart the app after the path lands. */
  restart: boolean;
  /** Path to restore when the restart can't happen (rollback path). */
  previousPath: string | null;
  /** Localized restart-failure message (the view owns i18n). */
  restartFailedMessage?: string;
}

const agentSetCliPath: OperationDefinition<SetCliPathInput, AgentInstallStatus> = {
  policy: 'pending',
  entityKey: input => agentEntityKey(input.executor),
  execute: async input => {
    const updated = await setAgentCliPath(input.executor, input.path);
    if (!input.restart) return updated;
    const restarting = await desktopBridge()?.restartApp?.() ?? false;
    if (restarting) return updated;
    // Restart failed: restore the previous path so the running app and the
    // stored config agree, then fail the run (pre-migration rollback at
    // SettingsBody :593).
    await setAgentCliPath(input.executor, input.previousPath);
    throw new Error(input.restartFailedMessage ?? 'Restart failed');
  },
  timeoutMs: REST_TIMEOUT_MS,
};

const agentSetProxyDefaults: OperationDefinition<
  ExecutorInput & { defaults: Partial<AgentProxyDefaults> },
  AgentInstallStatus
> = {
  policy: 'pending',
  entityKey: input => agentEntityKey(input.executor),
  execute: input => setAgentProxyDefaults(input.executor, input.defaults),
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
registry.register('agent.setCliPath', agentSetCliPath);
registry.register('agent.setProxyDefaults', agentSetProxyDefaults);
registry.register('agent.pickCliPath', agentPickCliPath);
registry.register('agent.restartApp', agentRestartApp);
