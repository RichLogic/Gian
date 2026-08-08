/**
 * UI Operation Layer — Workspace-domain definitions (Phase 3a of
 * `docs/archive/proposals/ui-operation-layer.md`). Every Workspace mutation the UI
 * can trigger is registered here; SpacesView, WorkspacesPanel, the App
 * sidebar pin, and the workspace-create flows dispatch by name instead of
 * calling the workspace REST helpers directly.
 *
 * Entity keys are `workspace:<id>` for existing workspaces; creates run on a
 * fresh `pending:workspace.create:<uuid>` key (proposal §4.3). Optimistic
 * writes target flat Workspace fields (`name`, `hidden`, `pinned`).
 *
 * REORDER OVERLAY SHAPE: the workspace list is an ORDERED ARRAY (like the
 * queue, see operations/queue.ts), so `workspace.reorder` uses a whole-list
 * overlay: entityFieldKey `workspace:list:order`, value = the FULL ordered
 * id array (`string[]`) the user just arranged. Rendering merges canonical +
 * overlay via `applyWorkspaceOrderOverlay`; `readCanonicalField` returns the
 * current canonical id array for rollback. Array values never Object.is-
 * match a fresh canonical array, so the defensive absorb path never fires
 * for it — result arrival (and the reconcile below) is the absorption path.
 *
 * REST CANONICAL CONVERGENCE (inventory §4 note 7): the host does NOT
 * broadcast workspace PATCH / reorder / claude_md PUT. Each definition's
 * `reconcile` therefore updates canonical client state directly on success
 * through the injected sink (`wireWorkspaceCanonicalSink`, wired by App):
 * - updateWorkspace responses carry the updated entity → `upsert` patches it
 *   into the canonical list (same JS task as the overlay absorption, so no
 *   flicker), then `refetch` reloads the authoritative list — the exact
 *   `onChange()` semantics the pre-migration call sites had.
 * - reorder returns no entity → `applyOrder` reorders the canonical list
 *   client-side to the confirmed id array, then `refetch`.
 * - delete returns no entity → `remove` + `refetch`.
 * - create carries the new workspace → `upsert` + `refetch`.
 *
 * `workspace.pickFolder` drives a cancelable native dialog: a cancel is a
 * CONFIRMED no-op (`result.path` undefined), never a failure.
 */
import type { Workspace } from '@gian/shared';

import {
  createWorkspace,
  deleteWorkspace,
  pickWorkspaceFolder,
  reorderWorkspaces,
  saveClaudeMd,
  updateWorkspace,
  type CreateWorkspaceOptions,
  type PickFolderResult,
} from '../api.js';
import { toast } from '../feedback.js';
import { registry } from './registry.js';
import type { OperationDefinition, OptimisticOverlay } from './types.js';

/** Entity key for an existing workspace. */
export function workspaceEntityKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

/** Entity key of the whole-list order overlay (`workspace:list:order`). */
export const WORKSPACE_LIST_ENTITY_KEY = 'workspace:list';
export const WORKSPACE_ORDER_FIELD = 'order';

/** REST round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const REST_TIMEOUT_MS = 10_000;
/** Workspace create may mkdir/git-clone — slower than a metadata write. */
const CREATE_TIMEOUT_MS = 60_000;
/** The native folder dialog can stay open for minutes; a timeout would mark
 *  the run unresolved and swallow the eventual pick. */
const PICK_TIMEOUT_MS = 300_000;

/**
 * Canonical workspace sink (see header) — wired by App with the canonical
 * `setWorkspaces`/`loadWorkspaces`; tests substitute a fake. Every method is
 * optional so partial wirings stay valid.
 */
export interface WorkspaceCanonicalSink {
  /** Insert or replace (by id) one workspace in the canonical list. */
  upsert(workspace: Workspace): void;
  /** Drop one workspace from the canonical list. */
  remove(workspaceId: string): void;
  /** Reorder the canonical list to the confirmed id array. */
  applyOrder(ids: string[]): void;
  /** Reload the authoritative list (the pre-migration `onChange()`). */
  refetch(): void;
}

let workspaceCanonicalSink: WorkspaceCanonicalSink | null = null;

export function wireWorkspaceCanonicalSink(sink: WorkspaceCanonicalSink | null): void {
  workspaceCanonicalSink = sink;
}

