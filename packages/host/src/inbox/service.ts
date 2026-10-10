import { randomUUID } from 'node:crypto';
import type {
  InboxAction,
  InboxChangedMessage,
  InboxDisplay,
  InboxInvalidatedMessage,
  InboxItemPublic,
  InboxPage,
  InboxSourceKind,
  InboxSyncSnapshot,
  InboxTarget,
} from '@gian/shared';
import { isInboxDisplay, isInboxTarget } from '@gian/shared';
import type { Db } from '../storage/db.js';
import { compareSemver } from '../plugin-store/semver.js';
import {
  InboxRepository,
  type InboxListFilter,
  type InboxRow,
} from './repository.js';
import {
  isIgnoredInboxSignal,
  parseInboxSignal,
  type InboxActor,
  type InboxSignal,
  type InboxTerminalOutcome,
} from './signal.js';

const TITLE_MAX = 120;
const SUMMARY_MAX = 280;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_SYNC_LIMIT = 200;
const IDENT = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_GONE_TITLE = 'Session unavailable';
const SESSION_GONE_SUMMARY = 'This session is no longer available.';
const CLOSED_TITLE = 'Closed';
const CLOSED_SUMMARY = 'This item is already closed.';
const RECONCILE_SCOPES = new Set<InboxReconcileScope>([
  'session.question',
  'session.approval',
  'system.repair.account',
  'system.repair.runtime',
  'system.repair.schedule',
  'system.pairing',
  'product.update.gian',
  'product.update.integration',
]);

export type InboxWriteOutcome =
  | 'created'
  | 'updated'
  | 'reopened'
  | 'duplicate'
  | 'stale'
  | 'terminal'
  | 'skipped'
  | 'resolved'
  | 'ignored';

export interface InboxWriteResult {
  outcome: InboxWriteOutcome;
  item: InboxItemPublic | null;
}

export interface InboxReconcileResult {
  changed: number;
  inbox_revision: number;
}

export type InboxReconcileScope =
  | 'session.question'
  | 'session.approval'
  | 'system.repair.account'
  | 'system.repair.runtime'
  | 'system.repair.schedule'
  | 'system.pairing'
  | 'product.update.gian'
  | 'product.update.integration';

/**
 * One producer snapshot.
 * `snapshot_revision` is `collectionRevision()` from the start of collection.
 * It is not the public list revision. The service never fills it in at apply time.
 */
export interface InboxReconcileRequest {
  scope: InboxReconcileScope;
  mode: 'complete' | 'partial';
  snapshot_revision: number;
  live: readonly unknown[];
}

export interface InboxClaimResult {
  emit: boolean;
  reason: 'ok' | 'missing' | 'stale' | 'closed' | 'read' | 'notified';
}

export class InboxError extends Error {
  constructor(
    readonly code: 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'STALE' | 'FORBIDDEN_ACTION' | 'INVALID_SOURCE',
    message: string,
  ) {
    super(message);
    this.name = 'InboxError';
  }
}

export interface InboxServiceOptions {
  now?: () => string;
  createId?: () => string;
  broadcast?: (message: InboxChangedMessage | InboxInvalidatedMessage) => void;
  /** Pending rows included in `state_sync`. Defaults to 200. */
  syncLimit?: number;
}

interface LiveFields {
  source_key: string;
  source_kind: InboxSourceKind;
  generation: number;
  title: string;
  summary: string;
  target: InboxTarget;
  display: InboxDisplay;
  candidate_version: string | null;
  candidate_channel: string | null;
  source_epoch: number | null;
}

interface PageCursor {
  updated_at: string;
  id: string;
  revision: number;
  status: InboxListFilter;
}

interface Internal {
  outcome: Exclude<InboxWriteOutcome, 'ignored'>;
  row: InboxRow;
  changed: boolean;
}

/**
 * Host-local Inbox. Producers call `upsert` / `resolve` / `reconcile`.
 * User routes call list, read, unread, and skip. Notification preferences
 * are not an input: Inbox collection does not pass through that gate.
 */
export class InboxService {
  private readonly repo: InboxRepository;
  private readonly db: Db;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly broadcast?: InboxServiceOptions['broadcast'];
  private readonly syncLimit: number;

