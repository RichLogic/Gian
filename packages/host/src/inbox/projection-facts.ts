import type { Db } from '../storage/db.js';
import { boundedInteractionId } from './signal.js';

const IDENT = /^[A-Za-z0-9._:-]{1,128}$/;
const FACT_SELECT = `session_id, provider_event_id, turn_id, interaction_id, direction,
            occurrence_event_id, generation, bound, origin, source, writer, projected, outcome,
            decision, action_id, title, description, subject, category, tool_name,
            turn_number, user_pending, user_source`;

export interface InboxProjectionFact {
  sessionId: string;
  providerEventId: string;
  turnId: string;
  interactionId: string;
  direction: 'open' | 'close';
  occurrenceEventId: string;
  generation: number;
  bound: boolean;
  origin: 'live' | 'replay';
  /**
   * Fact identity component. Native provider events and Host-local facts may
   * share an event id string; every read, mark, and occurrence fence below is
   * scoped by it, so one source never consumes or fences the other.
   */
  source: 'native' | 'local';
  /**
   * Fact writer. Provider events are 'provider'; Host-synthesized facts
   * (terminal-turn closes, local approval facts) are 'host'. A provider event
   * id may equal a Host-synthesized id string, so identity and marking are
   * scoped by writer as well.
   */
  writer: 'provider' | 'host';
  projected: 'question' | 'approval' | null;
  outcome: string | null;
  decision: string | null;
  actionId: string | null;
  title: string | null;
  description: string | null;
  subject: string | null;
  category: string | null;
  toolName: string | null;
  turnNumber: number | null;
  /** True only when this open is a confirmed user pending, decided at insert. */
  userPending: boolean;
  userSource: boolean;
}

interface FactRow {
  session_id: string;
  provider_event_id: string;
  turn_id: string;
  interaction_id: string;
  direction: 'open' | 'close';
  occurrence_event_id: string;
  generation: number;
  bound: number;
  origin: 'live' | 'replay';
  source: 'native' | 'local';
  writer: 'provider' | 'host';
  projected: 'question' | 'approval' | null;
  outcome: string | null;
  decision: string | null;
  action_id: string | null;
  title: string | null;
  description: string | null;
  subject: string | null;
  category: string | null;
  tool_name: string | null;
  turn_number: number | null;
  user_pending: number;
  user_source: number;
}

export interface InboxProjectionDraft {
  sessionId: string;
  providerEventId: string;
  turnId: string;
  turnNumber: number;
  origin: 'live' | 'replay';
  /**
   * Fact source. Native provider events are the default. Host-local approvals
   * (no provider event) use 'local' plus the owning process generation, so a
   * native event id that merely looks like a local one is never deduplicated
   * or cancelled as local.
   */
  source?: 'native' | 'local';
  ownerGeneration?: string | null;
  /**
   * Fact writer. Provider events are 'provider' (default). Host-synthesized
   * facts — terminal-turn closes and local approval facts — are 'host', so a
   * provider event id that equals a Host-synthesized id string is never
   * deduplicated or marked against the synthetic fact.
   */
  writer?: 'provider' | 'host';
  method: string;
  raw: Record<string, unknown>;
  displayType: string | null;
  displayData: Record<string, unknown> | null;
  /**
   * Result of ApprovalManager.inboxUserPending for this request.
   * False writes an applied non-todo. Recovery must not turn it into Inbox.
   */
  userPending: boolean;
  /** True only for a peeked web, im, or tool resolution source. */
  userSource: boolean;
}

/**
 * One occurrence is one host session, one host turn id, and the original
 * interaction id. Its generation is assigned when the first opening fact for
 * that triple is inserted. A later request on the same triple is a join, even
 * after a close. Arrival order does not open another generation.
 * A different host turn is the next occurrence. A resolved fact binds only to
 * the opening on its own triple. Without that opening it stays unknown and
 * cannot close a newer generation.
 */
