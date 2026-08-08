/**
 * UI Operation Layer — Session-domain definitions (Phase 2a of
 * `docs/archive/proposals/ui-operation-layer.md`). Every Session mutation the UI can
 * trigger is registered here on the product registry; entry points
 * (controllers, shortcuts, views) dispatch by name instead of calling
 * `ws.send` / mutation APIs directly.
 *
 * Entity keys are `session:<id>`. Optimistic writes target flat Session
 * fields (`name`, `pinned_at`, `archived`, `unread`, `approval_mode`,
 * `model`, `thinking_effort`, `service_tier`); rendering merges
 * `canonical + overlays` via `applySessionOverlays` (see use-operations.ts
 * for the hooks).
 *
 * `session.setNativeConfig` is deliberately PENDING (inventory §4 note 6):
 * its rendered value lives in `native_config_options[].currentValue`, a
 * nested array element that does not fit the entity+field overlay model.
 * The Composer's local option patch keeps the instant feedback; the run
 * still correlates the Host result and blocks duplicate submissions of the
 * same option (entity key includes the config id, so different options of
 * one session proceed concurrently).
 */
import type {
  ApprovalMode,
  Executor,
  NativeConfigValue,
  Session,
  ThinkingEffort,
} from '@gian/shared';

import { dropSession, mergeSession } from '../api.js';
import { toast } from '../feedback.js';
import { registry } from './registry.js';
import type { OperationDefinition, OptimisticOverlay } from './types.js';

/** Entity key for an existing session. */
export function sessionEntityKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/** WS round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const WS_TIMEOUT_MS = 10_000;
/** Session creation spins up the executor/proxy — slower than a metadata
 *  write but still bounded. */
const CREATE_TIMEOUT_MS = 30_000;
/** Merge/drop run real git work (merge, worktree teardown). */
const GIT_TIMEOUT_MS = 60_000;

interface SessionIdInput {
  sessionId: string;
}

