import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  GIAN_TOOL_METHODS,
  type GianToolMethod,
} from '@gian/shared';
import type { Db } from '../storage/db.js';

const TOKEN_PREFIX = 'gian_mcp_v1';
const TOKEN_SECRET_BYTES = 32;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const PROVISIONAL_TTL_MS = 2 * 60_000;
const INTERNAL_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const DUMMY_HASH = createHash('sha256').update('gian-tool-invalid-credential').digest();
const KNOWN_METHODS = new Set<string>(GIAN_TOOL_METHODS);
const ADMIN_ONLY_METHODS = new Set<GianToolMethod>(['task.create', 'task.update']);
const INTERNAL_ONLY_METHODS = new Set<GianToolMethod>(['worktree.create_and_bind']);

export type GianToolRole = 'standard' | 'admin';

export function defaultGianToolGrants(role: GianToolRole): GianToolMethod[] {
  return GIAN_TOOL_METHODS.filter(method => role === 'admin' || !ADMIN_ONLY_METHODS.has(method));
}

export type GianToolActor = GianToolInternalSessionActor | GianToolExternalControllerActor;

export interface GianToolActorBase {
  credentialId: string;
  callerId: string;
  role: GianToolRole;
  grants: GianToolMethod[];
  expiresAt: string;
  /** Provisioning actors may complete MCP discovery, but Tool calls are
   *  denied until the canonical Session row is committed. */
  provisioning?: true;
}

export interface GianToolInternalSessionActor extends GianToolActorBase {
  kind: 'internal_session';
  sessionId: string;
  agentId: string | null;
  workspaceId: string | null;
  taskId: string | null;
}

export interface GianToolExternalControllerActor extends GianToolActorBase {
  kind: 'external_controller';
  clientId: string;
}

export interface IssuedGianToolCredential {
  credentialId: string;
  token: string;
  actor: GianToolActor;
}

interface CredentialRow {
  id: string;
  token_hash: string;
  actor_kind: string;
  session_id: string | null;
  client_id: string | null;
  caller_id: string;
  role: string;
  grants_json: string;
  expires_at: string;
  revoked_at: string | null;
  renewable: number;
  agent_id: string | null;
  workspace_id: string | null;
  task_id: string | null;
  live_session_id: string | null;
}

interface ProvisionalInternalCredential {
  tokenHash: Buffer;
  actor: GianToolInternalSessionActor & { provisioning: true };
  issuedAt: string;
  finalTtlMs: number;
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function parseCredentialId(token: string): string | null {
  if (token.length > 512) return null;
  const match = token.match(/^gian_mcp_v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
  return match?.[1] ?? null;
}

function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  return token.length > 0 && token === token.trim() ? token : null;
}

function grants(value: readonly GianToolMethod[], role: GianToolRole): GianToolMethod[] {
  if (value.length === 0) throw new Error('Gian Tool credential requires at least one method grant');
  const unique = [...new Set(value)];
  for (const method of unique) {
    if (!KNOWN_METHODS.has(method)) throw new Error(`unknown Gian Tool grant: ${method}`);
    if (role === 'standard' && ADMIN_ONLY_METHODS.has(method)) {
      throw new Error(`${method} requires an administrator credential`);
    }
  }
  return unique.sort((a, b) => a.localeCompare(b));
}

function storedGrants(json: string): GianToolMethod[] | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value) || value.length === 0) return null;
    if (!value.every(method => typeof method === 'string' && KNOWN_METHODS.has(method))) return null;
    return [...new Set(value as GianToolMethod[])];
  } catch {
    return null;
  }
}

function expiresAt(now: Date, ttlMs: number): string {
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new Error(`credential ttl_ms must be ${MIN_TTL_MS} to ${MAX_TTL_MS}`);
  }
  return new Date(now.getTime() + ttlMs).toISOString();
}

export class GianToolCredentialManager {
  private readonly provisional = new Map<string, ProvisionalInternalCredential>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  issueInternalSession(input: {
    sessionId: string;
    role?: GianToolRole;
    grants?: readonly GianToolMethod[];
    ttlMs: number;
    renewable?: boolean;
  }): IssuedGianToolCredential {
    const session = this.db.prepare(
      'SELECT id, agent_id, workspace_id, task_id FROM sessions WHERE id = ?',
    ).get(input.sessionId) as {
      id: string;
      agent_id: string | null;
      workspace_id: string | null;
      task_id: string | null;
    } | undefined;
    if (!session) throw new Error(`session not found: ${input.sessionId}`);
    const role = input.role ?? 'standard';
    const allowed = grants(input.grants ?? defaultGianToolGrants(role), role);
    return this.issue({
      kind: 'internal_session',
      sessionId: session.id,
      agentId: session.agent_id,
      workspaceId: session.workspace_id,
      taskId: session.task_id,
      role,
      grants: allowed,
      ttlMs: input.ttlMs,
      renewable: input.renewable === true,
    });
  }

