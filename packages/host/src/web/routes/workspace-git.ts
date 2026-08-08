import type { Hono } from 'hono';
import { basename } from 'node:path';
import type { Db } from '../../storage/db.js';
import {
  buildRemoteBranchList,
  listLocalBranchesAsync,
  REMOTE_BRANCHES_FOR_EACH_REF_FMT,
} from '../../workspace/git-branches.js';
import { listGitWorktreesAsync } from '../../workspace/git.js';
import {
  CommandExecutionError,
  commandErrorMessage,
  GIT_MAX_CONCURRENCY,
  GitQueueFullError,
  mapWithConcurrency,
  RepoMutationLockError,
  runGit,
  withRepoMutationLock,
} from '../../workspace/async-command.js';
import {
  claudeMdInfoAtAsync,
  extTreeId,
  gitBranchAtAsync,
  gitInfoAtAsync,
  gitPendingOpAtAsync,
} from '../working-tree-git.js';
import type { WsBroadcaster } from '../ws-broadcast.js';

function gitMutationStatus(
  error: unknown,
  nonZeroStatus: 400 | 500 = 500,
): 400 | 500 | 503 | 504 {
  if (error instanceof RepoMutationLockError || error instanceof GitQueueFullError) return 503;
  if (error instanceof CommandExecutionError && error.timedOut) return 504;
  if (error instanceof CommandExecutionError
    && error.exitCode != null && !error.aborted && error.signal == null) {
    return nonZeroStatus;
  }
  return 500;
}