  constructor(db: Db, options: InboxServiceOptions = {}) {
    this.db = db;
    this.repo = new InboxRepository(db);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => randomUUID());
    this.broadcast = options.broadcast;
    this.syncLimit = options.syncLimit && options.syncLimit > 0 ? options.syncLimit : DEFAULT_SYNC_LIMIT;
  }

  applySignal(input: unknown): InboxWriteResult {
    const signal = parseInboxSignal(input);
    if (isIgnoredInboxSignal(signal)) return { outcome: 'ignored', item: null };
    if (isClosedSignal(signal)) return this.resolveParsed(signal);
    return this.upsertParsed(signal);
  }

  upsert(input: unknown): InboxWriteResult {
    const signal = parseInboxSignal(input);
    if (isIgnoredInboxSignal(signal) || isClosedSignal(signal)) {
      throw new InboxError('INVALID_ARGUMENT', 'upsert accepts a live inbox item');
    }
    return this.upsertParsed(signal);
  }

  resolve(input: unknown): InboxWriteResult {
    const signal = parseInboxSignal(input);
    if (!isClosedSignal(signal)) {
      throw new InboxError('INVALID_ARGUMENT', 'resolve accepts a closed inbox signal');
    }
    return this.resolveParsed(signal);
  }

  /**
   * Close a session question or approval that is already stored.
   * A missing row stays missing: this does not insert the tombstone `resolve` writes.
   * An existing row closes at its stored generation, so a later request event cannot
   * replace the open display with a higher-generation placeholder.
   * A signal older than that stored generation writes nothing.
   */
  closeExisting(input: unknown): InboxWriteResult | null {
    const signal = parseInboxSignal(input);
    if (signal.kind !== 'session.question.closed' && signal.kind !== 'session.approval.closed') {
      throw new InboxError('INVALID_ARGUMENT', 'closeExisting accepts a session question or approval close');
    }
    const located = locateClosed(signal);
    if (!located) {
      throw new InboxError('INVALID_ARGUMENT', 'closeExisting accepts a session question or approval close');
    }
    const result = this.db.transaction(() => {
      const row = this.repo.getBySourceKey(located.source_key);
      if (!row) return null;
      if (located.generation < row.generation) return null;
      return this.finish(row, row.generation, located.outcome, located.actor, null);
    })();
    if (!result) return null;
    this.emitSingle(result);
    return { outcome: result.outcome, item: this.toPublic(result.row) };
  }

  /** Stored main-session row, without inserting a placeholder. */
  storedSessionItem(sessionId: string, interactionId: string): {
    sourceKind: 'session.question' | 'session.approval';
    generation: number;
    status: string;
  } | null {
    for (const sourceKind of ['session.question', 'session.approval'] as const) {
      const row = this.repo.getBySourceKey(sessionSourceKey(sourceKind, sessionId, interactionId));
      if (!row) continue;
      return { sourceKind, generation: row.generation, status: row.status };
    }
    return null;
  }

  /**
   * Apply one producer snapshot.
   * `snapshot_revision` must be the collection fence from the start of collection.
   * Both modes write nothing when that fence has moved.
   * `partial` upserts the listed rows and expires nothing.
   * `complete` also expires pending rows in that scope that are absent.
   * An unknown scope, an unknown mode, a missing snapshot revision, or a live
   * row from another scope writes nothing.
   */
  reconcile(input: InboxReconcileRequest): InboxReconcileResult {
    const request = reconcileRequest(input);
    const signals: InboxSignal[] = [];
    for (const entry of request.live) {
      const signal = parseInboxSignal(entry);
      if (isIgnoredInboxSignal(signal) || isClosedSignal(signal) || signalScope(signal) !== request.scope) {
        throw new InboxError('INVALID_ARGUMENT', 'reconcile live item is outside the snapshot scope');
      }
      signals.push(signal);
    }
    const changed = this.db.transaction(() => {
      if (request.snapshot_revision !== this.repo.collectionRevision()) {
        throw new InboxError('STALE', 'reconcile snapshot is stale');
      }
      const rows: InboxRow[] = [];
      const keys = new Set<string>();
      for (const signal of signals) {
        const result = this.writeOpen(signal);
        keys.add(result.row.source_key);
        if (result.changed) rows.push(result.row);
      }
      if (request.mode === 'complete') {
        for (const row of this.repo.listPendingAll()) {
          if (rowInScope(row, request.scope) && !keys.has(row.source_key)) rows.push(this.expireRow(row));
        }
      }
      return rows;
    })();
    this.emitMany(changed);
    return { changed: changed.length, inbox_revision: this.repo.revision() };
  }

  claimNotification(id: string, generation: number): InboxClaimResult {
    return this.db.transaction(() => {
      const row = this.repo.getById(id);
      if (!row) return { emit: false, reason: 'missing' as const };
      if (!Number.isInteger(generation) || row.generation !== generation) {
        return { emit: false, reason: 'stale' as const };
      }
      if (row.status !== 'pending') return { emit: false, reason: 'closed' as const };
      if (row.read_generation === generation) return { emit: false, reason: 'read' as const };
      if (row.notified_generation === generation) return { emit: false, reason: 'notified' as const };
      this.repo.save({ ...row, notified_generation: generation });
      return { emit: true, reason: 'ok' as const };
    })();
  }

  /** Session end. Closes matching pending session targets without claiming a user read. */
  expireSession(sessionId: string): { changed: number } {
    if (!IDENT.test(sessionId)) throw new InboxError('INVALID_ARGUMENT', 'session_id is not a bounded identifier');
    const changed = this.db.transaction(() => {
      const rows: InboxRow[] = [];
      for (const row of this.repo.listPendingAll()) {
        const target = parseStoredTarget(row.target_json);
        if (target.type === 'session' && target.session_id === sessionId) {
          rows.push(this.expireRow(row, {
            title: SESSION_GONE_TITLE,
            summary: SESSION_GONE_SUMMARY,
            target: { type: 'unavailable', reason: 'missing' },
          }));
        }
      }
      return rows;
    })();
    this.emitMany(changed);
    return { changed: changed.length };
  }

  list(input: { status?: InboxListFilter; limit?: number; cursor?: string | null } = {}): InboxPage {
    const status = input.status ?? 'pending';
    if (status !== 'pending' && status !== 'closed' && status !== 'all') {
      throw new InboxError('INVALID_ARGUMENT', 'status is invalid');
    }
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new InboxError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 100');
    }
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const snapshot = this.db.transaction(() => {
      const inbox_revision = this.repo.revision();
      if (cursor) {
        if (cursor.status !== status) throw new InboxError('STALE', 'cursor does not match status');
        if (cursor.revision !== inbox_revision) throw new InboxError('STALE', 'cursor is stale');
      }
      return {
        rows: this.repo.list(status, cursor, limit + 1),
        pending_count: this.repo.pendingCount(),
        inbox_revision,
      };
    })();
    const page = snapshot.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(row => this.toPublic(row)),
      next_cursor: snapshot.rows.length > limit && last
        ? encodeCursor({
            updated_at: last.updated_at,
            id: last.id,
            revision: snapshot.inbox_revision,
            status,
          })
        : null,
      pending_count: snapshot.pending_count,
      inbox_revision: snapshot.inbox_revision,
    };
  }

  get(id: string): InboxItemPublic {
    return this.toPublic(this.mustGet(id));
  }

  count(): { pending_count: number; inbox_revision: number } {
    return { pending_count: this.repo.pendingCount(), inbox_revision: this.repo.revision() };
  }

  /** Fence for reconcile. Distinct from the public list revision. */
  collectionRevision(): number {
    return this.repo.collectionRevision();
  }

  markRead(id: string, generation: number): InboxItemPublic {
    this.assertGeneration(generation);
    const result = this.db.transaction(() => {
      const row = this.mustGet(id);
      if (row.generation !== generation) throw new InboxError('STALE', 'generation is stale');
      if (row.read_at !== null && row.read_generation === generation) {
        return { outcome: 'duplicate' as const, row, changed: false };
      }
      const at = this.now();
      const next: InboxRow = {
        ...row,
        read_at: at,
        read_generation: generation,
        notified_generation: generation,
        updated_at: at,
        revision: row.revision + 1,
      };
      this.repo.save(next);
      this.repo.bumpRevision();
      return { outcome: 'updated' as const, row: next, changed: true };
    })();
    this.emitSingle(result);
    return this.toPublic(result.row);
  }

  markUnread(id: string, generation: number): InboxItemPublic {
    this.assertGeneration(generation);
    const result = this.db.transaction(() => {
      const row = this.mustGet(id);
      if (row.generation !== generation) throw new InboxError('STALE', 'generation is stale');
      if (row.read_at === null || row.read_generation !== generation) {
        return { outcome: 'duplicate' as const, row, changed: false };
      }
      const at = this.now();
      const next: InboxRow = {
        ...row,
        read_at: null,
        read_generation: null,
        updated_at: at,
        revision: row.revision + 1,
      };
      this.repo.save(next);
      this.repo.bumpRevision();
      return { outcome: 'updated' as const, row: next, changed: true };
    })();
    this.emitSingle(result);
    return this.toPublic(result.row);
  }

  skipVersion(id: string, generation: number, version: string): InboxItemPublic {
    this.assertGeneration(generation);
    if (!IDENT.test(version)) throw new InboxError('INVALID_ARGUMENT', 'version is not a bounded identifier');
    const result = this.db.transaction(() => {
      const row = this.mustGet(id);
      if (row.source_kind !== 'product.update') {
        throw new InboxError('FORBIDDEN_ACTION', 'skip_version applies only to an update item');
      }
      if (row.generation !== generation || row.candidate_version !== version) {
        throw new InboxError('STALE', 'generation is stale');
      }
      if (
        row.status === 'cancelled'
        && row.skipped_version === version
        && row.skipped_channel === row.candidate_channel
      ) {
        return { outcome: 'duplicate' as const, row, changed: false };
      }
      if (row.status !== 'pending') throw new InboxError('STALE', 'update is no longer pending');
      const at = this.now();
      const display = parseStoredDisplay(row.display_json);
      const nextDisplay: InboxDisplay = display.kind === 'product.update'
        ? { ...display, skipped_version: version }
        : display;
      const next: InboxRow = {
        ...row,
        status: 'cancelled',
        closed_at: at,
        updated_at: at,
        revision: row.revision + 1,
        read_at: at,
        read_generation: generation,
        notified_generation: generation,
        skipped_version: version,
        skipped_channel: row.candidate_channel,
        display_json: JSON.stringify(nextDisplay),
      };
      this.repo.save(next);
      this.repo.bumpRevision();
      return { outcome: 'resolved' as const, row: next, changed: true };
    })();
    this.emitSingle(result);
    return this.toPublic(result.row);
  }

  syncSnapshot(): InboxSyncSnapshot {
    const items = this.repo.listPending(this.syncLimit).map(row => this.toPublic(row));
    const pending_count = this.repo.pendingCount();
    return {
      inbox_revision: this.repo.revision(),
      pending_count,
      items,
      truncated: pending_count > items.length,
    };
  }

  private upsertParsed(signal: InboxSignal): InboxWriteResult {
    const result = this.db.transaction(() => this.writeOpen(signal))();
    this.emitSingle(result);
    return { outcome: result.outcome, item: this.toPublic(result.row) };
  }

  private resolveParsed(signal: InboxSignal): InboxWriteResult {
    const result = this.db.transaction(() => this.writeClose(signal))();
    this.emitSingle(result);
    return { outcome: result.outcome, item: this.toPublic(result.row) };
  }

  private writeOpen(signal: InboxSignal): Internal {
    switch (signal.kind) {
      case 'session.question':
        return this.writeGeneration({
          source_key: sessionSourceKey('session.question', signal.session_id, signal.interaction_id),
          source_kind: 'session.question',
          generation: signal.generation,
          title: clip(signal.title, TITLE_MAX),
          summary: clip(signal.summary, SUMMARY_MAX),
          target: {
            type: 'session',
            session_id: signal.session_id,
            turn: signal.turn,
            interaction_id: signal.interaction_id,
          },
          display: { kind: 'session.question', interaction_id: signal.interaction_id },
          candidate_version: null,
          candidate_channel: null,
          source_epoch: null,
        });
      case 'session.approval':
        return this.writeGeneration({
          source_key: sessionSourceKey('session.approval', signal.session_id, signal.interaction_id),
          source_kind: 'session.approval',
          generation: signal.generation,
          title: clip(signal.title, TITLE_MAX),
          summary: clip(signal.summary, SUMMARY_MAX),
          target: {
            type: 'session',
            session_id: signal.session_id,
            turn: signal.turn,
            interaction_id: signal.interaction_id,
          },
          display: {
            kind: 'session.approval',
            interaction_id: signal.interaction_id,
            category: signal.category,
          },
          candidate_version: null,
          candidate_channel: null,
          source_epoch: null,
        });
      case 'system.repair':
        return this.writeGeneration({
          source_key: `system.repair:${signal.scope}:${signal.subject_id}`,
          source_kind: 'system.repair',
          generation: signal.fault_generation,
          title: clip(signal.title, TITLE_MAX),
          summary: clip(signal.summary, SUMMARY_MAX),
          target: { type: 'system_repair', repair: signal.scope, subject_id: signal.subject_id },
          display: { kind: 'system.repair', scope: signal.scope, subject_id: signal.subject_id },
          candidate_version: null,
          candidate_channel: null,
          source_epoch: null,
        });
      case 'system.pairing':
        return this.writeGeneration({
          source_key: `system.pairing:${signal.request_id}`,
          source_kind: 'system.pairing',
          generation: signal.generation,
          title: clip(signal.title, TITLE_MAX),
          summary: clip(signal.summary, SUMMARY_MAX),
          target: { type: 'pairing', request_id: signal.request_id },
          display: { kind: 'system.pairing', request_id: signal.request_id },
          candidate_version: null,
          candidate_channel: null,
          source_epoch: null,
        });
      case 'product.update':
        return this.writeUpdate(signal);
      default:
        throw new InboxError('INVALID_ARGUMENT', 'upsert accepts a live inbox item');
    }
  }

  private writeGeneration(fields: LiveFields): Internal {
    const existing = this.repo.getBySourceKey(fields.source_key);
    if (!existing) return this.insertPending(fields);
    if (fields.generation < existing.generation) return { outcome: 'stale', row: existing, changed: false };
    if (fields.generation === existing.generation) {
      if (existing.status !== 'pending') {
        if (existing.tombstone !== 1) return { outcome: 'terminal', row: existing, changed: false };
        if (samePayload(existing, fields)) return this.acceptTombstoneDisplay(existing);
        return this.completeTombstone(existing, fields);
      }
      if (samePayload(existing, fields)) return { outcome: 'duplicate', row: existing, changed: false };
      return this.savePending(existing, fields, existing.generation, false);
    }
    return this.savePending(existing, fields, fields.generation, true);
  }

  private writeUpdate(signal: Extract<InboxSignal, { kind: 'product.update' }>): Internal {
    const source_key = `product.update:${signal.product}:${signal.target_id}`;
    const existing = this.repo.getBySourceKey(source_key);
    const title = clip(signal.title, TITLE_MAX);
    const summary = clip(signal.summary, SUMMARY_MAX);
    if (!existing) {
      return this.insertPending({
        source_key,
        source_kind: 'product.update',
        generation: 1,
        title,
        summary,
        target: updateTarget(signal),
        display: updateDisplay(signal, null),
        candidate_version: signal.version,
        candidate_channel: signal.channel,
        source_epoch: signal.epoch,
      });
    }
    const storedEpoch = existing.source_epoch ?? 0;
    // Epoch is the producer boundary. Arrival order is not freshness.
    // A higher epoch may refresh the same pending candidate or open the next
    // generation. An older epoch does not write. A higher epoch that leaves
    // the public candidate unchanged is still remembered.
    if (signal.epoch < storedEpoch) return { outcome: 'stale', row: existing, changed: false };
    const sameCandidate = existing.candidate_version === signal.version
      && existing.candidate_channel === signal.channel;
    if (signal.epoch === storedEpoch) {
      if (!sameCandidate || existing.status !== 'pending') {
        return { outcome: existing.status === 'pending' ? 'stale' : 'terminal', row: existing, changed: false };
      }
      const fields = this.updateFields(signal, source_key, existing, existing.generation);
      if (samePayload(existing, fields)) return { outcome: 'duplicate', row: existing, changed: false };
      return { outcome: 'stale', row: existing, changed: false };
    }
    if (sameCandidate) {
      if (existing.status !== 'pending') {
        return { outcome: 'terminal', row: this.noteSeenEpoch(existing, signal.epoch), changed: false };
      }
      return this.savePending(
        existing,
        this.updateFields(signal, source_key, existing, existing.generation),
        existing.generation,
        false,
      );
    }
    if (
      existing.skipped_version
      && existing.skipped_channel === signal.channel
      && compareSemver(signal.version, existing.skipped_version) <= 0
    ) {
      return { outcome: 'skipped', row: this.noteSeenEpoch(existing, signal.epoch), changed: false };
    }
    if (
      existing.candidate_channel === signal.channel
      && existing.candidate_version
      && compareSemver(signal.version, existing.candidate_version) < 0
    ) {
      return { outcome: 'stale', row: this.noteSeenEpoch(existing, signal.epoch), changed: false };
    }
    return this.savePending(
      existing,
      this.updateFields(signal, source_key, existing, existing.generation + 1),
      existing.generation + 1,
      true,
    );
  }

  private updateFields(
    signal: Extract<InboxSignal, { kind: 'product.update' }>,
    source_key: string,
    existing: InboxRow,
    generation: number,
  ): LiveFields {
    return {
      source_key,
      source_kind: 'product.update',
      generation,
      title: clip(signal.title, TITLE_MAX),
      summary: clip(signal.summary, SUMMARY_MAX),
      target: updateTarget(signal),
      display: updateDisplay(signal, existing.skipped_version),
      candidate_version: signal.version,
      candidate_channel: signal.channel,
      source_epoch: signal.epoch,
    };
  }

  private writeClose(signal: InboxSignal): Internal {
    if (signal.kind === 'product.update.closed') return this.writeUpdateClose(signal);
    const located = locateClosed(signal);
    if (!located) throw new InboxError('INVALID_ARGUMENT', 'resolve accepts a closed inbox signal');
    const row = this.repo.getBySourceKey(located.source_key);
    if (!row) return this.insertTerminal(tombstoneFields(signal), located.outcome, located.actor);
    const current = located.generation > row.generation ? maskHigherGeneration(row, signal) : row;
    return this.finish(current, located.generation, located.outcome, located.actor, null);
  }

  private writeUpdateClose(signal: Extract<InboxSignal, { kind: 'product.update.closed' }>): Internal {
    const source_key = `product.update:${signal.product}:${signal.target_id}`;
    const row = this.repo.getBySourceKey(source_key);
    if (!row) {
      return this.insertTerminal({
        source_key,
        source_kind: 'product.update',
        generation: signal.generation,
        title: CLOSED_TITLE,
        summary: CLOSED_SUMMARY,
        target: {
          type: 'update',
          product: signal.product,
          target_id: signal.target_id,
          version: signal.version,
          channel: signal.channel,
        },
        display: {
          kind: 'product.update',
          product: signal.product,
          target_id: signal.target_id,
          version: signal.version,
          channel: signal.channel,
          // Close carries no phase. The row is terminal, so this is not an install offer.
          phase: 'available',
          skipped_version: null,
        },
        candidate_version: signal.version,
        candidate_channel: signal.channel,
        source_epoch: signal.epoch,
      }, signal.outcome, signal.actor);
    }
    const storedEpoch = row.source_epoch ?? 0;
    if (signal.epoch < storedEpoch) return { outcome: 'stale', row, changed: false };
    if (signal.generation !== row.generation) return { outcome: 'stale', row, changed: false };
    if (row.candidate_version !== signal.version || row.candidate_channel !== signal.channel) {
      return { outcome: 'stale', row, changed: false };
    }
    if (row.status === signal.outcome) {
      return { outcome: 'duplicate', row: this.noteSeenEpoch(row, signal.epoch), changed: false };
    }
    if (row.status !== 'pending') return { outcome: 'stale', row, changed: false };
    return this.applyTerminal(row, row.generation, signal.outcome, signal.actor, signal.epoch);
  }

  private finish(
    row: InboxRow,
    generation: number,
    outcome: InboxTerminalOutcome,
    actor: InboxActor,
    sourceEpoch: number | null,
  ): Internal {
    if (generation < row.generation) return { outcome: 'stale', row, changed: false };
    if (generation === row.generation) {
      if (row.status === outcome) return { outcome: 'duplicate', row, changed: false };
      if (row.status !== 'pending') return { outcome: 'stale', row, changed: false };
    }
    return this.applyTerminal(row, generation, outcome, actor, sourceEpoch ?? row.source_epoch);
  }

  private applyTerminal(
    row: InboxRow,
    generation: number,
    outcome: InboxTerminalOutcome,
    actor: InboxActor,
    sourceEpoch: number | null,
  ): Internal {
    const at = this.now();
    const user = actor === 'user';
    // A user resolve marks the item read, but keeps an earlier read at the
    // same generation instead of moving its timestamp forward.
    const alreadyRead = row.read_at !== null && row.read_generation === generation;
    const next: InboxRow = {
      ...row,
      status: outcome,
      generation,
      closed_at: at,
      updated_at: at,
      revision: row.revision + 1,
      read_at: user && !alreadyRead ? at : row.read_at,
      read_generation: user ? generation : row.read_generation,
      notified_generation: user ? generation : row.notified_generation,
      source_epoch: sourceEpoch,
    };
    this.repo.save(next);
    this.repo.bumpRevision();
    return { outcome: 'resolved', row: next, changed: true };
  }

  private insertTerminal(fields: LiveFields, outcome: InboxTerminalOutcome, actor: InboxActor): Internal {
    const at = this.now();
    const user = actor === 'user';
    const row: InboxRow = {
      id: this.createId(),
      source_key: fields.source_key,
      source_kind: fields.source_kind,
      status: outcome,
      generation: fields.generation,
      revision: 1,
      read_at: user ? at : null,
      read_generation: user ? fields.generation : null,
      notified_generation: user ? fields.generation : null,
      title: fields.title,
      summary: fields.summary,
      target_json: JSON.stringify(fields.target),
      display_json: JSON.stringify(fields.display),
      candidate_version: fields.candidate_version,
      candidate_channel: fields.candidate_channel,
      skipped_version: null,
      skipped_channel: null,
      source_epoch: fields.source_epoch,
      tombstone: fields.source_kind === 'product.update' ? 0 : 1,
      created_at: at,
      updated_at: at,
      closed_at: at,
    };
    this.repo.insert(row);
    this.repo.bumpRevision();
    return { outcome: 'resolved', row, changed: true };
  }

  private insertPending(fields: LiveFields): Internal {
    const at = this.now();
    const row: InboxRow = {
      id: this.createId(),
      source_key: fields.source_key,
      source_kind: fields.source_kind,
      status: 'pending',
      generation: fields.generation,
      revision: 1,
      read_at: null,
      read_generation: null,
      notified_generation: null,
      title: fields.title,
      summary: fields.summary,
      target_json: JSON.stringify(fields.target),
      display_json: JSON.stringify(fields.display),
      candidate_version: fields.candidate_version,
      candidate_channel: fields.candidate_channel,
      skipped_version: null,
      skipped_channel: null,
      source_epoch: fields.source_epoch,
      tombstone: 0,
      created_at: at,
      updated_at: at,
      closed_at: null,
    };
    this.repo.insert(row);
    this.repo.bumpRevision();
    return { outcome: 'created', row, changed: true };
  }

  private savePending(existing: InboxRow, fields: LiveFields, generation: number, reopen: boolean): Internal {
    const at = this.now();
    const next: InboxRow = {
      ...existing,
      status: 'pending',
      generation,
      revision: existing.revision + 1,
      read_at: reopen ? null : existing.read_at,
      read_generation: reopen ? null : existing.read_generation,
      notified_generation: existing.notified_generation,
      title: fields.title,
      summary: fields.summary,
      target_json: JSON.stringify(fields.target),
      display_json: JSON.stringify(fields.display),
      candidate_version: fields.candidate_version,
      candidate_channel: fields.candidate_channel,
      source_epoch: fields.source_epoch,
      tombstone: 0,
      updated_at: at,
      closed_at: null,
    };
    this.repo.save(next);
    this.repo.bumpRevision();
    return { outcome: reopen ? 'reopened' : 'updated', row: next, changed: true };
  }

  /** Fill a safe tombstone. Status, generation, and read state stay closed. */
  private completeTombstone(existing: InboxRow, fields: LiveFields): Internal {
    const at = this.now();
    const next: InboxRow = {
      ...existing,
      revision: existing.revision + 1,
      title: fields.title,
      summary: fields.summary,
      target_json: JSON.stringify(fields.target),
      display_json: JSON.stringify(fields.display),
      tombstone: 0,
      updated_at: at,
    };
    this.repo.save(next);
    this.repo.bumpRevision();
    return { outcome: 'updated', row: next, changed: true };
  }

  /**
   * The open repeats the placeholder already stored for this generation.
   * Clear the fill flag without a public revision, timestamp, or broadcast.
   */
  private acceptTombstoneDisplay(existing: InboxRow): Internal {
    this.repo.clearTombstone(existing.id);
    return { outcome: 'duplicate', row: { ...existing, tombstone: 0 }, changed: false };
  }

  /** A higher epoch that does not change the public item still raises the high water. */
  private noteSeenEpoch(row: InboxRow, epoch: number): InboxRow {
    if (row.source_epoch !== null && epoch <= row.source_epoch) return row;
    this.repo.rememberEpoch(row.id, epoch);
    return { ...row, source_epoch: epoch };
  }

  private expireRow(
    row: InboxRow,
    patch?: { title: string; summary: string; target: InboxTarget },
  ): InboxRow {
    const at = this.now();
    const next: InboxRow = {
      ...row,
      status: 'expired',
      closed_at: at,
      updated_at: at,
      revision: row.revision + 1,
      ...(patch
        ? {
            title: patch.title,
            summary: patch.summary,
            target_json: JSON.stringify(patch.target),
          }
        : {}),
    };
    this.repo.save(next);
    this.repo.bumpRevision();
    return next;
  }

  private emitSingle(result: Internal): void {
    if (!result.changed || !this.broadcast) return;
    this.broadcast({
      type: 'inbox:changed',
      inbox_revision: this.repo.revision(),
      item: this.toPublic(result.row),
    });
  }

  private emitMany(rows: readonly InboxRow[]): void {
    if (!this.broadcast || rows.length === 0) return;
    const inbox_revision = this.repo.revision();
    if (rows.length === 1) {
      this.broadcast({
        type: 'inbox:changed',
        inbox_revision,
        item: this.toPublic(rows[0]!),
      });
      return;
    }
    this.broadcast({ type: 'inbox:invalidated', inbox_revision });
  }

  private mustGet(id: string): InboxRow {
    const row = this.repo.getById(id);
    if (!row) throw new InboxError('NOT_FOUND', 'inbox item not found');
    return row;
  }

  private assertGeneration(generation: number): void {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new InboxError('INVALID_ARGUMENT', 'generation must be a positive integer');
    }
  }

  private toPublic(row: InboxRow): InboxItemPublic {
    const target = parseStoredTarget(row.target_json);
    const display = parseStoredDisplay(row.display_json);
    return {
      id: row.id,
      source_kind: row.source_kind,
      status: row.status,
      generation: row.generation,
      revision: row.revision,
      unread: row.read_at === null || row.read_generation !== row.generation,
      read_at: row.read_at,
      title: clip(row.title, TITLE_MAX),
      summary: clip(row.summary, SUMMARY_MAX),
      target,
      display,
      actions: actionsFor(row, target, display),
      created_at: row.created_at,
      updated_at: row.updated_at,
      closed_at: row.closed_at,
    };
  }
}

