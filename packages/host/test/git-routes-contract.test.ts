import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { ServerToClientMessage } from '@gian/shared';
import { Hono } from 'hono';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { registerWorkspaceGitRoutes } from '../src/web/routes/workspace-git.js';
import { makeTestApp } from './fixtures/test-app.js';
import { bareUpstream, createGitRepo } from './fixtures/git-repo.js';

test('GIT-001/002/003: repo routes expose metadata/session links and broadcast every successful mutation', async t => {
  const appCtx = await makeTestApp();
  t.after(() => appCtx.cleanup());
  const upstream = bareUpstream({ seedBranch: 'main' });
  t.after(() => upstream.cleanup());
  const repo = createGitRepo({
    initialBranch: 'main',
    initialMessage: 'fixture head',
    origin: upstream.path,
    files: { 'CLAUDE.md': 'line one\nline two\n' },
  });
  t.after(() => repo.cleanup());
  repo.git(['remote', 'set-head', 'origin', '-a']);
  writeFileSync(join(repo.path, 'dirty.txt'), 'untracked\n', 'utf8');

  const workspaceId = 'workspace-git-contract';
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'Git contract', repo.path);

  const linkedSessionId = 'session-git-contract';
  const linkedBranch = 'worktree/session-linked';
  const linkedWorktree = join(appCtx.dataDir, 'session-linked');
  repo.git(['worktree', 'add', '-b', linkedBranch, linkedWorktree, 'main']);
  appCtx.db.prepare(`
    INSERT INTO sessions (
      id, name, workspace_id, executor, native_session_id, status,
      worktree_path, branch, base_branch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    linkedSessionId,
    'Linked session',
    workspaceId,
    'codex',
    'native-git-contract',
    'done',
    linkedWorktree,
    linkedBranch,
    'main',
  );

  const messages: ServerToClientMessage[] = [];
  const broadcaster = {
    broadcast(message: ServerToClientMessage) { messages.push(message); },
  } as unknown as WsBroadcaster;
  const app = new Hono();
  registerWorkspaceGitRoutes(app, appCtx.db, broadcaster);

  const repoInfoResponse = await app.request(`/api/workspaces/${workspaceId}/repo-info`);
  assert.equal(repoInfoResponse.status, 200);
  const repoInfo = await repoInfoResponse.json() as {
    git: {
      isRepo: boolean;
      remote: string | null;
      defaultBranch: string | null;
      currentBranch: string | null;
      lastCommit: { message: string } | null;
      modifiedCount: number;
      pendingOp: unknown;
    };
    claudeMd: { exists: boolean; lines: number; mtime: string | null };
  };
  assert.equal(repoInfo.git.isRepo, true);
  assert.equal(repoInfo.git.remote, upstream.path);
  assert.equal(repoInfo.git.defaultBranch, 'main');
  assert.equal(repoInfo.git.currentBranch, 'main');
  assert.equal(repoInfo.git.lastCommit?.message, 'fixture head');
  assert.equal(repoInfo.git.modifiedCount, 1);
  assert.equal(repoInfo.git.pendingOp, null);
  assert.equal(repoInfo.claudeMd.exists, true);
  assert.equal(repoInfo.claudeMd.lines, 3);
  assert.ok(repoInfo.claudeMd.mtime);

  const branchesResponse = await app.request(`/api/workspaces/${workspaceId}/branches`);
  assert.equal(branchesResponse.status, 200);
  const branches = await branchesResponse.json() as Array<{
    name: string;
    worktreePath: string | null;
    session: { id: string; name: string | null } | null;
  }>;
  const linked = branches.find(branch => branch.name === linkedBranch);
  assert.deepEqual(linked?.session, { id: linkedSessionId, name: 'Linked session' });
  assert.equal(linked?.worktreePath, realpathSync(linkedWorktree));

  const createResponse = await app.request(`/api/workspaces/${workspaceId}/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'feature/created-by-route', base: 'main' }),
  });
  assert.equal(createResponse.status, 200);

  const fetchResponse = await app.request(`/api/workspaces/${workspaceId}/fetch`, { method: 'POST' });
  assert.equal(fetchResponse.status, 200);

  repo.commit('conflict.txt', 'baseline\n', 'conflict baseline');
  repo.checkout('feature/abort-contract', { create: true });
  repo.commit('conflict.txt', 'feature\n', 'feature conflict');
  repo.checkout('main');
  repo.commit('conflict.txt', 'main\n', 'main conflict');
  assert.throws(() => repo.git(['merge', 'feature/abort-contract']));
  const abortResponse = await app.request(`/api/workspaces/${workspaceId}/abort-merge`, { method: 'POST' });
  assert.equal(abortResponse.status, 200);

  const updates = messages.filter(
    (message): message is Extract<ServerToClientMessage, { type: 'workspace:git-updated' }> =>
      message.type === 'workspace:git-updated',
  );
  assert.deepEqual(updates.map(update => update.reason), ['branch-created', 'fetch', 'merge']);
  assert.ok(updates.every(update => update.workspace_id === workspaceId));
});
