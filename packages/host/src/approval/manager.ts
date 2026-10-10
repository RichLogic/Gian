import { randomUUID } from 'node:crypto';
import type {
  ApprovalCategory,
  ApprovalDecision,
  ApprovalResolvedBy,
  ApprovalStatus,
  AttentionMessage,
} from '@gian/shared';
import type { WsBroadcaster } from '../web/ws-broadcast.js';

export interface ApprovalRequest {
  sessionId: string;
  turnId: string;
  /** Canonical Gian turn ordinal for Host-local interaction projection. */
  turnNumber?: number;
  category: ApprovalCategory;
  risk: 'low' | 'medium' | 'high';
  description: string;
  subject?: string;
  /** Display title already carried by the projected interaction. */
  title?: string;
  /** Proxy tool name. v2 permissions otherwise arrive as category `other`. */
  toolName?: string;
  /** Projected display type. Question comes only from this or category `question`. */
  projected?: 'question' | 'approval';
  payload?: Record<string, unknown>;
  nativeOptions?: import('@gian/shared').NativeApprovalOption[];
  /** Prebuilt generic notification. Broadcast only after the request is known
   *  to be pending; auto-approved requests intentionally ignore it. */
  attention?: AttentionMessage;
}

export interface ApprovalRecord extends ApprovalRequest {
  id: string;
  status: ApprovalStatus;
  resolvedBy?: ApprovalResolvedBy;
  resolvedAt?: number;
  createdAt: number;
}

/**
 * Callback type for responding to proxies — injected by SessionManager to
 * avoid a circular import (ApprovalManager ↔ SessionManager would form a cycle
 * if we imported SessionManager directly).
 */
export type RespondApprovalFn = (
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
) => Promise<void>;

export type GetApprovalModeFn = (
  sessionId: string,
) => import('@gian/shared').ApprovalMode | null;

/** `fresh` is the first pending record for this session and interaction in this process.
 *  `joined` means that pair is already waiting. Auto-approve does not call the mirror.
 *  A replayed provider event never reaches it. */
export type SessionInboxDelivery = 'fresh' | 'joined';

/** A persisted interaction.resolved, including one whose pending record is gone. */
export interface SessionInboxPersistedResolution {
  sessionId: string;
  interactionId: string;
  /** Host turn the resolved event was stored on. */
  turnId: string;
  /** Provider event id of this resolved notification. Empty when the event has none. */
  providerEventId: string;
  decision: ApprovalDecision;
  /** Raw interaction outcome. Display decision is not a substitute. */
  outcome: string | null;
  /**
   * True only when this process consumed a web, im, or tool resolution source.
   * Auto, missing, and recovered sources stay false and must not mark the row read.
   */
  userSource: boolean;
  by: ApprovalResolvedBy;
}

/** Inbox read state follows only an explicit user surface. `auto` is not one. */
export function isInboxUserResolutionSource(
  source: ApprovalResolvedBy | undefined,
): boolean {
  return source === 'web' || source === 'im' || source === 'tool';
}

export interface SessionInboxMirror {
  onPending(record: ApprovalRecord, delivery: SessionInboxDelivery): void;
  /**
   * Durability gate for a local-only user decision, invoked before any state
   * is released. Implementations throw on a transient persistence failure;
   * the resolution then stays pending and the guarded action must not run.
   */
  onLocalResolved(record: ApprovalRecord, decision: ApprovalDecision, by: ApprovalResolvedBy): void;
  onResolved(record: ApprovalRecord, decision: ApprovalDecision, by: ApprovalResolvedBy): void;
  onLocalCleared(record: ApprovalRecord): void;
  /** Close an inbox row that is already stored. Does not require a live record. */
  onPersistedResolved(resolution: SessionInboxPersistedResolution): void;
  /** The named host turn row is already terminal. The mirror closes that occurrence. */
  onHostTurnTerminal(sessionId: string, turnId: string): void;
}

/** A lookup or mutation named only an interaction id that is live in more than one session. */
export class ApprovalScopeError extends Error {
  readonly code = 'AMBIGUOUS_APPROVAL' as const;

