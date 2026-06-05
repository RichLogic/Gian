import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';
import { normalizeCcNotification } from '../event/normalize-cc.js';

/**
 * Replay a native (claude / codex) JSONL session into Gian's `turns` and
 * `events` tables, so an adopted Gian session has a populated transcript
 * the moment the user opens it.
 *
 * Idempotency: caller must guarantee this runs ONCE per Gian session — we
 * don't dedup events here. Typical flow: adopt endpoint creates the Gian
 * session row in same transaction as this replay.
 */

export interface NormalizedEvent {
  callId: string;
  type: string;
  data: Record<string, unknown>;
}

export interface NormalizedTurn {
  events: NormalizedEvent[];
}

/**
 * Per-line parser result for live-sync.
 *
 *   - `boundary: 'turn-start'`: this line is a real human user message; the
 *     watcher should open a new turn before flushing this event into the DB.
 *   - `boundary: 'continue'`: this line is an assistant continuation in the
 *     current turn (output.text / tool.use). Skipped if there's no open turn
 *     (which can only happen on a partial / corrupt JSONL).
 *   - `null`: the line was system noise, malformed JSON, an unrelated entry,
 *     or otherwise has no transcript-visible event.
 */
export interface ParsedLine {
  boundary: 'turn-start' | 'continue';
  events: NormalizedEvent[];
}