export function registerWorkspaceGitRoutes(
  app: Hono,
  db: Db,
  broadcaster: WsBroadcaster,
): void {
  app.get('/api/workspaces/:id/repo-info', async c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const [git, claudeMd] = await Promise.all([
      gitInfoAtAsync(ws.path),
      claudeMdInfoAtAsync(ws.path),
    ]);
    return c.json({ git, claudeMd });
  });

  app.get('/api/workspaces/:id/trees', async c => {
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

    async function dirty(path: string): Promise<{ isDirty: boolean; modifiedCount: number }> {
      try {
        const { stdout } = await runGit(
          ['status', '--porcelain'],
          { cwd: path, timeoutMs: 2_000 },
        );
        const lines = stdout.split('\n').filter(l => l.trim());
        return { isDirty: lines.length > 0, modifiedCount: lines.length };
      } catch {
        return { isDirty: false, modifiedCount: 0 };
      }
    }

    type TreeOut = {
      id: string;
      kind: 'main' | 'worktree';
      label: string;
      path: string;
      branch: string | null;
      isDirty: boolean;
      modifiedCount: number;
      claudeMd: { exists: boolean; lines: number; mtime: string | null };
      session?: { id: string; name: string | null };
    };
    type Candidate = Omit<TreeOut, 'branch' | 'isDirty' | 'modifiedCount' | 'claudeMd'> & {
      branchHint: string | null;
    };
    const candidates: Candidate[] = [{
      id: `ws:${ws.id}`,
      kind: 'main',
      label: ws.name,
      path: ws.path,
      branchHint: null,
    }];
    for (const s of sessRows) {
      candidates.push({
        id: `wt:${s.id}`,
        kind: 'worktree',
        label: s.name || `session ${s.id.slice(0, 6)}`,
        path: s.worktree_path,
        branchHint: s.branch,
        session: { id: s.id, name: s.name },
      });
    }
    // External worktrees (created outside Gian — e.g. by the agent itself via
    // `git worktree add`). Dedupe against the main tree and DB-owned session
    // worktrees; the `wt:` entry wins on overlap.
    const knownPaths = new Set<string>([ws.path, ...sessRows.map(s => s.worktree_path)]);
    for (const wt of await listGitWorktreesAsync(ws.path)) {
      if (knownPaths.has(wt.path)) continue;
      candidates.push({
        id: extTreeId(ws.id, wt.path),
        kind: 'worktree',
        label: basename(wt.path),
        path: wt.path,
        branchHint: wt.branch,
      });
    }
    const out = await mapWithConcurrency(candidates, GIT_MAX_CONCURRENCY, async candidate => {
      const [fallbackBranch, dirtyState, claudeMd] = await Promise.all([
        candidate.branchHint == null ? gitBranchAtAsync(candidate.path) : Promise.resolve(candidate.branchHint),
        dirty(candidate.path),
        claudeMdInfoAtAsync(candidate.path),
      ]);
      return {
        id: candidate.id,
        kind: candidate.kind,
        label: candidate.label,
        path: candidate.path,
        branch: fallbackBranch,
        ...dirtyState,
        claudeMd,
        ...(candidate.session ? { session: candidate.session } : {}),
      } satisfies TreeOut;
    });
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

  app.get('/api/workspaces/:id/branches', async c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const branches: LocalBranchOut[] = (await listLocalBranchesAsync(ws.path))
      .map(b => ({ ...b, session: null }));
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

  app.get('/api/workspaces/:id/remote-branches', async c => {
    const id = c.req.param('id');
    const search = (c.req.query('search') ?? '').trim().toLowerCase();
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    let raw: string;
    let localNames: Set<string>;
    try {
      const [remoteResult, localBranches] = await Promise.all([
        runGit(
          ['for-each-ref', '--format=' + REMOTE_BRANCHES_FOR_EACH_REF_FMT, 'refs/remotes'],
          { cwd: ws.path, timeoutMs: 5_000 },
        ),
        listLocalBranchesAsync(ws.path),
      ]);
      raw = remoteResult.stdout;
      localNames = new Set(localBranches.map(branch => branch.name));
    } catch {
      return c.json([]);
    }
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
    const signal = c.req.raw.signal;
    try {
      return await withRepoMutationLock(ws.path, async () => {
        // Keep validation, remote probing, and creation in one repository
        // mutation transaction so fetch/merge cannot change refs in between.
        try {
          await runGit(
            ['check-ref-format', '--branch', name],
            { cwd: ws.path, timeoutMs: 2_000, signal },
          );
        } catch (error) {
          if (!(error instanceof CommandExecutionError)
            || error.exitCode == null || error.timedOut || error.aborted) {
            const status = gitMutationStatus(error);
            return c.json({
              ok: false,
              error: commandErrorMessage(error, 'branch validation failed'),
            }, status);
          }
          return c.json({ error: `invalid branch name: ${name}` }, 400);
        }
        // When base is a remote-tracking ref (origin/foo), --track makes the
        // new local branch follow it for ahead/behind. Probe refs/remotes;
        // shape alone cannot distinguish `feature/x` from `origin/foo`.
        let isRemote = false;
        if (base) {
          try {
            await runGit(
              ['rev-parse', '--verify', '--quiet', `refs/remotes/${base}`],
              { cwd: ws.path, timeoutMs: 2_000, signal },
            );
            isRemote = true;
          } catch (error) {
            if (error instanceof CommandExecutionError
              && error.exitCode != null && !error.timedOut && !error.aborted) {
              isRemote = false;
            } else {
              const status = gitMutationStatus(error);
              return c.json({
                ok: false,
                error: commandErrorMessage(error, 'base branch probe failed'),
              }, status);
            }
          }
        }
        const args = ['branch'];
        if (isRemote) args.push('--track');
        args.push(name);
        if (base) args.push(base);
        try {
          await runGit(args, { cwd: ws.path, timeoutMs: 5_000, signal });
        } catch (err) {
          const status = gitMutationStatus(err, 400);
          return c.json({
            ok: false,
            error: commandErrorMessage(err, 'branch create failed'),
          }, status);
        }
        broadcaster.broadcast({
          type: 'workspace:git-updated',
          workspace_id: id,
          reason: 'branch-created',
        });
        return c.json({ ok: true });
      }, { signal });
    } catch (error) {
      return c.json(
        { ok: false, error: commandErrorMessage(error, 'branch mutation unavailable') },
        gitMutationStatus(error),
      );
    }
  });

  app.post('/api/workspaces/:id/abort-merge', async c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const signal = c.req.raw.signal;
    try {
      return await withRepoMutationLock(ws.path, async () => {
        const pending = await gitPendingOpAtAsync(ws.path, signal);
        if (!pending) return c.json({ ok: false, error: 'no merge in progress' }, 400);
        // Detect and abort under the same lock; otherwise another mutation can
        // finish or replace the operation between the probe and `--abort`.
        const args: Record<typeof pending.kind, string[]> = {
          'merge':       ['merge', '--abort'],
          'rebase':      ['rebase', '--abort'],
          'cherry-pick': ['cherry-pick', '--abort'],
          'revert':      ['revert', '--abort'],
        };
        try {
          await runGit(
            args[pending.kind],
            { cwd: ws.path, timeoutMs: 10_000, signal },
          );
        } catch (err) {
          const status = gitMutationStatus(err);
          return c.json({
            ok: false,
            error: commandErrorMessage(err, 'abort failed'),
          }, status);
        }
        broadcaster.broadcast({
          type: 'workspace:git-updated',
          workspace_id: id,
          reason: 'merge',
        });
        return c.json({ ok: true });
      }, { signal });
    } catch (error) {
      return c.json(
        { ok: false, error: commandErrorMessage(error, 'abort mutation unavailable') },
        gitMutationStatus(error),
      );
    }
  });

  app.post('/api/workspaces/:id/fetch', async c => {
    const id = c.req.param('id');
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
      | { path: string } | undefined;
    if (!ws) return c.json({ error: 'workspace not found' }, 404);
    const signal = c.req.raw.signal;
    try {
      return await withRepoMutationLock(ws.path, async () => {
        try {
          await runGit(
            ['fetch', '--prune', '--all'],
            { cwd: ws.path, timeoutMs: 60_000, signal },
          );
        } catch (err) {
          const status = gitMutationStatus(err);
          return c.json({
            ok: false,
            error: commandErrorMessage(err, 'fetch failed'),
          }, status);
        }
        broadcaster.broadcast({
          type: 'workspace:git-updated',
          workspace_id: id,
          reason: 'fetch',
        });
        return c.json({ ok: true, fetchedAt: new Date().toISOString() });
      }, { signal });
    } catch (error) {
      return c.json(
        { ok: false, error: commandErrorMessage(error, 'fetch mutation unavailable') },
        gitMutationStatus(error),
      );
    }
  });
}
