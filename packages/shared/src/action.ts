// Gian action protocol + task-loop / action-ledger types (proposal
// `docs/proposals/gian-task-pm-engineer.md` §4A.A). An agent emits a JSON
// envelope in its FINAL text; the host's output watcher parses, deduplicates,
// authorizes, and executes it. This is NOT MCP / not a real tool call — it is
// text the host intercepts, so there is no permission popup and Claude/Codex
// are treated identically.
//
//   <<gian:action>>
//   {"method":"create_subtask","params":{"workspace":"repoA","executor":"claude","brief":"…"}}
//   <</gian:action>>
//
// This module is TYPES + sentinel constants only — no runtime logic and no Node
// imports — so it is safe to bundle into the web. The parser + hashing (which
// need `node:crypto`) live host-side in `packages/host/src/task/action-parser.ts`.

import type { Executor } from './model.js';

/** The three task roles. Determined by session type and injected by the host
 *  (RoleInjector, §4A.C): `individual` ← type='coding' (default, works directly
 *  with the user, ≈ classic session-context); `engineer` ← type='subtask'
 *  (= individual + a brief + reports to the PM); `pm` ← type='manager'
 *  (orchestrates, never engineers). */
export type Role = 'individual' | 'engineer' | 'pm';

// ── The ROLE header (RoleInjector, §4A.C / §4.8 ①) ───────────────────────────

// Gian injects a small ROLE header at the top of a session. On the Codex /
// Claude-structured "prepend to first message" path it is wrapped in these
// sentinels so the web can strip it from the visible transcript (the text still
// reaches the model). On the Claude-TTY SessionStart-hook path it never enters
// the visible conversation, so no stripping is needed there.
export const GIAN_ROLE_OPEN = '<<gian:role>>';
export const GIAN_ROLE_CLOSE = '<</gian:role>>';

/** Strip a leading sentinel-wrapped ROLE header from a message, if present.
 *  Mirrors `stripManagerSystemPrefix`: only leading blocks are removed, so a
 *  sentinel literal later in the user's own text is left intact. Returns the
 *  text unchanged when no header is found. */
export function stripGianRolePrefix(text: string): string {
  let out = text.replace(/^\s+/, '');
  while (out.startsWith(GIAN_ROLE_OPEN)) {
    const close = out.indexOf(GIAN_ROLE_CLOSE);
    if (close === -1) break;
    out = out.slice(close + GIAN_ROLE_CLOSE.length).replace(/^\s+/, '');
  }
  return out;
}

// ── The action envelope ──────────────────────────────────────────────────────

export const GIAN_ACTION_OPEN = '<<gian:action>>';
export const GIAN_ACTION_CLOSE = '<</gian:action>>';

/** Remove every `<<gian:action>>…<</gian:action>>` block from assistant text so
 *  the raw JSON envelope never shows in the transcript. Mirrors the Manager's
 *  `stripCreateSubtaskBlocks`. Leaves surrounding prose intact. */
export function stripGianActionBlocks(text: string): string {
  let out = text;
  for (;;) {
    const open = out.indexOf(GIAN_ACTION_OPEN);
    if (open === -1) break;
    const close = out.indexOf(GIAN_ACTION_CLOSE, open);
    if (close === -1) {
      out = out.slice(0, open).trimEnd();
      break;
    }
    out = out.slice(0, open) + out.slice(close + GIAN_ACTION_CLOSE.length);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** The controller's full action surface — one method per action (§4A.A). */
export type GianActionMethod = 'create_subtask' | 'message_subtask' | 'submit_step';

/** PM builds a subtask (NL already aligned / loop contract already authorized). */
export interface CreateSubtaskParams {
  /** Workspace name or absolute path — resolved to a workspace_id at validation. */
  workspace: string;
  executor: Executor;
  /** The engineering brief handed to the new subtask. */
  brief: string;
  /** Optional short title. */
  name?: string;
}

/** PM / loop feeds a message to an existing subtask (e.g. a fix round reusing
 *  its context). */
export interface MessageSubtaskParams {
  subtask_id: string;
  text: string;
}

export type SubmitStepStatus = 'done' | 'blocked';
/** Loop decision carried by the engineer's `submit_step`. Null when the step
 *  did not produce a pass/changes judgement (e.g. a `blocked` submit). */
export type SubmitStepVerdict = 'pass' | 'changes' | null;

/** Engineer explicitly declares "this step is finished". The ONLY signal that
 *  advances the loop (a bare Stop = idle / needs-submit). Self-carries the
 *  verdict so it is both the completion signal (H3) and the loop decision data
 *  (M5) — no separate report parser needed. */
export interface SubmitStepParams {
  status: SubmitStepStatus;
  headline: string;
  verdict?: SubmitStepVerdict;
  points?: string[];
}

/** Discriminated union over `method` — the validated shape a parsed action
 *  takes once params pass validation. */
export type GianAction =
  | { method: 'create_subtask'; params: CreateSubtaskParams }
  | { method: 'message_subtask'; params: MessageSubtaskParams }
  | { method: 'submit_step'; params: SubmitStepParams };

// ── Persistence: loop authorization + action ledger ──────────────────────────

export type LoopStatus = 'active' | 'paused' | 'done';

/** Per-Task authorization context (`task_loops`, migration 028). Filled by the
 *  loop contract (§4.5); read by the executor gate (§4A.A execution contract ④).
 *  `allowed_*` array columns are stored as JSON TEXT in SQLite. */
export interface TaskLoop {
  id: string;
  task_id: string;
  status: LoopStatus;
  allowed_methods: GianActionMethod[];
  /** Canonical workspace_ids (§4A.A ⑧). */
  allowed_workspaces: string[];
  allowed_executors: Executor[];
  round: number;
  max_rounds: number;
  current_step: string | null;
  /** The subtask session allowed to `submit_step` for the current step — guards
   *  against an engineer spoofing another engineer's / the PM's method. */
  current_step_session_id: string | null;
  expected_role: Role | null;
  created_at: string;
  updated_at: string;
}

/** Lifecycle of a parsed action (§4A.A execution contract). `staged` = parsed
 *  but not executable without a user confirm (no active loop / out of bounds);
 *  `queued` = valid + authorized but the target subtask is busy, to be drained
 *  when it returns idle. */
export type ActionStatus =
  | 'parsed'
  | 'validated'
  | 'staged'
  | 'queued'
  | 'authorized'
  | 'executing'
  | 'done'
  | 'failed'
  | 'rejected';

/** One row per parsed action (`task_actions`, migration 028). Keyed by a
 *  DETERMINISTIC `action_id = hash(session_id + source_turn_key + payload_hash)`
 *  so JSONL replay / restart re-parse / stream+final double-reads / retry
 *  injection never execute the same action twice (§4A.A execution contract ②/③).
 *  `payload` / `result` are JSON TEXT. */
export interface TaskAction {
  action_id: string;
  task_id: string;
  session_id: string;
  /** Host DB turn UUID. Nullable — a TTY Stop may not carry one. */
  host_turn_id: string | null;
  /** Runtime-native key of the assistant output the block parsed from
   *  (Codex `turn_completed.turnId`; Claude structured message/turn id; Claude
   *  TTY: JSONL message id / offset / hook seq, §7). */
  source_turn_key: string | null;
  method: GianActionMethod;
  /** Hash of the verbatim action block text (stable — Codex final text is a
   *  verbatim join, §2.7). */
  payload_hash: string;
  /** Normalized `{method, params}` JSON. */
  payload: string;
  status: ActionStatus;
  /** JSON result once executed, e.g. `{"subtask_id":"…"}`. */
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
