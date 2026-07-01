// Gian action parser — pure, side-effect-free (proposal gian-task-pm-engineer
// §4A.A). Turns an agent's FINAL assistant text into a validated `GianAction`,
// or an explaining failure. Kept isolated and unit-tested; the live wiring
// (turn-terminal event source, dedup, authorization, execution) lands in
// Slice 2 and calls into this.
//
// Two defenses make text parsing safe for a side-effecting protocol:
//   • Tail rule  — only accept a block that is EXACTLY the trailing content of
//                  the final text (after trimming trailing whitespace). Codex
//                  final text is many agentMessages joined with no separator, so
//                  a model might show an example block then keep writing; a
//                  "find any block" parser would mis-fire. Anything after the
//                  block ⇒ treat it as an example, not an instruction.
//   • Fence rule — a block wrapped in a ``` code fence is an example. A CLOSED
//                  fence puts ``` after the block ⇒ caught by the tail rule; an
//                  OPEN fence right before the block is caught by counting ```.

import { createHash } from 'node:crypto';
import {
  GIAN_ACTION_OPEN,
  GIAN_ACTION_CLOSE,
  type Executor,
  type GianAction,
} from '@gian/shared';

export type ParseFailureReason =
  | 'no-block' // no action envelope present at all
  | 'not-trailing' // an envelope exists but is not the trailing content (example)
  | 'bad-json' // trailing envelope found, but its body is not valid JSON
  | 'unknown-method' // method missing / not one of the three
  | 'invalid-params'; // params failed validation for the method

export interface ParsedActionOk {
  ok: true;
  action: GianAction;
  /** Verbatim trailing block (OPEN through CLOSE, inclusive). Hashed for
   *  payload_hash so action_id is stable across re-parses of the same
   *  (verbatim) final text. */
  blockText: string;
}

export interface ParsedActionErr {
  ok: false;
  reason: ParseFailureReason;
  /** Short, agent-facing hint injected back on the next turn so it can retry
   *  (execution contract ③/⑦). */
  detail: string;
}

export type ParseResult = ParsedActionOk | ParsedActionErr;

/**
 * Parse the single trailing `<<gian:action>>…<</gian:action>>` envelope from an
 * agent's final assistant text. Returns the validated action + verbatim block,
 * or a failure with an agent-facing hint.
 */
export function parseGianAction(finalText: string): ParseResult {
  const trimmed = finalText.replace(/\s+$/, '');

  // Tail rule: the envelope must close the message.
  if (!trimmed.endsWith(GIAN_ACTION_CLOSE)) {
    if (finalText.includes(GIAN_ACTION_OPEN)) {
      return {
        ok: false,
        reason: 'not-trailing',
        detail:
          'A gian:action block was found but it is not at the very end of your reply. ' +
          'To execute an action, put a single <<gian:action>>…<</gian:action>> block as the LAST thing in your message.',
      };
    }
    return { ok: false, reason: 'no-block', detail: 'No gian:action block present.' };
  }

  const closeIdx = trimmed.length - GIAN_ACTION_CLOSE.length;
  const openIdx = trimmed.lastIndexOf(GIAN_ACTION_OPEN, closeIdx);
  if (openIdx === -1 || openIdx >= closeIdx) {
    // A closing sentinel with no matching opener — nothing executable.
    return { ok: false, reason: 'no-block', detail: 'No gian:action block present.' };
  }

  // Fence rule: an odd number of ``` before the opener ⇒ the block sits inside
  // an unclosed code fence ⇒ it is an example, not an instruction.
  const before = trimmed.slice(0, openIdx);
  const fenceCount = (before.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    return {
      ok: false,
      reason: 'not-trailing',
      detail:
        'The gian:action block is inside a code fence, so it was treated as an example. ' +
        'Emit the block as bare text (no ``` fence) at the end of your reply to run it.',
    };
  }

  const blockText = trimmed.slice(openIdx); // OPEN … CLOSE, verbatim
  const inner = trimmed.slice(openIdx + GIAN_ACTION_OPEN.length, closeIdx).trim();

  let obj: unknown;
  try {
    obj = JSON.parse(inner);
  } catch {
    return {
      ok: false,
      reason: 'bad-json',
      detail: 'The gian:action block did not contain valid JSON.',
    };
  }

  const validated = validateAction(obj);
  if (!validated.ok) return validated;
  return { ok: true, action: validated.action, blockText };
}