  constructor() {
    super('approval id matches more than one session');
    this.name = 'ApprovalScopeError';
  }
}

function approvalScopeKey(sessionId: string, approvalId: string): string {
  return `${sessionId.length}:${sessionId}${approvalId.length}:${approvalId}`;
}

function parseApprovalScopeKey(key: string): { sessionId: string; approvalId: string } | null {
  const sessionMark = key.indexOf(':');
  if (sessionMark <= 0) return null;
  const sessionLength = Number(key.slice(0, sessionMark));
  if (!Number.isInteger(sessionLength) || sessionLength < 1) return null;
  const sessionStart = sessionMark + 1;
  const sessionId = key.slice(sessionStart, sessionStart + sessionLength);
  if (sessionId.length !== sessionLength) return null;
  const rest = key.slice(sessionStart + sessionLength);
  const idMark = rest.indexOf(':');
  if (idMark <= 0) return null;
  const idLength = Number(rest.slice(0, idMark));
  const approvalId = rest.slice(idMark + 1);
  if (!Number.isInteger(idLength) || approvalId.length !== idLength) return null;
  return { sessionId, approvalId };
}

export class ApprovalManager {
  private pending = new Map<string, ApprovalRecord>();
  private sessionAllowed = new Map<string, Set<ApprovalCategory>>();
  private resolvers = new Map<string, Array<(decision: ApprovalDecision) => void>>();
  private resolutionSources = new Map<string, ApprovalResolvedBy>();

  private respondFn: RespondApprovalFn | null = null;
  private getModeFn: GetApprovalModeFn | null = null;
  private sessionInbox: SessionInboxMirror | null = null;

  constructor(private broadcaster: WsBroadcaster) {}

  /**
   * Injected post-construction to break the circular dependency:
   * SessionManager → ApprovalManager → SessionManager.respondApproval.
   */
  setRespondFn(fn: RespondApprovalFn): void {
    this.respondFn = fn;
  }

  setGetModeFn(fn: GetApprovalModeFn): void {
    this.getModeFn = fn;
  }

  setSessionInbox(mirror: SessionInboxMirror | null): void {
    this.sessionInbox = mirror;
  }