function isClosedSignal(signal: InboxSignal): boolean {
  return signal.kind.endsWith('.closed');
}

/** Length-prefixed pair. A colon inside either ident cannot collide with another pair. */
function sessionSourceKey(
  kind: 'session.question' | 'session.approval',
  sessionId: string,
  interactionId: string,
): string {
  return `${kind}:${prefixedField(sessionId)}${prefixedField(interactionId)}`;
}

function prefixedField(value: string): string {
  return `${value.length}:${value}`;
}

function maskHigherGeneration(row: InboxRow, signal: InboxSignal): InboxRow {
  const tomb = higherGenerationTombstone(row, signal);
  return {
    ...row,
    tombstone: 1,
    title: tomb.title,
    summary: tomb.summary,
    target_json: JSON.stringify(tomb.target),
    display_json: JSON.stringify(tomb.display),
  };
}

function higherGenerationTombstone(row: InboxRow, signal: InboxSignal): LiveFields {
  if (signal.kind === 'session.approval.closed' && !signal.category) {
    const display = parseStoredDisplay(row.display_json);
    if (display.kind !== 'session.approval') {
      throw new InboxError('INVALID_ARGUMENT', 'approval close needs a category when no row exists');
    }
    return {
      source_key: sessionSourceKey('session.approval', signal.session_id, signal.interaction_id),
      source_kind: 'session.approval',
      generation: signal.generation,
      title: CLOSED_TITLE,
      summary: CLOSED_SUMMARY,
      target: {
        type: 'session',
        session_id: signal.session_id,
        turn: null,
        interaction_id: signal.interaction_id,
      },
      display: {
        kind: 'session.approval',
        interaction_id: signal.interaction_id,
        category: display.category,
      },
      candidate_version: null,
      candidate_channel: null,
      source_epoch: null,
    };
  }
  return tombstoneFields(signal);
}

