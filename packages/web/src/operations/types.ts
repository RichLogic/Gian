/**
 * UI Operation Layer — Phase 0 artifact of
 * `docs/archive/proposals/ui-operation-layer.md`.
 *
 * This module currently contains ONLY the closed operation-name union, the
 * policy table, and the shared types from proposal §4.2/§4.3. The operation
 * store, overlay reducer, dispatcher, and hooks land in Phase 1. Nothing
 * here is wired into product code yet; the full rationale for every name
 * and policy lives in `docs/archive/proposals/ui-operation-inventory.md`.
 */
import type { ClientToServerMessage } from '@gian/shared';

export type OperationPolicy = 'local' | 'optimistic' | 'pending';

/**
 * Closed union of every registered UI operation. Adding a name here without
 * a policy entry (or vice versa) fails TypeScript via `OPERATION_POLICIES`
 * below — that is the type-level completeness gate from proposal §4.2.
 */
export type OperationName =
  // Session
  | 'session.create'
  | 'session.fork'
  | 'session.delete'
  | 'session.stop'
  | 'session.recover'
  | 'session.rename'
  | 'session.archive'
  | 'session.pin'
  | 'session.setUnread'
  | 'session.setMode'
  | 'session.setModel'
  | 'session.setEffort'
  | 'session.setServiceTier'
  | 'session.setNativeConfig'
  | 'session.merge'
  | 'session.drop'
  // Message / Queue / Approval
  | 'message.send'
  | 'message.sendSkill'
  | 'message.steer'
  | 'message.uploadAttachment'
  | 'queue.add'
  | 'queue.update'
  | 'queue.remove'
  | 'queue.clear'
  | 'queue.sendNow'
  | 'approval.resolve'
  // Task
  | 'task.create'
  | 'task.rename'
  | 'task.toggleDone'
  | 'task.pin'
  | 'task.delete'
  | 'task.createSubtask'
  | 'task.completeSubtask'
  | 'task.reopenSubtask'
  // Workspace
  | 'workspace.create'
  | 'workspace.rename'
  | 'workspace.setHidden'
  | 'workspace.pin'
  | 'workspace.reorder'
  | 'workspace.delete'
  | 'workspace.saveClaudeMd'
  | 'workspace.pickFolder'
  // Git / worktree / external open
  | 'git.fetch'
  | 'git.historyFetch'
  | 'git.abortPendingOp'
  | 'git.stage'
  | 'git.unstage'
  | 'files.openExternal'
  | 'browser.openExternal'
  | 'browser.clearData'
  // Native Session
  | 'native.adopt'
  | 'native.delete'
  // Settings / Agents / Onboarding / Auth
  | 'settings.save'
  | 'settings.resetOnboarding'
  | 'agent.installCli'
  | 'agent.installProxy'
  | 'agent.setCliPath'
  | 'agent.setProxyDefaults'
  | 'agent.pickCliPath'
  | 'agent.restartApp'
  | 'onboarding.saveProjectRoot'
  | 'onboarding.complete'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.githubLogin'
  // Terminal
  | 'term.spawn'
  | 'term.close';

/**
 * The policy table — the Phase 0 source of truth. `optimistic` renders the
 * reversible result immediately and rolls back only on explicit failure;
 * `pending` renders a stable in-progress state and blocks duplicate
 * submission. There is deliberately no fourth policy (proposal §2).
 */
