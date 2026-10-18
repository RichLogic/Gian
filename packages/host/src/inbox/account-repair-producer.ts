import {
  attentionSessionName,
  isExecutorId,
  isProxyPluginId,
  pluginIdForExecutorId,
} from '@gian/shared';
import { agentLoginArgs } from '../agents/home.js';
import { EventStore } from '../session/event-store.js';
import type { Db } from '../storage/db.js';

/**
 * One Inbox item per saved Agent when a persisted `state.error` carries
 * `code=RUNTIME_AUTH_REQUIRED`. `retryable` is ignored. Session status and
 * error text do not open an item. Sessions without `agent_id` are not folded
 * into the executor.
 *
 * Generation is the row in `inbox_repair_episodes`, not a count of surviving
 * events. `inbox_repair_watermarks` records the last consumed
 * `events.sequence` for each session. One live event reads that cursor and
 * does not scan older rows. Deleting a session does not rewind the generation.
 *
 * A later `state.turn-completed` closes the episode only when its status is
 * the canonical `completed`, its turn started after the fault, and both turns'
 * own `config_json` carry the same runtime binding. `startTurn` does not
 * persist `runtime_profile` on that snapshot, so a real fault stores
 * `recovery_block=CONFIG_IDENTITY_ABSENT` and no success closes it.
 * Unknown, missing, `error`, and `stopped` statuses are not success.
 * The Agent login terminal is only the `entry` target and is not started.
 * This producer does not emit an OS notification.
 */
const SUBJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LOGIN_SUMMARY = 'Sign in to this Agent from its login terminal. Gian does not run login by itself.';
const SETTINGS_SUMMARY = 'This Agent has no login command. Open its settings. Gian cannot repair the account automatically.';
const TITLE_FALLBACK = 'Account sign-in';
const BLOCK = 'CONFIG_IDENTITY_ABSENT';
const ACCOUNT_PREFIX = 'system.repair:account:';

export interface AccountRepairInboxSink {
  applySignal(input: unknown): unknown;
}

export interface AccountRepairWake {
  session_id: string;
  call_id?: string;
  display?: { type?: unknown; data?: unknown };
}

export interface AccountRepairInboxObserver {
  reconcile(): void;
  observe(event: AccountRepairWake): void;
}

interface StoredEvent {
  id: string;
  sequence: number | null;
  turn_id: string | null;
  type: string;
  data: string;
  created_at: string;
  session_id: string;
}

interface TurnRow {
  id: string;
  turn_number: number;
  created_at: string;
  config_json: string | null;
}

interface Episode {
  source_key: string;
  generation: number;
  phase: 'open' | 'closed';
  config_identity: string | null;
  recovery_block: typeof BLOCK | null;
  fault_event_id: string | null;
  fault_session_id: string | null;
  fault_turn_id: string | null;
  fault_turn_number: number | null;
  fault_turn_created_at: string | null;
  title: string;
  entry_kind: 'agent_login' | 'agent_settings';
}

interface DisplayFact {
  type: string;
  body: Record<string, unknown>;
}

export function accountRepairInboxObserver(
  db: Db,
  inbox: AccountRepairInboxSink,
): AccountRepairInboxObserver {
  const events = new EventStore(db);
  const sequenced = hasEventSequence(db);
  return {
    reconcile() {
      try {
        const seen = new Set<string>();
        const agents = db.prepare(
          `SELECT DISTINCT agent_id FROM sessions WHERE agent_id IS NOT NULL`,
        ).all() as Array<{ agent_id: string }>;
        for (const row of agents) {
          if (!SUBJECT_ID.test(row.agent_id)) continue;
          seen.add(row.agent_id);
          catchUp(db, events, inbox, row.agent_id, sequenced);
          mirrorEpisode(db, inbox, row.agent_id);
        }
        const stored = db.prepare(
          `SELECT source_key FROM inbox_repair_episodes
            WHERE source_key LIKE ?`,
        ).all(`${ACCOUNT_PREFIX}%`) as Array<{ source_key: string }>;
        for (const row of stored) {
          const agentId = row.source_key.slice(ACCOUNT_PREFIX.length);
          if (seen.has(agentId) || !SUBJECT_ID.test(agentId)) continue;
          mirrorEpisode(db, inbox, agentId);
        }
      } catch (error) {
        console.error('[inbox] account repair reconcile failed', error);
      }
    },
    observe(event) {
      if (!wakesAccountRepair(event)) return;
      if (typeof event.call_id !== 'string' || event.call_id.length === 0) return;
      try {
        const owner = db.prepare(
          'SELECT agent_id FROM sessions WHERE id = ?',
        ).get(event.session_id) as { agent_id?: unknown } | undefined;
        if (typeof owner?.agent_id !== 'string' || !SUBJECT_ID.test(owner.agent_id)) return;
        const stored = loadEvent(db, event.session_id, event.call_id, sequenced);
        if (!stored) return;
        db.transaction(() => {
          consume(db, events, inbox, owner.agent_id as string, stored);
        })();
      } catch (error) {
        console.error('[inbox] account repair observe failed', error);
      }
    },
  };
}