export function recordInboxProjection(db: Db, draft: InboxProjectionDraft): void {
  if (draft.method !== 'interaction.requested' && draft.method !== 'interaction.resolved') return;
  if (!IDENT.test(draft.sessionId) || !IDENT.test(draft.turnId)) return;
  const interactionId = boundedInteractionId(draft.raw.interactionId);
  if (!interactionId) {
    console.error('[inbox] projection fact dropped: interaction id is not a non-empty string');
    return;
  }
  if (!draft.providerEventId) return;
  const source = draft.source ?? 'native';
  const writer = draft.writer ?? 'provider';
  const existing = db.prepare(
    `SELECT 1 AS ok
       FROM inbox_projection_facts
      WHERE session_id = ? AND source = ? AND writer = ? AND provider_event_id = ?`,
  ).get(draft.sessionId, source, writer, draft.providerEventId);
  if (existing) return;

  const projected = draft.displayType === 'interaction.question'
    ? 'question'
    : draft.displayType === 'interaction.approval'
      ? 'approval'
      : null;
  const display = draft.displayData;
  const fields = {
    title: text(display?.title),
    description: text(display?.description),
    subject: text(display?.subject),
    category: text(display?.category) ?? text(draft.raw.category),
    toolName: toolName(draft.raw, display),
    turnNumber: Number.isInteger(draft.turnNumber) && draft.turnNumber >= 1 ? draft.turnNumber : null,
    outcome: text(draft.raw.outcome),
    decision: text(display?.decision),
    actionId: text(draft.raw.actionId),
  };

  if (draft.method === 'interaction.requested') {
    const opening = canonicalOpening(db, draft.sessionId, draft.turnId, interactionId, source);
    if (opening) {
      const fenced = closeExists(db, draft.sessionId, draft.turnId, interactionId, source);
      insertFact(db, draft, {
        interactionId,
        direction: 'open',
        occurrenceEventId: opening.occurrenceEventId,
        generation: opening.generation,
        bound: true,
        projected: opening.projected ?? projected,
        userPending: opening.userPending,
        userSource: false,
        applied: !opening.userPending || fenced,
        ...fields,
      });
      bindWaitingCloses(
        db,
        draft.sessionId,
        draft.turnId,
        interactionId,
        opening.occurrenceEventId,
        opening.generation,
        source,
      );
      return;
    }
    const generation = nextGeneration(db, draft.sessionId, interactionId, source);
    const fenced = closeExists(db, draft.sessionId, draft.turnId, interactionId, source);
    const userPending = draft.userPending;
    insertFact(db, draft, {
      interactionId,
      direction: 'open',
      occurrenceEventId: draft.providerEventId,
      generation,
      bound: true,
      projected,
      userPending,
      userSource: false,
      applied: !userPending || fenced,
      ...fields,
    });
    bindWaitingCloses(
      db,
      draft.sessionId,
      draft.turnId,
      interactionId,
      draft.providerEventId,
      generation,
      source,
    );
    return;
  }

  const opening = canonicalOpening(db, draft.sessionId, draft.turnId, interactionId, source);
  if (!opening) {
    insertFact(db, draft, {
      interactionId,
      direction: 'close',
      occurrenceEventId: '',
      generation: 0,
      bound: false,
      projected,
      userPending: false,
      userSource: draft.userSource,
      applied: false,
      ...fields,
    });
    return;
  }
  insertFact(db, draft, {
    interactionId,
    direction: 'close',
    occurrenceEventId: opening.occurrenceEventId,
    generation: opening.generation,
    bound: true,
    projected: opening.projected ?? projected,
    userPending: false,
    userSource: draft.userSource,
    applied: false,
    ...fields,
    title: opening.title,
    description: opening.description,
    subject: opening.subject,
    category: opening.category,
    toolName: opening.toolName,
  });
}

export function listUnappliedInboxProjections(db: Db): InboxProjectionFact[] {
  const rows = db.prepare(
    `SELECT ${FACT_SELECT}
       FROM inbox_projection_facts
      WHERE applied = 0
      ORDER BY rowid ASC`,
  ).all() as FactRow[];
  return rows.map(toFact);
}

/** Occurrence identity is session + source + event id: a native event and a
 *  Host-local fact may share the id string and must stay independent. */
export function inboxOccurrenceKey(sessionId: string, source: string, occurrenceEventId: string): string {
  return `${sessionId.length}:${sessionId}${source.length}:${source}${occurrenceEventId.length}:${occurrenceEventId}`;
}

