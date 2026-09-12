import { createHash, randomUUID } from 'node:crypto';
import { COMMAND_RETENTION_MS, uuidV7TimestampMs } from '@gian/remote-protocol';
import type {
  GianToolCall,
  GianToolError,
  GianToolMethod,
} from '@gian/shared';
import type { QueueEntry } from '../queue/manager.js';
import type {
  DeliveryLifecycleSink,
  SteerReceipt,
  TurnReceipt,
} from '../session/delivery-lifecycle.js';
import type { Db } from '../storage/db.js';
import { fail } from './errors.js';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isRemoteToolCaller(callerId: string): boolean {
  return callerId.startsWith('remote:');
}

export function remoteCommandExpired(callerId: string, requestId: string, now = Date.now()): boolean {
  if (!isRemoteToolCaller(callerId)) return false;
  // attempt_id / Tool request_id may be any canonical UUID. Only a UUIDv7
  // command identity participates in the 90-day Remote retention window.
  if (!UUID_V7_RE.test(requestId)) return false;
  return now - uuidV7TimestampMs(requestId) > COMMAND_RETENTION_MS;
}

export interface ToolRequestRow {
  id: string;
  callerId: string;
  idempotencyKey: string;
  method: GianToolMethod;
  inputHash: string;
  status: 'in_progress' | 'succeeded' | 'failed';
  domainId: string | null;
  result: unknown;
  error: GianToolError | null;
  recovered: boolean;
}

export interface ToolDeliveryRow {
  id: string;
  requestId: string;
  callerId: string;
  sessionId: string;
  queueEntryId: string | null;
  turnId: string | null;
  state: 'pending' | 'started' | 'queued' | 'steered' | 'completed' | 'error' | 'stopped' | 'cancelled' | 'unknown';
  createdAt: string;
  updatedAt: string;
}

interface StoredRequestRow {
  id: string;
  caller_id: string;
  idempotency_key: string;
  method: string;
  input_hash: string;
  status: ToolRequestRow['status'];
  domain_id: string | null;
  result_json: string | null;
  error_json: string | null;
}