function catchUp(
  db: Db,
  events: EventStore,
  inbox: AccountRepairInboxSink,
  agentId: string,
  sequenced: boolean,
): void {
  if (!sequenced) return;
  let rows: StoredEvent[] = [];
  try {
    rows = db.prepare(
      `SELECT e.id, e.sequence, e.turn_id, e.type, e.data, e.created_at, e.session_id
         FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.agent_id = ?
          AND e.sequence IS NOT NULL
          AND e.sequence > COALESCE((
            SELECT w.sequence FROM inbox_repair_watermarks w
             WHERE w.source_key = ? AND w.session_id = e.session_id
          ), -1)
          AND (
            json_extract(e.data, '$.display.type') IN ('state.error', 'state.turn-completed')
            OR e.type IN ('state.error', 'state.turn-completed')
          )
        ORDER BY e.rowid`,
    ).all(agentId, sourceKey(agentId)) as StoredEvent[];
  } catch (error) {
    console.error(`[inbox] account repair catch-up failed agent=${agentId}`, error);
    return;
  }
  for (const row of rows) {
    try {
      db.transaction(() => {
        consume(db, events, inbox, agentId, row);
      })();
    } catch (error) {
      console.error(`[inbox] account repair catch-up failed agent=${agentId}`, error);
      break;
    }
  }
}

function consume(
  db: Db,
  events: EventStore,
  inbox: AccountRepairInboxSink,
  agentId: string,
  row: StoredEvent,
): void {
  const key = sourceKey(agentId);
  const seen = watermark(db, key, row.session_id);
  if (row.sequence != null && seen != null && row.sequence <= seen) return;
  const display = displayOf(events.decode(row.data), row.type);
  const episode = loadEpisode(db, key);
  if (display && isAuthFault(display)) {
    openFault(db, inbox, agentId, episode, row);
  } else if (display && episode) {
    const turnId = canonicalCompletedTurn(display, row.turn_id);
    if (turnId) closeFault(db, inbox, agentId, episode, row.session_id, turnId);
  }
  if (row.sequence == null) return;
  const floor = seen ?? -1;
  if (row.sequence > floor && !earlierCandidate(db, row.session_id, floor, row.sequence)) {
    remember(db, key, row.session_id, row.sequence);
  }
}

function earlierCandidate(db: Db, sessionId: string, after: number, before: number): boolean {
  const row = db.prepare(
    `SELECT 1 AS ok FROM events
      WHERE session_id = ?
        AND sequence > ?
        AND sequence < ?
        AND (
          json_extract(data, '$.display.type') IN ('state.error', 'state.turn-completed')
          OR type IN ('state.error', 'state.turn-completed')
        )
      LIMIT 1`,
  ).get(sessionId, after, before) as { ok: number } | undefined;
  return row != null;
}

function openFault(
  db: Db,
  inbox: AccountRepairInboxSink,
  agentId: string,
  episode: Episode | undefined,
  row: StoredEvent,
): void {
  const key = sourceKey(agentId);
  const turn = row.turn_id ? loadTurn(db, row.turn_id) : undefined;
  const snapshot = turn ? parseSnapshot(turn.config_json) : null;
  if (!episode || episode.phase === 'closed') {
    const identity = configIdentity(snapshot, agentId);
    episode = {
      source_key: key,
      generation: episode ? episode.generation + 1 : 1,
      phase: 'open',
      config_identity: identity,
      recovery_block: identity ? null : BLOCK,
      fault_event_id: row.id,
      fault_session_id: row.session_id,
      fault_turn_id: turn?.id ?? null,
      fault_turn_number: turn?.turn_number ?? null,
      fault_turn_created_at: turn?.created_at ?? null,
      title: titleFor(snapshot),
      entry_kind: entryKindFor(snapshot?.proxy),
    };
    saveEpisode(db, episode);
  }
  if (!episode) return;
  emitOpen(inbox, agentId, episode);
}

