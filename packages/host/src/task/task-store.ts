// DB access for the Gian action protocol tables (`task_loops` / `task_actions`,
// migration 028). Thin, synchronous helpers over better-sqlite3 — no business
// logic (that lives in action-authorize.ts / action-executor.ts). JSON array
// columns are (de)serialized here so callers see typed `TaskLoop` / `TaskAction`.

import type { Db } from '../storage/db.js';
import type {
  ActionStatus,
  Executor,
  GianActionMethod,
  Role,
  TaskAction,
  TaskLoop,
} from '@gian/shared';

interface TaskLoopRow {
  id: string;
  task_id: string;
  status: string;
  allowed_methods: string;
  allowed_workspaces: string;
  allowed_executors: string;
  round: number;
  max_rounds: number;
  current_step: string | null;
  current_step_session_id: string | null;
  expected_role: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function rowToLoop(row: TaskLoopRow): TaskLoop {
  return {
    id: row.id,
    task_id: row.task_id,
    status: row.status as TaskLoop['status'],
    allowed_methods: parseJsonArray<GianActionMethod>(row.allowed_methods),
    allowed_workspaces: parseJsonArray<string>(row.allowed_workspaces),
    allowed_executors: parseJsonArray<Executor>(row.allowed_executors),
    round: row.round,
    max_rounds: row.max_rounds,
    current_step: row.current_step,
    current_step_session_id: row.current_step_session_id,
    expected_role: (row.expected_role as Role | null) ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── task_actions ─────────────────────────────────────────────────────────────

export interface InsertActionInput {
  action_id: string;
  task_id: string;
  session_id: string;
  host_turn_id: string | null;
  source_turn_key: string | null;
  method: GianActionMethod;
  payload_hash: string;
  payload: string;
  status: ActionStatus;
}

/** Insert a parsed action. Returns false if `action_id` already exists (the
 *  idempotency floor — the PK rejects the duplicate). */
export function insertAction(db: Db, input: InsertActionInput): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO task_actions
         (action_id, task_id, session_id, host_turn_id, source_turn_key, method, payload_hash, payload, status)
       VALUES (@action_id, @task_id, @session_id, @host_turn_id, @source_turn_key, @method, @payload_hash, @payload, @status)`,
    )
    .run(input);
  return info.changes > 0;
}

export function getAction(db: Db, actionId: string): TaskAction | null {
  const row = db.prepare('SELECT * FROM task_actions WHERE action_id = ?').get(actionId) as
    | TaskAction
    | undefined;
  return row ?? null;
}

export interface UpdateActionPatch {
  status?: ActionStatus;
  result?: string | null;
  error?: string | null;
}

export function updateAction(db: Db, actionId: string, patch: UpdateActionPatch): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { action_id: actionId };
  if (patch.status !== undefined) {
    sets.push('status = @status');
    params.status = patch.status;
  }
  if (patch.result !== undefined) {
    sets.push('result = @result');
    params.result = patch.result;
  }
  if (patch.error !== undefined) {
    sets.push('error = @error');
    params.error = patch.error;
  }
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE task_actions SET ${sets.join(', ')} WHERE action_id = @action_id`).run(params);
}

/** A status is terminal once execution decided its fate — replays skip it. */
export function isTerminalStatus(status: ActionStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'rejected';
}

// ── task_loops ───────────────────────────────────────────────────────────────

/** The single active loop for a task (status='active'), or null. */
export function getActiveLoop(db: Db, taskId: string): TaskLoop | null {
  const row = db
    .prepare("SELECT * FROM task_loops WHERE task_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(taskId) as TaskLoopRow | undefined;
  return row ? rowToLoop(row) : null;
}

export function getLoop(db: Db, id: string): TaskLoop | null {
  const row = db.prepare('SELECT * FROM task_loops WHERE id = ?').get(id) as TaskLoopRow | undefined;
  return row ? rowToLoop(row) : null;
}

export interface InsertLoopInput {
  id: string;
  task_id: string;
  allowed_methods?: GianActionMethod[];
  allowed_workspaces?: string[];
  allowed_executors?: Executor[];
  max_rounds?: number;
  current_step?: string | null;
  current_step_session_id?: string | null;
  expected_role?: Role | null;
}

export function insertLoop(db: Db, input: InsertLoopInput): void {
  db.prepare(
    `INSERT INTO task_loops
       (id, task_id, status, allowed_methods, allowed_workspaces, allowed_executors,
        round, max_rounds, current_step, current_step_session_id, expected_role)
     VALUES (@id, @task_id, 'active', @allowed_methods, @allowed_workspaces, @allowed_executors,
        0, @max_rounds, @current_step, @current_step_session_id, @expected_role)`,
  ).run({
    id: input.id,
    task_id: input.task_id,
    allowed_methods: JSON.stringify(input.allowed_methods ?? []),
    allowed_workspaces: JSON.stringify(input.allowed_workspaces ?? []),
    allowed_executors: JSON.stringify(input.allowed_executors ?? []),
    max_rounds: input.max_rounds ?? 0,
    current_step: input.current_step ?? null,
    current_step_session_id: input.current_step_session_id ?? null,
    expected_role: input.expected_role ?? null,
  });
}

export interface UpdateLoopPatch {
  status?: TaskLoop['status'];
  round?: number;
  current_step?: string | null;
  current_step_session_id?: string | null;
  expected_role?: Role | null;
  allowed_methods?: GianActionMethod[];
  allowed_workspaces?: string[];
  allowed_executors?: Executor[];
  max_rounds?: number;
}

export function updateLoop(db: Db, id: string, patch: UpdateLoopPatch): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  const scalar: (keyof UpdateLoopPatch)[] = ['status', 'round', 'current_step', 'current_step_session_id', 'expected_role', 'max_rounds'];
  for (const key of scalar) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = patch[key];
    }
  }
  const arrays: (keyof UpdateLoopPatch)[] = ['allowed_methods', 'allowed_workspaces', 'allowed_executors'];
  for (const key of arrays) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = JSON.stringify(patch[key]);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE task_loops SET ${sets.join(', ')} WHERE id = @id`).run(params);
}
