import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../storage/db.js';
import { replayNativeJsonl } from '../native/replay.js';

/**
 * Lazy rebuild of the events hot-cache from JSONL.
 *
 * If a session's `events` rows have been swept (cold session), we rebuild
 * them on demand from the on-disk native JSONL using the same parser the
 * adoption flow uses. This is called from the events list endpoint so the
 * user gets a fully populated transcript on first cold-session open.
 *
 * Idempotent: if events already exist for the session, this is a no-op.
 * Safe to call on every events fetch.
 */

export interface RebuildResult {
  turnsInserted: number;
  eventsInserted: number;
}

interface SessionRow {
  native_session_id: string | null;
  executor: 'claude' | 'codex';
  workspace_id: string;
}

interface WorkspaceRow {
  path: string;
}

export function ensureEventsRebuilt(db: Db, sessionId: string, force = false): RebuildResult {
  // Fast path: hot cache already populated. Skipped when `force` is set — a
  // forced rebuild re-derives the transcript from the authoritative JSONL even
  // when events exist, healing sessions whose rows were duplicated/corrupted by
  // older append-style replays. Safe because `replayNativeJsonl` now clears the
  // session's rows before re-inserting (a true rebuild, not an append).
  if (!force) {
    const eventsCount = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sessionId) as { c: number } | undefined;
    if (eventsCount && eventsCount.c > 0) {
      return { turnsInserted: 0, eventsInserted: 0 };
    }
  }

  const session = db
    .prepare('SELECT native_session_id, executor, workspace_id FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;
  if (!session) {
    // Caller's responsibility to validate session existence before this.
    // Returning zeros keeps the events endpoint forgiving.
    return { turnsInserted: 0, eventsInserted: 0 };
  }
  if (!session.native_session_id) {
    // Post-PR1 invariant: every session has a native_session_id. The
    // only way to hit null is a corrupted row — surface it loudly.
    throw new Error(
      `session ${sessionId} has null native_session_id; cannot rebuild events from JSONL`,
    );
  }

  const ws = db
    .prepare('SELECT path FROM workspaces WHERE id = ?')
    .get(session.workspace_id) as WorkspaceRow | undefined;
  if (!ws) {
    // Can't rebuild without a cwd to look up cc storage / verify codex.
    // Treat as no-op rather than crashing the events endpoint.
    return { turnsInserted: 0, eventsInserted: 0 };
  }

  const jsonlPath = session.executor === 'claude'
    ? findClaudeJsonl(ws.path, session.native_session_id)
    : findCodexJsonlByThreadId(session.native_session_id);

  if (!jsonlPath) {
    // No on-disk JSONL — cold session with no recoverable transcript.
    // This is a normal state for very old sessions whose files were
    // archived externally; transcript stays empty.
    return { turnsInserted: 0, eventsInserted: 0 };
  }

  const result = replayNativeJsonl(db, sessionId, jsonlPath, session.executor);
  return {
    turnsInserted: result.turnCount,
    eventsInserted: result.eventCount,
  };
}

// ---------------------------------------------------------------------------
// JSONL path resolution
// ---------------------------------------------------------------------------

/** Encode an absolute path the way Claude Code's project dir does:
 *  every `/` becomes `-`. e.g. `/Users/me/proj` → `-Users-me-proj`. */
function encodeCcProjectDir(absPath: string): string {
  return absPath.replaceAll('/', '-');
}

function findClaudeJsonl(workspacePath: string, nativeId: string): string | null {
  const filePath = join(
    homedir(),
    '.claude',
    'projects',
    encodeCcProjectDir(workspacePath),
    `${nativeId}.jsonl`,
  );
  return existsSync(filePath) ? filePath : null;
}

/**
 * Codex stores rollouts under ~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl
 * with date-derived directories. There's no path-based shortcut, so we walk
 * the tree (depth-bounded) and find the file whose name contains the thread
 * id. Exported so other modules / future callers can reuse the lookup.
 */
export function findCodexJsonlByThreadId(threadId: string): string | null {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return null;

  // Walk YYYY/MM/DD; bail at depth 3 to stay cheap. Files live at depth 3.
  return walkForId(root, threadId, 0, 3);
}

function walkForId(dir: string, needle: string, depth: number, maxDepth: number): string | null {
  if (depth > maxDepth) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const found = walkForId(full, needle, depth + 1, maxDepth);
      if (found) return found;
    } else if (
      stat.isFile() &&
      entry.endsWith('.jsonl') &&
      entry.startsWith('rollout-') &&
      entry.includes(needle)
    ) {
      return full;
    }
  }
  return null;
}