function closeFault(
  db: Db,
  inbox: AccountRepairInboxSink,
  agentId: string,
  episode: Episode,
  sessionId: string,
  turnId: string,
): void {
  if (episode.phase !== 'open' || episode.recovery_block || !episode.config_identity) return;
  const turn = loadTurn(db, turnId);
  if (!turn) return;
  const identity = configIdentity(parseSnapshot(turn.config_json), agentId);
  if (identity !== episode.config_identity) return;
  if (!startedAfter(episode, turn, sessionId)) return;
  const closed: Episode = { ...episode, phase: 'closed' };
  saveEpisode(db, closed);
  inbox.applySignal({
    kind: 'system.repair.closed',
    scope: 'account',
    subject_id: agentId,
    fault_generation: closed.generation,
    outcome: 'resolved',
    actor: 'system',
  });
}

function mirrorEpisode(db: Db, inbox: AccountRepairInboxSink, agentId: string): void {
  try {
    const episode = loadEpisode(db, sourceKey(agentId));
    if (!episode) return;
    const row = storedRepair(db, agentId);
    if (episode.phase === 'open') {
      if (row && row.status === 'pending' && row.generation < episode.generation) {
        emitClose(inbox, agentId, row.generation);
      }
      emitOpen(inbox, agentId, episode);
      return;
    }
    if (row && row.status === 'pending' && row.generation === episode.generation) {
      emitClose(inbox, agentId, episode.generation);
    }
  } catch (error) {
    console.error(`[inbox] account repair project failed agent=${agentId}`, error);
  }
}

function emitOpen(inbox: AccountRepairInboxSink, agentId: string, episode: Episode): void {
  inbox.applySignal({
    kind: 'system.repair',
    scope: 'account',
    subject_id: agentId,
    fault_generation: episode.generation,
    title: episode.title,
    summary: episode.entry_kind === 'agent_login' ? LOGIN_SUMMARY : SETTINGS_SUMMARY,
    entry: { kind: episode.entry_kind, agent_id: agentId },
  });
}

function emitClose(inbox: AccountRepairInboxSink, agentId: string, generation: number): void {
  inbox.applySignal({
    kind: 'system.repair.closed',
    scope: 'account',
    subject_id: agentId,
    fault_generation: generation,
    outcome: 'resolved',
    actor: 'system',
  });
}

function wakesAccountRepair(event: AccountRepairWake): boolean {
  const display = event.display;
  if (!display) return false;
  if (display.type === 'state.turn-completed') return true;
  if (display.type !== 'state.error') return false;
  const data = display.data;
  if (!data || typeof data !== 'object') return false;
  return (data as { code?: unknown }).code === 'RUNTIME_AUTH_REQUIRED';
}

function isAuthFault(display: DisplayFact): boolean {
  return display.type === 'state.error' && display.body.code === 'RUNTIME_AUTH_REQUIRED';
}

function canonicalCompletedTurn(display: DisplayFact, eventTurnId: string | null): string | null {
  if (display.type !== 'state.turn-completed') return null;
  if (display.body.status !== 'completed') return null;
  const turnId = display.body.turnId;
  if (typeof turnId !== 'string' || turnId.length === 0) return null;
  if (!eventTurnId || turnId !== eventTurnId) return null;
  return turnId;
}

function displayOf(data: Record<string, unknown>, typeColumn: string): DisplayFact | null {
  const nested = data.display;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as { type?: unknown; data?: unknown };
    if (typeof record.type !== 'string') return null;
    const body = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : {};
    return { type: record.type, body };
  }
  if (typeColumn !== 'state.error' && typeColumn !== 'state.turn-completed') return null;
  return { type: typeColumn, body: data };
}

function configIdentity(snapshot: Record<string, unknown> | null, subjectId: string): string | null {
  if (!snapshot || snapshot.agent_id !== subjectId) return null;
  const proxy = snapshot.proxy;
  if (typeof proxy !== 'string' || proxy.length === 0 || proxy.length > 128) return null;
  const profile = snapshot.runtime_profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const runtime = profile as { id?: unknown; configHome?: unknown };
  if (typeof runtime.id !== 'string' || runtime.id.length === 0 || runtime.id.length > 128) return null;
  if (runtime.id.includes('\0')) return null;
  if (runtime.configHome != null && typeof runtime.configHome !== 'string') return null;
  const configHome = typeof runtime.configHome === 'string' ? runtime.configHome : null;
  return JSON.stringify({
    agent_id: subjectId,
    proxy,
    runtime_id: runtime.id,
    config_home: configHome,
  });
}

function startedAfter(episode: Episode, turn: TurnRow, sessionId: string): boolean {
  if (!episode.fault_turn_id || episode.fault_turn_number == null || !episode.fault_turn_created_at) {
    return false;
  }
  if (turn.id === episode.fault_turn_id) return false;
  if (sessionId === episode.fault_session_id) return turn.turn_number > episode.fault_turn_number;
  return turn.created_at > episode.fault_turn_created_at;
}

