/**
 * UI Operation Layer — Git/worktree-domain definitions (Phase 3b of
 * `docs/archive/proposals/ui-operation-layer.md`). All PENDING REST: remote fetch,
 * pending-op abort, and index stage/unstage.
 *
 * The views keep their existing UX and derive it from the run:
 * - the git pane shows the fetch spinner/inline error and the abort banner
 *   busy state from the pending run, and refreshes its query state once the
 *   run confirms (the host also broadcasts `workspace:git-updated`);
 * - the Changes inspector disables the row's stage/unstage button while its
 *   run is in flight and reloads the changed-file list on confirm. Stage/
 *   unstage have no inline error surface, so their failures toast here;
 *   fetch/abort render inline errors in the pane — no toast (that would
 *   double-surface, same convention as `workspace.delete`).
 *
 * Phase 4 deleted the entry-less `git.createBranch` operation together with
 * its dead REST transport (`createLocalBranch`) — inventory §5.
 */
import {
  abortPendingGitOp,
  fetchRemotes,
  stageFile,
  unstageFile,
} from '../api.js';
import { toast } from '../feedback.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** Fetch/abort entity keys are per workspace; stage/unstage per file. */
export function gitFetchEntityKey(workspaceId: string): string {
  return `git:${workspaceId}:fetch`;
}

export function gitAbortEntityKey(workspaceId: string): string {
  return `git:${workspaceId}:abort`;
}

export function gitIndexEntityKey(workingTreeId: string, path: string): string {
  return `git:${workingTreeId}:${path}`;
}

/** A `git fetch --all --prune` can take a while on slow remotes. */
const FETCH_TIMEOUT_MS = 60_000;
/** Index writes are local and fast. */
const REST_TIMEOUT_MS = 15_000;

const gitFetch: OperationDefinition<{ workspaceId: string }, { fetchedAt: string }> = {
  policy: 'pending',
  entityKey: input => gitFetchEntityKey(input.workspaceId),
  execute: async input => {
    const result = await fetchRemotes(input.workspaceId);
    if (!result.ok) throw new Error(result.error ?? 'Fetch failed');
    return { fetchedAt: result.fetchedAt ?? new Date().toISOString() };
  },
  // The pane renders the run's error inline — no toast here.
  timeoutMs: FETCH_TIMEOUT_MS,
};

const gitAbortPendingOp: OperationDefinition<{ workspaceId: string }> = {
  policy: 'pending',
  entityKey: input => gitAbortEntityKey(input.workspaceId),
  execute: async input => {
    const result = await abortPendingGitOp(input.workspaceId);
    if (!result.ok) throw new Error(result.error ?? 'Abort failed');
  },
  // Inline error in the banner — no toast.
  timeoutMs: REST_TIMEOUT_MS,
};

const gitStage: OperationDefinition<{ workingTreeId: string; path: string }> = {
  policy: 'pending',
  entityKey: input => gitIndexEntityKey(input.workingTreeId, input.path),
  execute: async input => {
    if (!(await stageFile(input.workingTreeId, input.path))) throw new Error('Stage failed');
  },
  // The Changes inspector has no inline error surface — toast the failure.
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: REST_TIMEOUT_MS,
};

const gitUnstage: OperationDefinition<{ workingTreeId: string; path: string }> = {
  policy: 'pending',
  entityKey: input => gitIndexEntityKey(input.workingTreeId, input.path),
  execute: async input => {
    if (!(await unstageFile(input.workingTreeId, input.path))) throw new Error('Unstage failed');
  },
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: REST_TIMEOUT_MS,
};

registry.register('git.fetch', gitFetch);
registry.register('git.abortPendingOp', gitAbortPendingOp);
registry.register('git.stage', gitStage);
registry.register('git.unstage', gitUnstage);