export function listPreexistingOccurrenceKeys(db: Db): string[] {
  const rows = db.prepare(
    `SELECT session_id, source, occurrence_event_id
       FROM inbox_projection_facts
      WHERE direction = 'open'
        AND bound = 1
        AND provider_event_id = occurrence_event_id`,
  ).all() as Array<{ session_id: string; source: string; occurrence_event_id: string }>;
  return rows.map(row => inboxOccurrenceKey(row.session_id, row.source, row.occurrence_event_id));
}

/** Any bound close for this occurrence is terminal, whatever its rowid. */
export function occurrenceHasBoundClose(
  db: Db,
  sessionId: string,
  occurrenceEventId: string,
  source: 'native' | 'local',
): boolean {
  if (!occurrenceEventId) return false;
  const row = db.prepare(
    `SELECT 1 AS ok
       FROM inbox_projection_facts
      WHERE session_id = ?
        AND source = ?
        AND direction = 'close'
        AND bound = 1
        AND occurrence_event_id = ?
      LIMIT 1`,
  ).get(sessionId, source, occurrenceEventId);
  return row !== undefined;
}

/** The terminal close is not durable yet. The open must stay recoverable. */
export function occurrenceClosePending(
  db: Db,
  sessionId: string,
  occurrenceEventId: string,
  source: 'native' | 'local',
): boolean {
  if (!occurrenceEventId) return false;
  const row = db.prepare(
    `SELECT 1 AS ok
       FROM inbox_projection_facts
      WHERE session_id = ?
        AND source = ?
        AND direction = 'close'
        AND bound = 1
        AND applied = 0
        AND occurrence_event_id = ?
      LIMIT 1`,
  ).get(sessionId, source, occurrenceEventId);
  return row !== undefined;
}

/** The close fact was marked applied without a terminal inbox row. */
export function reopenInboxOccurrenceClose(
  db: Db,
  sessionId: string,
  occurrenceEventId: string,
  source: 'native' | 'local',
): void {
  if (!occurrenceEventId) return;
  db.prepare(
    `UPDATE inbox_projection_facts
        SET applied = 0
      WHERE session_id = ?
        AND source = ?
        AND direction = 'close'
        AND bound = 1
        AND applied = 1
        AND occurrence_event_id = ?`,
  ).run(sessionId, source, occurrenceEventId);
}

export function stampInboxClose(
  db: Db,
  sessionId: string,
  providerEventId: string,
  source: 'native' | 'local',
  writer: 'provider' | 'host',
  patch: { decision: string | null; userSource: boolean },
): void {
  if (!providerEventId) return;
  db.prepare(
    `UPDATE inbox_projection_facts
        SET decision = COALESCE(?, decision),
            user_source = CASE WHEN ? = 1 THEN 1 ELSE user_source END
      WHERE session_id = ?
        AND source = ?
        AND writer = ?
        AND provider_event_id = ?
        AND direction = 'close'`,
  ).run(patch.decision, patch.userSource ? 1 : 0, sessionId, source, writer, providerEventId);
}

export function markInboxProjectionApplied(
  db: Db,
  sessionId: string,
  providerEventId: string,
  source: 'native' | 'local',
  writer: 'provider' | 'host',
): void {
  db.prepare(
    `UPDATE inbox_projection_facts
        SET applied = 1
      WHERE session_id = ? AND source = ? AND writer = ? AND provider_event_id = ?`,
  ).run(sessionId, source, writer, providerEventId);
}

export function markSessionProjectionFactsApplied(db: Db, sessionId: string): void {
  db.prepare(
    `UPDATE inbox_projection_facts
        SET applied = 1
      WHERE session_id = ? AND applied = 0`,
  ).run(sessionId);
}

function canonicalOpening(
  db: Db,
  sessionId: string,
  turnId: string,
  interactionId: string,
  source: 'native' | 'local',
): InboxProjectionFact | null {
  const row = db.prepare(
    `SELECT ${FACT_SELECT}
       FROM inbox_projection_facts
      WHERE session_id = ?
        AND turn_id = ?
        AND interaction_id = ?
        AND source = ?
        AND direction = 'open'
        AND bound = 1
        AND provider_event_id = occurrence_event_id
      LIMIT 1`,
  ).get(sessionId, turnId, interactionId, source) as FactRow | undefined;
  return row ? toFact(row) : null;
}