// ── Validation ───────────────────────────────────────────────────────────────

type ValidateResult = { ok: true; action: GianAction } | ParsedActionErr;

function invalid(detail: string): ParsedActionErr {
  return { ok: false, reason: 'invalid-params', detail };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isExecutor(v: unknown): v is Executor {
  return v === 'claude' || v === 'codex';
}

function validateAction(obj: unknown): ValidateResult {
  if (!isPlainObject(obj)) {
    return { ok: false, reason: 'invalid-params', detail: 'Action must be a JSON object.' };
  }
  const { method, params } = obj as { method?: unknown; params?: unknown };
  if (method !== 'create_subtask' && method !== 'message_subtask' && method !== 'submit_step') {
    return {
      ok: false,
      reason: 'unknown-method',
      detail: 'method must be one of create_subtask | message_subtask | submit_step.',
    };
  }
  if (!isPlainObject(params)) {
    return invalid(`${method} requires a "params" object.`);
  }

  switch (method) {
    case 'create_subtask': {
      const { workspace, executor, brief, name } = params;
      if (!nonEmptyString(workspace)) return invalid('create_subtask.params.workspace is required.');
      if (!isExecutor(executor)) return invalid('create_subtask.params.executor must be "claude" or "codex".');
      if (!nonEmptyString(brief)) return invalid('create_subtask.params.brief is required.');
      if (name !== undefined && typeof name !== 'string') return invalid('create_subtask.params.name must be a string.');
      return {
        ok: true,
        action: {
          method,
          params: {
            workspace: workspace.trim(),
            executor,
            brief: brief.trim(),
            ...(nonEmptyString(name) ? { name: name.trim() } : {}),
          },
        },
      };
    }
    case 'message_subtask': {
      const { subtask_id, text } = params;
      if (!nonEmptyString(subtask_id)) return invalid('message_subtask.params.subtask_id is required.');
      if (!nonEmptyString(text)) return invalid('message_subtask.params.text is required.');
      return { ok: true, action: { method, params: { subtask_id: subtask_id.trim(), text } } };
    }
    case 'submit_step': {
      const { status, headline, verdict, points } = params;
      if (status !== 'done' && status !== 'blocked') return invalid('submit_step.params.status must be "done" or "blocked".');
      if (!nonEmptyString(headline)) return invalid('submit_step.params.headline is required.');
      if (verdict !== undefined && verdict !== null && verdict !== 'pass' && verdict !== 'changes') {
        return invalid('submit_step.params.verdict must be "pass", "changes", or null.');
      }
      let normPoints: string[] | undefined;
      if (points !== undefined) {
        if (!Array.isArray(points) || points.some(p => typeof p !== 'string')) {
          return invalid('submit_step.params.points must be an array of strings.');
        }
        normPoints = (points as string[]).map(p => p).filter(p => p.trim().length > 0);
      }
      return {
        ok: true,
        action: {
          method,
          params: {
            status,
            headline: headline.trim(),
            ...(verdict !== undefined ? { verdict } : {}),
            ...(normPoints && normPoints.length > 0 ? { points: normPoints } : {}),
          },
        },
      };
    }
  }
}

// ── Idempotency hashing ──────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Hash of the verbatim action block text. Stable because Codex final text is a
 *  verbatim join of agentMessage text (§2.7), so the same turn re-parses to the
 *  same block. */
export function computePayloadHash(blockText: string): string {
  return sha256(blockText);
}

/** Deterministic action id: `hash(session_id + source_turn_key + payload_hash)`.
 *  The three parts are NUL-separated so no concatenation collision is possible.
 *  Guards against JSONL replay / restart re-parse / stream+final double-reads /
 *  retry injection re-running the same action (execution contract ②/③). */
export function computeActionId(sessionId: string, sourceTurnKey: string, payloadHash: string): string {
  return sha256(`${sessionId} ${sourceTurnKey} ${payloadHash}`);
}
