import { requestViolation, validateBindingConfig } from '@gian/proxy-protocol';
import type { ConfigOption, ConfigValue } from '@gian/shared';
import type { Db } from '../storage/db.js';
import { sanitizeTitle } from './auto-title.js';

export type ForkAnchorInput =
  | { type: 'head' }
  | { type: 'turn'; turnId: string; sourceTurnId: string };

export interface ResolvedForkAnchor {
  turnId: string;
  sourceTurnId: string;
}

export interface PersistedForkBoundary extends ResolvedForkAnchor {}

interface ForkNameSource {
  id: string;
  name?: string | null;
}

interface TerminalTurnRow {
  turnId: string;
  sourceTurnId: string | null;
  status: string;
}

export function persistedForkBoundaries(db: Db, sessionId: string): PersistedForkBoundary[] {
  return db.prepare(
    `SELECT turnId, sourceTurnId
     FROM (
       SELECT turns.id AS turnId,
              replay.provider_turn_id AS sourceTurnId,
              turns.turn_number AS turnNumber
       FROM turns
       JOIN proxy_replay_turns replay
         ON replay.turn_id = turns.id AND replay.session_id = turns.session_id
       WHERE turns.session_id = ?
         AND turns.status IN ('completed', 'error', 'stopped')
         AND replay.provider_turn_id IS NOT NULL
       ORDER BY turns.turn_number DESC
       LIMIT 10000
     )
     ORDER BY turnNumber ASC`,
  ).all(sessionId) as PersistedForkBoundary[];
}

export function nextForkSessionName(db: Db, source: ForkNameSource): string {
  const row = db.prepare(
    `SELECT COUNT(*) AS count
     FROM sessions
     WHERE origin_kind = 'fork' AND origin_session_id = ?`,
  ).get(source.id) as { count: number };
  const ordinal = row.count + 1;
  const sourceLabel = sanitizeTitle(source.name ?? '') || source.id.slice(0, 8);
  return sanitizeTitle(`Fork ${ordinal}: ${sourceLabel}`);
}

export function inheritedSessionBoundConfig(
  options: readonly ConfigOption[],
  values: Record<string, ConfigValue>,
): Record<string, ConfigValue> {
  const advertised = new Map(options.map((option) => [option.id, option]));
  const inherited: Record<string, ConfigValue> = {};
  for (const [optionId, value] of Object.entries(values)) {
    const option = advertised.get(optionId);
    if (option && option.binding !== 'session') {
      throw requestViolation(
        'CONFIG_BINDING_INVALID',
        `Config option ${optionId} is ${option.binding}-bound.`,
      );
    }
    inherited[optionId] = value;
  }
  return inherited;
}

export function assertInheritedSessionConfig(
  options: readonly ConfigOption[],
  values: Record<string, ConfigValue>,
): Record<string, ConfigValue> {
  const inherited = inheritedSessionBoundConfig(options, values);
  validateBindingConfig(options, inherited, 'session');
  return inherited;
}

export function resolveForkAnchor(
  db: Db,
  sessionId: string,
  anchor: ForkAnchorInput,
): ResolvedForkAnchor {
  if (anchor.type === 'head') {
    const row = latestTerminalTurn(db, sessionId);
    if (!row || !row.sourceTurnId) {
      throw requestViolation(
        'FORK_BOUNDARY_UNAVAILABLE',
        'session.fork head requires a terminal Turn.',
      );
    }
    return { turnId: row.turnId, sourceTurnId: row.sourceTurnId };
  }

  const row = db.prepare(
    `SELECT turns.id AS turnId, replay.provider_turn_id AS sourceTurnId, turns.status AS status
     FROM turns
     LEFT JOIN proxy_replay_turns replay
       ON replay.turn_id = turns.id AND replay.session_id = turns.session_id
     WHERE turns.session_id = ? AND turns.id = ?`,
  ).get(sessionId, anchor.turnId) as TerminalTurnRow | undefined;

  if (
    !row
    || row.sourceTurnId !== anchor.sourceTurnId
    || !isTerminalStatus(row.status)
  ) {
    throw requestViolation(
      'FORK_BOUNDARY_UNAVAILABLE',
      'session.fork.atTurn requires the exact terminal Turn.',
    );
  }
  return { turnId: row.turnId, sourceTurnId: row.sourceTurnId };
}

function latestTerminalTurn(db: Db, sessionId: string): TerminalTurnRow | undefined {
  return db.prepare(
    `SELECT turns.id AS turnId, replay.provider_turn_id AS sourceTurnId, turns.status AS status
     FROM turns
     LEFT JOIN proxy_replay_turns replay
       ON replay.turn_id = turns.id AND replay.session_id = turns.session_id
     WHERE turns.session_id = ?
       AND turns.status IN ('completed', 'error', 'stopped')
     ORDER BY turns.turn_number DESC
     LIMIT 1`,
  ).get(sessionId) as TerminalTurnRow | undefined;
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'error' || status === 'stopped';
}
