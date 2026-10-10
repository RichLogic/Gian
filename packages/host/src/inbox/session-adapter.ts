import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalResolvedBy } from '@gian/shared';
import {
  isInboxUserResolutionSource,
  type ApprovalRecord,
  type SessionInboxDelivery,
  type SessionInboxMirror,
  type SessionInboxPersistedResolution,
} from '../approval/manager.js';
import type { Db } from '../storage/db.js';
import {
  inboxOccurrenceKey,
  listPreexistingOccurrenceKeys,
  listUnappliedInboxProjections,
  markInboxProjectionApplied,
  markSessionProjectionFactsApplied,
  occurrenceClosePending,
  occurrenceHasBoundClose,
  recordHostTerminalOpens,
  recordInboxProjection,
  reopenInboxOccurrenceClose,
  stampInboxClose,
  type InboxProjectionFact,
} from './projection-facts.js';
import { InboxError, type InboxWriteResult } from './service.js';
import {
  boundedInteractionId,
  InboxSignalError,
  type InboxActor,
  type InboxTerminalOutcome,
} from './signal.js';

const IDENT = /^[A-Za-z0-9._:-]{1,128}$/;
/** One immediate attempt, then these delays. The schedule stops after the last one. */
const MIRROR_RETRY_DELAYS_MS = [200, 1_000, 5_000] as const;
/** Recovery sweep batch. A full batch asks for another continuation pass. */
const TERMINAL_SWEEP_BATCH = 200;
/** Continuation passes yield the event loop; they are not error backoff. */
const SWEEP_CONTINUATION_DELAY_MS = 25;
/** Local occurrence event ids carry the owning process generation. */
const LOCAL_OPEN_PREFIX = 'local:';
const LOCAL_RESOLVED_PREFIX = 'local:resolved:';
const LOCAL_CANCELLED_PREFIX = 'local:cancelled:';
/**
 * Stable for the life of this Host process. Adapters replaced within the
 * process share it, so only a genuinely new process owns a different
 * generation and may cancel orphaned local pendings.
 */
const HOST_PROCESS_GENERATION = randomUUID();

export interface SessionInboxStore {
  upsert(input: unknown): InboxWriteResult;
  closeExisting(input: unknown): InboxWriteResult | null;
  expireSession(sessionId: string): { changed: number };
  storedSessionItem(sessionId: string, interactionId: string): {
    sourceKind: 'session.question' | 'session.approval';
    generation: number;
    status: string;
  } | null;
}

/**
 * P4 may claim an OS notification only for `fresh`.
 * `fresh` is the first successful live projection of an occurrence that this
 * process did not already have on disk. Identity is the session plus that
 * occurrence: a provider event id repeats across sessions. Until the identity
 * read succeeds, a projection is replay or recovered. Recovery, replay, and a
 * later registration of an occurrence that already existed are never fresh.
 * An empty notice map is not fresh. `joinCount` does not authorize another claim.
 */
export interface SessionInboxNotice {
  sessionId: string;
  interactionId: string;
  turnId: string;
  occurrenceEventId: string;
  generation: number;
  delivery: 'fresh' | 'replay' | 'recovered';
  joinCount: number;
}

export function sessionInboxMayNotify(notice: SessionInboxNotice | undefined): boolean {
  return notice?.delivery === 'fresh';
}

/**
 * The durable local decision fact could not be written. The guarded action
 * must stay pending; the failure is safe for the caller to retry.
 */
export class LocalDecisionPersistenceError extends Error {
  readonly code = 'INBOX_WRITE_FAILED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'LocalDecisionPersistenceError';
  }
}

interface MirrorWrite {
  open?: Record<string, unknown>;
  close?: Record<string, unknown>;
}

/** A local open/close whose durable fact is not written yet. The exact intent
 *  is kept here and retried; an unrecoverable pending is never exposed first. */
interface LocalFactIntent {
  record: ApprovalRecord;
  method: 'interaction.requested' | 'interaction.resolved';
  result: { outcome: string | undefined; decision: ApprovalDecision | null; userSource: boolean };
  after: 'open' | 'close';
}

type SessionKind =
  | { kind: 'session.question' }
  | { kind: 'session.approval'; category: 'command' | 'permission' | 'browser' | 'plan' };

/** A host turn row that is no longer running closes that occurrence. The close
 * is system cancelled or expired and does not mark the row read.
 * Local-only approvals (browser capture) have no provider event. Their open
 * and close are recorded as the same durable facts with a `local:` event id
 * that carries the owning Host process generation. A local pending is exposed
 * only after its open fact is durable, and a close keeps its exact outcome
 * intent queued until that fact lands, so a crash cannot strand an
 * unrecoverable row or silently demote a user outcome to a system cancel.
 * A brand-new Host process cancels only local opens owned by a dead
 * generation (their waiters died with the process); it never auto-approves,
 * never replays the local action, never stops the turn, and never touches
 * recoverable native occurrences or another live process's local pendings.
 */
