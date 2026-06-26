import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Subtask-completion summarizer — the `.ai/` write-back (PRD-v3 P4).
 *
 * When a `type='subtask'` session reaches `done`, gian asynchronously rewrites
 * the workspace's `.ai/` context so the next Subtask in the same workspace (and
 * the Task Manager) inherits a fresh picture:
 *
 *   - `.ai/STATE.md`     — overwritten with a new snapshot
 *   - `.ai/HANDOFF.md`   — overwritten with a brief for the next Subtask
 *   - `.ai/SESSION_LOG.md` — one append-only entry (timestamp + subtask ref)
 *
 * The new STATE/HANDOFF bodies come from a CHEAP small-model call (NOT the
 * Manager's gpt-5.5). That live call is abstracted behind `generateSummary` and
 * marked TODO(P4-live); until it's wired, a deterministic **template fallback**
 * runs — which is also the PRD §155 degradation path when the live call fails.
 *
 * C1 (locked default): before overwriting STATE.md / HANDOFF.md we copy the
 * existing file to `.ai/.history/<ISO-timestamp>-<name>` so a user (or prior
 * Subtask) edit is never silently clobbered.
 *
 * Abandon path (§153): only append a SESSION_LOG line (`abandoned: <reason>`).
 * HANDOFF is NOT rewritten — an abandoned Subtask has nothing to hand off.
 *
 * Everything here is synchronous fs mechanics so it unit-tests against a real
 * temp dir. The async/non-blocking scheduling lives at the call site
 * (SessionManager) — this module never blocks a turn.
 */

const STATE_REL = '.ai/STATE.md';
const HANDOFF_REL = '.ai/HANDOFF.md';
const SESSION_LOG_REL = '.ai/SESSION_LOG.md';
const HISTORY_DIR_REL = '.ai/.history';

/** A completed Subtask, reduced to what the summarizer needs. */
export interface SubtaskContext {
  /** Subtask session id (for the SESSION_LOG reference). */
  id: string;
  /** Display name, or null when untitled. */
  name: string | null;
  /** Terminal status the writeback is for. */
  status: 'done' | 'abandoned';
  /** Best-effort transcript text (agent/user messages concatenated). May be
   *  empty — the template fallback still produces a valid entry. */
  transcript?: string;
}

/** New `.ai/` bodies a summarizer (live or template) produces on completion. */
export interface SummaryOutput {
  /** Full new body for `.ai/STATE.md`. */
  state: string;
  /** Full new body for `.ai/HANDOFF.md`. */
  handoff: string;
  /** One-line, user-editable subtask summary persisted to `sessions.summary`. */
  summary: string;
  /** True when this came from the template fallback (live call absent/failed). */
  fallback: boolean;
}

/** Pluggable LLM hook so the live call can be injected (and stubbed in tests).
 *  Returns the new STATE/HANDOFF/summary, or throws to trigger the fallback. */
export type SummaryLlm = (input: {
  subtask: SubtaskContext;
  currentState: string;
  currentHandoff: string;
}) => Promise<{ state: string; handoff: string; summary: string }>;

/** ISO-8601 with `:` / `.` swapped for `-` so it's a safe filename segment. */
function fsTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

function subtaskLabel(subtask: SubtaskContext): string {
  return subtask.name?.trim() || `(untitled ${subtask.id.slice(0, 8)})`;
}

function readIfExists(abs: string): string {
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

/**
 * C1 backup: if `abs` exists, copy it to `.ai/.history/<ISO>-<basename>` before
 * the caller overwrites it. No-op when the file is absent (nothing to clobber).
 * Returns the backup path written, or null when nothing was backed up.
 */
export function backupToHistory(
  workspaceDir: string,
  rel: string,
  stamp = fsTimestamp(),
): string | null {
  const abs = join(workspaceDir, rel);
  if (!existsSync(abs)) return null;
  const historyDir = join(workspaceDir, HISTORY_DIR_REL);
  mkdirSync(historyDir, { recursive: true });
  const dest = join(historyDir, `${stamp}-${basename(rel)}`);
  copyFileSync(abs, dest);
  return dest;
}

/**
 * Build the deterministic template fallback (PRD §155). Used both as the
 * pre-live placeholder and as the degradation path when the live call throws.
 * Mentions the subtask name + status and preserves the prior STATE/HANDOFF so
 * we never blank out context we couldn't regenerate.
 */
export function buildTemplateSummary(input: {
  subtask: SubtaskContext;
  currentState: string;
  currentHandoff: string;
  now?: Date;
}): SummaryOutput {
  const { subtask, currentState, currentHandoff } = input;
  const label = subtaskLabel(subtask);
  const iso = (input.now ?? new Date()).toISOString();

  const note = `<!-- gian: auto-template writeback (summarizer fallback) ${iso} -->`;
  const line = `Subtask "${label}" completed (${subtask.status}).`;

  // Keep prior body so context isn't lost; prepend a dated note.
  const priorState = currentState.trim();
  const state = [
    note,
    '',
    '# State',
    '',
    line,
    '',
    priorState ? '## Previous state' : '_No prior state snapshot._',
    priorState ? '' : '',
    priorState,
    '',
  ].filter(seg => seg !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');

  const handoff = [
    note,
    '',
    '# Handoff',
    '',
    `Previous subtask "${label}" finished (${subtask.status}). ` +
      'No machine-written handoff is available (template fallback) — ' +
      'review the workspace and SESSION_LOG.md before continuing.',
    '',
  ].join('\n');

  const summary = line;

  return { state, handoff, summary, fallback: true };
}

/** Format the SESSION_LOG append block for a COMPLETED subtask. */
export function formatSessionLogEntry(
  subtask: SubtaskContext,
  now = new Date(),
): string {
  const iso = now.toISOString();
  return [
    '',
    `## ${iso} — ${subtaskLabel(subtask)} [${subtask.id}]`,
    `status: ${subtask.status}`,
    '',
  ].join('\n');
}

/** Format the SESSION_LOG line for an ABANDONED subtask (§153). */
export function formatAbandonLogEntry(
  subtask: SubtaskContext,
  reason: string | null | undefined,
  now = new Date(),
): string {
  const iso = now.toISOString();
  const why = (reason ?? '').trim() || '(no reason given)';
  return [
    '',
    `## ${iso} — ${subtaskLabel(subtask)} [${subtask.id}]`,
    `abandoned: ${why}`,
    '',
  ].join('\n');
}

/** Append text to `.ai/SESSION_LOG.md`, creating it (with header) when absent. */
function appendSessionLog(workspaceDir: string, entry: string): void {
  const abs = join(workspaceDir, SESSION_LOG_REL);
  if (!existsSync(abs)) {
    mkdirSync(join(workspaceDir, '.ai'), { recursive: true });
    writeFileSync(abs, '# Session Log\n', 'utf8');
  }
  appendFileSync(abs, entry, 'utf8');
}

export interface WritebackResult {
  /** Backup paths written under `.ai/.history` (STATE/HANDOFF), in order. */
  backups: string[];
  /** Whether the template fallback produced the bodies. */
  fallback: boolean;
  /** The one-line summary to persist to `sessions.summary`. */
  summary: string;
}

/**
 * Completion write-back: backup (C1) → overwrite STATE.md + HANDOFF.md →
 * append SESSION_LOG.md. Pure fs mechanics; bodies come from `output`.
 */
export function applyCompletionWriteback(
  workspaceDir: string,
  subtask: SubtaskContext,
  output: SummaryOutput,
  now = new Date(),
): WritebackResult {
  mkdirSync(join(workspaceDir, '.ai'), { recursive: true });
  const stamp = fsTimestamp(now);

  const backups: string[] = [];
  // C1: back up BOTH targets before touching either, so a mid-run crash can't
  // leave one overwritten without its backup.
  for (const rel of [STATE_REL, HANDOFF_REL]) {
    const b = backupToHistory(workspaceDir, rel, stamp);
    if (b) backups.push(b);
  }

  writeFileSync(join(workspaceDir, STATE_REL), ensureTrailingNewline(output.state), 'utf8');
  writeFileSync(join(workspaceDir, HANDOFF_REL), ensureTrailingNewline(output.handoff), 'utf8');
  appendSessionLog(workspaceDir, formatSessionLogEntry(subtask, now));

  return { backups, fallback: output.fallback, summary: output.summary };
}

/**
 * Abandon write-back (§153): append ONE SESSION_LOG line. STATE.md / HANDOFF.md
 * are left untouched — an abandoned Subtask hands nothing off.
 */
export function applyAbandonWriteback(
  workspaceDir: string,
  subtask: SubtaskContext,
  reason: string | null | undefined,
  now = new Date(),
): void {
  appendSessionLog(workspaceDir, formatAbandonLogEntry(subtask, reason, now));
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/**
 * Produce the new STATE/HANDOFF/summary for a completed Subtask. Tries the
 * injected live LLM (`llm`) when present; on any throw — or when no live call
 * is wired — degrades to the deterministic template (PRD §155).
 *
 * TODO(P4-live): wire a CHEAP small-model direct client here (NOT the Manager's
 * gpt-5.5) and pass it in as `llm`. There is no direct-LLM client in host today
 * (cc-proxy / codex-proxy are session-scoped), so the live call is deliberately
 * left unimplemented and the template fallback is the active path.
 */
export async function generateSummary(input: {
  subtask: SubtaskContext;
  currentState: string;
  currentHandoff: string;
  llm?: SummaryLlm | null;
  now?: Date;
}): Promise<SummaryOutput> {
  const { subtask, currentState, currentHandoff, llm } = input;
  if (llm) {
    try {
      const out = await llm({ subtask, currentState, currentHandoff });
      return { state: out.state, handoff: out.handoff, summary: out.summary, fallback: false };
    } catch {
      // Degrade to template on any live-call failure (§155).
    }
  }
  return buildTemplateSummary({ subtask, currentState, currentHandoff, now: input.now });
}

/**
 * Full completion path: generate (live or fallback) then write back. Reads the
 * current STATE/HANDOFF off disk. Returns the writeback result (incl. the
 * one-line `summary` the caller persists to `sessions.summary`).
 */
export async function summarizeCompletedSubtask(input: {
  workspaceDir: string;
  subtask: SubtaskContext;
  llm?: SummaryLlm | null;
  now?: Date;
}): Promise<WritebackResult> {
  const { workspaceDir, subtask, llm } = input;
  const now = input.now ?? new Date();
  const currentState = readIfExists(join(workspaceDir, STATE_REL));
  const currentHandoff = readIfExists(join(workspaceDir, HANDOFF_REL));

  const output = await generateSummary({ subtask, currentState, currentHandoff, llm, now });
  return applyCompletionWriteback(workspaceDir, subtask, output, now);
}