function locateClosed(signal: InboxSignal): {
  source_key: string;
  generation: number;
  outcome: InboxTerminalOutcome;
  actor: InboxActor;
} | null {
  switch (signal.kind) {
    case 'session.question.closed':
      return {
        source_key: sessionSourceKey('session.question', signal.session_id, signal.interaction_id),
        generation: signal.generation,
        outcome: signal.outcome,
        actor: signal.actor,
      };
    case 'session.approval.closed':
      return {
        source_key: sessionSourceKey('session.approval', signal.session_id, signal.interaction_id),
        generation: signal.generation,
        outcome: signal.outcome,
        actor: signal.actor,
      };
    case 'system.repair.closed':
      return {
        source_key: `system.repair:${signal.scope}:${signal.subject_id}`,
        generation: signal.fault_generation,
        outcome: signal.outcome,
        actor: signal.actor,
      };
    case 'system.pairing.closed':
      return {
        source_key: `system.pairing:${signal.request_id}`,
        generation: signal.generation,
        outcome: signal.outcome,
        actor: signal.actor,
      };
    default:
      return null;
  }
}

function updateTarget(signal: Extract<InboxSignal, { kind: 'product.update' }>): InboxTarget {
  return {
    type: 'update',
    product: signal.product,
    target_id: signal.target_id,
    version: signal.version,
    channel: signal.channel,
  };
}

