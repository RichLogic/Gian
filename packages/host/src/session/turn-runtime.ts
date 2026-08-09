import type { Db } from '../storage/db.js';
import type { SessionHistoryStore } from './history-store.js';

export interface ActiveTurn {
  id: string;
  number: number;
  providerTurnId?: string;
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

  start(sessionId: string, turnId: string, createdAt: string): ActiveTurn {
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
          `INSERT INTO turns (id, session_id, turn_number, status, created_at)
           VALUES (?, ?, ?, 'running', ?)`,
        )
        .run(next.id, sessionId, next.number, createdAt);
      return next;
    })();
    this.active.set(sessionId, turn);
    return turn;
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
