import type { ApprovalMode, Executor, NativeSession } from '@gian/shared';
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { replayNativeJsonl } from '../../native/replay.js';
import { clearNativeSessionsCache, scanNativeSessions } from '../../native/scanner.js';
import type { SessionManager } from '../../session/manager.js';
import type { Db } from '../../storage/db.js';
import type { WsBroadcaster } from '../ws-broadcast.js';

interface NativeSessionRouteDependencies {
  db: Db;
  sessions: SessionManager;
  broadcaster: WsBroadcaster;
}

export function registerNativeSessionRoutes(
  app: Hono,
  { db, sessions, broadcaster }: NativeSessionRouteDependencies,
): void {
  app.post('/api/workspaces/:id/native-sessions/adopt', async c => {
    const workspace = db.prepare('SELECT id, path FROM workspaces WHERE id = ?')
      .get(c.req.param('id')) as { id: string; path: string } | undefined;
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);

    const body = await c.req.json<{
      executor?: Executor;
      native_session_id?: string;
      name?: string;
      approval_mode?: ApprovalMode;
    }>();
    const executor = body.executor;
    const nativeId = body.native_session_id;
    if (executor !== 'claude' && executor !== 'codex' && executor !== 'kimi') {
      return c.json({ error: 'executor must be claude, codex, or kimi' }, 400);
    }
    if (!nativeId) return c.json({ error: 'native_session_id required' }, 400);

    const existing = db.prepare(
      `SELECT id, name FROM sessions
       WHERE executor = ? AND native_session_id = ?`,
    ).get(executor, nativeId) as { id: string; name: string | null } | undefined;
    if (existing) {
      return c.json({
        error: `Already adopted as session ${existing.name ?? existing.id}`,
        gian_session_id: existing.id,
      }, 409);
    }

    if (executor === 'kimi') {
      if (body.approval_mode !== undefined) {
        return c.json({
          error: 'Kimi uses executor-native mode; approval_mode must be omitted',
        }, 400);
      }
      try {
        return c.json(await sessions.adoptKimiNativeSession({
          workspaceId: workspace.id,
          cwd: workspace.path,
          nativeSessionId: nativeId,
          ...(body.name ? { name: body.name } : {}),
        }));
      } catch (error) {
        const value = error as { code?: unknown; sessionId?: unknown; message?: unknown };
        const message = typeof value.message === 'string' ? value.message : String(error);
        if (value.code === 'SESSION_ALREADY_EXISTS') {
          return c.json({
            error: message,
            ...(typeof value.sessionId === 'string' ? { gian_session_id: value.sessionId } : {}),
          }, 409);
        }
        return c.json({ error: message }, value.code === 'AUTH_REQUIRED' ? 401 : 400);
      }
    }

    const candidates = await scanNativeSessions(workspace.path);
    const native = candidates.find(session => session.executor === executor && session.id === nativeId);
    if (!native) return c.json({ error: 'native session not found in this workspace' }, 404);

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const approvalMode = body.approval_mode ?? 'ask';
    if ((approvalMode === 'custom' || approvalMode === 'full-access') && executor !== 'codex') {
      return c.json({ error: `${approvalMode} approval mode is codex-only` }, 400);
    }
    const sessionName = body.name?.trim() || `adopted ${nativeId.slice(0, 8)}`;

    db.prepare(
      `INSERT INTO sessions
        (id, name, type, workspace_id, executor, model, approval_mode,
         active_channel, status, archived,
         worktree_path, branch, base_branch, worktree_outcome,
         native_session_id,
         created_at, updated_at)
       VALUES
        (?, ?, 'coding', ?, ?, NULL, ?,
         'web', 'new', 0,
         NULL, NULL, NULL, NULL,
         ?,
         ?, ?)`,
    ).run(sessionId, sessionName, workspace.id, executor, approvalMode, nativeId, now, now);

    const replay = replayNativeJsonl(db, sessionId, native.filePath, executor);
    clearNativeSessionsCache();
    const session = sessions.getSession(sessionId);
    broadcaster.broadcast({ type: 'session:created', session, origin: 'native-adopt' });
    return c.json({ session, replay });
  });

  app.delete('/api/workspaces/:id/native-sessions/:nativeId', async c => {
    const nativeId = c.req.param('nativeId');
    const executor = c.req.query('executor') as Executor | undefined;
    if (executor !== 'claude' && executor !== 'codex' && executor !== 'kimi') {
      return c.json({ error: 'executor query param must be claude, codex, or kimi' }, 400);
    }
    if (executor === 'kimi') {
      return c.json({
        error: 'Kimi ACP does not expose destructive native-session deletion.',
      }, 400);
    }
    const workspace = db.prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(c.req.param('id')) as { path: string } | undefined;
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);

    const adopted = db.prepare(
      `SELECT id, name FROM sessions
       WHERE executor = ? AND native_session_id = ?`,
    ).get(executor, nativeId) as { id: string; name: string | null } | undefined;
    if (adopted) {
      return c.json({
        error: `Native session is currently adopted as ${adopted.name ?? adopted.id}. Delete the Gian session first.`,
        gian_session_id: adopted.id,
      }, 409);
    }

    const candidates = await scanNativeSessions(workspace.path);
    const target = candidates.find(session => session.executor === executor && session.id === nativeId);
    if (!target) return c.json({ error: 'native session not found in this workspace' }, 404);
    try {
      await unlink(target.filePath);
    } catch (error) {
      return c.json({ error: `Failed to delete: ${String(error)}` }, 500);
    }
    clearNativeSessionsCache();
    return c.json({ ok: true });
  });

  app.get('/api/workspaces/:id/native-sessions', async c => {
    const id = c.req.param('id');
    const workspace = db.prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(id) as { path: string } | undefined;
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);

    const diskSessions = await scanNativeSessions(workspace.path);
    let kimiSessions: NativeSession[] = [];
    try {
      kimiSessions = await sessions.listKimiNativeSessions(workspace.path);
    } catch (error) {
      console.warn(`[native-sessions] Kimi discovery unavailable: ${String(error)}`);
    }
    const adoptedRows = db.prepare(
      `SELECT id AS gianSessionId, name AS gianSessionName, executor, native_session_id
         FROM sessions
        WHERE workspace_id = ? AND native_session_id IS NOT NULL`,
    ).all(id) as Array<{
      gianSessionId: string;
      gianSessionName: string | null;
      executor: Executor;
      native_session_id: string;
    }>;
    const adopted = new Map(adoptedRows.map(row => [
      `${row.executor}:${row.native_session_id}`,
      { gianSessionId: row.gianSessionId, gianSessionName: row.gianSessionName },
    ]));

    return c.json({
      sessions: [...diskSessions, ...kimiSessions].map(session => {
        const binding = adopted.get(`${session.executor}:${session.id}`);
        return binding ? { ...session, adoptedBy: binding } : session;
      }),
    });
  });
}
