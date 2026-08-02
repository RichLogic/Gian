import type { Hono } from 'hono';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Db } from '../../storage/db.js';
import { resolveWithinWorkspace } from '../../workspace/safe-path.js';

export function registerWorkspaceFileRoutes(
  app: Hono,
  db: Db,
): void {
  app.get('/api/workspaces/:id/tree', async c => {
    const relativePath = c.req.query('path') ?? '';
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    const target = await resolveWithinWorkspace(workspace, relativePath);
    if (!target) return c.json({ error: 'path escapes workspace' }, 400);
    try {
      const entries = await readdir(target, { withFileTypes: true });
      return c.json(entries
        .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' as const : 'file' as const,
          path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
        }))
        .sort((left, right) => {
          if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
          return left.name.localeCompare(right.name);
        }));
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });

  app.get('/api/workspaces/:id/file', async c => {
    const relativePath = c.req.query('path') ?? '';
    if (!relativePath) return c.json({ error: 'path required' }, 400);
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    const target = await resolveWithinWorkspace(workspace, relativePath);
    if (!target) return c.json({ error: 'path escapes workspace' }, 400);
    try {
      const info = await stat(target);
      if (!info.isFile()) return c.json({ error: 'not a file' }, 400);
      if (info.size > 1024 * 1024) return c.json({ error: 'file too large' }, 413);
      return c.json({
        path: relativePath,
        size: info.size,
        content: await readFile(target, 'utf8'),
      });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });

  app.get('/api/workspaces/:id/diff', async c => {
    const relativePath = c.req.query('path') ?? '';
    if (!relativePath) return c.json({ error: 'path required' }, 400);
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (!await resolveWithinWorkspace(workspace, relativePath)) {
      return c.json({ error: 'path escapes workspace' }, 400);
    }
    return c.json({ diff: computeWorkspaceFileDiff(workspace, relativePath) });
  });

  app.get('/api/workspaces/:id/claude_md', async c => {
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    try {
      return c.json({ content: await readFile(resolve(workspace, 'CLAUDE.md'), 'utf8') });
    } catch {
      return c.json({ content: '' });
    }
  });

  app.put('/api/workspaces/:id/claude_md', async c => {
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    const body = await c.req.json<{ content: string }>();
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }
    try {
      await writeFile(resolve(workspace, 'CLAUDE.md'), body.content, 'utf8');
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });

  app.get('/api/workspaces/:id/file_meta', async c => {
    const relativePath = c.req.query('path') ?? '';
    if (!relativePath) return c.json({ error: 'path required' }, 400);
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (!await resolveWithinWorkspace(workspace, relativePath)) {
      return c.json({ error: 'path escapes workspace' }, 400);
    }

    let uncommitted = false;
    try {
      uncommitted = execFileSync(
        'git',
        ['-C', workspace, 'status', '--porcelain', '--', relativePath],
        { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim().length > 0;
    } catch {
      // Non-git workspaces simply have no git status.
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString().slice(0, 19).replace('T', ' ');
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM events
       WHERE (type = 'file_change'
              OR (json_valid(data) AND json_extract(data, '$.display.type') = 'activity.file-change'))
         AND data LIKE ? AND created_at >= ?`,
    ).get(`%"path":"${relativePath}"%`, todayIso) as { n: number };
    return c.json({ uncommitted, edit_count_today: row.n });
  });
}

function computeWorkspaceFileDiff(cwd: string, relativePath: string): string {
  try {
    const diff = execFileSync('git', ['-C', cwd, 'diff', 'HEAD', '--', relativePath], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (diff) return diff;
  } catch {
    return '';
  }
  try {
    execFileSync('git', ['-C', cwd, 'ls-files', '--error-unmatch', '--', relativePath], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return '';
  } catch {
    try {
      execFileSync('git', ['-C', cwd, 'diff', '--no-index', '--', '/dev/null', relativePath], {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return '';
    } catch (error) {
      const result = error as { stdout?: Buffer | string; status?: number };
      if (result.status === 1 && result.stdout != null) {
        return typeof result.stdout === 'string'
          ? result.stdout
          : result.stdout.toString('utf8');
      }
      return '';
    }
  }
}

function workspacePath(db: Db, id: string): string | null {
  const row = db.prepare('SELECT path FROM workspaces WHERE id = ?')
    .get(id) as { path: string } | undefined;
  return row?.path ?? null;
}