function updateDisplay(
  signal: Extract<InboxSignal, { kind: 'product.update' }>,
  skipped: string | null,
): InboxDisplay {
  return {
    kind: 'product.update',
    product: signal.product,
    target_id: signal.target_id,
    version: signal.version,
    channel: signal.channel,
    phase: signal.phase,
    skipped_version: skipped,
  };
}

function samePayload(row: InboxRow, fields: LiveFields): boolean {
  return row.title === fields.title
    && row.summary === fields.summary
    && row.target_json === JSON.stringify(fields.target)
    && row.display_json === JSON.stringify(fields.display)
    && row.candidate_version === fields.candidate_version
    && row.candidate_channel === fields.candidate_channel;
}

function parseStoredTarget(json: string): InboxTarget {
  try {
    const value: unknown = JSON.parse(json);
    if (isInboxTarget(value)) return value;
  } catch {
    // Stored JSON is host-written. A bad value becomes unavailable, never the current session.
  }
  return { type: 'unavailable', reason: 'unknown' };
}

function parseStoredDisplay(json: string): InboxDisplay {
  const value: unknown = JSON.parse(json);
  if (!isInboxDisplay(value)) throw new InboxError('INVALID_ARGUMENT', 'stored display is not an inbox display');
  return value;
}

function actionsFor(row: InboxRow, target: InboxTarget, display: InboxDisplay): InboxAction[] {
  if (target.type === 'unavailable') return [];
  if (row.status !== 'pending') return ['open'];
  switch (row.source_kind) {
    case 'session.question':
      return ['open', 'answer', 'cancel'];
    case 'session.approval':
      return ['open', 'approve', 'reject'];
    case 'system.repair':
      return ['open'];
    case 'system.pairing':
      return ['open', 'approve', 'reject'];
    case 'product.update': {
      const actions: InboxAction[] = ['open', 'skip_version'];
      if (display.kind === 'product.update' && display.phase === 'failed') actions.push('retry');
      return actions;
    }
    default:
      return ['open'];
  }
}

