/**
 * UI Operation Layer — Native-session-domain definitions (Phase 3b of
 * `docs/proposals/ui-operation-layer.md`): adopt an executor-owned native
 * session as a Gian session, and delete a native session's underlying file.
 * Both PENDING REST (inventory: `native.adopt`, `native.delete`).
 *
 * The pane keeps its dialog + refresh UX: the Adopt dialog stays open with a
 * submitting state while the run is in flight, renders the run's error
 * inline on failure, and closes + refreshes the list on confirm (the created
 * Gian session arrives on the run as `run.result`); delete keeps the row
 * visible until the run confirms, then refreshes. Failures render inline in
 * the pane — no toast here (same convention as `workspace.delete`).
 */
import type { AdoptNativeSessionRequest, Executor, Session } from '@gian/shared';

import { adoptNativeSession, deleteNativeSession } from '../api.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** Entity key for one native session (adopt and delete are mutually
 *  exclusive per session, so they share the key). */
export function nativeEntityKey(workspaceId: string, executor: Executor, nativeId: string): string {
  return `native:${workspaceId}:${executor}:${nativeId}`;
}

/** Adoption binds history and may probe the executor — slower than a write. */
const ADOPT_TIMEOUT_MS = 30_000;
const REST_TIMEOUT_MS = 15_000;

export interface NativeAdoptInput {
  workspaceId: string;
  executor: Executor;
  nativeId: string;
  request: AdoptNativeSessionRequest;
}

const nativeAdopt: OperationDefinition<NativeAdoptInput, Session> = {
  policy: 'pending',
  entityKey: input => nativeEntityKey(input.workspaceId, input.executor, input.nativeId),
  // The adopted Gian session is the run result: the dialog closes and the
  // pane refreshes once the run confirms.
  execute: async input => {
    const result = await adoptNativeSession(input.workspaceId, input.request);
    if (!result.session) throw new Error(result.error ?? 'Adopt failed');
    return result.session;
  },
  timeoutMs: ADOPT_TIMEOUT_MS,
};

const nativeDelete: OperationDefinition<{ workspaceId: string; executor: Executor; nativeId: string }> = {
  policy: 'pending',
  entityKey: input => nativeEntityKey(input.workspaceId, input.executor, input.nativeId),
  execute: async input => {
    const result = await deleteNativeSession(input.workspaceId, input.executor, input.nativeId);
    if (!result.ok) throw new Error(result.error ?? 'Delete failed');
  },
  timeoutMs: REST_TIMEOUT_MS,
};

registry.register('native.adopt', nativeAdopt);
registry.register('native.delete', nativeDelete);