  issueProvisionalInternalSession(input: {
    sessionId: string;
    agentId: string | null;
    workspaceId: string | null;
    taskId: string | null;
    role?: GianToolRole;
    grants?: readonly GianToolMethod[];
    ttlMs: number;
  }): IssuedGianToolCredential {
    // Validate the durable lease now even though the short provisioning lease
    // is kept only in this Host process.
    expiresAt(this.now(), input.ttlMs);
    const role = input.role ?? 'standard';
    const allowed = grants(input.grants ?? defaultGianToolGrants(role), role);
    const credentialId = randomUUID();
    const token = `${TOKEN_PREFIX}.${credentialId}.${randomBytes(TOKEN_SECRET_BYTES).toString('base64url')}`;
    const issuedAt = this.now();
    const actor: GianToolInternalSessionActor & { provisioning: true } = {
      kind: 'internal_session',
      credentialId,
      callerId: `internal-session:${input.sessionId}`,
      role,
      sessionId: input.sessionId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      grants: allowed,
      expiresAt: new Date(issuedAt.getTime() + PROVISIONAL_TTL_MS).toISOString(),
      provisioning: true,
    };
    this.provisional.set(credentialId, {
      tokenHash: tokenHash(token),
      actor,
      issuedAt: issuedAt.toISOString(),
      finalTtlMs: input.ttlMs,
    });
    return { credentialId, token, actor };
  }

  activateProvisionalInternalSession(credentialId: string): GianToolInternalSessionActor {
    const pending = this.provisional.get(credentialId);
    if (!pending) throw new Error('provisional Gian Tool credential is unavailable');
    if (Date.parse(pending.actor.expiresAt) <= this.now().getTime()) {
      this.provisional.delete(credentialId);
      throw new Error('provisional Gian Tool credential expired before activation');
    }
    const session = this.db.prepare(
      'SELECT id, agent_id, workspace_id, task_id FROM sessions WHERE id = ?',
    ).get(pending.actor.sessionId) as {
      id: string;
      agent_id: string | null;
      workspace_id: string | null;
      task_id: string | null;
    } | undefined;
    if (!session
      || session.agent_id !== pending.actor.agentId
      || session.workspace_id !== pending.actor.workspaceId
      || session.task_id !== pending.actor.taskId) {
      throw new Error('provisional Gian Tool credential does not match the committed Session');
    }
    const expiry = expiresAt(this.now(), pending.finalTtlMs);
    this.db.prepare(
      `INSERT INTO tool_credentials
        (id, token_hash, actor_kind, session_id, client_id, caller_id, role,
         grants_json, issued_at, expires_at, revoked_at, renewable)
       VALUES (?, ?, 'internal_session', ?, NULL, ?, ?, ?, ?, ?, NULL, 1)`,
    ).run(
      credentialId,
      pending.tokenHash.toString('hex'),
      session.id,
      pending.actor.callerId,
      pending.actor.role,
      JSON.stringify(pending.actor.grants),
      pending.issuedAt,
      expiry,
    );
    this.provisional.delete(credentialId);
    const { provisioning: _provisioning, ...actor } = pending.actor;
    return { ...actor, expiresAt: expiry };
  }