function entryKindFor(proxy: unknown): 'agent_login' | 'agent_settings' {
  if (typeof proxy !== 'string') return 'agent_settings';
  const pluginId = isExecutorId(proxy)
    ? pluginIdForExecutorId(proxy)
    : isProxyPluginId(proxy) ? proxy : null;
  if (!pluginId || !agentLoginArgs(pluginId)) return 'agent_settings';
  return 'agent_login';
}

function titleFor(snapshot: Record<string, unknown> | null): string {
  const name = snapshot ? attentionSessionName(snapshot.agent_name) : '';
  return name || TITLE_FALLBACK;
}

function parseSnapshot(encoded: string | null): Record<string, unknown> | null {
  if (!encoded) return null;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadEvent(db: Db, sessionId: string, callId: string, sequenced: boolean): StoredEvent | undefined {
  const sql = sequenced
    ? `SELECT id, sequence, turn_id, type, data, created_at, session_id
         FROM events
        WHERE session_id = ? AND call_id = ?
        ORDER BY sequence DESC
        LIMIT 1`
    : `SELECT id, NULL AS sequence, turn_id, type, data, created_at, session_id
         FROM events
        WHERE session_id = ? AND call_id = ?
        ORDER BY rowid DESC
        LIMIT 1`;
  return db.prepare(sql).get(sessionId, callId) as StoredEvent | undefined;
}

function loadTurn(db: Db, turnId: string): TurnRow | undefined {
  return db.prepare(
    `SELECT id, turn_number, created_at, config_json
       FROM turns WHERE id = ?`,
  ).get(turnId) as TurnRow | undefined;
}

function loadEpisode(db: Db, key: string): Episode | undefined {
  return db.prepare(
    `SELECT source_key, generation, phase, config_identity, recovery_block,
            fault_event_id, fault_session_id, fault_turn_id, fault_turn_number,
            fault_turn_created_at, title, entry_kind
       FROM inbox_repair_episodes WHERE source_key = ?`,
  ).get(key) as Episode | undefined;
}

function saveEpisode(db: Db, episode: Episode): void {
  db.prepare(
    `INSERT INTO inbox_repair_episodes (
       source_key, generation, phase, config_identity, recovery_block,
       fault_event_id, fault_session_id, fault_turn_id, fault_turn_number,
       fault_turn_created_at, title, entry_kind, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       generation = excluded.generation,
       phase = excluded.phase,
       config_identity = excluded.config_identity,
       recovery_block = excluded.recovery_block,
       fault_event_id = excluded.fault_event_id,
       fault_session_id = excluded.fault_session_id,
       fault_turn_id = excluded.fault_turn_id,
       fault_turn_number = excluded.fault_turn_number,
       fault_turn_created_at = excluded.fault_turn_created_at,
       title = excluded.title,
       entry_kind = excluded.entry_kind,
       updated_at = excluded.updated_at`,
  ).run(
    episode.source_key,
    episode.generation,
    episode.phase,
    episode.config_identity,
    episode.recovery_block,
    episode.fault_event_id,
    episode.fault_session_id,
    episode.fault_turn_id,
    episode.fault_turn_number,
    episode.fault_turn_created_at,
    episode.title,
    episode.entry_kind,
    new Date().toISOString(),
  );
}

function watermark(db: Db, key: string, sessionId: string): number | null {
  const row = db.prepare(
    `SELECT sequence FROM inbox_repair_watermarks
      WHERE source_key = ? AND session_id = ?`,
  ).get(key, sessionId) as { sequence: number } | undefined;
  return row?.sequence ?? null;
}

function remember(db: Db, key: string, sessionId: string, sequence: number): void {
  db.prepare(
    `INSERT INTO inbox_repair_watermarks (source_key, session_id, sequence)
     VALUES (?, ?, ?)
     ON CONFLICT(source_key, session_id) DO UPDATE SET
       sequence = excluded.sequence
     WHERE excluded.sequence > inbox_repair_watermarks.sequence`,
  ).run(key, sessionId, sequence);
}

function storedRepair(db: Db, agentId: string): { status: string; generation: number } | undefined {
  return db.prepare(
    `SELECT status, generation FROM inbox_items WHERE source_key = ?`,
  ).get(sourceKey(agentId)) as { status: string; generation: number } | undefined;
}

function sourceKey(agentId: string): string {
  return `${ACCOUNT_PREFIX}${agentId}`;
}

function hasEventSequence(db: Db): boolean {
  const columns = db.prepare(`PRAGMA table_info('events')`).all() as Array<{ name: string }>;
  return columns.some(column => column.name === 'sequence');
}
