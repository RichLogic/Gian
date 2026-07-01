// Host-generated `.ai/` views (proposal gian-task-pm-engineer §4.3 / §2.9 ①).
//
// The iron rule: agents write only their own shard (`.ai/sessions/<id>.state.md`);
// the HOST merges those shards into the read-only view `.ai/STATE.view.md`.
// Generation is LAZY — a derived cache regenerated read-on-dirty (when a shard is
// newer than the view), not on every shard write. This module owns that merge.
//
// Writes are atomic (temp + rename) so a concurrent reader never sees a partial
// view. The view is host-owned and gitignored; agents must not edit it.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const AI_DIR = '.ai';
const SESSIONS_DIR = join(AI_DIR, 'sessions');
const STATE_VIEW_REL = join(AI_DIR, 'STATE.view.md');
const STATE_SHARD_SUFFIX = '.state.md';

/** Absolute path to a workspace's merged state view. */
export function stateViewPath(workspaceRoot: string): string {
  return join(workspaceRoot, STATE_VIEW_REL);
}

interface Shard {
  /** Session id parsed from `<id>.state.md`. */
  id: string;
  abs: string;
  mtimeMs: number;
}

function listStateShards(workspaceRoot: string): Shard[] {
  const dir = join(workspaceRoot, SESSIONS_DIR);
  if (!existsSync(dir)) return [];
  const out: Shard[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(STATE_SHARD_SUFFIX)) continue;
    const abs = join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — skip
    }
    out.push({ id: name.slice(0, -STATE_SHARD_SUFFIX.length), abs, mtimeMs });
  }
  // Deterministic order: freshest first (most useful at the top of the view).
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  return out;
}

function renderView(shards: Shard[]): string {
  const header = [
    '<!-- gian:.ai/STATE.view.md — HOST-GENERATED, read-only.',
    '     Merge of every session\'s .ai/sessions/<id>.state.md shard.',
    '     Do NOT edit by hand; Gian regenerates this from the shards. -->',
    '',
    '# Workspace state (merged view)',
    '',
  ];
  if (shards.length === 0) {
    header.push('_No session shards yet._', '');
    return header.join('\n');
  }
  const body: string[] = [];
  for (const s of shards) {
    let content = '';
    try {
      content = readFileSync(s.abs, 'utf8').trim();
    } catch {
      continue;
    }
    body.push(`## session ${s.id}`, '', content, '');
  }
  return header.concat(body).join('\n');
}

/** Atomically write `content` to `abs` (temp in the same dir + rename). */
function atomicWrite(abs: string, content: string): void {
  const tmp = `${abs}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, abs);
}

/**
 * Regenerate `.ai/STATE.view.md` unconditionally from the current shards.
 * Returns the absolute view path. Creates `.ai/` if needed.
 */
export function regenerateStateView(workspaceRoot: string): string {
  const shards = listStateShards(workspaceRoot);
  const view = stateViewPath(workspaceRoot);
  mkdirSync(join(workspaceRoot, AI_DIR), { recursive: true });
  atomicWrite(view, renderView(shards));
  return view;
}

/**
 * Regenerate the view ONLY when it is stale — i.e. missing, or any shard is
 * newer than the view (read-on-dirty). Returns true when it (re)generated.
 * This is the cheap call the read path uses; it stat()s shards but only
 * rewrites when something actually changed.
 */
export function regenerateStateViewIfDirty(workspaceRoot: string): boolean {
  const view = stateViewPath(workspaceRoot);
  const shards = listStateShards(workspaceRoot);

  let viewMtime = -1;
  try {
    viewMtime = statSync(view).mtimeMs;
  } catch {
    viewMtime = -1; // missing → dirty
  }

  const newestShard = shards.reduce((m, s) => Math.max(m, s.mtimeMs), 0);
  // Dirty when the view is missing, or a shard is at least as new as the view.
  // (`>=` not `>`: same-millisecond writes on coarse filesystems should still
  // trigger a rebuild rather than be missed.)
  const dirty = viewMtime < 0 || (shards.length > 0 && newestShard >= viewMtime);
  if (!dirty) return false;

  regenerateStateView(workspaceRoot);
  return true;
}
