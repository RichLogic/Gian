/**
 * UI Operation Layer — Git History Fetch (Issue #3).
 *
 * A separate operation from the workspace-level `git.fetch` on purpose: the
 * History rail's Fetch is worktree-scoped (`POST /api/working_trees/:id/fetch`,
 * `git fetch --prune --all`) and its outcome taxonomy is richer —
 * `refsChanged` drives the timeline's "history changed" reconcile, and the
 * auth-failed / unknown-outcome variants must survive to the view.
 *
 * The dispatcher's run record flattens REST errors to a message string
 * (`{code:'EXECUTE_FAILED', message}`), so the structured
 * `GitHistoryRequestError` fields (`code`, `unknownOutcome`, `refsChanged`)
 * are preserved here in a small per-tree side record written from `execute`
 * before the rethrow. The run still settles as failed/timed-out normally —
 * the inspector reads phase from the run and detail from this record. This
 * keeps the dispatcher contract untouched (design review 2026-08-08).
 *
 * The pending-policy duplicate guard in the dispatcher already blocks a
 * second Fetch while one is in flight for the same tree.
 */
import {
  fetchGitHistory,
  GitHistoryRequestError,
  type GitHistoryFetchResult,
} from '../api.js';
import { reconcileHistoryAfterFetch } from '../controllers/use-history.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

export function gitHistoryFetchEntityKey(workingTreeId: string): string {
  return `git:${workingTreeId}:historyFetch`;
}

export interface GitHistoryFetchFailure {
  code: string;
  message: string;
  retryable: boolean;
  unknownOutcome: boolean;
  refsChanged: boolean;
}

const lastFailures = new Map<string, GitHistoryFetchFailure>();

/** Structured detail of the most recent failed Fetch for this tree, if the
 *  failure came from the host's error envelope. Null after a success. */
export function lastGitHistoryFetchFailure(workingTreeId: string): GitHistoryFetchFailure | null {
  return lastFailures.get(workingTreeId) ?? null;
}

/** `git fetch --prune --all` against a slow remote — mirrors `git.fetch`. */
const HISTORY_FETCH_TIMEOUT_MS = 60_000;

const gitHistoryFetch: OperationDefinition<{ workingTreeId: string }, GitHistoryFetchResult> = {
  policy: 'pending',
  entityKey: input => gitHistoryFetchEntityKey(input.workingTreeId),
  execute: async input => {
    // A later generic network failure must not inherit structured detail from
    // an earlier Host failure for the same tree.
    lastFailures.delete(input.workingTreeId);
    try {
      const result = await fetchGitHistory(input.workingTreeId);
      // Reconcile here (not in the view) so the timeline resets even when the
      // rail was collapsed while the fetch was in flight. Every successful
      // fetch drops its cursor; refsChanged additionally raises moved/revision.
      reconcileHistoryAfterFetch(input.workingTreeId, result.refsChanged);
      return result;
    } catch (err) {
      if (err instanceof GitHistoryRequestError) {
        lastFailures.set(input.workingTreeId, {
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          unknownOutcome: err.unknownOutcome,
          refsChanged: err.refsChanged,
        });
        // Failed-but-maybe-applied (the host saw the ref fingerprint move):
        // the contract requires the Web side to reconcile, never to present
        // the fetch as rolled back (proposal §3).
        if (err.unknownOutcome) reconcileHistoryAfterFetch(input.workingTreeId, true);
      }
      throw err;
    }
  },
  // Outcomes render inline in the History inspector's fetch status bar —
  // no toast here (same convention as `git.fetch`).
  timeoutMs: HISTORY_FETCH_TIMEOUT_MS,
};

registry.register('git.historyFetch', gitHistoryFetch);
