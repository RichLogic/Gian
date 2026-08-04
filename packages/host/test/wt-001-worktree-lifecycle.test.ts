// Coverage for traceability rows:
//   WT-003 — Worktree merge/drop must record outcome and block subsequent
//            sendMessage. Gian no longer creates worktrees on behalf of the
//            user (agents create their own via `git worktree add`), so
//            merge/drop operate on legacy worktree-session rows and
//            deliberately do NOT remove the worktree directory or branch.
//   INV-013 — After finalize, worktree_outcome / branch / base_branch
//             survive on the row; worktree_path goes null; session is
//             archived; status flips to 'done'.
//
// Worktree-session rows are set up by hand (regular session + a manual
// `git worktree add` + a row UPDATE) because session creation no longer
// offers a worktree mode.
//
// Drives SessionManager with a deterministic fake proxy AND a real git
// repo fixture (test/fixtures/git-repo.ts). The fake proxy never touches a
// real claude/codex binary; the git repo is a per-test tmpdir.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import { createGitRepo, type GitRepo } from './fixtures/git-repo.js';

// ---------------------------------------------------------------------------
// Fake proxy — minimal surface needed by SessionManager.createSession +
// teardown. Tracks `closeSession` calls so we can verify proxy is torn
// down during merge/drop.
// ---------------------------------------------------------------------------

class FakeProxyClient implements ProxyClient {
  readonly executor: 'claude' | 'codex' = 'claude';
  notificationHandlers: NotificationHandler[] = [];
  createSessionCalls: Array<{ cwd: string }> = [];
  closeSessionCalls: string[] = [];

  async initialize() { return { mode: 'spawn' as const, protocolVersion: '0.1.0', methods: [] }; }
  async capabilities() { return { protocolVersion: '0.1.0', models: [], slashCommands: [] }; }
  async listSlashCommands() { return { commands: [] }; }
  async createSession(params: { cwd: string; claudeSessionId?: string }) {
    this.createSessionCalls.push({ cwd: params.cwd });
    const nativeSessionId = params.claudeSessionId ?? `cc_${randomUUID()}`;
    return {
      session: {
        id: nativeSessionId,
        cwd: params.cwd,
        claudeSessionId: nativeSessionId,
        model: null,
        status: 'idle' as const,
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }
  async interruptTurn() {}
  async respondApproval() {}
  async startTurn() {
    return {
      session: {
        id: 'proxy_x', cwd: '/tmp', model: null,
        status: 'running' as const,
        createdAt: '2026-05-17T00:00:00.000Z', updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      turn: { id: 'proxy_turn' },
    };
  }
  async closeSession(id: string) { this.closeSessionCalls.push(id); }
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => { this.notificationHandlers = this.notificationHandlers.filter(h => h !== handler); };
  }
  onExit() { return () => {}; }
  fire(notification: ProxyNotification): void {
    for (const h of this.notificationHandlers) h(notification);
  }
}

class FakeProxyManager {
  client = new FakeProxyClient();
  async getOrCreate(): Promise<ProxyClient> { return this.client; }
  get(): ProxyClient { return this.client; }
  async closeAll(): Promise<void> {}
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {} remove() {} send() {}
  broadcast(msg: ServerToClientMessage): void { this.messages.push(msg); }
  get size() { return 0; }
}

interface SetupResult {
  dataDir: string;
  repo: GitRepo;
  db: ReturnType<typeof openDatabase>;
  wsId: string;
  sessions: SessionManager;
  proxyMgr: FakeProxyManager;
  broadcaster: CapturingBroadcaster;
}

function setup(): SetupResult {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-wt-test-'));
  const db = openDatabase(dataDir);
  const repo = createGitRepo({ initialBranch: 'main' });

  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'demo', repo.path);

  const proxyMgr = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    queue,
    dataDir,
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);
  return { dataDir, repo, db, wsId, sessions, proxyMgr, broadcaster };
}

function teardown(ctx: SetupResult) {
  ctx.db.close();
  rmSync(ctx.dataDir, { recursive: true, force: true });
  ctx.repo.cleanup();
}

/**
 * Create a regular session, then dress its row up as a legacy worktree
 * session: a real `git worktree add` plus worktree_path/branch/base_branch
 * on the row. This mirrors rows created before the worktree mode was
 * removed — merge/drop must keep working for them.
 */
async function setupWorktreeSession(ctx: SetupResult): Promise<{
  session: { id: string; branch: string | null };
  branch: string;
  worktreePath: string;
}> {
  const session = await ctx.sessions.createSession({
    workspace_id: ctx.wsId,
    executor: 'claude',
  });
  const branch = `worktree/${session.id.slice(0, 8)}`;
  const worktreePath = join(ctx.dataDir, `wt-${session.id.slice(0, 8)}`);
  ctx.repo.git(['worktree', 'add', '-b', branch, worktreePath, 'main']);
  ctx.db
    .prepare('UPDATE sessions SET worktree_path = ?, branch = ?, base_branch = ? WHERE id = ?')
    .run(worktreePath, branch, 'main', session.id);
  return { session, branch, worktreePath };
}

// ---------------------------------------------------------------------------
// WT-003 + INV-013 — finalize merge / drop
// ---------------------------------------------------------------------------