  issueExternalController(input: {
    clientId: string;
    role?: GianToolRole;
    grants?: readonly GianToolMethod[];
    ttlMs: number;
  }): IssuedGianToolCredential {
    const clientId = input.clientId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(clientId)) {
      throw new Error('external controller client_id must be a safe 1 to 200 character identifier');
    }
    const role = input.role ?? 'standard';
    const requested = input.grants
      ?? defaultGianToolGrants(role).filter(method => !INTERNAL_ONLY_METHODS.has(method));
    if (requested.some(method => INTERNAL_ONLY_METHODS.has(method))) {
      throw new Error('worktree.create_and_bind requires an internal Session credential');
    }
    return this.issue({
      kind: 'external_controller',
      clientId,
      role,
      grants: grants(requested, role),
      ttlMs: input.ttlMs,
    });
  }

  authenticate(authorization: string | null | undefined): GianToolActor | null {
    const token = bearerToken(authorization);
    const id = token ? parseCredentialId(token) : null;
    const row = id ? this.row(id) : undefined;
    const pending = id ? this.provisional.get(id) : undefined;
    const actualHash = token ? tokenHash(token) : DUMMY_HASH;
    const expectedHash = row && /^[0-9a-f]{64}$/.test(row.token_hash)
      ? Buffer.from(row.token_hash, 'hex')
      : pending
        ? pending.tokenHash
        : DUMMY_HASH;
    if (!timingSafeEqual(actualHash, expectedHash)) return null;
    if (pending) {
      if (Date.parse(pending.actor.expiresAt) <= this.now().getTime()) {
        this.provisional.delete(pending.actor.credentialId);
        return null;
      }
      return { ...pending.actor, grants: [...pending.actor.grants] };
    }
    if (!row) return null;
    const expiry = Date.parse(row.expires_at);
    if (row.revoked_at !== null || !Number.isFinite(expiry) || expiry <= this.now().getTime()) return null;
    const parsedGrants = storedGrants(row.grants_json);
    if (!parsedGrants) return null;
    if (row.role === 'standard' && parsedGrants.some(method => ADMIN_ONLY_METHODS.has(method))) return null;
    const actor = this.actor(row, parsedGrants);
    if (!actor || actor.kind !== 'internal_session' || row.renewable !== 1) return actor;
    if (expiry - this.now().getTime() > INTERNAL_RENEWAL_WINDOW_MS) return actor;
    const renewedExpiry = expiresAt(this.now(), MAX_TTL_MS);
    const result = this.db.prepare(
      `UPDATE tool_credentials SET expires_at = ?
       WHERE id = ? AND revoked_at IS NULL AND expires_at = ?`,
    ).run(renewedExpiry, row.id, row.expires_at);
    return result.changes === 1 ? { ...actor, expiresAt: renewedExpiry } : actor;
  }

  revoke(credentialId: string): boolean {
    if (this.provisional.delete(credentialId)) return true;
    const result = this.db.prepare(
      'UPDATE tool_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ).run(this.now().toISOString(), credentialId);
    return result.changes > 0;
  }

  revokeSession(sessionId: string): number {
    let provisional = 0;
    for (const [credentialId, pending] of this.provisional) {
      if (pending.actor.sessionId !== sessionId) continue;
      this.provisional.delete(credentialId);
      provisional += 1;
    }
    const result = this.db.prepare(
      `UPDATE tool_credentials SET revoked_at = ?
       WHERE session_id = ? AND revoked_at IS NULL`,
    ).run(this.now().toISOString(), sessionId);
    return result.changes + provisional;
  }

  revokeAllInternalSessions(): number {
    const provisional = this.provisional.size;
    this.provisional.clear();
    const result = this.db.prepare(
      `UPDATE tool_credentials SET revoked_at = ?
       WHERE actor_kind = 'internal_session' AND revoked_at IS NULL`,
    ).run(this.now().toISOString());
    return result.changes + provisional;
  }

  private issue(input: ({
    kind: 'internal_session';
    sessionId: string;
    agentId: string | null;
    workspaceId: string | null;
    taskId: string | null;
  } | {
    kind: 'external_controller';
    clientId: string;
  }) & {
    grants: GianToolMethod[];
    role: GianToolRole;
    ttlMs: number;
    renewable?: boolean;
  }): IssuedGianToolCredential {
    const credentialId = randomUUID();
    const token = `${TOKEN_PREFIX}.${credentialId}.${randomBytes(TOKEN_SECRET_BYTES).toString('base64url')}`;
    const issuedAt = this.now();
    const expiry = expiresAt(issuedAt, input.ttlMs);
    const callerId = input.kind === 'internal_session'
      ? `internal-session:${input.sessionId}`
      : `external-controller:${input.clientId}`;
    this.db.prepare(
      `INSERT INTO tool_credentials
        (id, token_hash, actor_kind, session_id, client_id, caller_id, role,
         grants_json, issued_at, expires_at, revoked_at, renewable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      credentialId,
      tokenHash(token).toString('hex'),
      input.kind,
      input.kind === 'internal_session' ? input.sessionId : null,
      input.kind === 'external_controller' ? input.clientId : null,
      callerId,
      input.role,
      JSON.stringify(input.grants),
      issuedAt.toISOString(),
      expiry,
      input.renewable === true ? 1 : 0,
    );
    const actor: GianToolActor = input.kind === 'internal_session'
      ? {
          kind: 'internal_session',
          credentialId,
          callerId,
          role: input.role,
          sessionId: input.sessionId,
          agentId: input.agentId,
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          grants: [...input.grants],
          expiresAt: expiry,
        }
      : {
          kind: 'external_controller',
          credentialId,
          callerId,
          role: input.role,
          clientId: input.clientId,
          grants: [...input.grants],
          expiresAt: expiry,
        };
    return { credentialId, token, actor };
  }

  private row(id: string): CredentialRow | undefined {
    return this.db.prepare(
      `SELECT c.id, c.token_hash, c.actor_kind, c.session_id, c.client_id,
              c.caller_id, c.role, c.grants_json, c.expires_at, c.revoked_at,
              c.renewable, s.id AS live_session_id, s.agent_id, s.workspace_id, s.task_id
         FROM tool_credentials c
         LEFT JOIN sessions s ON s.id = c.session_id
        WHERE c.id = ?`,
    ).get(id) as CredentialRow | undefined;
  }

  private actor(row: CredentialRow, allowed: GianToolMethod[]): GianToolActor | null {
    if ((row.role !== 'standard' && row.role !== 'admin')) return null;
    if (row.actor_kind === 'internal_session' && row.session_id && row.live_session_id === row.session_id) {
      return {
        kind: 'internal_session',
        credentialId: row.id,
        callerId: row.caller_id,
        role: row.role,
        sessionId: row.session_id,
        agentId: row.agent_id,
        workspaceId: row.workspace_id,
        taskId: row.task_id,
        grants: allowed,
        expiresAt: row.expires_at,
      };
    }
    if (row.actor_kind === 'external_controller' && row.client_id) {
      return {
        kind: 'external_controller',
        credentialId: row.id,
        callerId: row.caller_id,
        role: row.role,
        clientId: row.client_id,
        grants: allowed,
        expiresAt: row.expires_at,
      };
    }
    return null;
  }
}
