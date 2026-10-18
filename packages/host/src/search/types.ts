import type { Hono } from 'hono';
import type { Db } from '../storage/db.js';

/**
 * Host search module signature frozen for worker A.
 * B does not edit `packages/host/src/web/app.ts`. A applies this install:
 *
 * ```
 * import { createSearchModule, type SearchModule } from '../search/index.js';
 *
 * // registerWorkingTreeRoutes returns { listWorkingTrees }. The public
 * // callback accepts only { includeArchived } and shares the workspace
 * // signature git cache. Do not pass refresh and do not scan git again.
 * const { listWorkingTrees } = registerWorkingTreeRoutes(app, ctx.db, broadcaster, {
 *   ...existing options
 * });
 * const search = createSearchModule({
 *   db: ctx.db,
 *   dataDir: ctx.dataDir,
 *   listWorkingTrees,
 * });
 * // AppHandle gains `search: SearchModule`.
 *
 * registerInboxRoutes(app, inbox);
 * search.register(app);
 *
 * search.start();
 * scheduleOrchestrator.start();
 *
 * shutdown: async () => {
 *   await search.dispose();
 *   sessions.setSessionInbox(null);
 *   ...
 * }
 * ```
 *
 * `register` must run after `requireDesktopClient` and `requireAuth`.
 * The search routes do not install their own auth bypass.
 * `createSearchModule` is implemented. `createApp` in `app.ts` is the call site.
 */
/**
 * Structural match for the route's `WorkingTreeListItem`. `path` is index
 * text only. Callers navigate with `id` through the existing resolver.
 */
export interface SearchWorkingTreeSource {
  id: string;
  kind: 'workspace' | 'worktree';
  label: string;
  path: string;
  branch: string | null;
  workspace_id: string;
  workspace_name: string;
  session_id: string | null;
  session_name: string | null;
}

export interface SearchModuleDeps {
  db: Db;
  /** Host data directory. `agents.json` is read from here. */
  dataDir: string;
  /**
   * Public inventory from `registerWorkingTreeRoutes`. The callback accepts
   * only `{ includeArchived }` and reuses that route's workspace-signature
   * git cache. Search does not start another `git worktree list`, does not
   * pass `refresh`, and does not mint `worktree:` ids.
   *
   * Pass `{ includeArchived: true }` so archived `wt:` rows are included.
   * `ext:` paths stay untrusted until `resolveWorkingTree` rechecks membership.
   */
  listWorkingTrees: (
    options?: { includeArchived?: boolean },
  ) => Promise<readonly SearchWorkingTreeSource[]>;
  /**
   * Test and backfill bounds. Production uses the module defaults.
   * Omitted fields keep those defaults.
   */
  limits?: SearchMaintainLimits;
}

export interface SearchMaintainLimits {
  dirtyPage?: number;
  sourcePage?: number;
  turnPage?: number;
  scanBudget?: number;
}

export interface SearchModule {
  /** Mount the four search routes on an already authenticated Hono app. */
  register(app: Hono): void;
  /** Start the persistent backfill and dirty drain. Idempotent. */
  start(): void;
  /** Stop timers and wait until the in-flight drain leaves the database. */
  dispose(): Promise<void>;
}