export const OPERATION_POLICIES = {
  'session.create': 'pending',
  'session.fork': 'pending',
  'session.delete': 'pending',
  'session.stop': 'pending',
  'session.recover': 'pending',
  'session.rename': 'optimistic',
  'session.archive': 'optimistic',
  'session.pin': 'optimistic',
  'session.setUnread': 'optimistic',
  'session.setMode': 'optimistic',
  'session.setModel': 'optimistic',
  'session.setEffort': 'optimistic',
  'session.setServiceTier': 'optimistic',
  // Pending, not optimistic (Phase 2a decision, inventory §4 note 6): the
  // rendered value lives in `native_config_options[].currentValue` — a nested
  // array element, not a flat Session field — so it does not fit the
  // entity+field overlay model (absorption compares with Object.is). The
  // Composer's local option patch keeps the instant feedback; the run tracks
  // the Host result per config option.
  'session.setNativeConfig': 'pending',
  'session.merge': 'pending',
  'session.drop': 'pending',
  'message.send': 'optimistic',
  'message.sendSkill': 'optimistic',
  'message.steer': 'pending',
  'message.uploadAttachment': 'pending',
  'queue.add': 'optimistic',
  'queue.update': 'optimistic',
  'queue.remove': 'optimistic',
  'queue.clear': 'optimistic',
  'queue.sendNow': 'pending',
  'approval.resolve': 'pending',
  'task.create': 'pending',
  'task.rename': 'optimistic',
  'task.toggleDone': 'optimistic',
  'task.pin': 'optimistic',
  'task.delete': 'pending',
  'task.createSubtask': 'pending',
  'task.completeSubtask': 'pending',
  'task.reopenSubtask': 'pending',
  'workspace.create': 'pending',
  'workspace.rename': 'optimistic',
  'workspace.setHidden': 'optimistic',
  'workspace.pin': 'optimistic',
  'workspace.reorder': 'optimistic',
  'workspace.delete': 'pending',
  'workspace.saveClaudeMd': 'pending',
  'workspace.pickFolder': 'pending',
  'git.fetch': 'pending',
  'git.historyFetch': 'pending',
  'git.abortPendingOp': 'pending',
  'git.stage': 'pending',
  'git.unstage': 'pending',
  'files.openExternal': 'pending',
  'browser.openExternal': 'pending',
  'browser.clearData': 'pending',
  'native.adopt': 'pending',
  'native.delete': 'pending',
  'settings.save': 'optimistic',
  'settings.resetOnboarding': 'pending',
  'agent.installCli': 'pending',
  'agent.installProxy': 'pending',
  'agent.setCliPath': 'pending',
  'agent.setProxyDefaults': 'pending',
  'agent.pickCliPath': 'pending',
  'agent.restartApp': 'pending',
  'onboarding.saveProjectRoot': 'pending',
  'onboarding.complete': 'pending',
  'auth.login': 'pending',
  'auth.logout': 'pending',
  'auth.githubLogin': 'pending',
  'term.spawn': 'pending',
  'term.close': 'pending',
} satisfies Record<OperationName, OperationPolicy>;

/**
 * WS message types that mutate Host state — every `ClientToServerMessage`
 * except the protocol exceptions (proposal §4.4): authentication bootstrap,
 * event subscription, terminal byte streaming, and replay request.
 */
export type MutatingWsType = Exclude<
  ClientToServerMessage['type'],
  'auth' | 'events:subscribe' | 'term:input' | 'term:resize' | 'term:replay-request'
>;

/** The mutating members of `ClientToServerMessage` — every one carries the
 *  optional `request_id` correlation field (proposal §4.4). */
export type MutatingClientMessage = Exclude<
  ClientToServerMessage,
  { type: 'auth' | 'events:subscribe' | 'term:input' | 'term:resize' | 'term:replay-request' }
>;

/**
 * WS-type → policy map. All operations sharing one WS type share its policy
 * (e.g. `session:create` backs both `session.create` and `session.fork`,
 * both pending), so a type-level map is sufficient for the static gate's
 * reverse check (proposal §6: a mutating WS type missing here fails).
 */
