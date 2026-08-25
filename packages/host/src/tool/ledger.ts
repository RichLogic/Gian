import { createHash, randomUUID } from 'node:crypto';
import type {
  GianToolCall,
  GianToolError,
  GianToolMethod,
} from '@gian/shared';
import type { Db } from '../storage/db.js';
import { fail } from './errors.js';

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
  state: 'pending' | 'started' | 'queued' | 'steered' | 'completed' | 'error' | 'stopped' | 'cancelled';
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
  return method === 'task.create' || method === 'session.create' || method === 'session.send'
    ? randomUUID()
    : null;
}

export class GianToolLedger {
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

  private prune(maxRows = 10_000): void {
    this.db.prepare(
      `DELETE FROM tool_requests
        WHERE id IN (
          SELECT id FROM tool_requests
           WHERE status IN ('succeeded', 'failed')
           ORDER BY updated_at DESC LIMIT -1 OFFSET ?
        )`,
    ).run(maxRows);
  }
}
