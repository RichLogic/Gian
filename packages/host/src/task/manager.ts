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

const TASK_STATUSES = new Set<TaskStatus>(['open', 'done', 'archived']);

function normalizedTaskName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('task name must not be empty');
  return name;
}

/**
 * Persistence for the Task abstraction layer (PRD-v3). A Task is a lightweight
 * container ("one thing the user is doing") that groups multiple Subtasks
 * (sessions via `sessions.task_id`). It owns Task persistence plus the one
 * Task-scoped session mutation: archive/restore on status transitions.
 *
 * Style mirrors SessionManager: better-sqlite3 prepared statements, ISO-8601
 * timestamps minted in JS (`new Date().toISOString()`), and `SELECT *` row →
 * type mapping (the `tasks` columns line up 1:1 with the `Task` interface).
 * All other session lifecycle remains on SessionManager.
 */
export class TaskManager {
  constructor(private db: Db) {}

  createTask(input: CreateTaskInput, requestedId?: string): Task {
    const id = requestedId ?? randomUUID();
    const now = new Date().toISOString();
    const name = normalizedTaskName(input.name);
    const description = input.description ?? null;
    this.db
      .prepare(
        `INSERT INTO tasks (id, name, description, status, created_at, updated_at)
         VALUES (@id, @name, @description, 'open', @now, @now)`,
      )
      .run({ id, name, description, now });
    return this.getTaskOrThrow(id);
  }

  listTasks(): Task[] {
    // Manual drag order (migration 067) wins; tasks never dragged
    // (sort_order IS NULL) keep the automatic creation-time order ABOVE the
    // manual range, so a fresh task still lands on top. The web client
    // re-sorts by the same keys (single source of truth for live reorder),
    // so this only needs to make the initial snapshot consistent.
    return this.db
      .prepare(
        `SELECT * FROM tasks
         ORDER BY (sort_order IS NOT NULL), sort_order, created_at DESC`,
      )
      .all() as Task[];
  }

  /**
   * Persist a manual order for the given tasks (sidebar drag reorder). The
   * caller passes the scope's full ordered id list (e.g. the open group);
   * values are rewritten to a dense 1..n sequence. Tasks absent from `ids`
   * keep their current sort_order (NULL = automatic order). Deliberately does
   * NOT bump `updated_at` — a reorder is view metadata, not a content edit.
   */
  reorderTasks(ids: string[]): void {
    const update = this.db
      .prepare('UPDATE tasks SET sort_order = @order WHERE id = @id');
    this.db.transaction(() => {
      ids.forEach((id, index) => update.run({ id, order: index + 1 }));
    })();
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
      params['name'] = normalizedTaskName(input.name);
    }
    if (input.description !== undefined) {
      sets.push('description = @description');
      params['description'] = input.description;
    }
    if (input.status !== undefined) {
      if (!TASK_STATUSES.has(input.status)) throw new Error(`invalid task status: ${input.status}`);
      sets.push('status = @status');
      params['status'] = input.status;
    }

    const now = new Date().toISOString();
    sets.push('updated_at = @now');
    params['now'] = now;

    const write = () => {
      this.db
        .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`)
        .run(params);

      if (input.status !== undefined && input.status !== existing.status) {
        const archived = input.status === 'done'
          ? 1
          : input.status === 'open'
            ? 0
            : null;
        if (archived !== null) {
          this.db
            .prepare('UPDATE sessions SET archived = ?, updated_at = ? WHERE task_id = ?')
            .run(archived, now, id);
        }
      }
    };

    // The Task status and every owned session's archive flag are one domain
    // transition. Keep them atomic so clients never observe a half-closed Task.
    this.db.transaction(write)();

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
