import type { Hono } from 'hono';
import type { SessionManager } from '../../session/manager.js';
import {
  SessionLifecycleBusyError,
  WorktreeLifecycleConflictError,
} from '../../session/lifecycle-service.js';
import {
  FALLBACK_ATTACHMENT_MIME,
  MAX_ATTACHMENT_BYTES,
  mimeForAttachment,
  readAttachment,
  writeAttachment,
} from '../../storage/attachments.js';
import type { Db } from '../../storage/db.js';
import { ensureEventPageRebuilt } from '../../events/lazy-rebuild.js';
import { markAccessed } from '../../events/lifecycle.js';
import {
  CommandExecutionError,
  GitQueueFullError,
  RepoMutationLockError,
} from '../../workspace/async-command.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeErrorStatus(error: unknown): 400 | 409 | 500 | 503 | 504 {
  if (error instanceof SessionLifecycleBusyError) return 409;
  if (error instanceof RepoMutationLockError || error instanceof GitQueueFullError) return 503;
  if (error instanceof WorktreeLifecycleConflictError) return 400;
  if (!(error instanceof CommandExecutionError)) return 500;
  if (error.timedOut) return 504;
  // A normal non-zero Git exit represents an expected merge conflict or
  // invalid branch. Spawn/abort/signal failures are infrastructure errors.
  if (error.exitCode != null && !error.aborted && error.signal == null) return 400;
  return 500;
}

function lifecycleErrorStatus(error: unknown): 400 | 409 {
  return error instanceof SessionLifecycleBusyError ? 409 : 400;
}

export function registerSessionRoutes(app: Hono, db: Db, sessions: SessionManager): void {
  app.get('/api/sessions', c => {
    const archived = c.req.query('archived');
    if (archived === 'true') return c.json(sessions.listSessions({ archivedOnly: true }));
    if (archived === 'all') return c.json(sessions.listSessions({ includeArchived: true }));
    return c.json(sessions.listSessions());
  });

  app.post('/api/sessions/:id/merge', async c => {
    try {
      await sessions.mergeWorktree(c.req.param('id'), c.req.raw.signal);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, mergeErrorStatus(error));
    }
  });

  app.post('/api/sessions/:id/drop', async c => {
    try {
      await sessions.dropWorktree(c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, lifecycleErrorStatus(error));
    }
  });

  app.post('/api/sessions/:id/attachments', async c => {
    const sessionId = c.req.param('id');
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) {
      return c.json({ error: 'session not found' }, 404);
    }
    const file = (await c.req.parseBody())['file'];
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return c.json({ error: `file too large: ${file.size} bytes` }, 413);
    }
    const mime = file.type.trim() || FALLBACK_ATTACHMENT_MIME;
    const path = await writeAttachment(
      sessionId,
      Buffer.from(await file.arrayBuffer()),
      mime,
      file.name,
    );
    return c.json({ path, name: file.name, size: file.size, mime });
  });

  app.get('/api/sessions/:id/attachments/:filename', async c => {
    const sessionId = c.req.param('id');
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) {
      return c.json({ error: 'session not found' }, 404);
    }
    const filename = c.req.param('filename');
    const bytes = await readAttachment(sessionId, filename);
    if (!bytes) return c.json({ error: 'attachment not found' }, 404);
    const mime = mimeForAttachment(filename);
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': mime,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      ...(mime === FALLBACK_ATTACHMENT_MIME
        ? { 'content-disposition': 'attachment' }
        : {}),
    });
  });

  app.post('/api/sessions/:id/archive', async c => {
    const body = await c.req.json<{ archived: boolean }>().catch(() => ({ archived: true }));
    try {
      await sessions.archiveSession(c.req.param('id'), body.archived !== false);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete('/api/sessions/:id', async c => {
    try {
      await sessions.deleteSession(c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, lifecycleErrorStatus(error));
    }
  });

  app.get('/api/sessions/:id/events', c => {
    const id = c.req.param('id');
    try {
      const beforeRaw = c.req.query('before');
      const before = beforeRaw && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : null;
      const pageSizeRaw = c.req.query('turns');
      const pageSize = pageSizeRaw && /^\d+$/.test(pageSizeRaw) ? Number(pageSizeRaw) : undefined;
      try {
        ensureEventPageRebuilt(db, id, before, pageSize, c.req.query('rebuild') === '1');
      } catch (error) {
        console.warn(`[gian] failed to rebuild events for session ${id}:`, error);
      }
      markAccessed(db, id);
      return c.json(sessions.listEventPage(id, before, pageSize));
    } catch (error) {
      return c.json({ error: String(error) }, 404);
    }
  });

  // Read-only Trace snapshot. Real-time refresh reuses the existing session
  // event stream as an invalidation signal: clients re-read this endpoint
  // when a ChatEvent or session:updated arrives for the session.
  app.get('/api/sessions/:id/trace', c => {
    try {
      return c.json(sessions.getTraceSnapshot(c.req.param('id')));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 404);
    }
  });

  app.get('/api/sessions/:id/native-config', async c => {
    try {
      return c.json(await sessions.getNativeConfig(c.req.param('id')));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get('/api/sessions/:id/slash', async c => {
    try {
      return c.json(await sessions.listSessionSlashCommands(c.req.param('id')));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  // Sidebar drag reorder (migration 067, 2026-08-29): `scope` picks the
  // order column (`workspace` = Sessions rail workspace/unfiled group,
  // `task` = Tasks rail subtask list), `parentId` the owning workspace/task
  // (null = the unfiled group). The caller passes the scope's full ordered id
  // list; values are rewritten to a dense 1..n sequence and the parent guard
  // keeps stray ids from leaking order into a scope they don't belong to.
  // `updated_at` is deliberately NOT bumped — it drives the rail's activity
  // fallback order and the row's relative-time label. No WS broadcast (the
  // web operation layer converges canonical state itself, like
  // /api/workspaces/reorder).
  app.post('/api/sessions/reorder', async c => {
    const body = await c.req.json<{
      scope?: string;
      parentId?: string | null;
      ids?: string[];
    }>();
    if ((body.scope !== 'workspace' && body.scope !== 'task') || !Array.isArray(body.ids)) {
      return c.json({ error: 'scope (workspace|task) and ids required' }, 400);
    }
    const column = body.scope === 'workspace' ? 'workspace_order' : 'task_order';
    const parentColumn = body.scope === 'workspace' ? 'workspace_id' : 'task_id';
    const update = body.parentId == null
      ? db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ? AND ${parentColumn} IS NULL`)
      : db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ? AND ${parentColumn} = ?`);
    db.transaction(() => {
      body.ids!.forEach((id, index) => {
        if (body.parentId == null) update.run(index + 1, id);
        else update.run(index + 1, id, body.parentId);
      });
    })();
    return c.json({ ok: true });
  });
}
