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
