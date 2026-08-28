import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { GianToolMethodData, GianToolMethodParams } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { SessionManager } from '../session/manager.js';
import { runGit } from '../workspace/async-command.js';
import {
  createGitWorktreeAsync,
  GitWorktreeCreateError,
} from '../workspace/git.js';
import { extTreeId } from '../web/working-tree-git.js';
import type { GianToolInternalSessionActor } from './credentials.js';
import { fail, GianToolServiceError } from './errors.js';

function slug(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return normalized || fallback;
}

export async function createAndBindWorktree(
  deps: { db: Db; sessions: SessionManager },
  actor: GianToolInternalSessionActor,
  params: GianToolMethodParams['worktree.create_and_bind'],
): Promise<GianToolMethodData['worktree.create_and_bind']> {
  const session = deps.sessions.getSession(actor.sessionId);
  if (session.archived === 1 || session.completed_at || session.worktree_outcome) {
    fail('SESSION_CLOSED', 'Current Gian Session is closed for worktree creation');
  }
  if (!session.workspace_id) fail('CONFLICT', 'Current Gian Session has no Workspace');
  const workspace = deps.db.prepare(
    'SELECT id, path FROM workspaces WHERE id = ?',
  ).get(session.workspace_id) as { id: string; path: string } | undefined;
  if (!workspace) fail('NOT_FOUND', `Workspace not found: ${session.workspace_id}`);

  const branch = params.branch.trim();
  const baseRef = params.base_ref?.trim() || 'HEAD';
  if (branch !== params.branch || !branch) {
    fail('INVALID_ARGUMENT', 'branch must be non-empty without surrounding whitespace');
  }
  if (params.base_ref !== undefined && baseRef !== params.base_ref) {
    fail('INVALID_ARGUMENT', 'base_ref must not contain surrounding whitespace');
  }

  let repoPath: string;
  try {
    repoPath = await realpath(workspace.path);
    const top = (await runGit(
      ['rev-parse', '--show-toplevel'],
      { cwd: repoPath, timeoutMs: 5_000 },
    )).stdout.trim();
    if (await realpath(top) !== repoPath) {
      fail('CONFLICT', 'Workspace path must be the Git repository root');
    }
  } catch (error) {
    if (error instanceof GianToolServiceError) throw error;
    fail('CONFLICT', 'Workspace is not an available Git repository');
  }

  const repoFallback = createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
  const branchFallback = createHash('sha256').update(branch).digest('hex').slice(0, 8);
  const directoryName = `${slug(basename(repoPath), repoFallback)}-${slug(branch, branchFallback)}`;
  const managedRoot = join(dirname(repoPath), 'worktrees');
  await mkdir(managedRoot, { recursive: true });
  if (await realpath(managedRoot) !== managedRoot) {
    fail('CONFLICT', 'Managed worktrees root must not be a symlink');
  }
  let worktree: Awaited<ReturnType<typeof createGitWorktreeAsync>>;
  try {
    worktree = await createGitWorktreeAsync({
      repoPath,
      managedRoot,
      directoryName,
      branch,
      baseRef,
    });
  } catch (error) {
    if (error instanceof GitWorktreeCreateError) {
      const code = error.kind === 'invalid-base' || error.kind === 'invalid-branch'
        ? 'INVALID_ARGUMENT'
        : 'CONFLICT';
      fail(code, error.message);
    }
    throw error;
  }

  deps.sessions.requestWorktreeView(session.id, worktree.path, 'gian_tool');
  return {
    session_id: session.id,
    workspace_id: workspace.id,
    working_tree_id: extTreeId(workspace.id, worktree.path),
    path: worktree.path,
    branch: worktree.branch,
    base_ref: worktree.baseRef,
    created: worktree.created,
  };
}