  /**
   * Called from SessionManager.afterUnified for every approval_requested event.
   * Applies mode/risk/allow_session policy; auto-approves when appropriate,
   * otherwise registers as pending and waits for the user.
   */
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (!this.inboxUserPending(req)) return this.autoApprove(req);
    return this.registerPending(req);
  }

  /**
   * Whether this request is a user todo. The projection fact uses the same
   * answer inside the event transaction, so auto-approve is never stored as
   * a recoverable inbox open.
   * Questions, plan review, an unapproved browser capture, and any request
   * that carries native options need a real choice. Mode, session allow, and
   * low risk auto-approve only the remainder.
   */
  inboxUserPending(
    req: Pick<ApprovalRequest, 'sessionId' | 'category' | 'risk' | 'nativeOptions'>,
  ): boolean {
    const mode = this.getModeFn?.(req.sessionId) ?? 'ask';
    const browserCaptureApproved = req.category === 'browser_capture'
      && this.wasAllowedForSession(req.sessionId, req.category);
    const requiresUser = req.category === 'question'
      || req.category === 'exit_plan_mode'
      || (req.category === 'browser_capture' && !browserCaptureApproved)
      || (req.nativeOptions?.length ?? 0) > 0;
    if (
      !requiresUser
      && (
        mode === 'auto'
        || this.wasAllowedForSession(req.sessionId, req.category)
        || req.risk === 'low'
      )
    ) {
      return false;
    }
    return true;
  }

  private async autoApprove(req: ApprovalRequest): Promise<ApprovalDecision> {
    const record: ApprovalRecord = {
      ...req,
      id: req.payload?.approvalId as string ?? randomUUID(),
      status: 'auto-approved',
      resolvedBy: 'auto',
      resolvedAt: Date.now(),
      createdAt: Date.now(),
    };

    this.broadcaster.broadcast({
      type: 'approval:created',
      approval: {
        id: record.id,
        session_id: record.sessionId,
        category: record.category,
        description: record.description,
        status: 'auto-approved',
        ...(record.turnNumber !== undefined ? { turn_number: record.turnNumber } : {}),
        ...(record.nativeOptions ? { native_options: record.nativeOptions } : {}),
      },
    });

    // Respond to the proxy immediately.
    try {
      if (req.payload?.['localOnly'] !== true) {
        await this.respondFn?.(req.sessionId, record.id, 'allow_once');
      }
    } catch (err) {
      console.error('[approval] auto-approve respondFn failed', err);
    }

    return 'allow_once';
  }

  private registerPending(req: ApprovalRequest): Promise<ApprovalDecision> {
    const id = req.payload?.approvalId as string ?? randomUUID();
    const key = approvalScopeKey(req.sessionId, id);
    if (this.pending.has(key)) {
      const existing = this.pending.get(key);
      const pendingDecision = new Promise<ApprovalDecision>(resolve => {
        const waiting = this.resolvers.get(key) ?? [];
        waiting.push(resolve);
        this.resolvers.set(key, waiting);
      });
      if (existing) this.observePending(existing, 'joined');
      return pendingDecision;
    }
    const record: ApprovalRecord = {
      ...req,
      id,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.pending.set(key, record);
    let resolvePending!: (decision: ApprovalDecision) => void;
    const pendingDecision = new Promise<ApprovalDecision>(resolve => {
      resolvePending = resolve;
    });
    this.resolvers.set(key, [resolvePending]);

    this.broadcaster.broadcast({
      type: 'approval:created',
      approval: {
        id,
        session_id: record.sessionId,
        category: record.category,
        description: record.description,
        status: 'pending',
        ...(record.turnNumber !== undefined ? { turn_number: record.turnNumber } : {}),
        ...(record.nativeOptions ? { native_options: record.nativeOptions } : {}),
      },
    });
    if (req.attention) this.broadcaster.broadcast(req.attention);
    this.observePending(record, 'fresh');
    return pendingDecision;
  }

  private observePending(record: ApprovalRecord, delivery: SessionInboxDelivery): void {
    try {
      this.sessionInbox?.onPending(record, delivery);
    } catch (error) {
      console.error('[inbox] session pending mirror failed', error);
    }
  }

  /** Late request for a waiter that is already registered. Does not open another pending. */
  joinPending(record: ApprovalRecord): void {
    this.observePending(record, 'joined');
  }

  /** Ask the mirror to close occurrences of the named, already-terminal host turn. */
  notifyHostTurnTerminal(sessionId: string, turnId: string): void {
    try {
      this.sessionInbox?.onHostTurnTerminal(sessionId, turnId);
    } catch (error) {
      console.error('[inbox] host turn terminal mirror failed', error);
    }
  }

  /**
   * One finished host turn. Drops that turn's pending records, ends their
   * waiters, and removes their resolution sources. Broadcasts each card so
   * it leaves the pending list. Other turns, other sessions, and
   * allow_session stay. A second call finds nothing to broadcast.
   * Does not call the provider.
   */
  releaseHostTurn(sessionId: string, turnId: string): void {
    const now = Date.now();
    for (const [key, record] of [...this.pending]) {
      if (record.sessionId !== sessionId || record.turnId !== turnId) continue;
      record.status = 'declined';
      record.resolvedBy = 'auto';
      record.resolvedAt = now;
      this.pending.delete(key);
      this.settle(key, 'decline');
      this.resolutionSources.delete(key);
      if (record.payload?.['localOnly'] === true) {
        try {
          this.sessionInbox?.onLocalCleared(record);
        } catch (error) {
          console.error('[inbox] local approval mirror failed', error);
        }
      }
      this.broadcaster.broadcast({
        type: 'approval:updated',
        approval: {
          id: record.id,
          session_id: record.sessionId,
          status: 'declined',
          resolved_by: 'auto',
          resolved_at: new Date(now).toISOString(),
          ...(record.payload?.['localOnly'] === true ? {
            ...(record.turnNumber !== undefined ? { turn_number: record.turnNumber } : {}),
            decision: 'decline' as const,
          } : {}),
        },
      });
    }
  }

  /**
   * Called by SessionManager.respondApproval after forwarding the decision to
   * the proxy. Updates state, broadcasts update, and resolves the pending
   * promise so the await in `request` can continue (if it was blocking).
   */
  resolve(
    approvalId: string,
    decision: ApprovalDecision,
    by: ApprovalResolvedBy,
    sessionId?: string,
  ): void {
    const record = this.scopedRecord(approvalId, sessionId);
    if (!record) return;
    const key = approvalScopeKey(record.sessionId, record.id);

    if (record.payload?.['localOnly'] === true) {
      // Local-only decisions release only after their durable close fact
      // lands. A transient failure propagates and keeps the pending record,
      // the waiter, and the guarded action untouched. No in-memory queue may
      // stand in for this gate.
      this.sessionInbox?.onLocalResolved(record, decision, by);
    }

    const status: ApprovalStatus =
      decision === 'allow_once' ? 'approved' :
      decision === 'allow_session' ? 'approved-session' :
      'declined';

    record.status = status;
    record.resolvedBy = by;
    record.resolvedAt = Date.now();
    this.pending.delete(key);

    if (decision === 'allow_session') {
      const set = this.sessionAllowed.get(record.sessionId) ?? new Set();
      set.add(record.category);
      this.sessionAllowed.set(record.sessionId, set);
    }

    this.broadcaster.broadcast({
      type: 'approval:updated',
      approval: {
        id: record.id,
        session_id: record.sessionId,
        status,
        ...(record.payload?.['localOnly'] === true ? {
          ...(record.turnNumber !== undefined ? { turn_number: record.turnNumber } : {}),
          decision,
        } : {}),
        resolved_by: by,
        resolved_at: new Date(record.resolvedAt!).toISOString(),
      },
    });

    this.settle(key, decision);
    try {
      this.sessionInbox?.onResolved(record, decision, by);
    } catch (error) {
      console.error('[inbox] session resolve mirror failed', error);
    }
  }

  /**
   * Trusted resolved event. The pending map is empty after a restart, so
   * `resolve` cannot close a row that was stored before the process died.
   * The mirror decides the generation; this does not invent one.
   */
  closePersisted(resolution: SessionInboxPersistedResolution): void {
    try {
      this.sessionInbox?.onPersistedResolved(resolution);
    } catch (error) {
      console.error('[inbox] persisted resolve mirror failed', error);
    }
  }

  private settle(key: string, decision: ApprovalDecision): void {
    const waiting = this.resolvers.get(key);
    this.resolvers.delete(key);
    if (!waiting) return;
    for (const resolve of waiting) resolve(decision);
  }

  wasAllowedForSession(sessionId: string, category: ApprovalCategory): boolean {
    return this.sessionAllowed.get(sessionId)?.has(category) ?? false;
  }

  /** Look up a pending approval record by id (e.g. to inspect its category
   *  before forwarding the decision). Returns undefined if already resolved. */
  getPending(approvalId: string, sessionId?: string): ApprovalRecord | undefined {
    return this.scopedRecord(approvalId, sessionId);
  }

  listPending(): ApprovalRecord[] {
    return [...this.pending.values()];
  }

  markResolutionSource(approvalId: string, source: ApprovalResolvedBy, sessionId?: string): void {
    const key = this.scopedKey(approvalId, sessionId);
    if (!key) throw new ApprovalScopeError();
    if (!this.resolutionSources.has(key)) this.resolutionSources.set(key, source);
  }

  peekResolutionSource(approvalId: string, sessionId?: string): ApprovalResolvedBy | undefined {
    const key = this.scopedKey(approvalId, sessionId);
    if (!key) return undefined;
    return this.resolutionSources.get(key);
  }

  consumeResolutionSource(approvalId: string, sessionId?: string): ApprovalResolvedBy | undefined {
    const key = this.scopedKey(approvalId, sessionId);
    if (!key) return undefined;
    const source = this.resolutionSources.get(key);
    this.resolutionSources.delete(key);
    return source;
  }

  clearResolutionSource(approvalId: string, sessionId?: string): void {
    const key = this.scopedKey(approvalId, sessionId);
    if (!key) return;
    this.resolutionSources.delete(key);
  }

  private scopedRecord(approvalId: string, sessionId?: string): ApprovalRecord | undefined {
    if (sessionId !== undefined) return this.pending.get(approvalScopeKey(sessionId, approvalId));
    const found = this.recordsFor(approvalId);
    if (found.length > 1) throw new ApprovalScopeError();
    return found[0];
  }

  /**
   * Session-scoped key. A caller that already knows the session always wins.
   * A caller that does not is accepted only when exactly one session owns the
   * id. Zero sessions returns null. More than one throws and writes nothing.
   */
  private scopedKey(approvalId: string, sessionId?: string): string | null {
    if (sessionId !== undefined) return approvalScopeKey(sessionId, approvalId);
    const sessions = new Set<string>();
    for (const record of this.recordsFor(approvalId)) sessions.add(record.sessionId);
    for (const sourceSession of this.sourceSessions(approvalId)) sessions.add(sourceSession);
    if (sessions.size > 1) throw new ApprovalScopeError();
    if (sessions.size === 0) return null;
    const only = [...sessions][0];
    return only === undefined ? null : approvalScopeKey(only, approvalId);
  }

  private recordsFor(approvalId: string): ApprovalRecord[] {
    const found: ApprovalRecord[] = [];
    for (const record of this.pending.values()) {
      if (record.id === approvalId) found.push(record);
    }
    return found;
  }

  private sourceSessions(approvalId: string): string[] {
    const sessions: string[] = [];
    for (const key of this.resolutionSources.keys()) {
      const parsed = parseApprovalScopeKey(key);
      if (parsed?.approvalId === approvalId) sessions.push(parsed.sessionId);
    }
    return sessions;
  }

  /**
   * Tear down all state for a session: resolves any pending request promises
   * with `decline`, drops them from the pending map, clears the
   * allow_session memo, and broadcasts `approval:updated` per record so the
   * UI doesn't keep stale cards (state_sync's `approvals` filter would
   * otherwise re-include them on reconnect).
   *
   * Called on `session:delete` and on proxy crash (handleProxyExit). Idempotent.
   * Only records for that host session are declined. Sources and resolvers for
   * that session are removed even when the pending record is already gone.
   * Native inbox rows stay. A host-confirmed terminal turn closes that
   * occurrence through the projection. Removing this map is not that fact,
   * and a later turn of this session stays open.
   */
  clearSession(sessionId: string): void {
    this.sessionAllowed.delete(sessionId);
    const now = Date.now();
    for (const [key, record] of [...this.pending]) {
      if (record.sessionId !== sessionId) continue;
      record.status = 'declined';
      record.resolvedBy = 'auto';
      record.resolvedAt = now;
      this.pending.delete(key);
      this.settle(key, 'decline');
      this.resolutionSources.delete(key);
      if (record.payload?.['localOnly'] === true) {
        try {
          this.sessionInbox?.onLocalCleared(record);
        } catch (error) {
          console.error('[inbox] local approval mirror failed', error);
        }
      }
      this.broadcaster.broadcast({
        type: 'approval:updated',
        approval: {
          id: record.id,
          session_id: record.sessionId,
          status: 'declined',
          resolved_by: 'auto',
          resolved_at: new Date(now).toISOString(),
          ...(record.payload?.['localOnly'] === true ? {
            ...(record.turnNumber !== undefined ? { turn_number: record.turnNumber } : {}),
            decision: 'decline' as const,
          } : {}),
        },
      });
    }
    for (const key of [...this.resolutionSources.keys()]) {
      if (parseApprovalScopeKey(key)?.sessionId === sessionId) this.resolutionSources.delete(key);
    }
    for (const key of [...this.resolvers.keys()]) {
      if (parseApprovalScopeKey(key)?.sessionId === sessionId) this.settle(key, 'decline');
    }
  }
}
