import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Executor, Session, Task, ThinkingEffort } from '@gian/shared';
import type { Db } from '../storage/db.js';
import { loadConfig } from '../storage/config.js';
import { expandHome } from '../workspace/index.js';

/**
 * Per-Task Manager support (PRD-v3 P3).
 *
 * The Manager is a `Session` with `type='manager'` + `task_id`, bound to a
 * hidden "root" workspace that points at the configured `workspace_root`
 * (`~/Coding`). Its executor is selected per Task, it has no worktree, and it
 * is persistent — one per Task.
 *
 * This module owns the bits that don't need the live proxy: resolving /
 * creating the root workspace row, and building the Manager's system prompt.
 * The actual session bring-up lives on SessionManager.ensureManagerSession so
 * it reuses the existing proxy + native-session machinery.
 */

/**
 * Manager (PM) runtime, resolved per executor (gian-task-pm-engineer §4.2 —
 * "PM 可选 claude / codex / kimi"). The executor is chosen per-Task at creation
 * (tasks.manager_executor); the model/effort follow from it:
 *
 *  - codex → pinned to `gpt-5.5` / `xhigh` (the original locked PRD-v3 runtime).
 *  - claude → left unpinned so SessionManager.createSession resolves the
 *    session default (`default_claude_model` / `default_claude_effort`, empty →
 *    the CLI/proxy default). Subscription-priced TTY controller.
 *  - kimi → left unpinned; ACP config options, including mode, stay native.
 *
 * `null` model/effort mean "let createSession pick" — it must NOT pass codex's
 * `gpt-5.5` to a Claude or Kimi session.
 */
export interface ManagerRuntime {
  executor: Executor;
  model: string | null;
  effort: ThinkingEffort | null;
}

/** Fallback when a Task has no `manager_executor` and config is unreadable. */
export const DEFAULT_MANAGER_EXECUTOR: Executor = 'claude';

export function managerRuntimeFor(executor: Executor): ManagerRuntime {
  if (executor === 'codex') {
    return { executor, model: 'gpt-5.5', effort: 'xhigh' };
  }
  // Claude/Kimi: never inherit Codex's pinned model or effort.
  return { executor, model: null, effort: null };
}

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
 * Build the Manager's system prompt: who it is (writable project
 * planner/orchestrator that proposes — but does not personally do — work), the
 * Task's subtask metadata inlined (name / completion / summary), the ASCII
 * `create_subtask` proposal protocol, and signposts to the `.ai/` dirs +
 * workspaces under the root.
 *
 * Spec 2026-06-28 §A1/§A2 (supersedes PRD-v3 §A1): the Manager runs
 * sandbox:'workspace-write' so it CAN edit/run — the "doesn't do the work
 * itself" boundary is a soft prompt convention (propose Subtasks, let the user
 * confirm), not a sandbox lock.
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
        // Show user-completion (completed_at), not the turn `status` — the
        // Manager plans around what's done, not whether a turn is mid-flight.
        const done = s.completed_at ? 'completed' : 'open';
        return `- ${name} [${s.executor}/${done}]${summaryPart}`;
      });

  const workspaceLines = workspacePaths.length === 0
    ? ['(no workspaces touched yet)']
    : workspacePaths.map(p => `- ${p}  (read its \`.ai/\` dir: ${p}/.ai/)`);

  return [
    'You are the project Manager for a Gian Task — its planner and orchestrator.',
    '',
    'You can read, grep, write files, and run commands anywhere under the',
    'project root with your native tools. But you do NOT do the coding work',
    'yourself: to get a unit of work done you spin up a Subtask (an ENGINEER',
    'session) and hand it a brief.',
    '',
    '## How to create a Subtask (natural-language confirm, then act)',
    '',
    'FIRST align with the user in plain language: what the subtask should do,',
    'which workspace, which executor. Ask; let them agree. Only AFTER the user',
    'has agreed, end that reply with EXACTLY ONE action envelope as the LAST',
    'line — nothing after it, no code fence:',
    '',
    '<<gian:action>>{"method":"create_subtask","params":{"workspace":"<workspace name or absolute path>","executor":"claude|codex|kimi","brief":"<the brief: goal / why / boundaries / where to look>","name":"<short title>"}}<</gian:action>>',
    '',
    'Gian reads that envelope straight from your reply and creates + starts the',
    'Subtask with your `brief` as its first message — there is NO card, NO extra',
    'confirm dialog (you already confirmed in the conversation). So do NOT emit',
    'the envelope until the user has agreed; a bare reply with no envelope does',
    'nothing. Routing default: build/edit → claude, review/audit → codex.',
    'Do NOT create/start Subtasks any other way (no API calls) and do NOT write',
    'the code yourself. Preserve the executor the user selected; do not map',
    'one CLI onto another CLI\'s mode or model vocabulary.',
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