function clip(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify({
    u: cursor.updated_at,
    i: cursor.id,
    r: cursor.revision,
    s: cursor.status,
  }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): PageCursor {
  if (raw.length > 512) throw new InboxError('INVALID_ARGUMENT', 'cursor is invalid');
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof json !== 'object' || json === null) throw new Error('cursor');
    const body = json as {
      u?: unknown;
      i?: unknown;
      r?: unknown;
      s?: unknown;
      updated_at?: unknown;
      id?: unknown;
      revision?: unknown;
      status?: unknown;
    };
    const updated_at = typeof body.u === 'string' ? body.u : body.updated_at;
    const id = typeof body.i === 'string' ? body.i : body.id;
    const revision = typeof body.r === 'number' ? body.r : body.revision;
    const status = typeof body.s === 'string' ? body.s : body.status;
    if (typeof updated_at !== 'string' || updated_at.length === 0 || updated_at.length > 64) {
      throw new Error('cursor');
    }
    if (typeof id !== 'string' || !IDENT.test(id)) throw new Error('cursor');
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) throw new Error('cursor');
    if (status !== 'pending' && status !== 'closed' && status !== 'all') throw new Error('cursor');
    return { updated_at, id, revision, status };
  } catch (error) {
    if (error instanceof InboxError) throw error;
    throw new InboxError('INVALID_ARGUMENT', 'cursor is invalid');
  }
}

