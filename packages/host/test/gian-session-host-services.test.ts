import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/storage/db.js';
import { GianToolCredentialManager } from '../src/tool/credentials.js';
import { GianSessionHostServiceIssuer } from '../src/tool/session-host-services.js';

test('Gian Session Host Service uses a provisional token, activates it, and revokes on detach', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-host-service-'));
  const db = openDatabase(dir);
  try {
    db.exec(`
      INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
      VALUES ('workspace-1', 'Workspace', '/tmp/workspace', 0, 0, datetime('now'), datetime('now'));
    `);
    const credentials = new GianToolCredentialManager(
      db,
      () => new Date('2026-08-27T00:00:00.000Z'),
    );
    const issuer = new GianSessionHostServiceIssuer(
      credentials,
      'http://127.0.0.1:8991/internal/mcp',
    );
    const lease = issuer.issue({
      sessionId: 'session-new',
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      taskId: null,
      role: 'admin',
    }, { provisional: true });
    const authorization = lease.descriptor.transport.headers?.Authorization;
    assert.equal(typeof authorization === 'string' && /^Bearer gian_mcp_v1\./.test(authorization), true);
    assert.equal(lease.descriptor.id, 'gian');
    assert.equal(lease.descriptor.protocol, 'mcp');
    assert.equal(lease.descriptor.transport.type, 'streamable-http');
    assert.equal(lease.descriptor.transport.url, 'http://127.0.0.1:8991/internal/mcp');
    assert.equal(credentials.authenticate(authorization ?? null)?.provisioning, true);

    db.prepare(
      `INSERT INTO sessions
        (id, name, type, workspace_id, executor, agent_id, approval_mode,
         status, archived, unread, native_session_id, created_at, updated_at)
       VALUES
        ('session-new', 'New', 'coding', 'workspace-1', 'codex', 'agent-1', 'ask',
         'new', 0, 0, 'native-new', datetime('now'), datetime('now'))`,
    ).run();
    lease.activate();
    const active = credentials.authenticate(authorization ?? null);
    assert.equal(active?.provisioning, undefined);
    assert.equal(active?.kind, 'internal_session');
    assert.equal(active?.role, 'admin');
    assert.equal(active?.sessionId, 'session-new');

    lease.revoke();
    assert.equal(credentials.authenticate(authorization ?? null), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Host restart revocation invalidates internal leases but preserves external controllers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-host-restart-'));
  const db = openDatabase(dir);
  try {
    db.exec(`
      INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
      VALUES ('workspace-1', 'Workspace', '/tmp/workspace', 0, 0, datetime('now'), datetime('now'));
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, approval_mode,
         status, archived, unread, native_session_id, created_at, updated_at)
      VALUES
        ('session-1', 'One', 'coding', 'workspace-1', 'codex', 'ask',
         'done', 0, 0, 'native-1', datetime('now'), datetime('now'));
    `);
    const credentials = new GianToolCredentialManager(db);
    const internal = credentials.issueInternalSession({
      sessionId: 'session-1',
      role: 'admin',
      ttlMs: 60_000,
      renewable: true,
    });
    const external = credentials.issueExternalController({
      clientId: 'external-admin',
      role: 'admin',
      ttlMs: 60_000,
    });

    assert.equal(credentials.revokeAllInternalSessions(), 1);
    assert.equal(credentials.authenticate(`Bearer ${internal.token}`), null);
    assert.equal(credentials.authenticate(`Bearer ${external.token}`)?.kind, 'external_controller');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
