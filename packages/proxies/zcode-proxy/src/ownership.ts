/**
 * Native session ownership + request ledger (Revision 2 §5, §9, §11, §12).
 *
 * Ownership: `detached -> attaching -> idle-owned -> running-owned /
 * waiting-interaction -> idle-owned -> detached`. Only idle native sessions may
 * be adopted; ownership is exclusive per nativeSessionId inside this proxy and
 * persisted so a proxy restart restores the mapping without re-driving ZCode.
 *
 * Persistence lives under GIAN_PLUGIN_DATA_DIR, holds identity metadata only
 * (no prompts, no tool output, no credentials), and is written atomically.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type OwnershipState =
  | 'detached'
  | 'attaching'
  | 'idle-owned'
  | 'running-owned'
  | 'waiting-interaction'
  | 'quarantined';

export interface SessionRecord {
  /** Gian-assigned session id. */
  sessionId: string;
  /** Current attach generation. */
  streamId: string;
  /** ZCode native session id (`sess_uuid`). */
  nativeSessionId: string;
  /** Runtime fingerprint the mapping was created under. */
  runtimeKey: string;
  state: OwnershipState;
  /** Session-bound config snapshot (always {} in v1; all options are turn-bound). */
  sessionConfig: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
  /** Last confirmed native settings snapshot for restore-on-failure (§7.4). */
  confirmedNativeSettings: {
    model?: { providerId: string; modelId: string };
    thoughtLevel?: string;
    mode?: string;
  };
  /** Outer turn currently running, if any. */
  activeTurnId: string | null;
  /** Native turn id bound to the active outer turn. */
  activeNativeTurnId: string | null;
}

export interface PersistedOwnershipFile {
  schemaVersion: 1;
  sessions: Array<PersistedSessionRecord>;
}

interface PersistedSessionRecord {
  sessionId: string;
  nativeSessionId: string;
  runtimeKey: string;
  state: OwnershipState;
  updatedAt: string;
}

const MAX_PERSISTED_SESSIONS = 500;

export class SessionRegistryError extends Error {
  readonly domainCode: string;
  readonly retryable: boolean;
  constructor(domainCode: string, message: string, retryable = false) {
    super(message);
    this.name = 'SessionRegistryError';
    this.domainCode = domainCode;
    this.retryable = retryable;
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  /** nativeSessionId -> sessionId, so ownership stays exclusive. */
  private readonly byNative = new Map<string, string>();

  constructor(private readonly dataDir: string | null) {
    this.load();
  }

  private get file(): string | null {
    return this.dataDir === null ? null : join(this.dataDir, 'zcode-ownership.json');
  }

  private load(): void {
    const file = this.file;
    if (file === null || existsSync(file) === false) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PersistedOwnershipFile;
      if (parsed.schemaVersion !== 1 || Array.isArray(parsed.sessions) === false) return;
      for (const record of parsed.sessions.slice(0, MAX_PERSISTED_SESSIONS)) {
        if (typeof record.sessionId !== 'string' || typeof record.nativeSessionId !== 'string') continue;
        if (record.state === 'running-owned' || record.state === 'attaching') {
          // Crash during a running turn: the turn's outcome is unknown, so the
          // session comes back stale-idle and MUST NOT be auto-re-driven.
          record.state = 'quarantined';
        }
        this.sessions.set(record.sessionId, {
          sessionId: record.sessionId,
          streamId: `stale-${record.sessionId}`,
          nativeSessionId: record.nativeSessionId,
          runtimeKey: record.runtimeKey,
          state: record.state,
          sessionConfig: {},
          confirmedNativeSettings: {},
          activeTurnId: null,
          activeNativeTurnId: null,
          createdAt: record.updatedAt,
          updatedAt: record.updatedAt,
        });
        if (this.byNative.has(record.nativeSessionId) === false) {
          this.byNative.set(record.nativeSessionId, record.sessionId);
        }
      }
    } catch {
      // Corrupt ownership file: start clean; native sessions remain usable.
    }
  }

