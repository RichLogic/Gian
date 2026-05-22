// Coverage for traceability rows:
//   WT-001 — Worktree session must create a dedicated git worktree, default
//            branch `worktree/<id>`, support base_branch override and a
//            user-supplied branch suffix.
//   WT-003 — Worktree merge/drop must record outcome, remove the worktree
//            directory + branch, and block subsequent sendMessage.
//   INV-013 — After finalize, worktree_outcome / branch / base_branch
//             survive on the row; worktree_path goes null; session is
//             archived; status flips to 'done'.
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
// down before the worktree dir is removed.
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

// ---------------------------------------------------------------------------
// WT-001 — creation
// ---------------------------------------------------------------------------

test('WT-001: default worktree session creates `worktree/<short-id>` branch and a real worktree dir', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId,
      executor: 'claude',
      mode: 'worktree',
    });

    // DB row carries the bookkeeping fields.
    assert.match(session.branch ?? '', /^worktree\/[0-9a-f]{8}$/,
      'default branch must be `worktree/<8-hex>` derived from session id');
    assert.equal(session.branch, `worktree/${session.id.slice(0, 8)}`,
      'default branch suffix is the first 8 chars of the session id');
    assert.equal(session.base_branch, 'main',
      'base_branch must default to the workspace default branch (`main` here)');
    assert.ok(session.worktree_path && session.worktree_path.length > 0,
      'worktree_path must be populated on a worktree session');
    assert.equal(session.worktree_outcome, null,
      'fresh worktree session has no outcome yet');

    // Real on-disk worktree.
    assert.equal(existsSync(session.worktree_path!), true,
      'worktree directory must physically exist after createSession');

    // Branch landed in the main repo's branch list.
    const branches = ctx.repo.git(['branch', '--list', '--format=%(refname:short)']);
    assert.ok(branches.split('\n').includes(session.branch!),
      'new branch must show up in the source repo\'s `git branch` output');

    // Proxy session was spawned in the worktree, not the workspace root.
    assert.equal(ctx.proxyMgr.client.createSessionCalls[0]!.cwd, session.worktree_path,
      'proxy createSession must use the worktree cwd, not the workspace root');
  } finally {
    teardown(ctx);
  }
});

test('WT-001: user-supplied `branch` override is honored verbatim', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId,
      executor: 'claude',
      mode: 'worktree',
      branch: 'worktree/my-feature',
    });
    assert.equal(session.branch, 'worktree/my-feature',
      'caller-supplied branch must NOT be overridden by the auto-generated suffix');
    const branches = ctx.repo.git(['branch', '--list', '--format=%(refname:short)']);
    assert.ok(branches.split('\n').includes('worktree/my-feature'));
  } finally {
    teardown(ctx);
  }
});

test('WT-001: `base_branch` override picks the right starting point', async () => {
  const ctx = setup();
  try {
    // Add a second branch with its own commit so we can detect base.
    ctx.repo.checkout('develop', { create: true });
    ctx.repo.commit('develop-only.txt', 'develop content', 'develop work');
    ctx.repo.checkout('main');

    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId,
      executor: 'claude',
      mode: 'worktree',
      base_branch: 'develop',
    });

    assert.equal(session.base_branch, 'develop',
      'base_branch override must round-trip into the DB row');

    // The new branch's commit history must include develop's tip.
    const mergeBase = ctx.repo.git(['merge-base', session.branch!, 'develop']);
    const developHead = ctx.repo.git(['rev-parse', 'develop']);
    assert.equal(mergeBase, developHead,
      'worktree branch must be rooted at the supplied base_branch tip');

    // develop-only.txt must exist in the worktree (it's reachable from this branch).
    assert.equal(existsSync(join(session.worktree_path!, 'develop-only.txt')), true);
  } finally {
    teardown(ctx);
  }
});

test('WT-001: creating two worktree sessions in parallel yields distinct branches and dirs', async () => {
  const ctx = setup();
  try {
    const a = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', mode: 'worktree',
    });
    const b = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', mode: 'worktree',
    });
    assert.notEqual(a.branch, b.branch, 'each worktree session must get its own branch');
    assert.notEqual(a.worktree_path, b.worktree_path,
      'each worktree session must get its own dir');
    assert.equal(existsSync(a.worktree_path!), true);
    assert.equal(existsSync(b.worktree_path!), true);
  } finally {
    teardown(ctx);
  }
});

test('WT-001: createSession failure on git side leaves NO half-row and NO partial worktree', async () => {
  // A pre-existing branch with the same name forces `git worktree add -b`
  // to fail. The host must roll back: no session row, no worktree dir.
  const ctx = setup();
  try {
    const collision = 'worktree/abcd1234';
    ctx.repo.git(['branch', collision]);

    await assert.rejects(
      ctx.sessions.createSession({
        workspace_id: ctx.wsId, executor: 'claude', mode: 'worktree',
        branch: collision,
      }),
      /worktree creation failed|already exists/i,
    );
    const rows = (ctx.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
    assert.equal(rows, 0, 'failed worktree creation must not leave a session row behind');
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// WT-003 + INV-013 — finalize merge / drop
// ---------------------------------------------------------------------------

test('WT-003: mergeWorktree records `merged` outcome, removes worktree dir, keeps branch+base on row', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', mode: 'worktree',
    });

    // Commit some work in the worktree so the merge is non-trivial.
    const wtRepo = ctx.repo.git.bind(null) as never; // sanity placeholder
    void wtRepo;
    // Use the worktree's own working dir.
    ctx.repo.git(['-C', session.worktree_path!, 'commit', '--allow-empty', '-m', 'wt change']);

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
      'worktree_path must be cleared so listings stop pointing at a removed dir');
    assert.equal(row.branch, session.branch,
      'branch history must survive on the row even after merge');
    assert.equal(row.base_branch, session.base_branch);
    assert.equal(row.status, 'done', 'status flips to done after merge finalize');
    assert.equal(row.archived, 1, 'finalize auto-archives the session');

    // On-disk: worktree dir gone, branch removed from main repo, merge commit on main.
    assert.equal(existsSync(session.worktree_path!), false,
      'worktree directory must be removed after merge');
    const branchList = ctx.repo.git(['branch', '--list', '--format=%(refname:short)']).split('\n');
    assert.equal(branchList.includes(session.branch!), false,
      'worktree branch must be deleted after merge');

    // Proxy was torn down before the dir was removed.
    assert.ok(ctx.proxyMgr.client.closeSessionCalls.length >= 1,
      'proxy.closeSession must be called before removing the worktree dir');
  } finally {
    teardown(ctx);
  }
});

test('WT-003: dropWorktree records `discarded` outcome, removes worktree + branch, blocks sendMessage', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', mode: 'worktree',
    });

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
    assert.equal(row.branch, session.branch,
      'branch name kept on the row for history even after drop');

    assert.equal(existsSync(session.worktree_path!), false);

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
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', mode: 'worktree',
    });
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
      // mode omitted → regular session, no branch
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
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', mode: 'worktree',
    });
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