function nextGeneration(db: Db, sessionId: string, interactionId: string, source: 'native' | 'local'): number {
  const row = db.prepare(
    `SELECT COALESCE(MAX(generation), 0) AS n
       FROM inbox_projection_facts
      WHERE session_id = ?
        AND interaction_id = ?
        AND source = ?
        AND direction = 'open'
        AND bound = 1
        AND provider_event_id = occurrence_event_id`,
  ).get(sessionId, interactionId, source) as { n: number } | undefined;
  return (row?.n ?? 0) + 1;
}

function closeExists(
  db: Db,
  sessionId: string,
  turnId: string,
  interactionId: string,
  source: 'native' | 'local',
): boolean {
  const row = db.prepare(
    `SELECT 1 AS ok
       FROM inbox_projection_facts
      WHERE session_id = ?
        AND turn_id = ?
        AND interaction_id = ?
        AND source = ?
        AND direction = 'close'`,
  ).get(sessionId, turnId, interactionId, source);
  return row !== undefined;
}

/** Same-turn close fact. A later host turn is a different occurrence. */
export function inboxOccurrenceHasClose(
  db: Db,
  sessionId: string,
  turnId: string,
  interactionId: string,
  source: 'native' | 'local' = 'native',
): boolean {
  return closeExists(db, sessionId, turnId, interactionId, source);
}

/**
 * Canonical user-pending opens whose host turn row is already terminal.
 * The turn status is the fact. This does not scan events, call the provider,
 * or close another turn. An existing close is left as it is.
 *
 * Hot path: callers that know the finished turn pass `sessionId` + `turnId`
 * and only that turn's opens are inspected. Recovery (startup, `recover()`)
 * passes only `limit`: the sweep visits just the unconverged set (terminal
 * turn, no close yet) in rowid batches, so a large terminated history is not
 * rescanned row by row on every event. Returns the number of candidate opens
 * inspected; an unscoped call that returns `limit` may have more batches.
 */
export function recordHostTerminalOpens(
  db: Db,
  scope: { sessionId?: string; turnId?: string; limit?: number } = {},
): number {
  const scoped = scope.sessionId !== undefined && scope.turnId !== undefined;
  const rows = (scoped
    ? db.prepare(
      `SELECT f.session_id AS sessionId,
              f.turn_id AS turnId,
              f.interaction_id AS interactionId,
              f.turn_number AS turnNumber,
              f.source AS source,
              t.status AS status
         FROM inbox_projection_facts f
         JOIN turns t ON t.id = f.turn_id AND t.session_id = f.session_id
        WHERE f.direction = 'open'
          AND f.bound = 1
          AND f.user_pending = 1
          AND f.provider_event_id = f.occurrence_event_id
          AND f.session_id = @sessionId
          AND f.turn_id = @turnId
          AND t.status != 'running'`,
    ).all({ sessionId: scope.sessionId, turnId: scope.turnId })
    : db.prepare(
      `SELECT f.session_id AS sessionId,
              f.turn_id AS turnId,
              f.interaction_id AS interactionId,
              f.turn_number AS turnNumber,
              f.source AS source,
              t.status AS status
         FROM inbox_projection_facts f
         JOIN turns t ON t.id = f.turn_id AND t.session_id = f.session_id
        WHERE f.direction = 'open'
          AND f.bound = 1
          AND f.user_pending = 1
          AND f.provider_event_id = f.occurrence_event_id
          AND t.status != 'running'
          AND NOT EXISTS (
            SELECT 1
              FROM inbox_projection_facts c
             WHERE c.session_id = f.session_id
               AND c.turn_id = f.turn_id
               AND c.interaction_id = f.interaction_id
               AND c.source = f.source
               AND c.direction = 'close'
          )
        ORDER BY f.rowid
        LIMIT @limit`,
    ).all({ limit: Math.max(1, Math.floor(scope.limit ?? 200)) })) as Array<{
    sessionId: string;
    turnId: string;
    interactionId: string;
    turnNumber: number | null;
    source: 'native' | 'local';
    status: string;
  }>;
  for (const row of rows) {
    if (closeExists(db, row.sessionId, row.turnId, row.interactionId, row.source)) continue;
    const outcome = row.status === 'error'
      ? 'runtime_ended'
      : row.status === 'expired'
        ? 'expired'
        : row.status === 'stopped' || row.status === 'completed'
          ? 'turn_ended'
          : null;
    if (!outcome) continue;
    recordInboxProjection(db, {
      sessionId: row.sessionId,
      providerEventId: `gian:turn-terminal:${row.turnId}:${row.interactionId}`,
      turnId: row.turnId,
      turnNumber: row.turnNumber ?? 1,
      origin: 'live',
      // The generated close shares its opening's source identity. A local
      // occurrence is closed as local; it never masquerades as a native fact
      // or collides with a same-id native occurrence on the same turn.
      source: row.source,
      // Host-synthesized: a provider event id equal to this synthetic id is a
      // different fact (writer 'provider') and is never deduplicated into it.
      writer: 'host',
      method: 'interaction.resolved',
      raw: { interactionId: row.interactionId, outcome },
      displayType: null,
      displayData: null,
      userPending: false,
      userSource: false,
    });
  }
  return rows.length;
}

