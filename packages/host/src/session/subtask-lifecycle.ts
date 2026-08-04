import type { Session } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { SessionRepository } from './repository.js';

interface SubtaskLifecycleCallbacks {
  broadcastUpdated: (sessionId: string, partial: Partial<Session>) => void;
}

export class SubtaskLifecycle {
  constructor(
    private db: Db,
    private sessions: SessionRepository,
    private callbacks: SubtaskLifecycleCallbacks,
  ) {}

  complete(sessionId: string): void {
    this.requireSubtask(sessionId);
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET completed_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, sessionId);
    this.callbacks.broadcastUpdated(sessionId, { completed_at: now, updated_at: now });
  }

  reopen(sessionId: string): void {
    this.requireSubtask(sessionId);
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET completed_at = NULL, updated_at = ? WHERE id = ?')
      .run(now, sessionId);
    this.callbacks.broadcastUpdated(sessionId, { completed_at: null, updated_at: now });
  }

  abandon(sessionId: string): void {
    this.requireSubtask(sessionId);
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET completed_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, sessionId);
    this.callbacks.broadcastUpdated(sessionId, { completed_at: now, updated_at: now });
  }

  private requireSubtask(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (session.type !== 'subtask') {
      throw new Error(`session ${sessionId} is not a subtask (type=${session.type})`);
    }
    return session;
  }

}
