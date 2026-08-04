import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/db.js';
import { SessionRepository } from '../src/session/repository.js';
import { SubtaskLifecycle } from '../src/session/subtask-lifecycle.js';

test('subtask lifecycle updates completion state without writing workspace .ai files', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-subtask-lifecycle-'));
  const workspacePath = join(dataDir, 'workspace');
  const aiDir = join(workspacePath, '.ai');
  mkdirSync(aiDir, { recursive: true });
  const statePath = join(aiDir, 'STATE.md');
  const handoffPath = join(aiDir, 'HANDOFF.md');
  writeFileSync(statePath, 'user-owned state\n');
  writeFileSync(handoffPath, 'user-owned handoff\n');

  const db = openDatabase(dataDir);
  try {
    db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run('ws-1', 'Workspace', workspacePath);
    db.prepare(
      `INSERT INTO sessions (id, name, type, workspace_id, executor, native_session_id)
       VALUES (?, ?, 'subtask', ?, 'claude', ?)`,
    ).run('session-1', 'Subtask', 'ws-1', 'native-session-1');

    const updates: Array<{ completed_at?: string | null }> = [];
    const lifecycle = new SubtaskLifecycle(db, new SessionRepository(db), {
      broadcastUpdated: (_sessionId, partial) => updates.push(partial),
    });

    lifecycle.complete('session-1');
    assert.ok(new SessionRepository(db).get('session-1').completed_at);
    lifecycle.reopen('session-1');
    assert.equal(new SessionRepository(db).get('session-1').completed_at, null);
    lifecycle.abandon('session-1');
    assert.ok(new SessionRepository(db).get('session-1').completed_at);

    assert.equal(readFileSync(statePath, 'utf8'), 'user-owned state\n');
    assert.equal(readFileSync(handoffPath, 'utf8'), 'user-owned handoff\n');
    assert.deepEqual(updates.map(update => update.completed_at === null), [false, true, false]);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
