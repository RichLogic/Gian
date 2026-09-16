import { locateNativeJsonl } from '../native/locate-jsonl.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import type { Db } from '../storage/db.js';

export function bootJsonlWatchers(
  db: Db,
  watcher: NativeJsonlWatcher,
  options: { executors?: ReadonlyArray<'claude' | 'codex'> } = {},
): void {
  const executors = new Set(options.executors ?? ['claude', 'codex']);
  for (const row of selectBootWatcherRows(db)) {
    if (!executors.has(row.executor)) continue;
    const filePath = locateNativeJsonl(
      row.executor,
      row.native_session_id,
      row.worktree_path ?? row.workspace_path,
    );
    if (filePath) watcher.start(row.id, filePath, row.executor);
  }
}

/** Canonical Live Sync selection at boot. Hidden schedule Fork Sessions are
 *  deliberately included: after a Host restart they are the only way a
 *  claude/codex Fork's external completion becomes observable, because no
 *  user interaction would ever lazily attach them. */
export function selectBootWatcherRows(db: Db): Array<{
  id: string;
  executor: 'claude' | 'codex';
  native_session_id: string;
  worktree_path: string | null;
  workspace_path: string;
}> {
  return db.prepare(
    `SELECT s.id, s.executor, s.native_session_id, s.worktree_path, w.path AS workspace_path
       FROM sessions s
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.archived = 0
        AND s.executor IN ('claude', 'codex')
        AND s.native_session_id IS NOT NULL`,
  ).all() as Array<{
    id: string;
    executor: 'claude' | 'codex';
    native_session_id: string;
    worktree_path: string | null;
    workspace_path: string;
  }>;
}
