import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Session, Task } from '@gian/shared';
import type { Db } from '../storage/db.js';
import { loadConfig } from '../storage/config.js';
import { expandHome } from '../workspace/index.js';

/**
 * Per-Task Manager support (PRD-v3 P3).
 *
 * The Manager is a `Session` with `type='manager'` + `task_id`, bound to a
 * hidden "root" workspace that points at the configured `workspace_root`
 * (`~/Coding`). It runs Codex (`gpt-5.5` / `xhigh`), is forced to read-only
 * every turn (enforced in SessionManager.sendMessage), has no worktree, and is
 * persistent — one per Task.
 *
 * This module owns the bits that don't need the live proxy: resolving /
 * creating the root workspace row, and building the Manager's system prompt.
 * The actual session bring-up lives on SessionManager.ensureManagerSession so
 * it reuses the existing proxy + native-session machinery.
 */

/** Locked Manager runtime defaults (PRD-v3 §85-106). */
export const MANAGER_EXECUTOR = 'codex' as const;
export const MANAGER_MODEL = 'gpt-5.5';
export const MANAGER_EFFORT = 'xhigh';

/** Stable name for the hidden workspace that points at `workspace_root`. The
 *  Manager binds to it because `sessions.workspace_id` has a NOT NULL FK and
 *  the Manager's cwd must be the root so it can reach every workspace under it. */
const ROOT_WORKSPACE_NAME = '__gian_root__';

export interface RootWorkspaceRow {
  id: string;
  name: string;
  path: string;
}

/**
 * Get-or-create the hidden root workspace whose `path` equals the resolved
 * `workspace_root`. Idempotent — keyed by the canonical absolute path so a
 * second call returns the same row even across config edits that don't move
 * the root. The row is `hidden=1` so it never shows up in the workspace list.
 *
 * Returns the row (id/name/path). The Manager session binds its
 * `workspace_id` to this id.
 */
export function getOrCreateRootWorkspace(db: Db): RootWorkspaceRow {
  const cfg = loadConfig(db);
  const rootPath = resolve(expandHome(cfg.workspace_root || '~/Coding'));

  const existing = db
    .prepare('SELECT id, name, path FROM workspaces WHERE path = ?')
    .get(rootPath) as RootWorkspaceRow | undefined;
  if (existing) return existing;

  const id = randomUUID();
  db
    .prepare(
      `INSERT INTO workspaces (id, name, path, hidden) VALUES (?, ?, ?, 1)`,
    )
    .run(id, ROOT_WORKSPACE_NAME, rootPath);
  return { id, name: ROOT_WORKSPACE_NAME, path: rootPath };
}

/**
 * Build the Manager's system prompt: who it is (read-only project manager,
 * suggest-don't-execute), the Task's subtask metadata inlined (name / status /
 * summary), and signposts to the `.ai/` dirs + workspaces under the root so
 * the Manager can read on demand with Codex's native file tools.
 *
 * Per PRD §93-98 the prompt carries SOFT guidance only — the read-only
 * boundary is the sandbox, not this text. We do NOT restate "please don't
 * write" as if it were a control; the sandbox already removes write / command
 * tools entirely.
 */
export function buildManagerSystemPrompt(args: {
  task: Task;
  /** Subtasks (sessions with type='subtask' + this task_id). */
  subtasks: Session[];
  /** Distinct workspace paths the Task's subtasks touch (absolute). */
  workspacePaths: string[];
  /** The resolved workspace_root the Manager's cwd points at. */
  rootPath: string;
}): string {
  const { task, subtasks, workspacePaths, rootPath } = args;

  const subtaskLines = subtasks.length === 0
    ? ['(no subtasks yet)']
    : subtasks.map(s => {
        const name = s.name?.trim() || '(untitled)';
        // `summary` is written by the P4 summarizer when a Subtask completes
        // (Session.summary, nullable). Inline it so the Manager sees what each
        // Subtask achieved without reading transcripts.
        const summary = s.summary?.trim();
        const summaryPart = summary ? ` — ${summary}` : '';
        return `- ${name} [${s.executor}/${s.status}]${summaryPart}`;
      });

  const workspaceLines = workspacePaths.length === 0
    ? ['(no workspaces touched yet)']
    : workspacePaths.map(p => `- ${p}  (read its \`.ai/\` dir: ${p}/.ai/)`);

  return [
    'You are the read-only project Manager for a Gian Task.',
    '',
    'Your job: help the user understand and plan this Task across its',
    'workspaces. You can read and grep any file under the project root with',
    'your native file tools. You propose; you do not execute. When you want a',
    'unit of work done, write a prose `create_subtask` suggestion describing',
    'the workspace, executor, and an initial prompt — the user reviews it and',
    'creates the Subtask. You cannot create, start, or complete Subtasks',
    'yourself, nor edit files or run commands.',
    '',
    `# Task: ${task.name}`,
    task.description ? task.description : '(no description)',
    '',
    '## Subtasks',
    ...subtaskLines,
    '',
    '## Where to read',
    `Project root (your cwd): ${rootPath}`,
    'Each workspace keeps a gian-maintained `.ai/` dir (HANDOFF.md, STATE.md,',
    'MEMORY.md, SESSION_LOG.md). Read them for context before advising.',
    ...workspaceLines,
  ].join('\n');
}