function reconcileRequest(input: InboxReconcileRequest): InboxReconcileRequest {
  const body: unknown = input;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InboxError('INVALID_ARGUMENT', 'reconcile requires a scoped complete or partial snapshot');
  }
  const record = body as { scope?: unknown; mode?: unknown; snapshot_revision?: unknown; live?: unknown };
  if (typeof record.scope !== 'string' || !RECONCILE_SCOPES.has(record.scope as InboxReconcileScope)) {
    throw new InboxError('INVALID_ARGUMENT', 'reconcile scope is not a producer snapshot');
  }
  if (record.mode !== 'complete' && record.mode !== 'partial') {
    throw new InboxError('INVALID_ARGUMENT', 'reconcile mode must be complete or partial');
  }
  if (
    typeof record.snapshot_revision !== 'number'
    || !Number.isInteger(record.snapshot_revision)
    || record.snapshot_revision < 0
  ) {
    throw new InboxError('INVALID_ARGUMENT', 'reconcile snapshot_revision must be a non-negative integer');
  }
  if (!Array.isArray(record.live)) {
    throw new InboxError('INVALID_ARGUMENT', 'reconcile requires a scoped complete or partial snapshot');
  }
  return {
    scope: record.scope as InboxReconcileScope,
    mode: record.mode,
    snapshot_revision: record.snapshot_revision,
    live: record.live,
  };
}

