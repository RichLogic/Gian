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
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY updated_at DESC')
      .all() as Task[];
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