interface WorkspaceIdInput {
  workspaceId: string;
}

/** Shared tail for the optimistic updateWorkspace-backed operations: the
 *  REST response carries the updated entity — patch canonical state with it
 *  and refetch (no host broadcast, see header). */
function reconcileUpdatedWorkspace(result: Workspace): void {
  workspaceCanonicalSink?.upsert(result);
  workspaceCanonicalSink?.refetch();
}

/** REST failures have no error envelope — surface them here (the overlay
 *  rollback is the store's job). */
function rollbackToast(error: { message: string }): void {
  toast({ kind: 'error', message: error.message });
}

async function patchWorkspace(id: string, patch: Parameters<typeof updateWorkspace>[1]): Promise<Workspace> {
  const updated = await updateWorkspace(id, patch);
  if (!updated) throw new Error('Workspace update failed');
  return updated;
}

const workspaceRename: OperationDefinition<WorkspaceIdInput & { name: string }, Workspace> = {
  policy: 'optimistic',
  entityKey: input => workspaceEntityKey(input.workspaceId),
  optimisticWrites: input => [{ field: 'name', value: input.name.trim() }],
  execute: input => patchWorkspace(input.workspaceId, { name: input.name.trim() }),
  reconcile: reconcileUpdatedWorkspace,
  rollback: rollbackToast,
  timeoutMs: REST_TIMEOUT_MS,
};

const workspaceSetHidden: OperationDefinition<WorkspaceIdInput & { hidden: boolean }, Workspace> = {
  policy: 'optimistic',
  entityKey: input => workspaceEntityKey(input.workspaceId),
  optimisticWrites: input => [{ field: 'hidden', value: input.hidden ? 1 : 0 }],
  execute: input => patchWorkspace(input.workspaceId, { hidden: input.hidden }),
  reconcile: reconcileUpdatedWorkspace,
  rollback: rollbackToast,
  timeoutMs: REST_TIMEOUT_MS,
};

const workspacePin: OperationDefinition<WorkspaceIdInput & { pinned: boolean }, Workspace> = {
  policy: 'optimistic',
  entityKey: input => workspaceEntityKey(input.workspaceId),
  optimisticWrites: input => [{ field: 'pinned', value: input.pinned ? 1 : 0 }],
  execute: input => patchWorkspace(input.workspaceId, { pinned: input.pinned }),
  reconcile: reconcileUpdatedWorkspace,
  rollback: rollbackToast,
  timeoutMs: REST_TIMEOUT_MS,
};

const workspaceReorder: OperationDefinition<{ ids: string[] }, string[]> = {
  policy: 'optimistic',
  entityKey: () => WORKSPACE_LIST_ENTITY_KEY,
  // Whole-list overlay: the full ordered id array (see header).
  optimisticWrites: input => [{ field: WORKSPACE_ORDER_FIELD, value: input.ids }],
  execute: async input => {
    await reorderWorkspaces(input.ids);
    return input.ids;
  },
  reconcile: ids => {
    workspaceCanonicalSink?.applyOrder(ids);
    workspaceCanonicalSink?.refetch();
  },
  rollback: rollbackToast,
  timeoutMs: REST_TIMEOUT_MS,
};

export interface WorkspaceCreateInput {
  name: string;
  /** git remote to clone — ignored when `path` is set (adopt-path variant). */
  gitRemote?: string;
  /** Absolute path (~ allowed) to adopt as workspace as-is. */
  path?: string;
}

