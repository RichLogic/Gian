import { locateNativeJsonl } from '../native/locate-jsonl.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import type { Db } from '../storage/db.js';

export function bootJsonlWatchers(db: Db, watcher: NativeJsonlWatcher): void {
  const rows = db.prepare(
    `SELECT s.id, s.executor, s.native_session_id, s.worktree_path, w.path AS workspace_path
       FROM sessions s
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.archived = 0
        AND s.executor IN ('claude', 'codex')
        AND s.native_session_id IS NOT NULL
        AND s.worktree_outcome IS NULL`,
  ).all() as Array<{
    id: string;
    executor: 'claude' | 'codex';
    native_session_id: string;
    worktree_path: string | null;
    workspace_path: string;
  }>;

  for (const row of rows) {
    const filePath = locateNativeJsonl(
      row.executor,
      row.native_session_id,
      row.worktree_path ?? row.workspace_path,
    );
    if (filePath) watcher.start(row.id, filePath, row.executor);
  }
}
