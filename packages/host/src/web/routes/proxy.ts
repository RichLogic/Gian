import type { Hono } from 'hono';
import type { SessionManager } from '../../session/manager.js';
import type { Db } from '../../storage/db.js';

export function registerProxyRoutes(app: Hono, db: Db, sessions: SessionManager): void {
  app.get('/api/proxy/:executor/capabilities', async c => {
    const executor = c.req.param('executor');
    if (executor !== 'codex' && executor !== 'claude' && executor !== 'kimi' && executor !== 'grok') {
      return c.json({ error: 'unknown executor' }, 400);
    }
    try {
      return c.json(await sessions.warmCapabilities(executor));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get('/api/proxy/:executor/models', async c => {
    const executor = c.req.param('executor');
    if (executor !== 'codex' && executor !== 'claude') {
      return c.json({ error: 'unknown executor' }, 400);
    }
    try {
      return c.json({ models: (await sessions.warmCapabilities(executor)).models });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get('/api/proxy/:executor/slash', async c => {
    const executor = c.req.param('executor');
    if (executor !== 'codex' && executor !== 'claude') {
      return c.json({ error: 'unknown executor' }, 400);
    }
    const workspaceId = c.req.query('workspace');
    const workspace = workspaceId
      ? db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as
          | { path: string }
          | undefined
      : undefined;
    try {
      return c.json(await sessions.listSlashCommands(executor, workspace?.path));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}