interface StoredDeliveryRow {
  id: string;
  request_id: string;
  caller_id: string;
  session_id: string;
  queue_entry_id: string | null;
  turn_id: string | null;
  state: ToolDeliveryRow['state'];
  created_at: string;
  updated_at: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  const input = value as Record<string, unknown>;
  return `{${Object.keys(input).filter(key => input[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
}

export function toolInputHash(method: GianToolMethod, params: unknown): string {
  return createHash('sha256').update(`${method}\0${canonical(params)}`).digest('hex');
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  return JSON.parse(value) as unknown;
}

function requestRow(row: StoredRequestRow): ToolRequestRow {
  return {
    id: row.id,
    callerId: row.caller_id,
    idempotencyKey: row.idempotency_key,
    method: row.method as GianToolMethod,
    inputHash: row.input_hash,
    status: row.status,
    domainId: row.domain_id,
    result: parseJson(row.result_json),
    error: parseJson(row.error_json) as GianToolError | null,
    recovered: true,
  };
}

function deliveryRow(row: StoredDeliveryRow): ToolDeliveryRow {
  return {
    id: row.id,
    requestId: row.request_id,
    callerId: row.caller_id,
    sessionId: row.session_id,
    queueEntryId: row.queue_entry_id,
    turnId: row.turn_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function preallocatedDomainId(method: GianToolMethod): string | null {
  // schedule.create pre-allocates the Schedule id so an interrupted create's
  // confirmation commit and its retries converge on one canonical row.
  return method === 'task.create' || method === 'session.create' || method === 'session.send'
    || method === 'schedule.create' || method === 'schedule.run_now'
    ? randomUUID()
    : null;
}

export class GianToolLedger implements DeliveryLifecycleSink {
  constructor(private db: Db) {}

  claim(call: GianToolCall): ToolRequestRow {
    const idempotencyKey = call.idempotency_key;
    if (!idempotencyKey) fail('INVALID_ARGUMENT', `idempotency_key is required for ${call.method}`);
    const hash = toolInputHash(call.method, call.params);
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT * FROM tool_requests WHERE caller_id = ? AND idempotency_key = ?`,
      ).get(call.caller_id, idempotencyKey) as StoredRequestRow | undefined;
      if (existing) {
        if (existing.method !== call.method || existing.input_hash !== hash) {
          fail('IDEMPOTENCY_CONFLICT', 'idempotency_key was already used with different input');
        }
        return requestRow(existing);
      }
      const requestIdCollision = this.db.prepare('SELECT 1 FROM tool_requests WHERE id = ?')
        .get(call.request_id);
      if (requestIdCollision) fail('CONFLICT', 'request_id was already used');
      const now = new Date().toISOString();
      const domainId = preallocatedDomainId(call.method);
      this.db.prepare(
        `INSERT INTO tool_requests
          (id, caller_id, idempotency_key, method, input_hash, status, domain_id,
           result_json, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'in_progress', ?, NULL, NULL, ?, ?)`,
      ).run(call.request_id, call.caller_id, idempotencyKey, call.method, hash, domainId, now, now);
      return {
        id: call.request_id,
        callerId: call.caller_id,
        idempotencyKey,
        method: call.method,
        inputHash: hash,
        status: 'in_progress' as const,
        domainId,
        result: null,
        error: null,
        recovered: false,
      };
    })();
  }

  succeed(requestId: string, result: unknown): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE tool_requests
          SET status = 'succeeded', result_json = ?, error_json = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(JSON.stringify(result), now, requestId);
    this.prune();
  }

  fail(requestId: string, error: GianToolError): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE tool_requests
          SET status = 'failed', result_json = NULL, error_json = ?, updated_at = ?
        WHERE id = ?`,
    ).run(JSON.stringify(error), now, requestId);
    this.prune();
  }

  createDelivery(request: ToolRequestRow, sessionId: string): ToolDeliveryRow {
    const existing = this.deliveryByRequest(request.id);
    if (existing) return existing;
    if (!request.domainId) throw new Error('session.send request has no preallocated delivery id');
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO tool_deliveries
        (id, request_id, session_id, queue_entry_id, turn_id, state, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, 'pending', ?, ?)`,
    ).run(request.domainId, request.id, sessionId, now, now);
    return this.deliveryByRequest(request.id)!;
  }

  delivery(id: string): ToolDeliveryRow | null {
    const row = this.db.prepare(
      `SELECT d.*, r.caller_id
         FROM tool_deliveries d JOIN tool_requests r ON r.id = d.request_id
        WHERE d.id = ?`,
    ).get(id) as StoredDeliveryRow | undefined;
    return row ? deliveryRow(row) : null;
  }

  deliveryByRequest(requestId: string): ToolDeliveryRow | null {
    const row = this.db.prepare(
      `SELECT d.*, r.caller_id
         FROM tool_deliveries d JOIN tool_requests r ON r.id = d.request_id
        WHERE d.request_id = ?`,
    ).get(requestId) as StoredDeliveryRow | undefined;
    return row ? deliveryRow(row) : null;
  }

  latestDelivery(sessionId: string): ToolDeliveryRow | null {
    const row = this.db.prepare(
      `SELECT d.*, r.caller_id
         FROM tool_deliveries d JOIN tool_requests r ON r.id = d.request_id
        WHERE d.session_id = ? ORDER BY d.updated_at DESC LIMIT 1`,
    ).get(sessionId) as StoredDeliveryRow | undefined;
    return row ? deliveryRow(row) : null;
  }

  updateDelivery(
    id: string,
    patch: { queueEntryId?: string | null; turnId?: string | null; state?: ToolDeliveryRow['state'] },
  ): ToolDeliveryRow {
    const current = this.delivery(id);
    if (!current) fail('NOT_FOUND', `delivery not found: ${id}`);
    const next = {
      queueEntryId: patch.queueEntryId !== undefined ? patch.queueEntryId : current.queueEntryId,
      turnId: patch.turnId !== undefined ? patch.turnId : current.turnId,
      state: patch.state ?? current.state,
    };
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE tool_deliveries
          SET queue_entry_id = ?, turn_id = ?, state = ?, updated_at = ?
        WHERE id = ?`,
    ).run(next.queueEntryId, next.turnId, next.state, now, id);
    return this.delivery(id)!;
  }

  removeDelivery(id: string): void {
    this.db.prepare('DELETE FROM tool_deliveries WHERE id = ?').run(id);
  }

  requestByIdempotency(callerId: string, idempotencyKey: string): ToolRequestRow | null {
    const row = this.db.prepare(
      `SELECT * FROM tool_requests WHERE caller_id = ? AND idempotency_key = ?`,
    ).get(callerId, idempotencyKey) as StoredRequestRow | undefined;
    return row ? requestRow(row) : null;
  }

  queueRemoved(entry: QueueEntry, reason: 'queue_removed' | 'queue_cleared'): void {
    if (!entry.toolRequestId) return;
    this.writeTombstone(entry, reason);
    const delivery = this.deliveryByRequest(entry.toolRequestId);
    if (!delivery || (delivery.state !== 'queued' && delivery.state !== 'pending')) return;
    this.updateDelivery(delivery.id, { state: 'cancelled', queueEntryId: null });
  }

  queueStarted(entry: QueueEntry, receipt: TurnReceipt): void {
    if (!entry.toolRequestId) return;
    const delivery = this.deliveryByRequest(entry.toolRequestId);
    if (!delivery) return;
    this.updateDelivery(delivery.id, {
      state: 'started',
      turnId: receipt.turnId,
      queueEntryId: null,
    });
  }

  queueSteered(entry: QueueEntry, receipt: SteerReceipt): void {
    if (!entry.toolRequestId) return;
    const delivery = this.deliveryByRequest(entry.toolRequestId);
    if (!delivery) return;
    this.updateDelivery(delivery.id, {
      state: 'steered',
      turnId: receipt.turnId,
      queueEntryId: null,
    });
  }

  queueRestored(entry: QueueEntry): void {
    if (!entry.toolRequestId) return;
    const delivery = this.deliveryByRequest(entry.toolRequestId);
    if (!delivery) return;
    this.updateDelivery(delivery.id, {
      state: 'queued',
      queueEntryId: entry.id,
      turnId: null,
    });
  }

  reconcileBoot(): void {
    const rows = this.db.prepare(
      `SELECT d.*, r.caller_id
         FROM tool_deliveries d JOIN tool_requests r ON r.id = d.request_id
        WHERE d.state IN ('pending', 'queued')`,
    ).all() as StoredDeliveryRow[];
    for (const row of rows) {
      const delivery = deliveryRow(row);
      const queued = this.db.prepare(
        'SELECT id FROM queue_entries WHERE tool_request_id = ?',
      ).get(delivery.requestId) as { id: string } | undefined;
      if (queued) {
        if (delivery.queueEntryId !== queued.id || delivery.state !== 'queued') {
          this.updateDelivery(delivery.id, { queueEntryId: queued.id, state: 'queued' });
        }
        continue;
      }
      const turn = delivery.turnId
        ? this.db.prepare('SELECT id, status FROM turns WHERE id = ?').get(delivery.turnId) as { id: string; status: string } | undefined
        : this.db.prepare('SELECT id, status FROM turns WHERE tool_request_id = ?').get(delivery.requestId) as { id: string; status: string } | undefined;
      if (turn) {
        const state = turn.status === 'running' ? 'started' : turn.status as ToolDeliveryRow['state'];
        this.updateDelivery(delivery.id, { turnId: turn.id, queueEntryId: null, state });
        continue;
      }
      const tombstone = this.db.prepare(
        'SELECT 1 FROM queue_delivery_tombstones WHERE tool_request_id = ?',
      ).get(delivery.requestId);
      if (tombstone) {
        this.updateDelivery(delivery.id, { state: 'cancelled', queueEntryId: null });
        continue;
      }
      this.updateDelivery(delivery.id, { state: 'unknown', queueEntryId: null });
    }
  }

  private writeTombstone(entry: QueueEntry, reason: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO queue_delivery_tombstones
        (queue_entry_id, session_id, tool_request_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(entry.id, entry.sessionId, entry.toolRequestId ?? null, reason, new Date().toISOString());
  }

  private prune(maxRows = 10_000): void {
    const cutoff = new Date(Date.now() - COMMAND_RETENTION_MS).toISOString();
    this.db.prepare(
      `DELETE FROM tool_requests
        WHERE id IN (
          SELECT r.id FROM tool_requests r
           WHERE r.status IN ('succeeded', 'failed')
             AND r.caller_id NOT LIKE 'remote:%'
             AND NOT EXISTS (
               SELECT 1 FROM tool_deliveries d
                WHERE d.request_id = r.id
                  AND d.state IN ('pending', 'queued', 'started', 'steered', 'unknown')
             )
           ORDER BY r.updated_at DESC LIMIT -1 OFFSET ?
        )`,
    ).run(maxRows);
    this.db.prepare(
      `DELETE FROM tool_requests
        WHERE status IN ('succeeded', 'failed')
          AND caller_id LIKE 'remote:%'
          AND updated_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM tool_deliveries d
             WHERE d.request_id = tool_requests.id
               AND d.state IN ('pending', 'queued', 'started', 'steered', 'unknown')
          )`,
    ).run(cutoff);
  }
}
