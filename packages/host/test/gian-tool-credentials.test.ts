import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase, type Db } from '../src/storage/db.js';
import { GianToolAccessController } from '../src/tool/access.js';
import {
  defaultGianToolGrants,
  GianToolCredentialManager,
} from '../src/tool/credentials.js';
import type { GianToolService } from '../src/tool/service.js';

function fixture(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gian-tool-credential-'));
  const db = openDatabase(dir);
  db.exec(`
    INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/tmp/workspace', 0, 0, datetime('now'), datetime('now'));
    INSERT INTO sessions
      (id, name, type, workspace_id, executor, agent_id, approval_mode,
       status, archived, unread, native_session_id, created_at, updated_at)
    VALUES
      ('session-1', 'One', 'primary', 'workspace-1', 'codex', 'agent-1', 'ask',
       'done', 0, 0, 'native-1', datetime('now'), datetime('now')),
      ('session-2', 'Two', 'primary', 'workspace-1', 'codex', 'agent-2', 'ask',
       'done', 0, 0, 'native-2', datetime('now'), datetime('now'));
  `);
  return { db, dir };
}

test('Gian Tool credentials persist only a hash and survive Host manager restart', () => {
  const { db, dir } = fixture();
  try {
    let now = Date.parse('2026-08-26T00:00:00.000Z');
    const manager = new GianToolCredentialManager(db, () => new Date(now));
    const issued = manager.issueInternalSession({
      sessionId: 'session-1',
      grants: ['session.get', 'interaction.list'],
      ttlMs: 120_000,
    });
    assert.match(issued.token, /^gian_mcp_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const stored = db.prepare(
      'SELECT token_hash, grants_json FROM tool_credentials WHERE id = ?',
    ).get(issued.credentialId) as { token_hash: string; grants_json: string };
    assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(stored).includes(issued.token), false);
    assert.deepEqual(JSON.parse(stored.grants_json), ['interaction.list', 'session.get']);

    const restarted = new GianToolCredentialManager(db, () => new Date(now));
    const actor = restarted.authenticate(`Bearer ${issued.token}`);
    assert.deepEqual(actor, {
      kind: 'internal_session',
      credentialId: issued.credentialId,
      callerId: 'internal-session:session-1',
      role: 'standard',
      sessionId: 'session-1',
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      taskId: null,
      grants: ['interaction.list', 'session.get'],
      expiresAt: '2026-08-26T00:02:00.000Z',
    });
    assert.equal(restarted.authenticate(`Bearer ${issued.token}x`), null);
    assert.equal(restarted.authenticate(issued.token), null);

    now += 120_000;
    assert.equal(restarted.authenticate(`Bearer ${issued.token}`), null, 'expiry fails closed');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credential roles have closed default Tool catalogs', () => {
  const standard = defaultGianToolGrants('standard');
  assert.equal(standard.includes('task.list'), true);
  assert.equal(standard.includes('session.create'), true);
  assert.equal(standard.includes('interaction.list'), true);
  assert.equal(standard.includes('interaction.respond'), true);
  assert.equal(standard.includes('worktree.create_and_bind'), true);
  assert.equal(standard.includes('task.create'), false);
  assert.equal(standard.includes('task.update'), false);
  assert.equal(defaultGianToolGrants('admin').length, 20);
});

test('provisional internal identity permits discovery but denies calls until atomic activation', async () => {
  const { db, dir } = fixture();
  try {
    const manager = new GianToolCredentialManager(
      db,
      () => new Date('2026-08-27T00:00:00.000Z'),
    );
    const issued = manager.issueProvisionalInternalSession({
      sessionId: 'session-new',
      agentId: 'agent-new',
      workspaceId: 'workspace-1',
      taskId: null,
      role: 'admin',
      ttlMs: 30 * 24 * 60 * 60 * 1_000,
    });
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM tool_credentials').get() as { n: number }).n,
      0,
      'raw and hashed provisional material stay in Host memory',
    );
    const pending = manager.authenticate(`Bearer ${issued.token}`);
    assert.equal(pending?.provisioning, true);
    assert.equal(pending?.role, 'admin');

    const calls: unknown[] = [];
    const service = { call: async (call: unknown) => {
      calls.push(call);
      return { ok: true, request_id: 'request-provisional', data: {} };
    } } as unknown as GianToolService;
    const access = new GianToolAccessController(service, db);
    const deniedCall = await access.call(pending!, {
      request_id: 'request-provisional',
      method: 'task.create',
      params: { name: 'must-not-run' },
      idempotency_key: 'provisional-task',
    });
    assert.equal(deniedCall.error?.code, 'PERMISSION_DENIED');
    assert.equal(calls.length, 0);

    db.prepare(
      `INSERT INTO sessions
        (id, name, type, workspace_id, executor, agent_id, approval_mode,
         status, archived, unread, native_session_id, created_at, updated_at)
       VALUES
        ('session-new', 'New', 'primary', 'workspace-1', 'codex', 'agent-new', 'ask',
         'new', 0, 0, 'native-new', datetime('now'), datetime('now'))`,
    ).run();
    const active = manager.activateProvisionalInternalSession(issued.credentialId);
    assert.equal(active.provisioning, undefined);
    assert.equal(manager.authenticate(`Bearer ${issued.token}`)?.provisioning, undefined);
    const stored = db.prepare(
      'SELECT token_hash, renewable FROM tool_credentials WHERE id = ?',
    ).get(issued.credentialId) as { token_hash: string; renewable: number };
    assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(stored.renewable, 1);
    assert.equal(JSON.stringify(stored).includes(issued.token), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renewable internal credentials slide before expiry and restart revocation cuts them off', () => {
  const { db, dir } = fixture();
  try {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const manager = new GianToolCredentialManager(db, () => new Date(now));
    const issued = manager.issueInternalSession({
      sessionId: 'session-1',
      role: 'admin',
      ttlMs: 10 * 24 * 60 * 60 * 1_000,
      renewable: true,
    });
    const originalExpiry = issued.actor.expiresAt;
    now += 4 * 24 * 60 * 60 * 1_000;
    const renewed = manager.authenticate(`Bearer ${issued.token}`);
    assert.ok(renewed && renewed.expiresAt > originalExpiry);
    assert.equal(
      (db.prepare('SELECT renewable FROM tool_credentials WHERE id = ?')
        .get(issued.credentialId) as { renewable: number }).renewable,
      1,
    );
    assert.equal(manager.revokeAllInternalSessions(), 1);
    assert.equal(manager.authenticate(`Bearer ${issued.token}`), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gian Tool credentials distinguish external callers and revoke without exposing raw tokens', () => {
  const { db, dir } = fixture();
  try {
    const manager = new GianToolCredentialManager(
      db,
      () => new Date('2026-08-26T00:00:00.000Z'),
    );
    const issued = manager.issueExternalController({
      clientId: 'local-codex',
      grants: ['task.list', 'session.get'],
      ttlMs: 60_000,
    });
    const actor = manager.authenticate(`Bearer ${issued.token}`);
    assert.equal(actor?.kind, 'external_controller');
    assert.equal(actor?.callerId, 'external-controller:local-codex');
    db.prepare('UPDATE tool_credentials SET grants_json = ? WHERE id = ?')
      .run(JSON.stringify(['task.create']), issued.credentialId);
    assert.equal(manager.authenticate(`Bearer ${issued.token}`), null, 'role/grant corruption fails closed');
    db.prepare('UPDATE tool_credentials SET grants_json = ? WHERE id = ?')
      .run(JSON.stringify(['session.get', 'task.list']), issued.credentialId);
    assert.equal(manager.revoke(issued.credentialId), true);
    assert.equal(manager.revoke(issued.credentialId), false);
    assert.equal(manager.authenticate(`Bearer ${issued.token}`), null);

    assert.throws(() => manager.issueInternalSession({
      sessionId: 'session-1',
      grants: ['task.create'],
      ttlMs: 60_000,
    }), /requires an administrator credential/);
    const admin = manager.issueExternalController({
      clientId: 'admin-codex',
      role: 'admin',
      grants: ['task.create', 'task.update', 'interaction.respond'],
      ttlMs: 60_000,
    });
    assert.equal(admin.actor.role, 'admin');
    assert.equal(manager.authenticate(`Bearer ${admin.token}`)?.role, 'admin');
    assert.throws(() => manager.issueExternalController({
      clientId: 'unsafe\nclient',
      grants: ['task.list'],
      ttlMs: 60_000,
    }), /safe 1 to 200 character identifier/);
    const externalDefaults = manager.issueExternalController({
      clientId: 'external-defaults',
      role: 'admin',
      ttlMs: 60_000,
    });
    assert.equal(externalDefaults.actor.grants.includes('worktree.create_and_bind'), false);
    assert.throws(() => manager.issueExternalController({
      clientId: 'external-self-context',
      role: 'admin',
      grants: ['worktree.create_and_bind'],
      ttlMs: 60_000,
    }), /requires an internal Session credential/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ordinary reads are global while grants still fail closed', async () => {
  const { db, dir } = fixture();
  try {
    const manager = new GianToolCredentialManager(db);
    const { actor } = manager.issueInternalSession({
      sessionId: 'session-1',
      grants: ['session.get', 'interaction.list'],
      ttlMs: 60_000,
    });
    const calls: unknown[] = [];
    const service = {
      call: async (call: unknown) => {
        calls.push(call);
        return { ok: true, request_id: 'request-1', data: { ok: true } };
      },
    } as unknown as GianToolService;
    const access = new GianToolAccessController(service, db);

    const own = await access.call(actor, {
      request_id: 'request-1',
      method: 'session.get',
      params: { session_id: 'session-1' },
    });
    assert.equal(own.ok, true);
    assert.deepEqual(calls[0], {
      request_id: 'request-1',
      caller_id: 'internal-session:session-1',
      method: 'session.get',
      params: { session_id: 'session-1' },
    });

    const other = await access.call(actor, {
      request_id: 'request-2',
      method: 'session.get',
      params: { session_id: 'session-2' },
    });
    assert.equal(other.ok, true);
    assert.equal(calls.length, 2);

    const ungranted = await access.call(actor, {
      request_id: 'request-3',
      method: 'session.stop',
      params: { session_id: 'session-1' },
      idempotency_key: 'not-granted',
    });
    assert.equal(ungranted.error?.code, 'PERMISSION_DENIED');
    assert.equal(calls.length, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
