import type { Db } from '../storage/db.js';
import type { SessionHistoryStore } from './history-store.js';

export interface ActiveTurn {
  id: string;
  number: number;
}

export class TurnRuntime {
  private active = new Map<string, ActiveTurn>();

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

  start(sessionId: string, turnId: string, createdAt: string): ActiveTurn {
    const turn = {
      id: turnId,
      number: this.history.nextTurnNumber(sessionId),
    };
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, turn_number, status, created_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(turn.id, sessionId, turn.number, createdAt);
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
    return turn;
  }

  rollbackStart(sessionId: string, turnId: string): void {
    this.db.prepare('DELETE FROM events WHERE turn_id = ?').run(turnId);
    this.db.prepare('DELETE FROM turns WHERE id = ?').run(turnId);
    this.active.delete(sessionId);
  }

  stopOrphaned(sessionId: string, completedAt: string): void {
    this.db
      .prepare(
        `UPDATE turns
         SET status = 'stopped', completed_at = ?
         WHERE session_id = ? AND status = 'running'`,
      )
      .run(completedAt, sessionId);
  }

  forget(sessionId: string): void {
    this.active.delete(sessionId);
  }
}