  private persist(): void {
    const file = this.file;
    if (file === null) return;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const payload: PersistedOwnershipFile = {
        schemaVersion: 1,
        sessions: [...this.sessions.values()].slice(-MAX_PERSISTED_SESSIONS).map((record) => ({
          sessionId: record.sessionId,
          nativeSessionId: record.nativeSessionId,
          runtimeKey: record.runtimeKey,
          state: record.state,
          updatedAt: record.updatedAt,
        })),
      };
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // Persistence is best-effort; in-memory state remains authoritative.
    }
  }

  private touch(record: SessionRecord): void {
    record.updatedAt = new Date().toISOString();
    this.persist();
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new SessionRegistryError('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    }
    return record;
  }

  requireStream(sessionId: string, streamId: string): SessionRecord {
    const record = this.requireSession(sessionId);
    if (record.streamId !== streamId) {
      throw new SessionRegistryError('SESSION_STALE', `Stream ${streamId} is no longer active.`);
    }
    return record;
  }

  byNativeSession(nativeSessionId: string): SessionRecord | undefined {
    const sessionId = this.byNative.get(nativeSessionId);
    return sessionId === undefined ? undefined : this.sessions.get(sessionId);
  }

  activeRecords(): SessionRecord[] {
    return [...this.sessions.values()].filter((record) => record.activeTurnId !== null);
  }

  records(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  /** Claim an exclusive attach slot for a native session. */
  beginAttach(sessionId: string, nativeSessionId: string, runtimeKey: string): SessionRecord {
    const existingOwner = this.byNative.get(nativeSessionId);
    if (existingOwner !== undefined && existingOwner !== sessionId) {
      throw new SessionRegistryError(
        'SESSION_BUSY',
        'Native session is already owned by another Gian session.',
      );
    }
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined && existing.nativeSessionId !== nativeSessionId) {
      throw new SessionRegistryError('CONFLICT', 'Session id was reused for a different native session.');
    }
    const now = new Date().toISOString();
    const record: SessionRecord = existing ?? {
      sessionId,
      streamId: `stream-${randomId()}`,
      nativeSessionId,
      runtimeKey,
      state: 'attaching',
      sessionConfig: {},
      confirmedNativeSettings: {},
      activeTurnId: null,
      activeNativeTurnId: null,
      createdAt: now,
      updatedAt: now,
    };
    if (existing === undefined) this.sessions.set(sessionId, record);
    record.state = 'attaching';
    this.byNative.set(nativeSessionId, sessionId);
    this.touch(record);
    return record;
  }

  markOwned(record: SessionRecord): void {
    record.state = record.activeTurnId !== null ? 'running-owned' : 'idle-owned';
    this.touch(record);
  }

  markRunning(record: SessionRecord, turnId: string, nativeTurnId: string | null): void {
    record.activeTurnId = turnId;
    record.activeNativeTurnId = nativeTurnId;
    record.state = 'running-owned';
    this.touch(record);
  }

  markWaitingInteraction(record: SessionRecord): void {
    if (record.state === 'running-owned') record.state = 'waiting-interaction';
    this.touch(record);
  }

  markIdle(record: SessionRecord): void {
    record.activeTurnId = null;
    record.activeNativeTurnId = null;
    record.state = 'idle-owned';
    this.touch(record);
  }

  /** Outer detach: never calls inner close (WP0 G7: destructive on empty
   *  sessions); drops the adapter mapping and releases ownership. */
  detach(sessionId: string, streamId: string): SessionRecord {
    const record = this.requireStream(sessionId, streamId);
    if (record.state === 'running-owned' || record.state === 'waiting-interaction') {
      throw new SessionRegistryError('SESSION_BUSY', 'Cannot detach while a turn is active.');
    }
    this.sessions.delete(sessionId);
    if (this.byNative.get(record.nativeSessionId) === sessionId) {
      this.byNative.delete(record.nativeSessionId);
    }
    this.persist();
    return record;
  }

  /** Roll back a failed attach: drop everything including the claimed name. */
  detachForce(record: SessionRecord): void {
    this.sessions.delete(record.sessionId);
    if (this.byNative.get(record.nativeSessionId) === record.sessionId) {
      this.byNative.delete(record.nativeSessionId);
    }
    this.persist();
  }

  quarantine(record: SessionRecord, reason: string): void {
    record.state = 'quarantined';
    record.activeTurnId = null;
    record.activeNativeTurnId = null;
    void reason;
    this.touch(record);
  }

  newStreamId(record: SessionRecord): string {
    record.streamId = `stream-${randomId()}`;
    this.touch(record);
    return record.streamId;
  }
}

export function randomId(): string {
  return createHash('sha256')
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest('base64url')
    .slice(0, 24);
}

export interface TurnLedgerEntry {
  turnId: string;
  fingerprint: string;
  accepted: boolean;
}

/** Per-session turn idempotency ledger (contract §11.2). */
export class TurnLedger {
  private readonly entries = new Map<string, TurnLedgerEntry>();

  private key(sessionId: string, streamId: string, turnId: string): string {
    return `${sessionId}\u0000${streamId}\u0000${turnId}`;
  }

  static fingerprint(input: unknown, config: unknown): string {
    return createHash('sha256').update(JSON.stringify({ input, config })).digest('hex');
  }

  observe(sessionId: string, streamId: string, turnId: string, fingerprint: string): 'new' | 'duplicate' {
    const key = this.key(sessionId, streamId, turnId);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new SessionRegistryError('CONFLICT', `Turn ${turnId} was reused with different input.`);
      }
      return 'duplicate';
    }
    this.entries.set(key, { turnId, fingerprint, accepted: false });
    return 'new';
  }

  markAccepted(sessionId: string, streamId: string, turnId: string): void {
    const existing = this.entries.get(this.key(sessionId, streamId, turnId));
    if (existing) existing.accepted = true;
  }

  forget(sessionId: string, streamId: string, turnId: string): void {
    this.entries.delete(this.key(sessionId, streamId, turnId));
  }

  forgetStream(sessionId: string, streamId: string): void {
    const prefix = `${sessionId}\u0000${streamId}\u0000`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

/** responseId -> fingerprint map for interaction.respond idempotency (§11.2). */
export class InteractionResponseLedger {
  private readonly entries = new Map<string, string>();

  observe(responseId: string, fingerprint: string): 'new' | 'duplicate' {
    const existing = this.entries.get(responseId);
    if (existing !== undefined) {
      if (existing !== fingerprint) {
        throw new SessionRegistryError(
          'CONFLICT',
          `Response ${responseId} was reused with different content.`,
        );
      }
      return 'duplicate';
    }
    this.entries.set(responseId, fingerprint);
    return 'new';
  }
}