function signalScope(signal: InboxSignal): InboxReconcileScope | null {
  switch (signal.kind) {
    case 'session.question':
      return 'session.question';
    case 'session.approval':
      return 'session.approval';
    case 'system.repair':
      return `system.repair.${signal.scope}`;
    case 'system.pairing':
      return 'system.pairing';
    case 'product.update':
      return signal.product === 'gian' ? 'product.update.gian' : 'product.update.integration';
    default:
      return null;
  }
}

function rowInScope(row: InboxRow, scope: InboxReconcileScope): boolean {
  switch (scope) {
    case 'session.question':
    case 'session.approval':
    case 'system.pairing':
      return row.source_kind === scope;
    case 'system.repair.account':
    case 'system.repair.runtime':
    case 'system.repair.schedule':
      return row.source_key.startsWith(`system.repair:${scope.slice('system.repair.'.length)}:`);
    case 'product.update.gian':
      return row.source_key.startsWith('product.update:gian:');
    case 'product.update.integration':
      return row.source_key.startsWith('product.update:integration:');
    default:
      return false;
  }
}

function tombstoneFields(signal: InboxSignal): LiveFields {
  switch (signal.kind) {
    case 'session.question.closed':
      return {
        source_key: sessionSourceKey('session.question', signal.session_id, signal.interaction_id),
        source_kind: 'session.question',
        generation: signal.generation,
        title: CLOSED_TITLE,
        summary: CLOSED_SUMMARY,
        target: {
          type: 'session',
          session_id: signal.session_id,
          turn: null,
          interaction_id: signal.interaction_id,
        },
        display: { kind: 'session.question', interaction_id: signal.interaction_id },
        candidate_version: null,
        candidate_channel: null,
        source_epoch: null,
      };
    case 'session.approval.closed': {
      if (!signal.category) {
        throw new InboxError('INVALID_ARGUMENT', 'approval close needs a category when no row exists');
      }
      return {
        source_key: sessionSourceKey('session.approval', signal.session_id, signal.interaction_id),
        source_kind: 'session.approval',
        generation: signal.generation,
        title: CLOSED_TITLE,
        summary: CLOSED_SUMMARY,
        target: {
          type: 'session',
          session_id: signal.session_id,
          turn: null,
          interaction_id: signal.interaction_id,
        },
        display: {
          kind: 'session.approval',
          interaction_id: signal.interaction_id,
          category: signal.category,
        },
        candidate_version: null,
        candidate_channel: null,
        source_epoch: null,
      };
    }
    case 'system.repair.closed':
      return {
        source_key: `system.repair:${signal.scope}:${signal.subject_id}`,
        source_kind: 'system.repair',
        generation: signal.fault_generation,
        title: CLOSED_TITLE,
        summary: CLOSED_SUMMARY,
        target: { type: 'system_repair', repair: signal.scope, subject_id: signal.subject_id },
        display: { kind: 'system.repair', scope: signal.scope, subject_id: signal.subject_id },
        candidate_version: null,
        candidate_channel: null,
        source_epoch: null,
      };
    case 'system.pairing.closed':
      return {
        source_key: `system.pairing:${signal.request_id}`,
        source_kind: 'system.pairing',
        generation: signal.generation,
        title: CLOSED_TITLE,
        summary: CLOSED_SUMMARY,
        target: { type: 'pairing', request_id: signal.request_id },
        display: { kind: 'system.pairing', request_id: signal.request_id },
        candidate_version: null,
        candidate_channel: null,
        source_epoch: null,
      };
    default:
      throw new InboxError('INVALID_ARGUMENT', 'resolve accepts a closed inbox signal');
  }
}