export class SessionInboxAdapter implements SessionInboxMirror {
  private readonly notices = new Map<string, SessionInboxNotice>();
  private readonly preexistingOccurrences = new Set<string>();
  private identityLoaded = false;
  private readonly pendingMirrors = new Map<string, MirrorWrite>();
  private readonly pendingExpires = new Set<string>();
  private readonly pendingTerminalTurns = new Set<string>();
  private readonly pendingLocalIntents = new Map<string, LocalFactIntent>();
  private readonly generation: string;
  /** Startup/recovery sweep over the unconverged terminal opens, in batches. */
  private terminalSweepPending = true;
  /** Orphaned local opens of dead process generations, once per activation. */
  private localGhostSweepPending = true;
  /** A full sweep batch asked for a continuation; independent of error backoff. */
  private sweepContinuation = false;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly terminalSessions = new Set<string>();
  private readonly skipped = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredAttempts = 0;
  private draining = false;
  private rerun = false;
  private disposed = false;

  constructor(
    private readonly db: Db,
    private readonly store: SessionInboxStore,
    generation?: string,
  ) {
    this.generation = generation ?? HOST_PROCESS_GENERATION;
    this.retryQuiet();
  }

  notice(sessionId: string, interactionId: string): SessionInboxNotice | undefined {
    return this.notices.get(mirrorKey(sessionId, interactionId));
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** Same flush the delay uses. Production schedules it; callers do not have to. */
  retryDeferred(): void {
    if (this.disposed) return;
    this.retryQuiet();
  }

  /** True while a bounded delay is armed. Dispose clears it. */
  retryScheduled(): boolean {
    return this.retryTimer !== null;
  }

  /** True while a sweep continuation (not error backoff) is armed. */
  sweepScheduled(): boolean {
    return this.sweepTimer !== null;
  }

  recover(): void {
    if (this.disposed) return;
    this.terminalSweepPending = true;
    this.localGhostSweepPending = true;
    this.retryQuiet();
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
  }

  onPending(record: ApprovalRecord, delivery: SessionInboxDelivery): void {
    if (this.disposed || this.terminalSessions.has(record.sessionId)) return;
    if (record.payload?.['localOnly'] === true) {
      this.observeLocal(record, delivery);
      return;
    }
    const notice = this.notices.get(mirrorKey(record.sessionId, record.id));
    if (notice && delivery === 'joined') notice.joinCount += 1;
    this.retryQuiet();
  }

  /**
   * Durability gate for a local-only user decision. Runs before the waiter,
   * allow_session, and the resolved broadcast are released: a transient write
   * failure throws and keeps the whole resolution pending instead of letting
   * the guarded action run. The native event path never passes through here.
   */
  onLocalResolved(record: ApprovalRecord, decision: ApprovalDecision, by: ApprovalResolvedBy): void {
    if (record.payload?.['localOnly'] !== true) return;
    const durable = this.writeLocalFact(record, 'interaction.resolved', {
      outcome: 'submitted',
      decision,
      userSource: isInboxUserResolutionSource(by),
    });
    if (!durable) {
      throw new LocalDecisionPersistenceError('local approval decision is not durable');
    }
  }

  onResolved(record: ApprovalRecord, decision: ApprovalDecision, by: ApprovalResolvedBy): void {
    if (record.payload?.['localOnly'] !== true) return;
    // Keep the exact close intent until its fact is durable. The direct close
    // still runs: a crash after it lands leaves a correctly closed row, and a
    // crash before it lands is covered by the durable close fact.
    const result = {
      outcome: 'submitted' as const,
      decision,
      userSource: isInboxUserResolutionSource(by),
    };
    if (!this.writeLocalFact(record, 'interaction.resolved', result)) {
      this.pendingLocalIntents.set(`${mirrorKey(record.sessionId, record.id)} resolved`, {
        record,
        method: 'interaction.resolved',
        result,
        after: 'close',
      });
    }
    const close = this.closeSignal(record, decision, actorFor(by));
    if (!close) return;
    this.deliver(mirrorKey(record.sessionId, record.id), { close });
  }

  onPersistedResolved(resolution: SessionInboxPersistedResolution): void {
    if (this.terminalSessions.has(resolution.sessionId)) return;
    if (resolution.providerEventId) {
      stampInboxClose(this.db, resolution.sessionId, resolution.providerEventId, 'native', 'provider', {
        decision: resolution.decision,
        userSource: resolution.userSource,
      });
    }
    this.retryQuiet();
  }

  onLocalCleared(record: ApprovalRecord): void {
    const result = {
      outcome: 'cancelled' as const,
      decision: null,
      userSource: false,
    };
    if (!this.writeLocalFact(record, 'interaction.resolved', result)) {
      this.pendingLocalIntents.set(`${mirrorKey(record.sessionId, record.id)} resolved`, {
        record,
        method: 'interaction.resolved',
        result,
        after: 'close',
      });
    }
    const close = this.closeSignal(record, 'decline', 'system', 'cancelled');
    if (!close) return;
    this.deliver(mirrorKey(record.sessionId, record.id), { close });
  }

  /** The named turn row is already terminal. Drain writes that occurrence's close. */
  onHostTurnTerminal(sessionId: string, turnId: string): void {
    if (this.disposed) return;
    this.pendingTerminalTurns.add(`${sessionId} ${turnId}`);
    this.retryQuiet();
  }

  expireSession(sessionId: string): void {
    if (!IDENT.test(sessionId)) {
      console.error('[inbox] session expire skipped an unbounded session id');
      return;
    }
    this.terminalSessions.add(sessionId);
    this.dropSessionMirrors(sessionId);
    this.pendingExpires.add(sessionId);
    this.deferredAttempts = 0;
    this.retryQuiet();
  }

  private observeLocal(record: ApprovalRecord, delivery: SessionInboxDelivery): void {
    const key = mirrorKey(record.sessionId, record.id);
    if (delivery === 'joined') {
      const notice = this.notices.get(key);
      if (notice) notice.joinCount += 1;
      return;
    }
    // Durable occurrence fact first. A pending that cannot be recovered is
    // never exposed: the intent stays queued for the bounded retry instead.
    const result = {
      outcome: undefined,
      decision: null,
      userSource: false,
    };
    if (!this.writeLocalFact(record, 'interaction.requested', result)) {
      this.pendingLocalIntents.set(key, {
        record,
        method: 'interaction.requested',
        result,
        after: 'open',
      });
      this.retryQuiet();
      return;
    }
    this.exposeLocalOpen(record, key);
  }

  private exposeLocalOpen(record: ApprovalRecord, key: string): void {
    const open = this.openSignal(record, 1);
    if (!open) return;
    this.notices.set(key, {
      sessionId: record.sessionId,
      interactionId: record.id,
      turnId: record.turnId,
      occurrenceEventId: `${LOCAL_OPEN_PREFIX}${this.generation}:${record.id}`,
      generation: 1,
      delivery: 'fresh',
      joinCount: 0,
    });
    this.deliver(key, { open });
  }

  /**
   * The local-only sibling of the provider-event projection. The open fact
   * carries the owning process generation and uses the same occurrence
   * identity the notice map uses, so the fact drain converges with the direct
   * mirror write instead of duplicating it. Returns false only for a
   * transient write failure; a permanently unprojectable id is a no-op the
   * direct path skips identically.
   */
  private writeLocalFact(
    record: ApprovalRecord,
    method: 'interaction.requested' | 'interaction.resolved',
    result: { outcome: string | undefined; decision: ApprovalDecision | null; userSource: boolean },
  ): boolean {
    if (
      !IDENT.test(record.sessionId)
      || !IDENT.test(record.turnId)
      || !boundedInteractionId(record.id)
    ) {
      return true;
    }
    try {
      recordInboxProjection(this.db, {
        sessionId: record.sessionId,
        providerEventId: method === 'interaction.requested'
          ? `${LOCAL_OPEN_PREFIX}${this.generation}:${record.id}`
          : `${LOCAL_RESOLVED_PREFIX}${this.generation}:${record.id}`,
        turnId: record.turnId,
        turnNumber: record.turnNumber ?? 1,
        origin: 'live',
        source: 'local',
        ownerGeneration: this.generation,
        writer: 'host',
        method,
        raw: {
          interactionId: record.id,
          ...(record.category ? { category: record.category } : {}),
          ...(record.toolName ? { toolName: record.toolName } : {}),
          ...(result.outcome ? { outcome: result.outcome } : {}),
        },
        displayType: method === 'interaction.requested'
          ? (record.projected === 'question' || record.category === 'question'
            ? 'interaction.question'
            : 'interaction.approval')
          : 'interaction.resolved',
        displayData: {
          ...(record.title ? { title: record.title } : {}),
          ...(record.description ? { description: record.description } : {}),
          ...(record.subject ? { subject: record.subject } : {}),
          ...(record.category ? { category: record.category } : {}),
          ...(record.toolName ? { toolName: record.toolName } : {}),
          ...(result.decision ? { decision: result.decision } : {}),
        },
        userPending: method === 'interaction.requested',
        userSource: result.userSource,
      });
      return true;
    } catch (error) {
      console.error('[inbox] local approval fact failed', error);
      return false;
    }
  }

  private openSignal(record: ApprovalRecord, generation: number): Record<string, unknown> | null {
    const classified = classify(record);
    if (!classified) {
      this.skip(record, 'no inbox category');
      return null;
    }
    if (!IDENT.test(record.sessionId) || !boundedInteractionId(record.id)) {
      this.skip(record, 'session or interaction id is not a bounded identifier');
      return null;
    }
    const title = firstVisible(record.title, record.description, record.subject, record.toolName);
    const summary = firstVisible(record.description, record.subject, record.title, record.toolName);
    if (!title || !summary) {
      this.skip(record, 'display text is empty');
      return null;
    }
    const turn = positiveTurn(record.turnNumber);
    if (classified.kind === 'session.question') {
      return {
        kind: 'session.question',
        interaction_id: record.id,
        session_id: record.sessionId,
        turn,
        generation,
        title,
        summary,
      };
    }
    return {
      kind: 'session.approval',
      interaction_id: record.id,
      session_id: record.sessionId,
      turn,
      generation,
      category: classified.category,
      title,
      summary,
    };
  }

  private closeSignal(
    record: ApprovalRecord,
    decision: ApprovalDecision,
    actor: InboxActor,
    forced?: 'cancelled',
  ): Record<string, unknown> | null {
    const classified = classify(record);
    if (!classified) return null;
    if (!IDENT.test(record.sessionId) || !boundedInteractionId(record.id)) return null;
    const notice = this.notices.get(mirrorKey(record.sessionId, record.id));
    const generation = notice?.generation ?? 1;
    const outcome = outcomeFor(classified.kind, decision, null, false, forced);
    if (!outcome) return null;
    if (classified.kind === 'session.question') {
      return {
        kind: 'session.question.closed',
        interaction_id: record.id,
        session_id: record.sessionId,
        generation,
        outcome: outcome.outcome === 'rejected' ? 'cancelled' : outcome.outcome,
        actor,
      };
    }
    return {
      kind: 'session.approval.closed',
      interaction_id: record.id,
      session_id: record.sessionId,
      generation,
      outcome: outcome.outcome,
      actor,
      category: classified.category,
    };
  }

  private retryQuiet(): void {
    if (this.disposed) return;
    if (this.draining) {
      this.rerun = true;
      return;
    }
    this.draining = true;
    let retry = false;
    try {
      this.loadOccurrenceIdentity();
      if (this.reconcileOrphanSessions()) retry = true;
      this.flushExpires();
      this.flushLocalIntents();
      this.flushMirrors();
      if (this.drainFacts()) retry = true;
    } catch (error) {
      console.error('[inbox] session projection pass failed', error);
      retry = true;
    } finally {
      this.draining = false;
    }
    if (this.disposed) {
      this.clearRetry();
      return;
    }
    if (this.rerun) {
      this.rerun = false;
      this.retryQuiet();
      return;
    }
    // A full sweep batch asks for a continuation pass. Progress is not an
    // error: the continuation runs on its own timer and never touches the
    // bounded error budget.
    if (this.sweepContinuation) {
      this.sweepContinuation = false;
      this.scheduleSweepContinuation();
    }
    if (
      !retry
      && this.pendingExpires.size === 0
      && this.pendingMirrors.size === 0
      && this.pendingLocalIntents.size === 0
    ) {
      if (this.identityLoaded) this.deferredAttempts = 0;
      if (!this.sweepTimer) this.clearRetry();
      return;
    }
    this.scheduleRetry();
  }

  /** An empty set is not a successful read. Existing facts stay non-fresh. */
  private loadOccurrenceIdentity(): void {
    if (this.identityLoaded) return;
    const keys = listPreexistingOccurrenceKeys(this.db);
    this.preexistingOccurrences.clear();
    for (const key of keys) this.preexistingOccurrences.add(key);
    this.identityLoaded = true;
  }

  /**
   * Durable-fact intents that failed their first write. An open is exposed
   * only after its fact lands; a close intent is preserved exactly until its
   * fact lands (the direct close already ran and converges as a duplicate).
   */
  private flushLocalIntents(): void {
    for (const [key, intent] of [...this.pendingLocalIntents]) {
      if (!this.writeLocalFact(intent.record, intent.method, intent.result)) continue;
      this.pendingLocalIntents.delete(key);
      if (intent.after === 'open') this.exposeLocalOpen(intent.record, key);
    }
  }

  private drainFacts(): boolean {
    let retry = this.drainTerminalTurns();
    const facts = listUnappliedInboxProjections(this.db);
    const blocked = new Set<string>();
    for (const fact of facts) {
      const occurrenceKey = `${fact.sessionId}\u0000${fact.source}\u0000${fact.occurrenceEventId}`;
      if (!fact.bound) {
        // An opening can still bind this close. Marking it applied here
        // would drop that evidence.
        continue;
      }
      if (blocked.has(occurrenceKey)) {
        retry = true;
        continue;
      }
      if (this.terminalSessions.has(fact.sessionId)) {
        markSessionProjectionFactsApplied(this.db, fact.sessionId);
        continue;
      }
      try {
        if (!this.sessionExists(fact.sessionId)) {
          this.store.expireSession(fact.sessionId);
          markSessionProjectionFactsApplied(this.db, fact.sessionId);
          continue;
        }
        if (this.applyFact(fact)) retry = true;
      } catch (error) {
        // A store or projection rejection is not a successful apply. The fact
        // stays unapplied. The bounded delay is the only retry.
        console.error(
          `[inbox] session projection failed session=${fact.sessionId} event=${fact.providerEventId}`,
          error,
        );
        blocked.add(occurrenceKey);
        retry = true;
      }
    }
    if (this.finishFencedOpens(facts)) retry = true;
    return retry;
  }

  /**
   * Exact finished turns are drained by identity, not by scanning history.
   * The recovery sweep (startup, recover()) only visits unconverged terminal
   * opens in bounded batches; a full batch asks for a continuation pass on
   * its own timer, never for error backoff.
   */
  private drainTerminalTurns(): boolean {
    for (const key of [...this.pendingTerminalTurns]) {
      const split = key.indexOf(' ');
      recordHostTerminalOpens(this.db, {
        sessionId: key.slice(0, split),
        turnId: key.slice(split + 1),
      });
      this.pendingTerminalTurns.delete(key);
    }
    if (!this.terminalSweepPending) return false;
    if (this.localGhostSweepPending) {
      this.localGhostSweepPending = false;
      this.cancelForeignLocalOpens();
    }
    const processed = recordHostTerminalOpens(this.db, { limit: TERMINAL_SWEEP_BATCH });
    if (processed >= TERMINAL_SWEEP_BATCH) {
      this.sweepContinuation = true;
      return false;
    }
    this.terminalSweepPending = false;
    return false;
  }

  /**
   * A brand-new Host process owns no waiters for local approvals a dead
   * generation registered: its in-memory ApprovalManager started empty, so
   * those opens can never be answered again and are cancelled as system
   * outcomes. Opens owned by this generation (a live local pending, possibly
   * re-mirrored by a same-process adapter swap) and recoverable native facts
   * are never touched, and the turn row is left as it is.
   */
  private cancelForeignLocalOpens(): void {
    const rows = this.db.prepare(
      `SELECT session_id AS sessionId,
              turn_id AS turnId,
              interaction_id AS interactionId,
              occurrence_event_id AS occurrenceEventId,
              owner_generation AS ownerGeneration
         FROM inbox_projection_facts
        WHERE direction = 'open'
          AND bound = 1
          AND user_pending = 1
          AND provider_event_id = occurrence_event_id
          AND source = 'local'`,
    ).all() as Array<{
      sessionId: string;
      turnId: string;
      interactionId: string;
      occurrenceEventId: string;
      ownerGeneration: string | null;
    }>;
    for (const row of rows) {
      // Ownership comes from the persisted column, never from the id text:
      // a native event id that mimics the local namespace is not touched.
      // A NULL owner predates the column and belongs to a dead process.
      if (row.ownerGeneration === this.generation) continue;
      if (occurrenceHasBoundClose(this.db, row.sessionId, row.occurrenceEventId, 'local')) continue;
      recordInboxProjection(this.db, {
        sessionId: row.sessionId,
        providerEventId: `${LOCAL_CANCELLED_PREFIX}${row.interactionId}`,
        turnId: row.turnId,
        turnNumber: 1,
        origin: 'live',
        source: 'local',
        ownerGeneration: this.generation,
        writer: 'host',
        method: 'interaction.resolved',
        raw: { interactionId: row.interactionId, outcome: 'cancelled' },
        displayType: 'interaction.resolved',
        displayData: null,
        userPending: false,
        userSource: false,
      });
    }
  }

  /**
   * Pending inbox session targets whose session row is gone. Not a transcript scan.
   * A transient read or expire failure asks for another bounded pass.
   */
  private reconcileOrphanSessions(): boolean {
    let rows: Array<{ target_json: string }> = [];
    try {
      rows = this.db.prepare(
        `SELECT target_json
           FROM inbox_items
          WHERE status = 'pending'`,
      ).all() as Array<{ target_json: string }>;
    } catch (error) {
      console.error('[inbox] orphan session reconcile skipped', error);
      return true;
    }
    const sessionIds = new Set<string>();
    for (const row of rows) {
      let target: { type?: unknown; session_id?: unknown };
      try {
        target = JSON.parse(row.target_json) as { type?: unknown; session_id?: unknown };
      } catch {
        continue;
      }
      if (target.type === 'session' && typeof target.session_id === 'string' && target.session_id.length > 0) {
        sessionIds.add(target.session_id);
      }
    }
    let retry = false;
    for (const sessionId of sessionIds) {
      try {
        if (this.sessionExists(sessionId)) continue;
        this.store.expireSession(sessionId);
      } catch (error) {
        console.error('[inbox] orphan session expire failed', error);
        if (retryable(error)) retry = true;
      }
    }
    return retry;
  }

  private finishFencedOpens(facts: readonly InboxProjectionFact[]): boolean {
    let retry = false;
    for (const fact of facts) {
      if (this.settleFencedOpen(fact)) retry = true;
    }
    return retry;
  }

  /**
   * A bound close seals its open only after the inbox row is gone or already
   * terminal for this generation. applied=1 while that row is still pending
   * is put back so a later pass can converge. A higher stored generation has
   * replaced this open, so the old fact is sealed and the newer row stays.
   * @returns true when the close has to be retried.
   */
  private settleFencedOpen(fact: InboxProjectionFact): boolean {
    if (fact.direction !== 'open' || !fact.userPending || !fact.occurrenceEventId) return false;
    if (!occurrenceHasBoundClose(this.db, fact.sessionId, fact.occurrenceEventId, fact.source)) return false;
    if (occurrenceClosePending(this.db, fact.sessionId, fact.occurrenceEventId, fact.source)) return false;
    const stored = this.store.storedSessionItem(fact.sessionId, fact.interactionId);
    if (stored?.generation === fact.generation && stored.status === 'pending') {
      reopenInboxOccurrenceClose(this.db, fact.sessionId, fact.occurrenceEventId, fact.source);
      console.error(
        `[inbox] session close left a pending row session=${fact.sessionId} occurrence=${fact.occurrenceEventId}`,
      );
      return true;
    }
    if (stored && stored.generation > fact.generation) {
      markInboxProjectionApplied(this.db, fact.sessionId, fact.providerEventId, fact.source, fact.writer);
      return false;
    }
    const absent = !stored;
    const terminal = !!stored && stored.generation === fact.generation && stored.status !== 'pending';
    if (absent || terminal) {
      markInboxProjectionApplied(this.db, fact.sessionId, fact.providerEventId, fact.source, fact.writer);
    }
    return false;
  }

  private applyFact(fact: InboxProjectionFact): boolean {
    if (fact.direction === 'close') {
      this.applyClose(fact);
      return false;
    }
    return this.applyOpen(fact);
  }

  private applyOpen(fact: InboxProjectionFact): boolean {
    if (!fact.userPending) {
      markInboxProjectionApplied(this.db, fact.sessionId, fact.providerEventId, fact.source, fact.writer);
      return false;
    }
    if (occurrenceHasBoundClose(this.db, fact.sessionId, fact.occurrenceEventId, fact.source)) {
      return this.settleFencedOpen(fact);
    }
    const record = recordFromFact(fact);
    const classified = classify(record);
    if (!classified) {
      this.skip(record, 'no inbox category');
      markInboxProjectionApplied(this.db, fact.sessionId, fact.providerEventId, fact.source, fact.writer);
      return false;
    }
    const open = this.openSignal(record, fact.generation);
    if (!open) {
      markInboxProjectionApplied(this.db, fact.sessionId, fact.providerEventId, fact.source, fact.writer);
      return false;
    }
    const stored = this.store.storedSessionItem(fact.sessionId, fact.interactionId);
    const sameRow = stored?.generation === fact.generation;
    this.store.upsert(open);
    markInboxProjectionApplied(this.db, fact.sessionId, fact.providerEventId, fact.source, fact.writer);
    const key = mirrorKey(fact.sessionId, fact.interactionId);
    const notice = this.notices.get(key);
    if (notice?.occurrenceEventId === fact.occurrenceEventId) return false;
    this.notices.set(key, {
      sessionId: fact.sessionId,
      interactionId: fact.interactionId,
      turnId: fact.turnId,
      occurrenceEventId: fact.occurrenceEventId,
      generation: fact.generation,
      delivery: this.deliveryFor(fact, sameRow),
      joinCount: notice?.joinCount ?? 0,
    });
    return false;
  }

  private applyClose(fact: InboxProjectionFact): void {
    const stored = this.store.storedSessionItem(fact.sessionId, fact.interactionId);
    if (!stored || stored.status !== 'pending' || stored.generation !== fact.generation) {
      markInboxProjectionApplied(this.db, fact.sessionId, fact.providerEventId, fact.source, fact.writer);
      return;
    }
    const mapped = outcomeFor(
      stored.sourceKind,
      fact.decision,
      fact.outcome,
      fact.userSource,
    );
    if (!mapped) {
      console.error(
        `[inbox] session close outcome is not projectable session=${fact.sessionId} event=${fact.providerEventId}`,
      );
      throw new InboxSignalError('close outcome is not projectable');
    }
    const close: Record<string, unknown> = {
      kind: stored.sourceKind === 'session.question' ? 'session.question.closed' : 'session.approval.closed',
      interaction_id: fact.interactionId,
      session_id: fact.sessionId,
      generation: fact.generation,
      outcome: stored.sourceKind === 'session.question' && mapped.outcome === 'rejected'
        ? 'cancelled'
        : mapped.outcome,
      actor: mapped.actor,
    };
    this.store.closeExisting(close);
    const after = this.store.storedSessionItem(fact.sessionId, fact.interactionId);
    if (after?.generation === fact.generation && after.status === 'pending') {
      console.error(
        `[inbox] session close left a pending row session=${fact.sessionId} event=${fact.providerEventId}`,
      );
      throw new Error('inbox close left the row pending');
    }
    markInboxProjectionApplied(this.db, fact.sessionId, fact.providerEventId, fact.source, fact.writer);
    const notice = this.notices.get(mirrorKey(fact.sessionId, fact.interactionId));
    if (notice?.occurrenceEventId === fact.occurrenceEventId) notice.delivery = 'replay';
  }

  private deliveryFor(fact: InboxProjectionFact, rowAlreadyStored: boolean): SessionInboxNotice['delivery'] {
    if (!this.identityLoaded) return rowAlreadyStored ? 'replay' : 'recovered';
    const key = inboxOccurrenceKey(fact.sessionId, fact.source, fact.occurrenceEventId);
    if (this.preexistingOccurrences.has(key)) {
      return rowAlreadyStored ? 'replay' : 'recovered';
    }
    if (fact.origin === 'replay' || fact.providerEventId !== fact.occurrenceEventId) return 'replay';
    return 'fresh';
  }

  private sessionExists(sessionId: string): boolean {
    return this.db.prepare(
      'SELECT 1 AS ok FROM sessions WHERE id = ?',
    ).get(sessionId) !== undefined;
  }

  private deliver(key: string, patch: MirrorWrite): void {
    const sessionId = sessionIdFromMirrorKey(key);
    if (sessionId && this.terminalSessions.has(sessionId)) return;
    const current = this.pendingMirrors.get(key) ?? {};
    const next = patch.open
      ? {
          open: patch.open,
          ...(patch.close || current.close ? { close: patch.close ?? current.close } : {}),
        }
      : { ...current, ...patch };
    this.pendingMirrors.set(key, next);
    this.deferredAttempts = 0;
    this.retryQuiet();
  }

  private flushExpires(): void {
    for (const sessionId of [...this.pendingExpires]) {
      this.dropSessionMirrors(sessionId);
      try {
        this.store.expireSession(sessionId);
        markSessionProjectionFactsApplied(this.db, sessionId);
        this.pendingExpires.delete(sessionId);
      } catch (error) {
        if (!retryable(error)) {
          this.pendingExpires.delete(sessionId);
          console.error('[inbox] session expire rejected', error);
          continue;
        }
        console.error('[inbox] session expire failed', error);
      }
    }
  }

  private flushMirrors(): void {
    for (const key of [...this.pendingMirrors.keys()]) {
      try {
        this.flush(key);
      } catch (error) {
        if (!retryable(error)) {
          this.pendingMirrors.delete(key);
          console.error('[inbox] session mirror rejected', error);
          continue;
        }
        console.error('[inbox] session mirror retry failed', error);
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    if (this.deferredAttempts >= MIRROR_RETRY_DELAYS_MS.length) {
      console.error('[inbox] session mirror retry stopped after the bounded delay');
      return;
    }
    const delay = MIRROR_RETRY_DELAYS_MS[this.deferredAttempts] ?? 5_000;
    this.deferredAttempts += 1;
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDeferred();
    }, delay);
    timer.unref();
    this.retryTimer = timer;
  }

  /**
   * Continuation of a productive recovery sweep. This is not error backoff:
   * it does not consume the bounded retry budget, yields the event loop, and
   * is cancelled by dispose.
   */
  private scheduleSweepContinuation(): void {
    if (this.sweepTimer || this.disposed) return;
    const timer = setTimeout(() => {
      this.sweepTimer = null;
      if (!this.disposed) this.retryQuiet();
    }, SWEEP_CONTINUATION_DELAY_MS);
    timer.unref();
    this.sweepTimer = timer;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }

  private dropSessionMirrors(sessionId: string): void {
    for (const key of [...this.pendingMirrors.keys()]) {
      if (sessionIdFromMirrorKey(key) === sessionId) this.pendingMirrors.delete(key);
    }
  }

  private flush(key: string): void {
    const desired = this.pendingMirrors.get(key);
    if (!desired) return;
    if (desired.open) {
      this.store.upsert(desired.open);
      desired.open = undefined;
    }
    if (desired.close) {
      this.store.closeExisting(desired.close);
      desired.close = undefined;
    }
    if (!desired.open && !desired.close) this.pendingMirrors.delete(key);
  }

  private skip(record: ApprovalRecord, reason: string): void {
    const key = `${mirrorKey(record.sessionId, record.id)}:${reason}`;
    if (this.skipped.has(key)) return;
    this.skipped.add(key);
    console.error(
      `[inbox] skipped session item session=${record.sessionId} interaction=${record.id} category=${record.category} tool=${record.toolName ?? ''} (${reason})`,
    );
  }
}

function recordFromFact(fact: InboxProjectionFact): ApprovalRecord {
  return {
    id: fact.interactionId,
    sessionId: fact.sessionId,
    turnId: fact.turnId,
    turnNumber: fact.turnNumber ?? undefined,
    category: fact.projected === 'question' ? 'question' : categoryOf(fact.category),
    risk: 'high',
    description: fact.description ?? '',
    subject: fact.subject ?? undefined,
    title: fact.title ?? undefined,
    toolName: fact.toolName ?? undefined,
    projected: fact.projected ?? undefined,
    status: 'pending',
    createdAt: 0,
  };
}

function categoryOf(value: string | null): ApprovalRecord['category'] {
  if (
    value === 'question'
    || value === 'command'
    || value === 'file_write_outside_ws'
    || value === 'network'
    || value === 'browser_capture'
    || value === 'exit_plan_mode'
    || value === 'other'
  ) return value;
  return 'other';
}

function classify(record: ApprovalRecord): SessionKind | null {
  if (record.projected === 'question' || record.category === 'question') {
    return { kind: 'session.question' };
  }
  if (record.category === 'exit_plan_mode' || record.toolName === 'ExitPlanMode') {
    return { kind: 'session.approval', category: 'plan' };
  }
  if (record.category === 'browser_capture') {
    return { kind: 'session.approval', category: 'browser' };
  }
  if (record.category === 'command' || record.toolName === 'Bash') {
    return { kind: 'session.approval', category: 'command' };
  }
  if (
    record.projected === 'approval'
    || record.category === 'network'
    || record.category === 'file_write_outside_ws'
    || record.category === 'other'
  ) {
    return { kind: 'session.approval', category: 'permission' };
  }
  return null;
}

function outcomeFor(
  kind: 'session.question' | 'session.approval',
  decision: string | null,
  nativeOutcome: string | null,
  userSource: boolean,
  forced?: 'cancelled',
): { outcome: InboxTerminalOutcome; actor: InboxActor } | null {
  if (forced === 'cancelled') return { outcome: 'cancelled', actor: 'system' };
  if (nativeOutcome === 'expired') return { outcome: 'expired', actor: 'system' };
  if (
    nativeOutcome === 'cancelled'
    || nativeOutcome === 'turn_ended'
    || nativeOutcome === 'runtime_ended'
  ) {
    return { outcome: 'cancelled', actor: 'system' };
  }
  if (nativeOutcome !== null && nativeOutcome !== 'submitted') return null;
  if (decision === null) return null;
  const declined = decision === 'decline' || decision === 'keep_planning';
  const actor: InboxActor = userSource ? 'user' : 'system';
  if (kind === 'session.question') {
    return { outcome: declined ? 'cancelled' : 'resolved', actor };
  }
  return { outcome: declined ? 'rejected' : 'resolved', actor };
}

function actorFor(by: ApprovalResolvedBy): InboxActor {
  return by === 'auto' ? 'system' : 'user';
}

function positiveTurn(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function visible(value: string): boolean {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().length > 0;
}

function firstVisible(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && visible(value)) return value;
  }
  return null;
}

function mirrorKey(sessionId: string, interactionId: string): string {
  return `${sessionId.length}:${sessionId}${interactionId.length}:${interactionId}`;
}

function sessionIdFromMirrorKey(key: string): string | null {
  const mark = key.indexOf(':');
  if (mark < 1) return null;
  const length = Number(key.slice(0, mark));
  if (!Number.isInteger(length) || length < 1) return null;
  const sessionId = key.slice(mark + 1, mark + 1 + length);
  return sessionId.length === length ? sessionId : null;
}

function retryable(error: unknown): boolean {
  return !(error instanceof InboxSignalError) && !(error instanceof InboxError);
}
