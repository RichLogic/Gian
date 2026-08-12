import { isAbsolute, posix, resolve, win32 } from 'node:path';
import type { Hono } from 'hono';
import { loadConfig } from '../../storage/config.js';
import type { Db } from '../../storage/db.js';
import { expandHome, initWorkspace } from '../../workspace/index.js';
import {
  canonicalWorkspacePath,
  reserveWorkspacePath,
  WorkspacePathReservationError,
  WorkspacePathResolutionError,
} from '../../workspace/path-reservation.js';
import { pickPath } from '../pick-path.js';

function isWindowsNamespacedRoot(candidate: string): boolean {
  const normalized = win32.normalize(candidate);
  const prefix = normalized.slice(0, 4).toLowerCase();
  if (prefix !== '\\\\?\\' && prefix !== '\\\\.\\') return false;

  const parts = normalized
    .slice(4)
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts[0]?.toLowerCase() === 'unc') {
    return parts.length === 3;
  }
  return parts.length === 1;
}

/** Reject every filesystem root before registration. Checking both path
 * dialects keeps the boundary testable on one platform while matching the
 * host semantics on POSIX, Windows drive roots, and Windows UNC shares. */
export function isFilesystemRoot(candidate: string): boolean {
  if (isWindowsNamespacedRoot(candidate)) return true;
  if (posix.isAbsolute(candidate)) {
    const normalized = posix.resolve(candidate);
    if (normalized === posix.parse(normalized).root) return true;
  }
  if (win32.isAbsolute(candidate)) {
    const normalized = win32.resolve(candidate);
    if (normalized === win32.parse(normalized).root) return true;
  }
  return false;
}

function sameWorkspaceIdentity(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
  }
  return left === right;
}

