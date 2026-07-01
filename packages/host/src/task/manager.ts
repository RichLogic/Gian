import { randomUUID } from 'node:crypto';
import type { Task, TaskStatus } from '@gian/shared';
import type { Db } from '../storage/db.js';

export interface CreateTaskInput {
  name: string;
  description?: string | null;
}

export interface UpdateTaskInput {
  name?: string;
  description?: string | null;
  status?: TaskStatus;
}

/**
 * Persistence for the Task abstraction layer (PRD-v3). A Task is a lightweight
 * container ("one thing the user is doing") that groups multiple Subtasks
 * (sessions via `sessions.task_id`). This manager owns the `tasks` table only;
 * Subtask/Manager sessions stay on SessionManager.
 *
 * Style mirrors SessionManager: better-sqlite3 prepared statements, ISO-8601
 * timestamps minted in JS (`new Date().toISOString()`), and `SELECT *` row →
 * type mapping (the `tasks` columns line up 1:1 with the `Task` interface).
 */
export class TaskManager {
  constructor(private db: Db) {}

  createTask(input: CreateTaskInput): Task {
    const id = randomUUID();
    const now = new Date().toISOString();
    const description = input.description ?? null;
    this.db
      .prepare(
        `INSERT INTO tasks (id, name, description, status, created_at, updated_at)
         VALUES (@id, @name, @description, 'open', @now, @now)`,
      )
      .run({ id, name: input.name, description, now });
    return this.getTaskOrThrow(id);
  }

  listTasks(): Task[] {
    // Pinned tasks first (most-recently-pinned on top), then the rest by
    // creation time (newest first). `(pinned_at IS NOT NULL) DESC` puts the
    // pinned group ahead; within each group the trailing keys order it. The web
    // client re-sorts by the same keys (single source of truth for live pin
    // moves), so this only needs to make the initial snapshot consistent.
    return this.db
      .prepare(
        `SELECT * FROM tasks
         ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC, created_at DESC`,
      )
      .all() as Task[];
  }

  /**
   * Pin or unpin a task. Stamps `pinned_at` with the current time (pin) or
   * clears it to NULL (unpin). Deliberately does NOT bump `updated_at` — a pin
   * is view metadata, not a content edit, and the list no longer orders by
   * updated_at anyway. Throws if the task doesn't exist.
   */
  setTaskPinned(id: string, pinned: boolean): Task {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`task not found: ${id}`);
    const pinnedAt = pinned ? new Date().toISOString() : null;
    this.db
      .prepare('UPDATE tasks SET pinned_at = @pinnedAt WHERE id = @id')
      .run({ id, pinnedAt });
    return this.getTaskOrThrow(id);
  }

  getTask(id: string): Task | undefined {
    return this.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(id) as Task | undefined;
  }

  /**
   * Patch a task. Only the provided fields are written (dynamic SET clause),
   * and `updated_at` is always bumped. Throws if the task doesn't exist.
   */
  updateTask(id: string, input: UpdateTaskInput): Task {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`task not found: ${id}`);

    // Host-enforced done guard (spec 2026-06-28 §G / Codex R2 #4): refuse to
    // mark a Task done while any of its subtasks has a turn running/pending —
    // those active subtasks would be orphaned in the collapsed Done group.
    // Enforced here (not just UI) so REST + WS + any client all hit it.
    // Unread-but-finished subtasks do NOT block.
    if (input.status === 'done' && existing.status !== 'done') {
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM sessions
           WHERE task_id = ? AND type = 'subtask' AND status IN ('running', 'pending')`,
        )
        .get(id) as { n: number };
      if (active.n > 0) {
        throw new Error(
          `TASK_HAS_ACTIVE_SUBTASKS: ${active.n} subtask(s) still running/pending`,
        );
      }
    }

    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (input.name !== undefined) {
      sets.push('name = @name');
      params['name'] = input.name;
    }
    if (input.description !== undefined) {
      sets.push('description = @description');
      params['description'] = input.description;
    }
    if (input.status !== undefined) {
      sets.push('status = @status');
      params['status'] = input.status;
    }

    const now = new Date().toISOString();
    sets.push('updated_at = @now');
    params['now'] = now;

    this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`)
      .run(params);

    return this.getTaskOrThrow(id);
  }

  /**
   * Permanently delete a task. Refuses when any session still references it
   * via `task_id`: the caller must reassign or delete those sessions first
   * (the migration's `ON DELETE SET NULL` would otherwise silently orphan
   * them, which we don't want to happen implicitly through this path).
   */
  deleteTask(id: string): void {
    const ref = this.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE task_id = ?')
      .get(id) as { n: number };
    if (ref.n > 0) {
      throw new Error(`task has associated sessions: ${id}`);
    }
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  private getTaskOrThrow(id: string): Task {
    const row = this.getTask(id);
    if (!row) throw new Error(`task not found: ${id}`);
    return row;
  }
}
