import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseStateSyncMessage, type Session, type Task } from '@gian/shared';
import type { WSContext } from 'hono/ws';
import type { SessionManager } from '../src/session/manager.js';
import type { TaskManager } from '../src/task/manager.js';
import { openDatabase } from '../src/storage/db.js';
import { loadConfig, saveConfig } from '../src/storage/config.js';

// Authentication mode is captured during module evaluation. Keep this
// wire-contract harness independent from the developer shell.
delete process.env.GIAN_AUTH_REQUIRED;
delete process.env.GIAN_DESKTOP_TOKEN;

const { ApprovalManager } = await import('../src/approval/manager.js');
const { makeWsHandlers } = await import('../src/web/ws-handler.js');
const { WsBroadcaster } = await import('../src/web/ws-broadcast.js');

type Frame = Record<string, unknown> & { type: string };

function client(frames: Frame[]): WSContext {
  return {
    send(value: string) { frames.push(JSON.parse(value) as Frame); },
    close() {},
  } as unknown as WSContext;
}

function sessionFixture(): Session {
  return {
    id: 'session-sync',
    name: 'Synced session',
    type: 'coding',
    task_id: 'task-sync',
    workspace_id: 'workspace-sync',
    executor: 'codex',
    model: null,
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: null,
    service_tier: null,
    active_channel: 'web',
    status: 'pending',
    archived: 0,
    pinned_at: null,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: null,
    summary: null,
    completed_at: null,
    created_at: '2026-08-08T00:00:00.000Z',
    updated_at: '2026-08-08T00:01:00.000Z',
  };
}

test('WS-001: auth_ok is followed immediately by one complete, runtime-valid state_sync snapshot', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-state-sync-'));
  const db = openDatabase(dataDir);
  try {
    saveConfig(db, {
      host: '127.0.0.9',
      workspace_root: '/contract/workspaces',
      theme: 'dark',
      density: 'compact',
    });
    db.prepare(`
      INSERT INTO workspaces (id, name, path, sort_order, hidden, pinned)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('workspace-sync', 'Sync workspace', '/contract/workspaces/project', 7, 0, 1);

    const session = sessionFixture();
    const task: Task = {
      id: 'task-sync',
      name: 'Sync task',
      description: 'state_sync task fixture',
      status: 'open',
      created_at: '2026-08-08T00:00:00.000Z',
      updated_at: '2026-08-08T00:00:00.000Z',
      pinned_at: null,
    };
    const sessions = {
      listSessions: () => [session],
      listSidechats: () => [],
    } as unknown as SessionManager;
    const tasks = { listTasks: () => [task] } as unknown as TaskManager;
    const broadcaster = new WsBroadcaster();
    const approvals = new ApprovalManager(broadcaster);
    void approvals.request({
      sessionId: session.id,
      turnId: 'turn-sync',
      category: 'command',
      risk: 'high',
      description: 'Run contract tests',
      subject: 'pnpm test',
      payload: { approvalId: 'approval-sync' },
    });

    const handlers = makeWsHandlers({ sessions, tasks, broadcaster, approvals, db });
    const frames: Frame[] = [];
    const ws = client(frames);
    handlers.onOpen(new Event('open'), ws);
    await handlers.onMessage(
      { data: JSON.stringify({ type: 'auth', token: 'contract-token' }) },
      ws,
    );

    assert.deepEqual(frames.map(frame => frame.type), ['auth_ok', 'state_sync']);
    assert.deepEqual(frames[0], { type: 'auth_ok', user: 'dev' });

    const sync = parseStateSyncMessage(frames[1]);
    assert.deepEqual(Object.keys(sync).sort(), [
      'approvals', 'config', 'runner', 'sessions', 'sidechats', 'tasks', 'type', 'workspaces',
    ]);
    assert.deepEqual(sync.sidechats, []);
    assert.deepEqual(sync.sessions, [session]);
    assert.deepEqual(sync.tasks, [task]);
    assert.deepEqual(sync.workspaces, db.prepare(
      'SELECT * FROM workspaces ORDER BY sort_order, name',
    ).all());
    assert.deepEqual(sync.approvals, [{
      id: 'approval-sync',
      session_id: session.id,
      turn_id: 'turn-sync',
      category: 'command',
      title: 'Run contract tests',
      command: 'pnpm test',
      reason: null,
      status: 'pending',
      resolved_by: null,
      resolved_at: null,
      created_at: sync.approvals[0]!.created_at,
    }]);
    assert.deepEqual(sync.config, loadConfig(db));
    assert.equal(sync.runner.host, sync.config.host);
    assert.equal(sync.runner.ws_root, sync.config.workspace_root);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