function bindWaitingCloses(
  db: Db,
  sessionId: string,
  turnId: string,
  interactionId: string,
  occurrenceEventId: string,
  generation: number,
  source: 'native' | 'local',
): void {
  // A close waiting here is what fenced the opening, so the open was stored
  // already-applied and never projects a row. The close has nothing left to
  // apply — mark it now instead of parking it for a drain that has no work.
  db.prepare(
    `UPDATE inbox_projection_facts
        SET occurrence_event_id = ?,
            generation = ?,
            bound = 1,
            applied = 1
      WHERE session_id = ?
        AND turn_id = ?
        AND interaction_id = ?
        AND source = ?
        AND direction = 'close'
        AND bound = 0`,
  ).run(occurrenceEventId, generation, sessionId, turnId, interactionId, source);
}

function insertFact(
  db: Db,
  draft: InboxProjectionDraft,
  fact: {
    interactionId: string;
    direction: 'open' | 'close';
    occurrenceEventId: string;
    generation: number;
    bound: boolean;
    projected: 'question' | 'approval' | null;
    userPending: boolean;
    userSource: boolean;
    applied: boolean;
    title: string | null;
    description: string | null;
    subject: string | null;
    category: string | null;
    toolName: string | null;
    turnNumber: number | null;
    outcome: string | null;
    decision: string | null;
    actionId: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO inbox_projection_facts (
       session_id, provider_event_id, turn_id, interaction_id, direction,
       occurrence_event_id, generation, bound, origin, source, owner_generation,
       writer, projected, outcome,
       decision, action_id, title, description, subject, category, tool_name,
       turn_number, user_pending, user_source, applied
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    draft.sessionId,
    draft.providerEventId,
    draft.turnId,
    fact.interactionId,
    fact.direction,
    fact.occurrenceEventId,
    fact.generation,
    fact.bound ? 1 : 0,
    draft.origin,
    draft.source ?? 'native',
    draft.ownerGeneration ?? null,
    draft.writer ?? 'provider',
    fact.projected,
    fact.outcome,
    fact.decision,
    fact.actionId,
    fact.title,
    fact.description,
    fact.subject,
    fact.category,
    fact.toolName,
    fact.turnNumber,
    fact.userPending ? 1 : 0,
    fact.userSource ? 1 : 0,
    fact.applied ? 1 : 0,
  );
}

function toFact(row: FactRow): InboxProjectionFact {
  return {
    sessionId: row.session_id,
    providerEventId: row.provider_event_id,
    turnId: row.turn_id,
    interactionId: row.interaction_id,
    direction: row.direction,
    occurrenceEventId: row.occurrence_event_id,
    generation: row.generation,
    bound: row.bound === 1,
    origin: row.origin,
    source: row.source,
    writer: row.writer,
    projected: row.projected,
    outcome: row.outcome,
    decision: row.decision,
    actionId: row.action_id,
    title: row.title,
    description: row.description,
    subject: row.subject,
    category: row.category,
    toolName: row.tool_name,
    turnNumber: row.turn_number,
    userPending: row.user_pending === 1,
    userSource: row.user_source === 1,
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toolName(
  raw: Record<string, unknown>,
  display: Record<string, unknown> | null,
): string | null {
  const displayed = text(display?.toolName);
  if (displayed) return displayed;
  const direct = text(raw.toolName);
  if (direct) return direct;
  const context = raw.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const subject = (context as Record<string, unknown>).subject;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return null;
  return text((subject as Record<string, unknown>).toolName);
}
