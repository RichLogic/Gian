import type { Db } from '../storage/db.js';
import type { SessionHistoryStore } from './history-store.js';

export interface ActiveTurn {
  id: string;
  number: number;
  providerTurnId?: string;
  configSnapshot?: Record<string, unknown>;
}

export class TurnRuntime {
  private active = new Map<string, ActiveTurn>();
  private settledProviderTurns = new Map<string, string[]>();
  private stopIntents = new Map<string, string>();

  constructor(
    private db: Db,
    private history: SessionHistoryStore,
  ) {}

  has(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /**
   * Re-register a persisted `running` Turn as the session's single active
   * generation after a Host restart. The canonical turns + proxy_replay_turns
   * rows are the authority: if no generation is active in memory and exactly
   * one running Turn exists, it becomes active again so provider
   * terminal/replay notifications settle it instead of being dropped. Never
   * creates or mutates rows; a no-op when anything is already active or the
   * evidence is ambiguous.
   */
  restoreActiveGenerationFromDb(sessionId: string, expectedTurnId: string): ActiveTurn | null {
    const current = this.active.get(sessionId);
    if (current) return current.id === expectedTurnId ? current : null;
    const rows = this.db.prepare(
      `SELECT t.id AS id, t.turn_number AS number,
              r.provider_turn_id AS providerTurnId, r.replay_owned AS replayOwned
         FROM turns t
         LEFT JOIN proxy_replay_turns r
           ON r.turn_id = t.id AND r.session_id = t.session_id
        WHERE t.session_id = ? AND t.status = 'running'
        ORDER BY t.turn_number DESC
        LIMIT 2`,
    ).all(sessionId) as Array<{
      id: string;
      number: number;
      providerTurnId: string | null;
      replayOwned: number | null;
    }>;
    // Zero rows: nothing to restore. More than one: ambiguous crash state —
    // leave it to the scheduler's fail-closed path instead of guessing. The
    // sole row must also be the Schedule Run's exact accepted Turn.
    if (rows.length !== 1 || rows[0]!.id !== expectedTurnId) return null;
    const row = rows[0]!;
    // sendMessage reserves provider_turn_id=hostTurnId before a protocol-v2
    // Provider exposes its real sourceTurnId. Do not restore that provisional
    // identity: the first post-restart Provider event must be allowed to bind
    // and replace it in proxy_replay_turns.
    const providerTurnId = row.providerTurnId
      && !(row.replayOwned === 0 && row.providerTurnId === row.id)
      ? row.providerTurnId
      : undefined;
    const restored: ActiveTurn = {
      id: row.id,
      number: row.number,
      ...(providerTurnId ? { providerTurnId } : {}),
    };
    this.active.set(sessionId, restored);
    return restored;
  }

  clearRestoredGeneration(sessionId: string, turnId: string): void {
    if (this.active.get(sessionId)?.id !== turnId) return;
    this.active.delete(sessionId);
    this.stopIntents.delete(sessionId);
  }

  get(sessionId: string): ActiveTurn | undefined {
    return this.active.get(sessionId);
  }

  requestStop(sessionId: string): ActiveTurn | null {
    const turn = this.active.get(sessionId);
    if (!turn) return null;
    this.stopIntents.set(sessionId, turn.id);
    return turn;
  }

  cancelStop(sessionId: string, hostTurnId: string): void {
    if (this.stopIntents.get(sessionId) === hostTurnId) {
      this.stopIntents.delete(sessionId);
    }
  }

  isStopRequested(sessionId: string, hostTurnId?: string): boolean {
    const intent = this.stopIntents.get(sessionId);
    return intent !== undefined && (hostTurnId === undefined || intent === hostTurnId);
  }

  /**
   * Bind a provider-native turn id to the current host turn. Notifications
   * use the guarded path; the successful startTurn response is authoritative.
   */
  bindProviderTurn(
    sessionId: string,
    hostTurnId: string,
    providerTurnId: string,
    authoritative = false,
  ): boolean {
    const turn = this.active.get(sessionId);
    if (!turn || turn.id !== hostTurnId) return false;
    const settled = this.settledProviderTurns.get(sessionId) ?? [];
    if (!authoritative && settled.includes(providerTurnId)) return false;
    if (!authoritative && turn.providerTurnId && turn.providerTurnId !== providerTurnId) {
      return false;
    }
    turn.providerTurnId = providerTurnId;
    if (authoritative && settled.includes(providerTurnId)) {
      this.settledProviderTurns.set(
        sessionId,
        settled.filter(id => id !== providerTurnId),
      );
    }
    return true;
  }

  start(
    sessionId: string,
    turnId: string,
    createdAt: string,
    options: { toolRequestId?: string } = {},
  ): ActiveTurn {
    if (this.active.has(sessionId)) {
      throw new Error(`turn already in flight for session ${sessionId}; enqueue instead`);
    }
    const turn = this.db.transaction(() => {
      const persistedRunning = this.db
        .prepare(
          `SELECT 1
           FROM turns
           WHERE session_id = ? AND status = 'running'
           LIMIT 1`,
        )
        .get(sessionId);
      if (persistedRunning) {
        throw new Error(`turn already in flight for session ${sessionId}; enqueue instead`);
      }
      const next = {
        id: turnId,
        number: this.history.nextTurnNumber(sessionId),
      };
      this.db
        .prepare(
          `INSERT INTO turns
            (id, session_id, turn_number, status, created_at, tool_request_id)
           VALUES (?, ?, ?, 'running', ?, ?)`,
        )
        .run(next.id, sessionId, next.number, createdAt, options.toolRequestId ?? null);
      return next;
    })();
    this.active.set(sessionId, turn);
    return turn;
  }

  setConfig(sessionId: string, turnId: string, snapshot: Record<string, unknown>): void {
    const turn = this.active.get(sessionId);
    if (!turn || turn.id !== turnId) throw new Error(`turn is not active: ${turnId}`);
    turn.configSnapshot = snapshot;
    this.db.prepare('UPDATE turns SET config_json = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), turnId);
  }

  finish(
    sessionId: string,
    status: 'completed' | 'error' | 'stopped',
    completedAt: string,
  ): ActiveTurn | null {
    const turn = this.active.get(sessionId);
    if (!turn) return null;
    this.db
      .prepare(`UPDATE turns SET status = ?, completed_at = ? WHERE id = ?`)
      .run(status, completedAt, turn.id);
    this.db.prepare(
      `UPDATE tool_deliveries SET state = ?, updated_at = ? WHERE turn_id = ?`,
    ).run(status, completedAt, turn.id);
    this.active.delete(sessionId);
    this.stopIntents.delete(sessionId);
    if (turn.providerTurnId) {
      const settled = this.settledProviderTurns.get(sessionId) ?? [];
      settled.push(turn.providerTurnId);
      this.settledProviderTurns.set(sessionId, settled.slice(-16));
    }
    return turn;
  }

  rollbackStart(sessionId: string, turnId: string): void {
    this.db.prepare('DELETE FROM events WHERE turn_id = ?').run(turnId);
    this.db.prepare('DELETE FROM turns WHERE id = ?').run(turnId);
    this.active.delete(sessionId);
    this.stopIntents.delete(sessionId);
  }

  stopOrphaned(sessionId: string, completedAt: string): ActiveTurn[] {
    return this.db.transaction(() => {
      const orphaned = this.db
        .prepare(
          `SELECT id, turn_number AS number
           FROM turns
           WHERE session_id = ? AND status = 'running'
           ORDER BY turn_number`,
        )
        .all(sessionId) as ActiveTurn[];
      if (orphaned.length > 0) {
        this.db
          .prepare(
            `UPDATE turns
             SET status = 'stopped', completed_at = ?
             WHERE session_id = ? AND status = 'running'`,
          )
          .run(completedAt, sessionId);
      }
      return orphaned;
    })();
  }

  forget(sessionId: string): void {
    this.active.delete(sessionId);
    this.settledProviderTurns.delete(sessionId);
    this.stopIntents.delete(sessionId);
  }
}