function pathResolutionFailure(error: unknown): {
  message: string;
  status: 500 | 503 | 504;
} {
  if (error instanceof WorkspacePathResolutionError) {
    return {
      message: error.message,
      status: error.reason === 'timed_out' ? 504 : 503,
    };
  }
  return { message: String(error), status: 500 };
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
    const requestedRoot = resolve(expandHome(loadConfig(db).workspace_root || '~/Coding'));
    let path: string;
    if (adopt) {
      const expanded = expandHome(body.path!.trim());
      if (isFilesystemRoot(expanded)) {
        return c.json({ error: `cannot adopt a filesystem root (${expanded}) — pick a project directory` }, 400);
      }
      if (!isAbsolute(expanded)) {
        return c.json({ error: 'path must be absolute (or start with ~)' }, 400);
      }
      path = resolve(expanded);
    } else {
      path = resolve(requestedRoot, body.name);
    }

    let root: string;
    try {
      [path, root] = await Promise.all([
        canonicalWorkspacePath(path, { signal: c.req.raw.signal }),
        canonicalWorkspacePath(requestedRoot, { signal: c.req.raw.signal }),
      ]);
    } catch (error) {
      const failure = pathResolutionFailure(error);
      return c.json({ error: failure.message }, failure.status);
    }

    if (adopt) {
      if (isFilesystemRoot(path)) {
        return c.json({ error: `cannot adopt a filesystem root (${path}) — pick a project directory` }, 400);
      }
      if (sameWorkspaceIdentity(path, root)) {
        return c.json({ error: `cannot adopt the project root itself (${root}) — pick a subdirectory or another path` }, 400);
      }
    }

    let releaseReservation: () => void;
    try {
      releaseReservation = await reserveWorkspacePath(path, { signal: c.req.raw.signal });
    } catch (error) {
      if (error instanceof WorkspacePathReservationError) {
        return c.json({
          error: error.message,
          code: 'WORKSPACE_INIT_IN_PROGRESS',
        }, 409);
      }
      if (error instanceof WorkspacePathResolutionError) {
        const failure = pathResolutionFailure(error);
        return c.json({ error: failure.message }, failure.status);
      }
      return c.json({ error: String(error) }, 500);
    }

    try {
      // Re-check only after reservation ownership. A request that arrived
      // during provisioning must see the row published by the prior owner.
      const existingRows = db
        .prepare('SELECT id, name, path FROM workspaces')
        .all() as Array<{ id: string; name: string; path: string }>;
      for (const existing of existingRows) {
        let existingPath: string;
        try {
          existingPath = await canonicalWorkspacePath(existing.path, { signal: c.req.raw.signal });
        } catch (error) {
          const failure = pathResolutionFailure(error);
          return c.json({ error: failure.message }, failure.status);
        }
        if (sameWorkspaceIdentity(existingPath, path)) {
          return c.json({ error: `path is already a workspace: "${existing.name}"` }, 409);
        }
      }

      const result = await initWorkspace({
        path,
        ...(body.git_remote ? { gitRemote: body.git_remote } : {}),
        name: body.name,
        ...(adopt ? { adopt: true } : {}),
        signal: c.req.raw.signal,
      });
      if (!result.ok) {
        return c.json(
          { error: result.error ?? 'init failed', notes: result.notes },
          result.errorStatus ?? 400,
        );
      }

      const id = crypto.randomUUID();
      try {
        db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
          .run(id, body.name, path);
      } catch (error) {
        // A second Host process may have won even though the in-process
        // reservation was held. Normalize that path conflict to 409.
        const winner = db
          .prepare('SELECT name FROM workspaces WHERE path = ?')
          .get(path) as { name: string } | undefined;
        if (winner) {
          return c.json({
            error: `path is already a workspace: "${winner.name}"`,
            notes: result.notes,
          }, 409);
        }
        return c.json({ error: String(error), notes: result.notes }, 500);
      }
      return c.json({
        workspace: db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id),
        notes: result.notes,
      });
    } finally {
      releaseReservation();
    }
  });

  /** Derive a workspace-safe directory name from a git remote URL:
   *  basename minus `.git`, sanitized to the workspace-name charset. */
  function deriveRepoName(url: string): string {
    const tail = url.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).filter(Boolean).pop() ?? '';
    return tail.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._-]/g, '-');
  }

  // Clone-only (issue #57 new-workspace redesign): clone a git remote into
  // <workspace_root>/<name> WITHOUT registering a workspace row. The form
  // fills its path field from the response; the actual registration happens
  // when the user confirms with Create (adopt path).
  app.post('/api/workspaces/clone', async c => {
    const body = await c.req.json<{ git_remote?: string; name?: string }>();
    const url = body.git_remote?.trim() ?? '';
    if (!url) return c.json({ error: 'git_remote required' }, 400);
    const name = body.name?.trim() || deriveRepoName(url);
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return c.json({ error: 'name may only contain letters, digits, dot, dash, underscore' }, 400);
    }

    const requestedRoot = resolve(expandHome(loadConfig(db).workspace_root || '~/Coding'));
    let path = resolve(requestedRoot, name);
    let root: string;
    try {
      [path, root] = await Promise.all([
        canonicalWorkspacePath(path, { signal: c.req.raw.signal }),
        canonicalWorkspacePath(requestedRoot, { signal: c.req.raw.signal }),
      ]);
    } catch (error) {
      const failure = pathResolutionFailure(error);
      return c.json({ error: failure.message }, failure.status);
    }
    if (isFilesystemRoot(path) || sameWorkspaceIdentity(path, root)) {
      return c.json({ error: `invalid clone target (${path})` }, 400);
    }

    let releaseReservation: () => void;
    try {
      releaseReservation = await reserveWorkspacePath(path, { signal: c.req.raw.signal });
    } catch (error) {
      if (error instanceof WorkspacePathReservationError) {
        return c.json({ error: error.message, code: 'WORKSPACE_INIT_IN_PROGRESS' }, 409);
      }
      if (error instanceof WorkspacePathResolutionError) {
        const failure = pathResolutionFailure(error);
        return c.json({ error: failure.message }, failure.status);
      }
      return c.json({ error: String(error) }, 500);
    }

    try {
      const existingRows = db
        .prepare('SELECT id, name, path FROM workspaces')
        .all() as Array<{ id: string; name: string; path: string }>;
      for (const existing of existingRows) {
        let existingPath: string;
        try {
          existingPath = await canonicalWorkspacePath(existing.path, { signal: c.req.raw.signal });
        } catch (error) {
          const failure = pathResolutionFailure(error);
          return c.json({ error: failure.message }, failure.status);
        }
        if (sameWorkspaceIdentity(existingPath, path)) {
          return c.json({ error: `path is already a workspace: "${existing.name}"` }, 409);
        }
      }

      const result = await initWorkspace({
        path,
        gitRemote: url,
        name,
        signal: c.req.raw.signal,
      });
      if (!result.ok) {
        return c.json(
          { error: result.error ?? 'clone failed', notes: result.notes },
          result.errorStatus ?? 400,
        );
      }
      return c.json({ path, name, notes: result.notes });
    } finally {
      releaseReservation();
    }
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
    if ('pinned' in body && typeof body.pinned !== 'boolean') {
      return c.json({ error: 'pinned must be boolean' }, 400);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of ['name', 'hidden', 'pinned'] as const) {
      if (!(key in body)) continue;
      sets.push(`${key} = ?`);
      values.push(
        key === 'hidden' || key === 'pinned' ? (body[key] ? 1 : 0) : body[key],
      );
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
    // Deleting a workspace never blocks on its sessions (2026-08-06):
    // sessions.workspace_id is ON DELETE SET NULL (migration 045), so they
    // lose their affiliation and surface in the Sessions rail's 无归属
    // (Unfiled) group instead of being deleted or blocking the delete.
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  app.post('/api/workspaces/pick-folder', async c => {
    if (process.platform !== 'darwin') {
      return c.json({ error: 'directory picker only available on macOS' }, 400);
    }
    const outcome = await pickPath('folder', 'Select folder');
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