export const WS_TYPE_POLICIES = {
  'session:create': 'pending',
  'message:send': 'optimistic',
  'message:steer': 'pending',
  'approval:resolve': 'pending',
  'session:stop': 'pending',
  'session:recover': 'pending',
  'session:rename': 'optimistic',
  'session:archive': 'optimistic',
  'session:pin': 'optimistic',
  'session:delete': 'pending',
  'session:set_unread': 'optimistic',
  'session:set_mode': 'optimistic',
  'session:set_model': 'optimistic',
  'session:set_effort': 'optimistic',
  'session:set_service_tier': 'optimistic',
  'session:set_native_config': 'pending', // see OPERATION_POLICIES note
  'task:create': 'pending',
  'task:update': 'optimistic',
  'task:delete': 'pending',
  'queue:add': 'optimistic',
  'queue:remove': 'optimistic',
  'queue:update': 'optimistic',
  'queue:send_now': 'pending',
  'queue:clear': 'optimistic',
  'term:spawn': 'pending',
  'term:close': 'pending',
} satisfies Record<MutatingWsType, OperationPolicy>;

/** One field-level optimistic write (proposal §4.2). */
export interface FieldWrite {
  /** Field name on the entity, e.g. "name". */
  field: string;
  /** Overlay value; the store records the prior value for rollback. */
  value: unknown;
}

/**
 * A single overlay revision, keyed by entity + field (proposal §4.3).
 * Overlays always render above canonical state; a run's result affects only
 * the overlays whose `operationId` still matches that run.
 */
export interface OptimisticOverlay {
  /** Entity + field, e.g. "session:<id>:name". */
  entityFieldKey: string;
  /** The run that wrote this revision. */
  operationId: string;
  value: unknown;
  /** Value to restore on rollback. */
  previous: unknown;
  /** Set after timeout/disconnect — outcome unknown, never rolled back. */
  unresolved?: boolean;
}

/** Transient state of one dispatched operation run (proposal §4.3). */
export interface OperationRun {
  id: string;
  name: OperationName;
  entityKey: string;
  phase: 'optimistic' | 'pending' | 'confirmed' | 'failed' | 'timed-out';
  startedAt: number;
  error?: string;
  /** REST executor result, recorded on success (Phase 3a) so views can
   *  consume the created/updated entity (e.g. select the workspace or
   *  subtask a pending create returned) from `useOperationRun`. */
  result?: unknown;
}

export interface OperationError {
  code: string;
  message: string;
}

/**
 * Per-dispatch context handed to `execute`/`reconcile`/`rollback`.
 * `requestId` correlates the run with the Host: for WS-backed operations it
 * is the `request_id` sent on the wire; for REST-backed ones it is still
 * minted (it identifies the local run) even though the HTTP promise already
 * identifies the request (proposal §4.4).
 */
export interface OperationContext {
  runId: string;
  requestId: string;
  /** Canonical entity key captured when the run starts. Escape-hatch
   * rollbacks use it to converge adjacent local UI state precisely. */
  entityKey: string;
}

/**
 * Registry entry shape (proposal §4.2). Overlay ownership, absorption,
 * rollback, and the unresolved path are uniform and store-driven (§4.3);
 * `reconcile`/`rollback` are escape hatches for non-standard effects only.
 *
 * Transport is declared by exactly one of (checked at registration time):
 * - `buildMessage` — WS executor: the dispatcher mints `request_id`, sends
 *   the message through the socket, and settles the run from the correlated
 *   `operation:result` (proposal §4.4). `Result` is `void` here.
 * - `execute` — REST executor: the dispatcher settles the run from the
 *   returned promise (resolve → confirmed, reject → failed).
 */
export interface OperationDefinition<Input, Result = void> {
  policy: OperationPolicy;
  entityKey(input: Input): string;
  optimisticWrites?(input: Input): FieldWrite[];
  buildMessage?(input: Input): MutatingClientMessage;
  execute?(input: Input, context: OperationContext): Promise<Result>;
  reconcile?(result: Result, context: OperationContext): void;
  rollback?(error: OperationError, context: OperationContext): void;
  timeoutMs: number;
}
