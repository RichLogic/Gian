import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDatabase } from '../src/storage/db.js';
import { registerWorkingTreeRoutes } from '../src/web/routes/working-trees.js';
import { WsBroadcaster } from '../src/web/ws-broadcast.js';
import type { GitWorktreeInfo } from '../src/workspace/git.js';
import { GIT_MAX_CONCURRENCY } from '../src/workspace/async-command.js';

test('ordinary concurrent working-tree requests coalesce and populate one shared cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-working-tree-coalesce-'));
  const db = openDatabase(dir);
  try {
    db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run('workspace-1', 'repo', '/repo/main');
    let scanCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const listGitWorktreesAsync = async (path: string): Promise<GitWorktreeInfo[]> => {
      scanCalls++;
      await gate;
      return [{ path, branch: 'main', head: 'aaaa1111' }];
    };
    const app = new Hono();
    registerWorkingTreeRoutes(app, db, new WsBroadcaster(), { listGitWorktreesAsync });

    const first = app.request('/api/working_trees');
    const second = app.request('/api/working_trees');
    await waitUntil(() => scanCalls === 1);
    assert.equal(scanCalls, 1, 'same-signature ordinary requests must share the pending scan');
    release();

    const [firstRows, secondRows] = await Promise.all([first.then(jsonRows), second.then(jsonRows)]);
    assert.deepEqual(firstRows, secondRows);
    await jsonRows(await app.request('/api/working_trees'));
    assert.equal(scanCalls, 1, 'the coalesced result must seed the ordinary TTL cache');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace discovery fan-out uses the fixed concurrency budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-working-tree-fanout-'));
  const db = openDatabase(dir);
  try {
    for (let i = 0; i < 11; i++) {
      db.prepare('INSERT INTO workspaces (id, name, path, sort_order) VALUES (?, ?, ?, ?)')
        .run(`workspace-${i}`, `repo-${i}`, `/repo/${i}`, i);
    }
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const listGitWorktreesAsync = async (path: string): Promise<GitWorktreeInfo[]> => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return [{ path, branch: 'main', head: 'aaaa1111' }];
    };
    const app = new Hono();
    registerWorkingTreeRoutes(app, db, new WsBroadcaster(), { listGitWorktreesAsync });

    const rows = await jsonRows(await app.request('/api/working_trees'));
    assert.equal(rows.length, 11);
    assert.equal(calls, 11, 'every workspace is discovered once');
    assert.equal(maxActive, GIT_MAX_CONCURRENCY,
      'fan-out should fill, but never exceed, the shared Git concurrency budget');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh=1 waits for an ordinary in-flight scan and then replaces its cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-working-tree-refresh-'));
  const db = openDatabase(dir);
  try {
    const workspaceId = 'workspace-1';
    const workspacePath = '/repo/main';
    db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(workspaceId, 'repo', workspacePath);

    let scanCalls = 0;
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>(resolve => { releaseOrdinary = resolve; });
    let snapshot: GitWorktreeInfo[] = [
      { path: workspacePath, branch: 'main', head: 'aaaa1111' },
    ];
    const listGitWorktreesAsync = async (): Promise<GitWorktreeInfo[]> => {
      scanCalls += 1;
      const captured = snapshot.map(tree => ({ ...tree }));
      if (scanCalls === 1) await ordinaryGate;
      return captured;
    };

    const app = new Hono();
    registerWorkingTreeRoutes(app, db, new WsBroadcaster(), { listGitWorktreesAsync });

    const ordinaryResponse = app.request('/api/working_trees');
    await waitUntil(() => scanCalls === 1);

    const newPath = '/repo/new-agent-tree';
    snapshot = [
      ...snapshot,
      { path: newPath, branch: 'feature/new', head: 'bbbb2222' },
    ];
    const firstRefreshedResponse = app.request('/api/working_trees?refresh=1');
    const secondRefreshedResponse = app.request('/api/working_trees?refresh=1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scanCalls, 1, 'forced refresh waits instead of reusing or racing the old scan');

    releaseOrdinary();
    const ordinaryRows = await jsonRows(await ordinaryResponse);
    assert.equal(ordinaryRows.some(row => row.path === newPath), false, 'ordinary scan captured old state');

    const [firstRefreshedRows, secondRefreshedRows] = await Promise.all([
      firstRefreshedResponse.then(jsonRows),
      secondRefreshedResponse.then(jsonRows),
    ]);
    assert.equal(scanCalls, 2, 'concurrent forced refreshes share one scan after the ordinary scan settles');
    assert.equal(firstRefreshedRows.some(row => row.path === newPath), true, 'first forced scan sees new worktree');
    assert.equal(secondRefreshedRows.some(row => row.path === newPath), true, 'second forced scan sees new worktree');

    const cachedRows = await jsonRows(await app.request('/api/working_trees'));
    assert.equal(scanCalls, 2, 'ordinary follow-up reuses the forced scan cache');
    assert.equal(cachedRows.some(row => row.path === newPath), true, 'old scan never overwrites forced cache');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('timed out waiting for scan');
}

async function jsonRows(response: Response): Promise<Array<{ path: string }>> {
  assert.equal(response.status, 200);
  return response.json() as Promise<Array<{ path: string }>>;
}