const workspaceCreate: OperationDefinition<WorkspaceCreateInput, Workspace> = {
  policy: 'pending',
  entityKey: () => `pending:workspace.create:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  // The created Workspace is the run result: callers (new-session-view)
  // select it once the run confirms.
  execute: async input => {
    const options: CreateWorkspaceOptions = input.path
      ? { path: input.path }
      : { ...(input.gitRemote ? { gitRemote: input.gitRemote } : {}) };
    const result = await createWorkspace(input.name, options);
    if (!result.workspace) throw new Error(result.error ?? 'Create failed');
    return result.workspace;
  },
  reconcile: workspace => {
    workspaceCanonicalSink?.upsert(workspace);
    workspaceCanonicalSink?.refetch();
  },
  timeoutMs: CREATE_TIMEOUT_MS,
};

const workspaceDelete: OperationDefinition<WorkspaceIdInput, { workspaceId: string }> = {
  policy: 'pending',
  entityKey: input => workspaceEntityKey(input.workspaceId),
  execute: async input => {
    const result = await deleteWorkspace(input.workspaceId);
    if (!result.ok) throw new Error(result.error ?? 'Delete failed');
    return { workspaceId: input.workspaceId };
  },
  reconcile: result => {
    workspaceCanonicalSink?.remove(result.workspaceId);
    workspaceCanonicalSink?.refetch();
  },
  // The view also renders the run's error inline (SpacesView deleteError);
  // no toast here — that would double-surface.
  timeoutMs: REST_TIMEOUT_MS,
};

const workspaceSaveClaudeMd: OperationDefinition<WorkspaceIdInput & { content: string }> = {
  policy: 'pending',
  // Distinct entity key: saving CLAUDE.md never collides with the metadata
  // operations on the same workspace.
  entityKey: input => `${workspaceEntityKey(input.workspaceId)}:claude-md`,
  execute: async input => {
    if (!(await saveClaudeMd(input.workspaceId, input.content))) throw new Error('Save failed');
  },
  // The view surfaces the failure (toast via the failed run) — no toast
  // here, same as workspace.delete.
  timeoutMs: REST_TIMEOUT_MS,
};

const workspacePickFolder: OperationDefinition<Record<string, never>, PickFolderResult> = {
  policy: 'pending',
  entityKey: () => `pending:workspace.pickFolder:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  // Cancelable native dialog: a cancel resolves with `canceled: true` and no
  // path — a confirmed no-op, NOT a failure (the button just re-enables).
  execute: async () => {
    const result = await pickWorkspaceFolder();
    if (result.error) throw new Error(result.error);
    return result;
  },
  timeoutMs: PICK_TIMEOUT_MS, // the dialog can stay open for a while
};

registry.register('workspace.rename', workspaceRename);
registry.register('workspace.setHidden', workspaceSetHidden);
registry.register('workspace.pin', workspacePin);
registry.register('workspace.reorder', workspaceReorder);
registry.register('workspace.create', workspaceCreate);
registry.register('workspace.delete', workspaceDelete);
registry.register('workspace.saveClaudeMd', workspaceSaveClaudeMd);
registry.register('workspace.pickFolder', workspacePickFolder);

/** Workspace fields an overlay may write (Phase 3a set). */
const WORKSPACE_OVERLAY_FIELDS = new Set(['name', 'hidden', 'pinned']);

/**
 * Render merge (proposal §4.3): `canonical + overlays`, the overlay always
 * winning. Returns the canonical object untouched when no overlay applies,
 * so unchanged workspaces keep referential identity.
 */
export function applyWorkspaceOverlays(
  workspace: Workspace,
  overlays: readonly OptimisticOverlay[],
): Workspace {
  const entityKey = workspaceEntityKey(workspace.id);
  let merged: Workspace | null = null;
  for (const overlay of overlays) {
    const field = overlay.entityFieldKey.slice(entityKey.length + 1);
    if (!WORKSPACE_OVERLAY_FIELDS.has(field)) continue;
    if (merged === null) merged = { ...workspace };
    (merged as unknown as Record<string, unknown>)[field] = overlay.value;
  }
  return merged ?? workspace;
}

/**
 * Whole-list order merge: reorder the canonical list to the overlay's id
 * array (see header). Workspaces missing from the id array keep their
 * relative order at the end; unknown ids are skipped. Returns the canonical
 * array untouched when every row is already in place (referential identity).
 */
export function applyWorkspaceOrderOverlay(
  workspaces: readonly Workspace[],
  orderIds: readonly string[],
): Workspace[] {
  const rank = new Map(orderIds.map((id, index) => [id, index]));
  const reordered = [...workspaces].sort((a, b) => {
    const ra = rank.get(a.id) ?? orderIds.length;
    const rb = rank.get(b.id) ?? orderIds.length;
    return ra - rb;
  });
  return reordered.every((workspace, index) => workspace === workspaces[index])
    ? workspaces as Workspace[]
    : reordered;
}
