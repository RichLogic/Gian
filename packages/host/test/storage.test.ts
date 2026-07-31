import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/db.js';
import { loadConfig, saveConfig } from '../src/storage/config.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gian-test-'));
}

test('openDatabase runs migrations and creates expected tables', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    for (const expected of [
      'workspaces',
      'sessions',
      'turns',
      'events',
      'approvals',
      'queue_entries',
      'bots',
      'config',
      'migrations',
      'tasks',
      'task_loops',
      'task_actions',
    ]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }
    assert.ok(!names.includes('queue'), 'legacy queue table should be removed');
    assert.ok(!names.includes('tokens'), 'unused API-token table should be removed');
    const sessionColumns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map(column => column.name);
    for (const retired of ['runtime_mode', 'turns', 'tty_turn_seq']) {
      assert.ok(!sessionColumns.includes(retired), `retired session column still exists: ${retired}`);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ACTION-DB-001 — task_loops / task_actions schema + FK behavior (migration 028).
test('migration 028 creates task_loops / task_actions with expected columns and FKs', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);

    const loopCols = (db.prepare('PRAGMA table_info(task_loops)').all() as Array<{ name: string }>)
      .map(c => c.name);
    for (const col of [
      'id', 'task_id', 'status', 'allowed_methods', 'allowed_workspaces', 'allowed_executors',
      'round', 'max_rounds', 'current_step', 'current_step_session_id', 'expected_role',
      'created_at', 'updated_at',
    ]) {
      assert.ok(loopCols.includes(col), `task_loops missing column ${col}`);
    }

    const actionCols = (db.prepare('PRAGMA table_info(task_actions)').all() as Array<{ name: string }>)
      .map(c => c.name);
    for (const col of [
      'action_id', 'task_id', 'session_id', 'host_turn_id', 'source_turn_key', 'method',
      'payload_hash', 'payload', 'status', 'result', 'error', 'created_at', 'updated_at',
    ]) {
      assert.ok(actionCols.includes(col), `task_actions missing column ${col}`);
    }

    // FK directions + on-delete actions.
    const loopFks = db.prepare('PRAGMA foreign_key_list(task_loops)').all() as Array<{ from: string; table: string; on_delete: string }>;
    assert.equal(loopFks.find(f => f.from === 'task_id')?.on_delete, 'CASCADE');
    assert.equal(loopFks.find(f => f.from === 'current_step_session_id')?.on_delete, 'SET NULL');
    const actFks = db.prepare('PRAGMA foreign_key_list(task_actions)').all() as Array<{ from: string; table: string; on_delete: string }>;
    assert.equal(actFks.find(f => f.from === 'task_id')?.on_delete, 'CASCADE');
    assert.equal(actFks.find(f => f.from === 'session_id')?.on_delete, 'CASCADE');

    // action_id is the primary key → duplicate insert rejected (idempotency floor).
    db.exec("INSERT INTO tasks(id,name,status,created_at,updated_at) VALUES('t1','T','open',datetime('now'),datetime('now'))");
    db.exec("INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at) VALUES('w1','w','/tmp',0,0,datetime('now'),datetime('now'))");
    db.exec("INSERT INTO sessions(id,name,type,task_id,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at) VALUES('s1',NULL,'subtask','t1','w1','claude','plan','new',0,0,'',datetime('now'),datetime('now'))");
    db.exec("INSERT INTO task_loops(id,task_id,current_step_session_id) VALUES('l1','t1','s1')");
    db.exec("INSERT INTO task_actions(action_id,task_id,session_id,method,payload_hash,payload) VALUES('a1','t1','s1','submit_step','ph','{}')");
    assert.throws(
      () => db.exec("INSERT INTO task_actions(action_id,task_id,session_id,method,payload_hash,payload) VALUES('a1','t1','s1','submit_step','ph','{}')"),
      /UNIQUE|PRIMARY/i,
    );

    // Defaults land as declared.
    const loop = db.prepare("SELECT status, allowed_methods, round, max_rounds FROM task_loops WHERE id='l1'").get() as { status: string; allowed_methods: string; round: number; max_rounds: number };
    assert.equal(loop.status, 'active');
    assert.equal(loop.allowed_methods, '[]');
    assert.equal(loop.round, 0);
    assert.equal(loop.max_rounds, 0);
    assert.equal((db.prepare("SELECT status FROM task_actions WHERE action_id='a1'").get() as { status: string }).status, 'parsed');

    // FK on-delete: deleting the session SET NULLs the loop pointer and CASCADEs the action.
    db.exec("DELETE FROM sessions WHERE id='s1'");
    assert.equal((db.prepare("SELECT current_step_session_id FROM task_loops WHERE id='l1'").get() as { current_step_session_id: string | null }).current_step_session_id, null);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM task_actions').get() as { c: number }).c, 0);
    // Deleting the task CASCADEs the loop.
    db.exec("DELETE FROM tasks WHERE id='t1'");
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM task_loops').get() as { c: number }).c, 0);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations are idempotent across reopens', () => {
  const dir = makeTempDir();
  try {
    const db1 = openDatabase(dir);
    const before = db1.prepare('SELECT COUNT(*) AS c FROM migrations').get() as { c: number };
    db1.close();

    const db2 = openDatabase(dir);
    const after = db2.prepare('SELECT COUNT(*) AS c FROM migrations').get() as { c: number };
    assert.equal(after.c, before.c, 'migrations re-applied unexpectedly');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 033 allows Kimi NULL approval mode and exact native config JSON', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const approvalMode = columns.find(column => column.name === 'approval_mode');
    const executorConfig = columns.find(column => column.name === 'executor_config_json');
    assert.equal(approvalMode?.notnull, 0);
    assert.equal(executorConfig?.notnull, 1);
    assert.equal(
      executorConfig?.dflt_value,
      `'{"schemaVersion":1,"values":{}}'`,
    );

    db.prepare(
      'INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)',
    ).run('w-kimi', 'Kimi', '/tmp/kimi');
    db.prepare(
      `INSERT INTO sessions (
        id, workspace_id, executor, approval_mode, executor_config_json,
        native_session_id
      ) VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(
      's-kimi',
      'w-kimi',
      'kimi',
      JSON.stringify({
        schemaVersion: 1,
        values: { model: 'kimi-k2', mode: 'yolo' },
      }),
      'native-kimi',
    );
    const row = db.prepare(
      'SELECT approval_mode, executor_config_json FROM sessions WHERE id = ?',
    ).get('s-kimi') as {
      approval_mode: string | null;
      executor_config_json: string;
    };
    assert.equal(row.approval_mode, null);
    assert.deepEqual(JSON.parse(row.executor_config_json), {
      schemaVersion: 1,
      values: { model: 'kimi-k2', mode: 'yolo' },
    });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 034 adds nullable context state and incomplete legacy totals', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    for (const name of [
      'context_tokens_used',
      'context_window_tokens',
      'context_usage_updated_at',
      'conversation_input_tokens',
      'conversation_output_tokens',
      'conversation_cached_input_tokens',
      'conversation_total_tokens',
      'conversation_usage_complete',
    ]) {
      assert.ok(columns.some(column => column.name === name), `sessions missing ${name}`);
    }
    assert.equal(
      columns.find(column => column.name === 'conversation_usage_complete')?.dflt_value,
      '0',
    );

    db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run('w-usage', 'Usage', '/tmp/usage');
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, executor, native_session_id)
       VALUES (?, ?, ?, ?)`,
    ).run('s-legacy', 'w-usage', 'codex', 'native-usage');
    const row = db.prepare(
      `SELECT context_tokens_used, context_window_tokens,
              conversation_total_tokens, conversation_usage_complete
       FROM sessions WHERE id = ?`,
    ).get('s-legacy') as {
      context_tokens_used: number | null;
      context_window_tokens: number | null;
      conversation_total_tokens: number | null;
      conversation_usage_complete: number;
    };
    assert.equal(row.context_tokens_used, null);
    assert.equal(row.context_window_tokens, null);
    assert.equal(row.conversation_total_tokens, null);
    assert.equal(row.conversation_usage_complete, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 036 adds the pending sidechat fork reference', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
    }>;
    assert.ok(
      columns.some(column => column.name === 'fork_from_session_id'),
      'sessions missing fork_from_session_id',
    );
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(sessions)').all() as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;
    assert.ok(
      foreignKeys.some(key => (
        key.from === 'fork_from_session_id'
        && key.table === 'sessions'
        && key.on_delete === 'SET NULL'
      )),
      'sidechat fork must clear when its parent session is deleted',
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig returns defaults from seeded config rows', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const cfg = loadConfig(db);
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 8990);
    assert.equal(cfg.theme, 'warm');
    assert.equal(cfg.density, 'cozy');
    assert.equal(cfg.locale, 'zh-CN');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig reads overridden values', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    db.prepare('UPDATE config SET value = ? WHERE key = ?').run('0.0.0.0', 'host');
    db.prepare('UPDATE config SET value = ? WHERE key = ?').run('9999', 'port');
    const cfg = loadConfig(db);
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.port, 9999);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: external_editors round-trips as JSON', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    saveConfig(db, {
      external_editors: [
        { id: 'a', name: 'VS Code', command: 'code', args: ['--new-window', '{path}'] },
        { id: 'b', name: 'Sublime', command: 'subl', args: [] },
      ],
    });
    const cfg = loadConfig(db);
    assert.equal(cfg.external_editors.length, 2);
    assert.equal(cfg.external_editors[0]!.name, 'VS Code');
    assert.deepEqual(cfg.external_editors[0]!.args, ['--new-window', '{path}']);
    assert.equal(cfg.external_editors[1]!.command, 'subl');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: external_editors defaults to [] when unset', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const cfg = loadConfig(db);
    assert.deepEqual(cfg.external_editors, []);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: external_editors drops invalid entries (silent filter)', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    saveConfig(db, {
      external_editors: [
        { id: 'a', name: 'OK', command: 'code', args: [] },
        // Empty name — drop.
        { id: 'b', name: '', command: 'code', args: [] } as any,
        // Missing command — drop.
        { id: 'c', name: 'NoCmd', command: '', args: [] } as any,
        // Duplicate id — second one dropped.
        { id: 'a', name: 'Dup', command: 'code', args: [] },
        // Non-string in args — drop.
        { id: 'd', name: 'BadArgs', command: 'code', args: [42 as unknown as string] },
      ],
    });
    const cfg = loadConfig(db);
    assert.deepEqual(cfg.external_editors.map(e => e.id), ['a']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
