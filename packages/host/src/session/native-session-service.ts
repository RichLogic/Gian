import { randomUUID } from 'node:crypto';
import type { NativeSession, Session } from '@gian/shared';
import type { ProxyManager } from '../proxy/manager.js';
import type { Db } from '../storage/db.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import type { ProxySessionCoordinator } from './proxy-session-coordinator.js';
import { executorConfigFromOptions, type SessionRepository } from './repository.js';

interface NativeSessionCallbacks {
  persistKimiReplay: (
    sessionId: string,
    updates: unknown[],
    timestamp: string,
  ) => { turns: number; events: number };
}

export class NativeSessionService {
  constructor(
    private db: Db,
    private proxy: ProxyManager,
    private proxySessions: ProxySessionCoordinator,
    private sessions: SessionRepository,
    private broadcaster: WsBroadcaster,
    private callbacks: NativeSessionCallbacks,
  ) {}

  async listKimi(cwd: string): Promise<NativeSession[]> {
    const cacheKey = '__native_sessions_kimi__';
    const client = await this.proxy.getOrCreate(cacheKey, 'kimi');
    try {
      await client.initialize();
      if (!client.listNativeSessions) return [];
      const rows: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const result = await client.listNativeSessions({
          cwd,
          ...(cursor ? { cursor } : {}),
        });
        if (!result || typeof result !== 'object') break;
        const page = result as { sessions?: unknown; nextCursor?: unknown };
        if (Array.isArray(page.sessions)) rows.push(...page.sessions);
        const nextCursor = typeof page.nextCursor === 'string' && page.nextCursor
          ? page.nextCursor
          : undefined;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return rows.flatMap(row => {
        if (!row || typeof row !== 'object') return [];
        const item = row as Record<string, unknown>;
        if (typeof item.sessionId !== 'string' || !item.sessionId) return [];
        const title = typeof item.title === 'string' ? item.title : '';
        return [{
          id: item.sessionId,
          executor: 'kimi' as const,
          filePath: '',
          cwd: typeof item.cwd === 'string' ? item.cwd : cwd,
          updatedAt: typeof item.updatedAt === 'string'
            ? item.updatedAt
            : new Date(0).toISOString(),
          fileSize: 0,
          turnCount: 0,
          firstUserMessage: title,
        }];
      });
    } catch (error) {
      await this.proxy.dispose(cacheKey).catch(() => undefined);
      throw error;
    }
  }

  async adoptKimi(input: {
    workspaceId: string;
    cwd: string;
    nativeSessionId: string;
    name?: string;
  }): Promise<{ session: Session; replay: { turns: number; events: number } }> {
    const duplicate = this.db
      .prepare("SELECT id FROM sessions WHERE executor = 'kimi' AND native_session_id = ?")
      .get(input.nativeSessionId) as { id: string } | undefined;
    if (duplicate) {
      throw Object.assign(
        new Error(`Kimi session is already adopted as ${duplicate.id}`),
        { code: 'SESSION_ALREADY_EXISTS', sessionId: duplicate.id },
      );
    }

    const sessionId = randomUUID();
    let broughtUp: Awaited<ReturnType<ProxySessionCoordinator['bringUp']>>;
    try {
      broughtUp = await this.proxySessions.bringUp({
        sessionId,
        executor: 'kimi',
        cwd: input.cwd,
        model: null,
        nativeSessionId: input.nativeSessionId,
        resumeMode: 'load',
      });
    } catch (error) {
      await this.proxy.dispose(sessionId).catch(() => undefined);
      this.proxySessions.forget(sessionId);
      throw error;
    }

    const now = new Date().toISOString();
    const name = input.name?.trim() || `adopted ${input.nativeSessionId.slice(0, 8)}`;
    let replay = { turns: 0, events: 0 };
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO sessions
              (id, name, type, workspace_id, executor, model, approval_mode,
               executor_config_json, active_channel, status, archived,
               worktree_path, branch, base_branch, worktree_outcome,
               native_session_id, created_at, updated_at)
             VALUES
              (?, ?, 'coding', ?, 'kimi', NULL, NULL, ?, 'web', 'new', 0,
               NULL, NULL, NULL, NULL, ?, ?, ?)`,
          )
          .run(
            sessionId,
            name,
            input.workspaceId,
            JSON.stringify(executorConfigFromOptions(broughtUp.configOptions)),
            input.nativeSessionId,
            now,
            now,
          );
        replay = this.callbacks.persistKimiReplay(sessionId, broughtUp.replayUpdates, now);
      })();
    } catch (error) {
      await this.proxy.dispose(sessionId).catch(() => undefined);
      this.proxySessions.forget(sessionId);
      this.sessions.forget(sessionId);
      throw error;
    }

    const session = this.sessions.get(sessionId);
    this.broadcaster.broadcast({ type: 'session:created', session });
    return { session, replay };
  }
}