export function replayNativeJsonl(
  db: Db,
  sessionId: string,
  filePath: string,
  executor: 'claude' | 'codex',
): { turnCount: number; eventCount: number } {
  const turns =
    executor === 'claude' ? parseCcJsonl(filePath) : parseCodexJsonl(filePath);

  const insertTurn = db.prepare(
    `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
     VALUES (?, ?, ?, 'completed', ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let eventCount = 0;
  // Use a base timestamp + per-turn nanosecond bump so created_at stays in
  // chronological order when many events are inserted in one batch.
  const baseTime = Date.now() - turns.length * 1000;

  const insertAll = db.transaction(() => {
    // Rebuild — not append. Drop any existing rows for this session first so a
    // replay can never layer a second copy on top of live/structured events
    // (the root cause of the "every turn duplicated" bug). Children (events)
    // before parents (turns) to respect the FK. Idempotent: a no-op when the
    // session is already empty (adoption / cold-rebuild). The JSONL is the
    // authoritative source for a native session, so a clean normalized rebuild
    // is always correct.
    db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      const turnId = randomUUID();
      const turnNumber = i + 1;
      const turnStartedAt = new Date(baseTime + i * 1000).toISOString();
      const turnCompletedAt = new Date(baseTime + i * 1000 + 500).toISOString();
      insertTurn.run(turnId, sessionId, turnNumber, turnStartedAt, turnCompletedAt);

      // Bracket each turn with turn.started / turn.completed events so the
      // transcript renders the turn-divider line.
      insertEvent.run(
        randomUUID(),
        sessionId,
        turnId,
        randomUUID(),
        'turn.started',
        JSON.stringify({ turnId, status: 'running' }),
        turnStartedAt,
      );
      eventCount++;

      for (let e = 0; e < turn.events.length; e++) {
        const event = turn.events[e]!;
        // Spread events evenly between turn-started and turn-completed.
        const ts = new Date(baseTime + i * 1000 + 1 + e * 10).toISOString();
        insertEvent.run(
          randomUUID(),
          sessionId,
          turnId,
          event.callId,
          event.type,
          JSON.stringify(event.data),
          ts,
        );
        eventCount++;
      }

      insertEvent.run(
        randomUUID(),
        sessionId,
        turnId,
        randomUUID(),
        'turn.completed',
        JSON.stringify({ turnId, status: 'completed' }),
        turnCompletedAt,
      );
      eventCount++;
    }
  });
  insertAll();

  return { turnCount: turns.length, eventCount };
}

// ---------------------------------------------------------------------------
// Claude Code JSONL → normalized turns
// ---------------------------------------------------------------------------

function parseCcJsonl(filePath: string): NormalizedTurn[] {
  const turns: NormalizedTurn[] = [];
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  let currentTurn: NormalizedTurn | null = null;

  for (const line of lines) {
    const parsed = parseCcLine(line);
    if (!parsed) continue;
    if (parsed.boundary === 'turn-start') {
      currentTurn = { events: [...parsed.events] };
      turns.push(currentTurn);
    } else if (currentTurn) {
      currentTurn.events.push(...parsed.events);
    }
  }

  return turns;
}

/**
 * Parse a single cc JSONL line into normalized events. Returns null when the
 * line should be ignored (system noise, malformed JSON, non-message entry).
 *
 * Used by both replay (whole-file) and the live JSONL watcher (incremental
 * tail) so behavior stays in sync.
 */
export function parseCcLine(line: string): ParsedLine | null {
  if (!line) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (parsed.type === 'user') {
    const msg = parsed.message as { content?: unknown } | undefined;
    if (typeof msg?.content === 'string') {
      const text = msg.content;
      if (!text || isSystemNoise(text)) return null;
      return {
        boundary: 'turn-start',
        events: [{
          callId: randomUUID(),
          type: 'user_message',
          data: { text: stripSystemTags(text) },
        }],
      };
    }

    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    const events: NormalizedEvent[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_result' || !isAskUserQuestionToolResult(b, parsed)) continue;
      const approvalId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
      if (!approvalId) continue;
      // Distinguish "user actually answered" from "tool was cancelled or
      // errored out". A normal answer carries `toolUseResult.answers`; a
      // selector-cancel (e.g. Beta paste-back, user hit Esc, PTY died) leaves
      // is_error=true or just the echoed questions with no answers. Treat both
      // as a deny so the QuestionCard doesn't show a green check on something
      // that was effectively aborted.
      const result = (b.toolUseResult ?? parsed.toolUseResult) as Record<string, unknown> | undefined;
      const hasAnswers = !!result
        && typeof result.answers === 'object'
        && result.answers !== null
        && !Array.isArray(result.answers)
        && Object.keys(result.answers as Record<string, unknown>).length > 0;
      const isError = b.is_error === true;
      const behavior = (!isError && hasAnswers) ? 'allow' : 'deny';
      events.push(...normalizeNativeCcEvent('approval.resolved', {
        approvalId,
        behavior,
        // Carry the picked answers so a transcript rebuilt from persisted
        // events (page reload) can still show "answered with …" — the live
        // synthetic resolve has them, the watcher must too.
        ...(behavior === 'allow' && hasAnswers ? { answers: (result as { answers: unknown }).answers } : {}),
      }));
    }
    if (events.length === 0) return null;
    return { boundary: 'continue', events };
  }

  if (parsed.type === 'assistant') {
    const msg = parsed.message as { content?: unknown[] } | undefined;
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    const events: NormalizedEvent[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const itemId = typeof b.id === 'string' ? b.id : randomUUID();
        events.push(...normalizeNativeCcEvent('output.text', {
          itemId,
          text: b.text,
        }));
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const callId = typeof b.id === 'string' ? b.id : randomUUID();
        const input = typeof b.input === 'object' && b.input ? b.input : {};
        if (isAskUserQuestionToolUse(b.name, input)) {
          events.push(...normalizeNativeCcEvent('approval.requested', {
            approvalId: callId,
            toolName: b.name,
            inputPreview: JSON.stringify(input),
          }));
        } else {
          events.push(...normalizeNativeCcEvent('tool.use', {
            callId,
            toolName: b.name,
            input,
          }));
        }
      }
    }
    if (events.length === 0) return null;
    return { boundary: 'continue', events };
  }

  return null;
}

function normalizeNativeCcEvent(method: string, data: Record<string, unknown>): NormalizedEvent[] {
  return normalizeCcNotification(
    { method, params: { sessionId: 'native-jsonl', data } },
    'native-jsonl',
    0,
  ).map(ev => ({
    callId: ev.call_id,
    type: ev.type,
    data: ev.data as unknown as Record<string, unknown>,
  }));
}

function isSystemNoise(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('Caveat: The messages below') ||
    trimmed.startsWith('<command-name>') ||
    /^<local-command-(caveat|stdout|stderr)>/.test(trimmed)
  );
}

function stripSystemTags(text: string): string {
  return text
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

function isAskUserQuestionToolUse(toolName: string, input: unknown): boolean {
  if (toolName === 'AskUserQuestion') return true;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return Array.isArray((input as { questions?: unknown }).questions);
}

function isAskUserQuestionToolResult(
  block: Record<string, unknown>,
  line: Record<string, unknown>,
): boolean {
  const result = block.toolUseResult ?? line.toolUseResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const r = result as Record<string, unknown>;
  return Array.isArray(r.questions) || (
    !!r.answers && typeof r.answers === 'object' && !Array.isArray(r.answers)
  );
}

// ---------------------------------------------------------------------------
// Codex JSONL → normalized turns
// ---------------------------------------------------------------------------

function parseCodexJsonl(filePath: string): NormalizedTurn[] {
  const turns: NormalizedTurn[] = [];
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  let currentTurn: NormalizedTurn | null = null;

  for (const line of lines) {
    const parsed = parseCodexLine(line);
    if (!parsed) continue;
    if (parsed.boundary === 'turn-start') {
      currentTurn = { events: [...parsed.events] };
      turns.push(currentTurn);
    } else if (currentTurn) {
      currentTurn.events.push(...parsed.events);
    }
  }

  return turns;
}

/**
 * Parse a single codex JSONL line into normalized events. Returns null when
 * the line should be ignored (session_meta header, non-event entries, etc.).
 *
 * Mirrors parseCcLine — used by both replay and the live JSONL watcher.
 */
export function parseCodexLine(line: string): ParsedLine | null {
  if (!line) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed.type === 'session_meta') return null;
  if (parsed.type !== 'event_msg') return null;

  const payload = parsed.payload as Record<string, unknown> | undefined;
  if (!payload) return null;

  if (payload.type === 'user_message' && typeof payload.message === 'string') {
    return {
      boundary: 'turn-start',
      events: [{
        callId: randomUUID(),
        type: 'user_message',
        data: { text: payload.message },
      }],
    };
  }
  if (payload.type === 'agent_message') {
    const text = typeof payload.message === 'string' ? payload.message : '';
    if (!text.trim()) return null;
    return {
      boundary: 'continue',
      events: [{
        callId: randomUUID(),
        type: 'output.text',
        data: { text, itemId: randomUUID() },
      }],
    };
  }
  return null;
}
