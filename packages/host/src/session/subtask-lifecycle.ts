import type { Session } from '@gian/shared';
import type { Db } from '../storage/db.js';
import {
  applyAbandonWriteback,
  summarizeCompletedSubtask,
} from '../task/summarizer.js';
import type {
  SubtaskContext,
  SummaryLlm,
} from '../task/summarizer.js';
import type { SessionHistoryStore } from './history-store.js';
import type { SessionRepository } from './repository.js';

interface SubtaskLifecycleCallbacks {
  broadcastUpdated: (sessionId: string, partial: Partial<Session>) => void;
}

export class SubtaskLifecycle {
  private summaryLlm: SummaryLlm | null = null;

  constructor(
    private db: Db,
    private sessions: SessionRepository,
    private history: SessionHistoryStore,
    private callbacks: SubtaskLifecycleCallbacks,
  ) {}

  setSummaryLlm(llm: SummaryLlm | null): void {
    this.summaryLlm = llm;
  }

  complete(sessionId: string): void {
    const session = this.requireSubtask(sessionId);
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET completed_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, sessionId);
    this.callbacks.broadcastUpdated(sessionId, { completed_at: now, updated_at: now });
    this.runWriteback(session, 'done', null, now);
  }

  reopen(sessionId: string): void {
    this.requireSubtask(sessionId);
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET completed_at = NULL, updated_at = ? WHERE id = ?')
      .run(now, sessionId);
    this.callbacks.broadcastUpdated(sessionId, { completed_at: null, updated_at: now });
  }

  abandon(sessionId: string, reason?: string | null): void {
    const session = this.requireSubtask(sessionId);
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET completed_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, sessionId);
    this.callbacks.broadcastUpdated(sessionId, { completed_at: now, updated_at: now });
    this.runWriteback(session, 'abandoned', reason ?? null, now);
  }

  private requireSubtask(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (session.type !== 'subtask') {
      throw new Error(`session ${sessionId} is not a subtask (type=${session.type})`);
    }
    return session;
  }

  private workspacePath(workspaceId: string): string | null {
    const workspace = this.db
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(workspaceId) as { path: string } | undefined;
    return workspace?.path ?? null;
  }

  private runWriteback(
    session: Session,
    status: 'done' | 'abandoned',
    reason: string | null,
    token: string,
  ): void {
    const workspaceDir = this.workspacePath(session.workspace_id);
    const subtask: SubtaskContext = {
      id: session.id,
      name: session.name,
      status,
      transcript: status === 'done' ? this.history.assistantTranscript(session.id) : undefined,
    };

    const stillCurrent = () => {
      const current = (this.db
        .prepare('SELECT completed_at FROM sessions WHERE id = ?')
        .get(session.id) as { completed_at: string | null } | undefined)?.completed_at ?? null;
      return current === token;
    };

    void Promise.resolve().then(async () => {
      try {
        if (!workspaceDir) {
          console.error(`[summarizer] workspace gone for subtask ${session.id}; skipping writeback`);
          return;
        }
        if (!stillCurrent()) return;
        if (status === 'abandoned') {
          applyAbandonWriteback(workspaceDir, subtask, reason);
          return;
        }
        const result = await summarizeCompletedSubtask({
          workspaceDir,
          subtask,
          llm: this.summaryLlm,
        });
        if (!stillCurrent()) return;
        const now = new Date().toISOString();
        this.db
          .prepare('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?')
          .run(result.summary, now, session.id);
        this.callbacks.broadcastUpdated(session.id, { summary: result.summary, updated_at: now });
      } catch (error) {
        console.error(`[summarizer] writeback failed for subtask ${session.id}:`, error);
      }
    });
  }
}
