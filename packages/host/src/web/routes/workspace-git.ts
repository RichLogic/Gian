import type { Hono } from 'hono';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import type { Db } from '../../storage/db.js';
import {
  buildRemoteBranchList,
  listLocalBranches,
  REMOTE_BRANCHES_FOR_EACH_REF_FMT,
} from '../../workspace/git-branches.js';
import { listGitWorktrees } from '../../workspace/git.js';
import {
  claudeMdInfoAt,
  extTreeId,
  gitBranchAt,
  gitInfoAt,
  gitPendingOpAt,
} from '../working-tree-git.js';
import type { WsBroadcaster } from '../ws-broadcast.js';

export function registerWorkspaceGitRoutes(
  app: Hono,
  db: Db,
  broadcaster: WsBroadcaster,
): void {
  app.get('/api/workspaces/:id/repo-info', c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    return c.json({
      git: gitInfoAt(ws.path),
      claudeMd: claudeMdInfoAt(ws.path),
    });
  });

  app.get('/api/workspaces/:id/trees', c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT id, name, path, created_at FROM workspaces WHERE id = ?').get(id) as
      | { id: string; name: string; path: string; created_at: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);

    const sessRows = db.prepare(`
      SELECT id, name, worktree_path, branch
      FROM sessions
      WHERE workspace_id = ? AND worktree_path IS NOT NULL AND archived = 0
      ORDER BY updated_at DESC
    `).all(id) as Array<{ id: string; name: string | null; worktree_path: string; branch: string | null }>;

    function dirty(path: string): { isDirty: boolean; modifiedCount: number } {
      try {
        const out = execFileSync('git', ['-C', path, 'status', '--porcelain'], {
          timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = out.split('\n').filter(l => l.trim());
        return { isDirty: lines.length > 0, modifiedCount: lines.length };
      } catch {
        return { isDirty: false, modifiedCount: 0 };
      }
    }

    const out: Array<{
      id: string;
      kind: 'main' | 'worktree';
      label: string;
      path: string;
      branch: string | null;
      isDirty: boolean;
      modifiedCount: number;
      claudeMd: { exists: boolean; lines: number; mtime: string | null };
      session?: { id: string; name: string | null };
    }> = [];

    out.push({
      id: `ws:${ws.id}`,
      kind: 'main',
      label: ws.name,
      path: ws.path,
      branch: gitBranchAt(ws.path),
      ...dirty(ws.path),
      claudeMd: claudeMdInfoAt(ws.path),
    });
    for (const s of sessRows) {
      out.push({
        id: `wt:${s.id}`,
        kind: 'worktree',
        label: s.name || `session ${s.id.slice(0, 6)}`,
        path: s.worktree_path,
        branch: s.branch ?? gitBranchAt(s.worktree_path),
        ...dirty(s.worktree_path),
        claudeMd: claudeMdInfoAt(s.worktree_path),
        session: { id: s.id, name: s.name },
      });
    }
    // External worktrees (created outside Gian — e.g. by the agent itself via
    // `git worktree add`). Dedupe against the main tree and DB-owned session
    // worktrees; the `wt:` entry wins on overlap.
    const knownPaths = new Set<string>([ws.path, ...sessRows.map(s => s.worktree_path)]);
    for (const wt of listGitWorktrees(ws.path)) {
      if (knownPaths.has(wt.path)) continue;
      out.push({
        id: extTreeId(ws.id, wt.path),
        kind: 'worktree',
        label: basename(wt.path),
        path: wt.path,
        branch: wt.branch ?? gitBranchAt(wt.path),
        ...dirty(wt.path),
        claudeMd: claudeMdInfoAt(wt.path),
      });
    }
    return c.json(out);
  });

  // ── Branches / remote-branches / fetch ─────────────────────────────────────
  // Powering the workspace-level Git panel (IDE-style branch management).
  // All three endpoints are thin wrappers around `git for-each-ref` and
  // `git fetch`. The sessions table is joined in `listLocalBranches` purely
  // for "which Gian session's worktree has this branch checked out" linkage.

  interface LocalBranchOut {
    name: string;
    upstream: string | null;
    ahead: number;
    behind: number;
    gone: boolean;
    lastCommit: { hash: string; subject: string; age: string } | null;
    worktreePath: string | null;
    /** True when the branch was auto-created by a Gian session worktree.
     *  Matches both the new `worktree/*` prefix and the legacy `gian/*`
     *  prefix used in older versions, so historical branches still flag
     *  correctly in the Git panel filter. */
    isWorktreeBranch: boolean;
    session: { id: string; name: string | null } | null;
  }

  app.get('/api/workspaces/:id/branches', c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const branches: LocalBranchOut[] = listLocalBranches(ws.path).map(b => ({ ...b, session: null }));
    const sessRows = db.prepare(`
      SELECT id, name, branch FROM sessions
      WHERE workspace_id = ? AND branch IS NOT NULL AND archived = 0
    `).all(id) as Array<{ id: string; name: string | null; branch: string }>;
    const byBranch = new Map(sessRows.map(s => [s.branch, { id: s.id, name: s.name }]));
    for (const b of branches) {
      const s = byBranch.get(b.name);
      if (s) b.session = s;
    }
    return c.json(branches);
  });

  app.get('/api/workspaces/:id/remote-branches', c => {
    const id = c.req.param('id');
    const search = (c.req.query('search') ?? '').trim().toLowerCase();
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    let raw: string;
    try {
      raw = execFileSync(
        'git',
        ['-C', ws.path, 'for-each-ref', '--format=' + REMOTE_BRANCHES_FOR_EACH_REF_FMT, 'refs/remotes'],
        { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      return c.json([]);
    }
    const localNames = new Set(listLocalBranches(ws.path).map(b => b.name));
    const out = buildRemoteBranchList({ rawForEachRef: raw, localBranchNames: localNames, search });
    return c.json(out);
  });

  app.post('/api/workspaces/:id/branches', async c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const body = await c.req.json<{ name?: string; base?: string }>().catch(() => ({} as { name?: string; base?: string }));
    const name = (body.name ?? '').trim();
    const base = (body.base ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    // `git check-ref-format --branch <name>` validates the proposed branch
    // name without creating anything. Cheaper than letting `git branch` blow
    // up with a vague error.
    try {
      execFileSync('git', ['-C', ws.path, 'check-ref-format', '--branch', name], {
        timeout: 2000, stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      return c.json({ error: `invalid branch name: ${name}` }, 400);
    }
    // When base is a remote-tracking ref (origin/foo), --track makes the new
    // local branch follow it for ahead/behind. Probe with rev-parse against
    // refs/remotes/<base> — `feature/x` happens to look like `origin/foo` by
    // shape, so a regex isn't enough.
    let isRemote = false;
    if (base) {
      try {
        execFileSync('git', ['-C', ws.path, 'rev-parse', '--verify', '--quiet', `refs/remotes/${base}`], {
          timeout: 2000, stdio: ['ignore', 'ignore', 'ignore'],
        });
        isRemote = true;
      } catch {
        isRemote = false;
      }
    }
    const args = ['-C', ws.path, 'branch'];
    if (isRemote) args.push('--track');
    args.push(name);
    if (base) args.push(base);
    try {
      execFileSync('git', args, {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
      return c.json({ ok: false, error: stderr.trim() || e.message || 'branch create failed' }, 400);
    }
    broadcaster.broadcast({ type: 'workspace:git-updated', workspace_id: id, reason: 'branch-created' });
    return c.json({ ok: true });
  });

  app.post('/api/workspaces/:id/abort-merge', c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const pending = gitPendingOpAt(ws.path);
    if (!pending) return c.json({ ok: false, error: 'no merge in progress' }, 400);
    // `git <op> --abort` is the canonical way to back out each state. The
    // command matches the pending op kind we detected.
    const args: Record<typeof pending.kind, string[]> = {
      'merge':       ['merge', '--abort'],
      'rebase':      ['rebase', '--abort'],
      'cherry-pick': ['cherry-pick', '--abort'],
      'revert':      ['revert', '--abort'],
    };
    try {
      execFileSync('git', ['-C', ws.path, ...args[pending.kind]], {
        timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
      return c.json({ ok: false, error: stderr.trim() || e.message || 'abort failed' }, 500);
    }
    broadcaster.broadcast({ type: 'workspace:git-updated', workspace_id: id, reason: 'merge' });
    return c.json({ ok: true });
  });

  app.post('/api/workspaces/:id/fetch', c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    try {
      execFileSync('git', ['-C', ws.path, 'fetch', '--prune', '--all'], {
        timeout: 60_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
      return c.json({ ok: false, error: stderr || e.message || 'fetch failed' }, 500);
    }
    broadcaster.broadcast({ type: 'workspace:git-updated', workspace_id: id, reason: 'fetch' });
    return c.json({ ok: true, fetchedAt: new Date().toISOString() });
  });

}
