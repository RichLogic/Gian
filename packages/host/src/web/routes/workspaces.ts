import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { Hono } from 'hono';
import { loadConfig } from '../../storage/config.js';
import type { Db } from '../../storage/db.js';
import { expandHome, initWorkspace } from '../../workspace/index.js';

type PickFolderOutcome =
  | { kind: 'ok'; path: string }
  | { kind: 'canceled' }
  | { kind: 'error'; error: string };

function pickWorkspaceFolder(): Promise<PickFolderOutcome> {
  return new Promise(resolveOutcome => {
    const child = spawn(
      'osascript',
      [
        '-e', 'tell application "System Events" to activate',
        '-e', 'POSIX path of (choose folder with prompt "Select workspace folder")',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => resolveOutcome({ kind: 'error', error: String(error) }));
    child.on('close', code => {
      if (code === 0) {
        const path = stdout.trim().replace(/\/+$/, '');
        resolveOutcome(path
          ? { kind: 'ok', path }
          : { kind: 'error', error: 'empty path returned' });
      } else if (stderr.includes('User canceled') || code === 1) {
        resolveOutcome({ kind: 'canceled' });
      } else {
        resolveOutcome({ kind: 'error', error: stderr.trim() || `osascript exited ${code}` });
      }
    });
  });
}

export function registerWorkspaceRoutes(app: Hono, db: Db): void {
  app.get('/api/workspaces', c => c.json(
    db.prepare('SELECT * FROM workspaces ORDER BY sort_order, name').all(),
  ));

  app.post('/api/workspaces', async c => {
    const body = await c.req.json<{
      name: string;
      git_remote?: string;
      path?: string;
    }>();
    if (!body.name) return c.json({ error: 'name required' }, 400);
    if (!/^[a-zA-Z0-9._-]+$/.test(body.name)) {
      return c.json({ error: 'name may only contain letters, digits, dot, dash, underscore' }, 400);
    }

    const adopt = typeof body.path === 'string' && body.path.trim() !== '';
    const root = resolve(expandHome(loadConfig(db).workspace_root || '~/Coding'));
    let path: string;
    if (adopt) {
      const expanded = expandHome(body.path!.trim());
      if (!isAbsolute(expanded)) {
        return c.json({ error: 'path must be absolute (or start with ~)' }, 400);
      }
      path = resolve(expanded);
      if (path === root) {
        return c.json({ error: `cannot adopt the workspace root itself (${root}) — pick a subdirectory or another path` }, 400);
      }
    } else {
      path = resolve(root, body.name);
    }

    const existing = db
      .prepare('SELECT id, name FROM workspaces WHERE path = ?')
      .get(path) as { id: string; name: string } | undefined;
    if (existing) {
      return c.json({ error: `path is already a workspace: "${existing.name}"` }, 409);
    }

    const result = initWorkspace({
      path,
      ...(body.git_remote ? { gitRemote: body.git_remote } : {}),
      name: body.name,
      ...(adopt ? { adopt: true } : {}),
    });
    if (!result.ok) {
      return c.json({ error: result.error ?? 'init failed', notes: result.notes }, 400);
    }

    const id = crypto.randomUUID();
    try {
      db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
        .run(id, body.name, path);
    } catch (error) {
      return c.json({ error: String(error), notes: result.notes }, 400);
    }
    return c.json({
      workspace: db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id),
      notes: result.notes,
    });
  });

  app.patch('/api/workspaces/:id', async c => {
    const id = c.req.param('id');
    if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const body = await c.req.json<Record<string, unknown>>();
    if ('hidden' in body && typeof body.hidden !== 'boolean') {
      return c.json({ error: 'hidden must be boolean' }, 400);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of ['name', 'hidden'] as const) {
      if (!(key in body)) continue;
      sets.push(`${key} = ?`);
      values.push(key === 'hidden' ? (body.hidden ? 1 : 0) : body[key]);
    }
    if (sets.length === 0) return c.json({ error: 'no updatable fields' }, 400);
    sets.push("updated_at = datetime('now')");
    values.push(id);
    try {
      db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
    return c.json(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id));
  });

  app.delete('/api/workspaces/:id', c => {
    const id = c.req.param('id');
    if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const sessionCount = db
      .prepare('SELECT COUNT(*) as n FROM sessions WHERE workspace_id = ?')
      .get(id) as { n: number };
    if (sessionCount.n > 0) {
      return c.json({ error: 'workspace has associated sessions' }, 409);
    }
    const liveWorktreeCount = db
      .prepare('SELECT COUNT(*) as n FROM sessions WHERE workspace_id = ? AND worktree_path IS NOT NULL')
      .get(id) as { n: number };
    if (liveWorktreeCount.n > 0) {
      return c.json({ error: 'workspace has live worktrees; merge or drop them first' }, 409);
    }
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  app.post('/api/workspaces/pick-folder', async c => {
    if (process.platform !== 'darwin') {
      return c.json({ error: 'directory picker only available on macOS' }, 400);
    }
    const outcome = await pickWorkspaceFolder();
    if (outcome.kind === 'ok') return c.json({ path: outcome.path });
    if (outcome.kind === 'canceled') return c.json({ canceled: true });
    return c.json({ error: outcome.error }, 500);
  });

  app.post('/api/workspaces/reorder', async c => {
    const body = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(body.ids)) return c.json({ error: 'ids required' }, 400);
    const update = db.prepare(
      "UPDATE workspaces SET sort_order = ?, updated_at = datetime('now') WHERE id = ?",
    );
    db.transaction(() => {
      body.ids.forEach((id, index) => update.run(index, id));
    })();
    return c.json({ ok: true });
  });
}