test('WT-003: mergeWorktree records `merged` outcome and merges the branch, but leaves worktree dir + branch in place', async () => {
  const ctx = setup();
  try {
    const { session, branch, worktreePath } = await setupWorktreeSession(ctx);

    // Commit some work in the worktree so the merge is non-trivial.
    ctx.repo.git(['-C', worktreePath, 'commit', '--allow-empty', '-m', 'wt change']);

    await ctx.sessions.mergeWorktree(session.id);

    // Row state: outcome=merged, branch+base preserved, path nulled.
    const row = ctx.db.prepare(`
      SELECT branch, base_branch, worktree_path, worktree_outcome, status, archived
      FROM sessions WHERE id = ?`).get(session.id) as {
        branch: string | null; base_branch: string | null;
        worktree_path: string | null; worktree_outcome: string | null;
        status: string; archived: number;
      };
    assert.equal(row.worktree_outcome, 'merged');
    assert.equal(row.worktree_path, null,
      'worktree_path must be cleared so listings stop pointing at a finalized worktree');
    assert.equal(row.branch, branch,
      'branch history must survive on the row even after merge');
    assert.equal(row.base_branch, 'main');
    assert.equal(row.status, 'done', 'status flips to done after merge finalize');
    assert.equal(row.archived, 1, 'finalize auto-archives the session');

    // The merge really happened on the base branch.
    const mergeBase = ctx.repo.git(['merge-base', 'main', branch]);
    const branchHead = ctx.repo.git(['rev-parse', branch]);
    assert.equal(mergeBase, branchHead,
      'base branch must contain the worktree branch tip after merge');

    // Gian does not own the worktree — dir and branch stay on disk.
    assert.equal(existsSync(worktreePath), true,
      'worktree directory must NOT be removed by merge');
    const branchList = ctx.repo.git(['branch', '--list', '--format=%(refname:short)']).split('\n');
    assert.equal(branchList.includes(branch), true,
      'worktree branch must NOT be deleted by merge');

    // Proxy was torn down.
    assert.ok(ctx.proxyMgr.client.closeSessionCalls.length >= 1,
      'proxy.closeSession must be called during merge finalize');
  } finally {
    teardown(ctx);
  }
});

test('WT-003: dropWorktree records `discarded` outcome, leaves worktree + branch untouched, blocks sendMessage', async () => {
  const ctx = setup();
  try {
    const { session, branch, worktreePath } = await setupWorktreeSession(ctx);

    await ctx.sessions.dropWorktree(session.id);

    const row = ctx.db.prepare(`
      SELECT worktree_outcome, worktree_path, archived, status, branch
      FROM sessions WHERE id = ?`).get(session.id) as {
        worktree_outcome: string | null; worktree_path: string | null;
        archived: number; status: string; branch: string | null;
      };
    assert.equal(row.worktree_outcome, 'discarded');
    assert.equal(row.archived, 1);
    assert.equal(row.status, 'done');
    assert.equal(row.worktree_path, null);
    assert.equal(row.branch, branch,
      'branch name kept on the row for history even after drop');

    assert.equal(existsSync(worktreePath), true,
      'worktree directory must NOT be removed by drop');
    const branchList = ctx.repo.git(['branch', '--list', '--format=%(refname:short)']).split('\n');
    assert.equal(branchList.includes(branch), true,
      'worktree branch must NOT be deleted by drop');

    // sendMessage must refuse to start a turn on a finalized session.
    await assert.rejects(
      ctx.sessions.sendMessage(session.id, 'hello'),
      /discarded|create a new session/i,
      'finalized session must block sendMessage so the user can\'t keep typing into a dead worktree',
    );
  } finally {
    teardown(ctx);
  }
});

test('WT-003: cannot merge OR drop a session that is already finalized', async () => {
  const ctx = setup();
  try {
    const { session } = await setupWorktreeSession(ctx);
    await ctx.sessions.dropWorktree(session.id);
    await assert.rejects(ctx.sessions.dropWorktree(session.id), /already discarded/);
    await assert.rejects(ctx.sessions.mergeWorktree(session.id), /already discarded/);
  } finally {
    teardown(ctx);
  }
});

test('WT-003: merge/drop on a non-worktree session is rejected', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude',
      // regular session, no branch
    });
    await assert.rejects(ctx.sessions.mergeWorktree(session.id), /not in worktree mode/);
    await assert.rejects(ctx.sessions.dropWorktree(session.id), /not in worktree mode/);
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// INV-013 — broadcast surface
// ---------------------------------------------------------------------------

test('INV-013: finalize broadcasts session:updated with full outcome+archived+status payload', async () => {
  const ctx = setup();
  try {
    const { session } = await setupWorktreeSession(ctx);
    ctx.broadcaster.messages.length = 0;

    await ctx.sessions.dropWorktree(session.id);

    const updates = ctx.broadcaster.messages.filter(
      m => m.type === 'session:updated',
    ) as Array<{ session: { id: string; worktree_outcome?: string; archived?: number; status?: string } }>;
    assert.ok(updates.length >= 1, 'session:updated must be broadcast on finalize');
    const last = updates[updates.length - 1]!;
    assert.equal(last.session.id, session.id);
    assert.equal(last.session.worktree_outcome, 'discarded');
    assert.equal(last.session.archived, 1);
    assert.equal(last.session.status, 'done');

    const gitUpdates = ctx.broadcaster.messages.filter(
      m => m.type === 'workspace:git-updated',
    ) as Array<{ workspace_id: string; reason: string }>;
    assert.ok(gitUpdates.some(u => u.reason === 'drop' && u.workspace_id === ctx.wsId),
      'workspace:git-updated must fire so the Workspace Git panel refreshes');
  } finally {
    teardown(ctx);
  }
});