const sessionRename: OperationDefinition<SessionIdInput & { name: string }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  // The overlay mirrors what the Host will persist (trimmed, empty → null);
  // the wire message carries the raw input, as before the migration.
  optimisticWrites: input => [{ field: 'name', value: input.name.trim() || null }],
  buildMessage: input => ({ type: 'session:rename', session_id: input.sessionId, name: input.name }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionArchive: OperationDefinition<SessionIdInput & { archived: boolean }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => [{ field: 'archived', value: input.archived ? 1 : 0 }],
  buildMessage: input => ({ type: 'session:archive', session_id: input.sessionId, archived: input.archived }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionPin: OperationDefinition<SessionIdInput & { pinned: boolean }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => [{ field: 'pinned_at', value: input.pinned ? new Date().toISOString() : null }],
  buildMessage: input => ({ type: 'session:pin', session_id: input.sessionId, pinned: input.pinned }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionSetUnread: OperationDefinition<SessionIdInput & { unread: boolean }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => [{ field: 'unread', value: input.unread ? 1 : 0 }],
  buildMessage: input => ({ type: 'session:set_unread', session_id: input.sessionId, unread: input.unread }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionSetMode: OperationDefinition<SessionIdInput & { approvalMode: ApprovalMode }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => [{ field: 'approval_mode', value: input.approvalMode }],
  buildMessage: input => ({ type: 'session:set_mode', session_id: input.sessionId, approval_mode: input.approvalMode }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionSetModel: OperationDefinition<SessionIdInput & { model: string }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => [{ field: 'model', value: input.model.trim() || null }],
  buildMessage: input => ({ type: 'session:set_model', session_id: input.sessionId, model: input.model }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionSetEffort: OperationDefinition<SessionIdInput & { effort: ThinkingEffort | null }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => [{ field: 'thinking_effort', value: input.effort }],
  buildMessage: input => ({ type: 'session:set_effort', session_id: input.sessionId, effort: input.effort }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionSetServiceTier: OperationDefinition<SessionIdInput & { tier: 'fast' | null }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => [{ field: 'service_tier', value: input.tier }],
  buildMessage: input => ({ type: 'session:set_service_tier', session_id: input.sessionId, service_tier: input.tier }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionSetNativeConfig: OperationDefinition<SessionIdInput & { configId: string; value: NativeConfigValue }> = {
  policy: 'pending',
  // Per-option key: changing two different options of one session is not a
  // duplicate submission and must not be blocked (proposal §4.3 duplicate
  // guard is name + entityKey).
  entityKey: input => `${sessionEntityKey(input.sessionId)}:native-config:${input.configId}`,
  buildMessage: input => ({
    type: 'session:set_native_config',
    session_id: input.sessionId,
    config_id: input.configId,
    value: input.value,
  }),
  timeoutMs: WS_TIMEOUT_MS,
};

export interface SessionCreateInput {
  workspaceId: string;
  executor: Executor;
  name?: string;
}

const sessionCreate: OperationDefinition<SessionCreateInput> = {
  policy: 'pending',
  // The entity does not exist yet (proposal §4.3): a fresh pending key per
  // run, so two concurrent creates never read as duplicate submissions.
  entityKey: () => `pending:session.create:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  buildMessage: input => ({
    type: 'session:create',
    workspace_id: input.workspaceId,
    executor: input.executor,
    ...(input.name ? { name: input.name } : {}),
  }),
  timeoutMs: CREATE_TIMEOUT_MS,
};

export interface SessionForkInput {
  workspaceId: string;
  executor: Executor;
  name: string;
  /** Inherited from the source session; omitted for Kimi (executor-native
   *  configuration, see SessionCreateMessage). */
  approvalMode?: ApprovalMode | null;
}

const sessionFork: OperationDefinition<SessionForkInput> = {
  policy: 'pending',
  entityKey: () => `pending:session.fork:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  buildMessage: input => ({
    type: 'session:create',
    workspace_id: input.workspaceId,
    executor: input.executor,
    ...(input.executor !== 'kimi' && input.approvalMode ? { approval_mode: input.approvalMode } : {}),
    name: input.name,
  }),
  timeoutMs: CREATE_TIMEOUT_MS,
};

const sessionDelete: OperationDefinition<SessionIdInput> = {
  policy: 'pending',
  entityKey: input => sessionEntityKey(input.sessionId),
  buildMessage: input => ({ type: 'session:delete', session_id: input.sessionId }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionStop: OperationDefinition<SessionIdInput> = {
  policy: 'pending',
  entityKey: input => sessionEntityKey(input.sessionId),
  buildMessage: input => ({ type: 'session:stop', session_id: input.sessionId }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionRecover: OperationDefinition<SessionIdInput> = {
  policy: 'pending',
  entityKey: input => sessionEntityKey(input.sessionId),
  buildMessage: input => ({ type: 'session:recover', session_id: input.sessionId }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionMerge: OperationDefinition<SessionIdInput> = {
  policy: 'pending',
  entityKey: input => sessionEntityKey(input.sessionId),
  execute: async input => {
    const result = await mergeSession(input.sessionId);
    if (!result.ok) throw new Error(result.error ?? 'merge failed');
  },
  // REST failures have no error envelope — surface them here (the pre-
  // migration call sites toasted the same message).
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: GIT_TIMEOUT_MS,
};

const sessionDrop: OperationDefinition<SessionIdInput> = {
  policy: 'pending',
  entityKey: input => sessionEntityKey(input.sessionId),
  execute: async input => {
    const result = await dropSession(input.sessionId);
    if (!result.ok) throw new Error(result.error ?? 'drop failed');
  },
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: GIT_TIMEOUT_MS,
};

registry.register('session.rename', sessionRename);
registry.register('session.archive', sessionArchive);
registry.register('session.pin', sessionPin);
registry.register('session.setUnread', sessionSetUnread);
registry.register('session.setMode', sessionSetMode);
registry.register('session.setModel', sessionSetModel);
registry.register('session.setEffort', sessionSetEffort);
registry.register('session.setServiceTier', sessionSetServiceTier);
registry.register('session.setNativeConfig', sessionSetNativeConfig);
registry.register('session.create', sessionCreate);
registry.register('session.fork', sessionFork);
registry.register('session.delete', sessionDelete);
registry.register('session.stop', sessionStop);
registry.register('session.recover', sessionRecover);
registry.register('session.merge', sessionMerge);
registry.register('session.drop', sessionDrop);

/** Session fields an overlay may write (Phase 2a set). */
const SESSION_OVERLAY_FIELDS = new Set([
  'name',
  'pinned_at',
  'archived',
  'unread',
  'approval_mode',
  'model',
  'thinking_effort',
  'service_tier',
]);

/**
 * Render merge (proposal §4.3): `canonical + overlays`, the overlay always
 * winning. Returns the canonical object untouched when no overlay applies,
 * so unchanged sessions keep referential identity.
 */
export function applySessionOverlays(
  session: Session,
  overlays: readonly OptimisticOverlay[],
): Session {
  const entityKey = sessionEntityKey(session.id);
  let merged: Session | null = null;
  for (const overlay of overlays) {
    const field = overlay.entityFieldKey.slice(entityKey.length + 1);
    if (!SESSION_OVERLAY_FIELDS.has(field)) continue;
    if (merged === null) merged = { ...session };
    (merged as unknown as Record<string, unknown>)[field] = overlay.value;
  }
  return merged ?? session;
}
