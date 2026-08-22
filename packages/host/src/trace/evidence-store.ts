import {
  type ProxyNotification as ProtocolNotification,
} from '@gian/proxy-protocol';
import type { Db } from '../storage/db.js';

/**
 * Canonical Trace evidence persistence.
 *
 * One trace_events row per gian.proxy/2.0 notification that reached the
 * coordinator's standard turn-scoped path (live or replay). The row keeps the
 * protocol identity fields the Trace projection needs — eventId, streamId,
 * sequence, sessionId, turnId, emittedAt, method — plus a normalized, bounded
 * view of the event payload.
 *
 * Idempotency: the (session_id, event_id) primary key makes repeated arrival
 * of the same eventId a no-op, so live delivery and replay can both persist
 * without generating duplicates.
 *
 * This table is intentionally separate from the transcript events table:
 * Chat keeps its display projection there, Trace keeps its canonical payload
 * here. Nothing in this module reads or writes transcript rows.
 */

/** Upper bound for a stored normalized payload. The cap applies only after
 *  allowlisting and recursive sanitization; the stored truncation marker
 *  never contains original payload content. */
export const MAX_TRACE_EVENT_DATA_BYTES = 64 * 1024;

/** Explicit event allowlist: only these methods land in trace_events. */
export const TRACE_EVIDENCE_METHODS: ReadonlySet<string> = new Set([
  'turn.started',
  'turn.completed',
  'turn.failed',
  'input.recorded',
  'content.delta',
  'content.completed',
  'tool.started',
  'tool.updated',
  'tool.completed',
  'activity.updated',
  'step.updated',
  'request.updated',
  'usage.updated',
  'plan.updated',
  'agent.updated',
  'notice.created',
]);

/** Bounded sanitization limits (named constants). */
export const TRACE_MAX_STRING_CHARS = 2048;
export const TRACE_MAX_ARRAY_ITEMS = 32;
export const TRACE_MAX_OBJECT_FIELDS = 32;
export const TRACE_MAX_DEPTH = 6;
export const TRACE_REDACTED_VALUE = '[redacted]';
export const TRACE_TRUNCATED_FLAG = '__gian_truncated';

/**
 * Core identity fields per method. When the sanitized payload exceeds the
 * global byte cap, these fields are always retained (toolCallId, contentId,
 * planId, status, ...) so projection never loses lifecycle identity; only
 * the crop-able payload fields (input, steps, content, ...) are folded into
 * the truncation marker.
 */
const TRACE_CORE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'turn.started': new Set(),
  'turn.completed': new Set(['stopReason']),
  'turn.failed': new Set(['error']),
  'input.recorded': new Set(['inputId']),
  'content.delta': new Set(['contentId', 'kind', 'stepId']),
  'content.completed': new Set(['contentId', 'kind', 'stepId']),
  'tool.started': new Set(['toolCallId', 'name', 'title', 'stepId']),
  'tool.updated': new Set(['toolCallId', 'statusText', 'stepId']),
  'tool.completed': new Set(['toolCallId', 'status', 'stepId']),
  'activity.updated': new Set(['activityId', 'kind', 'title', 'status', 'stepId']),
  'step.updated': new Set(['stepId', 'index', 'status']),
  'request.updated': new Set(['requestId', 'reason', 'stepId']),
  'usage.updated': new Set(['stepId']),
  'plan.updated': new Set(['planId', 'title']),
  'agent.updated': new Set(['agentId', 'status', 'description', 'agentType', 'model', 'outputChars']),
  'notice.created': new Set(['noticeId', 'severity', 'code', 'title', 'message']),
};

/** Keep only the core identity fields when the payload had to be truncated. */
function coreFieldsFor(method: string, normalized: Record<string, unknown>): Record<string, unknown> {
  const core = TRACE_CORE_FIELDS[method] ?? new Set<string>();
  const out: Record<string, unknown> = {};
  for (const key of core) {
    if (normalized[key] !== undefined) out[key] = normalized[key];
  }
  return out;
}

/**
 * Sensitive key detection. Keys are first normalized from camelCase /
 * PascalCase / kebab-case / snake_case into underscore-separated lowercase
 * segments (accessToken -> access_token, apiKey -> api_key, sessionCookie ->
 * session_cookie), then matched as whole segments against the sensitive
 * vocabulary. The safety boundary errs on the side of redacting more.
 */
const SENSITIVE_SEGMENT_RE =
  /(?:^|_)(?:password|passwd|secret|token|authorization|auth|api[_-]?key|cookie|credential|resume_ref)s?(?:_|$)/;

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  return SENSITIVE_SEGMENT_RE.test(normalized);
}

/** Decoded row shape shared by the store and the projector. */
export interface TraceEvidenceRow {
  eventId: string;
  streamId: string;
  sequence: number;
  streamGeneration: number;
  sessionId: string;
  turnId: string | null;
  emittedAt: string;
  method: string;
  data: Record<string, unknown>;
}

interface TraceEventRow {
  event_id: string;
  stream_id: string;
  sequence: number;
  stream_generation: number;
  session_id: string;
  turn_id: string | null;
  emitted_at: string;
  method: string;
  data: string;
}

export class TraceEvidenceStore {
  constructor(private db: Db) {}

  /**
   * Persist one validated v2 notification as canonical Trace evidence.
   * Only allowlisted methods are stored; every stored payload passes the
   * per-method field allowlist and the recursive bounded sanitizer.
   * Idempotent: a repeated eventId for the same session is ignored.
   */
  persist(notification: ProtocolNotification): void {
    if (!TRACE_EVIDENCE_METHODS.has(notification.method)) return;
    const params = notification.params;
    if (
      !('eventId' in params)
      || !('streamId' in params)
      || !('sequence' in params)
      || !('sessionId' in params)
      || !('emittedAt' in params)
    ) {
      return;
    }
    const normalized = normalizeTraceEvidenceData(notification.method, params.data);
    const encoded = JSON.stringify(normalized);
    const byteLength = Buffer.byteLength(encoded);
    const stored = byteLength > MAX_TRACE_EVENT_DATA_BYTES
      ? JSON.stringify({
          ...coreFieldsFor(notification.method, normalized),
          [TRACE_TRUNCATED_FLAG]: { byte_length: byteLength },
        })
      : encoded;
    const streamGeneration = this.streamGeneration(
      params.sessionId,
      params.streamId,
    );
    this.db.prepare(
      `INSERT OR IGNORE INTO trace_events
        (event_id, stream_id, sequence, stream_generation, session_id, turn_id, emitted_at, method, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.eventId,
      params.streamId,
      params.sequence,
      streamGeneration,
      params.sessionId,
      'turnId' in params ? params.turnId : null,
      params.emittedAt,
      notification.method,
      stored,
    );
  }

  /**
   * Host-assigned stable order for a protocol stream. The protocol resets
   * sequence when a session is re-attached with a new streamId, so each
   * stream gets a session-monotonic generation; events from a reconnected
   * stream must never sort before older streams.
   */
  private streamGeneration(sessionId: string, streamId: string): number {
    const existing = this.db.prepare(
      `SELECT stream_generation FROM trace_events
       WHERE session_id = ? AND stream_id = ?
       ORDER BY stream_generation ASC LIMIT 1`,
    ).get(sessionId, streamId) as { stream_generation: number } | undefined;
    if (existing) return existing.stream_generation;
    const next = this.db.prepare(
      `SELECT COALESCE(MAX(stream_generation), 0) + 1 AS generation
       FROM trace_events WHERE session_id = ?`,
    ).get(sessionId) as { generation: number };
    return next.generation;
  }

  /** All evidence rows for a session in stable protocol-sequence order. */
  listEvidence(sessionId: string): TraceEvidenceRow[] {
    const rows = this.db.prepare(
      `SELECT event_id, stream_id, sequence, stream_generation, session_id, turn_id, emitted_at, method, data
       FROM trace_events
       WHERE session_id = ?
       ORDER BY stream_generation ASC, sequence ASC, event_id ASC`,
    ).all(sessionId) as TraceEventRow[];
    return rows.map(row => ({
      eventId: row.event_id,
      streamId: row.stream_id,
      sequence: row.sequence,
      streamGeneration: row.stream_generation,
      sessionId: row.session_id,
      turnId: row.turn_id,
      emittedAt: row.emitted_at,
      method: row.method,
      data: decodeEvidenceData(row.data),
    }));
  }
}

function decodeEvidenceData(encoded: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(encoded) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    console.warn('[trace] undecodable trace_events payload; ignoring row data');
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Per-method field allowlist plus recursive bounded sanitization.
 *
 * Deletion rules stricter than generic sanitization:
 * - tool raw output is never stored ('tool.completed' drops output);
 * - 'tool.updated' drops outputDelta/data, keeping only statusText;
 * - terminal command/status content text is dropped;
 * - diff text is never stored ('diff.updated' is not allowlisted);
 * - approval payloads are never stored (approval.* not allowlisted);
 * - 'agent.updated' drops the output body, keeping only outputChars metadata;
 * - tool input is stored only as the recursively sanitized/bounded summary;
 * - errors keep only bounded code/message/retryable.
 *
 * The default branch never returns raw data; allowlist enforcement happens in
 * persist(), and the switch is exhaustive over the allowlist.
 */
function normalizeTraceEvidenceData(method: string, data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return {};
  switch (method) {
    case 'turn.started':
      return {};
    case 'turn.completed':
      return pickStrings(data, 'stopReason');
    case 'turn.failed':
      return { error: sanitizeError(data['error']) };
    case 'input.recorded':
      return {
        ...pickStrings(data, 'inputId'),
        ...(data['input'] !== undefined ? { input: sanitizeValue(data['input']) } : {}),
      };
    case 'content.delta':
    case 'content.completed': {
      const kind = stringValue(data['kind']);
      const base: Record<string, unknown> = {
        ...pickStrings(data, 'contentId', 'stepId'),
        kind,
      };
      // Terminal command/status output is intentionally excluded from Trace.
      if (kind === 'command' || kind === 'status') return base;
      if (method === 'content.delta' && data['delta'] !== undefined) {
        base['delta'] = sanitizeString(data['delta']);
      }
      if (method === 'content.completed' && data['content'] !== undefined) {
        base['content'] = sanitizeString(data['content']);
      }
      return base;
    }
    case 'tool.started':
      return {
        ...pickStrings(data, 'toolCallId', 'name', 'title', 'stepId'),
        ...(data['input'] !== undefined ? { input: sanitizeValue(data['input']) } : {}),
      };
    case 'tool.updated':
      return pickStrings(data, 'toolCallId', 'statusText', 'stepId');
    case 'tool.completed':
      return {
        ...pickStrings(data, 'toolCallId', 'status', 'stepId'),
        ...(data['error'] !== undefined ? { error: sanitizeError(data['error']) } : {}),
      };
    case 'activity.updated':
      return {
        ...pickStrings(data, 'activityId', 'kind', 'title', 'status', 'summary', 'stepId'),
        ...(data['presentation'] !== undefined ? { presentation: sanitizeValue(data['presentation']) } : {}),
      };
    case 'step.updated':
      return {
        ...pickStrings(data, 'stepId', 'status'),
        ...(typeof data['index'] === 'number' ? { index: data['index'] } : {}),
      };
    case 'request.updated':
      return {
        ...pickStrings(data, 'requestId', 'reason', 'stepId'),
        ...(data['model'] !== undefined ? { model: sanitizeValue(data['model']) } : {}),
        ...(data['parameters'] !== undefined ? { parameters: sanitizeValue(data['parameters']) } : {}),
        ...(data['systemPrompt'] !== undefined ? { systemPrompt: sanitizeValue(data['systemPrompt']) } : {}),
        ...(data['tools'] !== undefined ? { tools: sanitizeValue(data['tools']) } : {}),
        ...(data['context'] !== undefined ? { context: sanitizeValue(data['context']) } : {}),
        ...(typeof data['truncated'] === 'boolean' ? { truncated: data['truncated'] } : {}),
        ...(data['artifact'] !== undefined ? { artifact: sanitizeValue(data['artifact']) } : {}),
      };
    case 'usage.updated':
      return {
        ...pickStrings(data, 'stepId'),
        ...(data['context'] !== undefined ? { context: sanitizeValue(data['context']) } : {}),
        ...(data['conversation'] !== undefined
          ? { conversation: sanitizeUsageConversation(data['conversation']) }
          : {}),
      };
    case 'plan.updated':
      return {
        ...pickStrings(data, 'planId', 'title'),
        ...(data['steps'] !== undefined ? { steps: sanitizeValue(data['steps']) } : {}),
      };
    case 'agent.updated': {
      const output = data['output'];
      return {
        ...pickStrings(data, 'agentId', 'status', 'description', 'agentType', 'model'),
        ...(typeof output === 'string' && output.length > 0
          ? { outputChars: output.length }
          : {}),
      };
    }
    case 'notice.created':
      return pickStrings(data, 'noticeId', 'severity', 'code', 'title', 'message');
    default:
      return {};
  }
}

function sanitizeUsageConversation(value: unknown): unknown {
  if (!isRecord(value)) return sanitizeValue(value);
  const out: Record<string, unknown> = {};
  if (typeof value['mode'] === 'string') out['mode'] = value['mode'];
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens']) {
    if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0) {
      out[key] = value[key];
    }
  }
  return out;
}

/** Pick only allowlisted string fields, sanitized; absent fields are omitted. */
function pickStrings(data: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (data[key] === undefined) continue;
    const sanitized = sanitizeString(data[key]);
    if (sanitized !== null) out[key] = sanitized;
  }
  return out;
}

/** Bounded string: oversized values are replaced by a safe length marker —
 *  original content is never stored for oversized strings. */
function sanitizeString(value: unknown): string | Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  if (value.length <= TRACE_MAX_STRING_CHARS) return value;
  return { [TRACE_TRUNCATED_FLAG]: true, chars: value.length };
}

/** Errors keep only bounded code/message/retryable fields. */
function sanitizeError(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  const code = stringValue(value['code']);
  if (code) out['code'] = code.slice(0, TRACE_MAX_STRING_CHARS);
  const message = stringValue(value['message']);
  if (message) out['message'] = message.slice(0, TRACE_MAX_STRING_CHARS);
  if (typeof value['retryable'] === 'boolean') out['retryable'] = value['retryable'];
  return out;
}

/**
 * Recursive bounded sanitization:
 * - sensitive key names (token/password/authorization/apiKey/cookie/
 *   credential and variants) are replaced with TRACE_REDACTED_VALUE — their
 *   original values never reach storage;
 * - string length, array item count, object field count, and nesting depth
 *   are bounded by the named constants above; truncation stores only a safe
 *   count/depth marker, never the original content;
 * - oversized final payloads are handled by the persist() byte cap, which
 *   also stores only a marker.
 */
function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) {
    if (depth >= TRACE_MAX_DEPTH) return { [TRACE_TRUNCATED_FLAG]: true, depth };
    const items = value.slice(0, TRACE_MAX_ARRAY_ITEMS)
      .map(item => sanitizeValue(item, depth + 1));
    if (value.length > TRACE_MAX_ARRAY_ITEMS) {
      items.push({ [TRACE_TRUNCATED_FLAG]: true, count: value.length });
    }
    return items;
  }
  if (isRecord(value)) {
    if (depth >= TRACE_MAX_DEPTH) return { [TRACE_TRUNCATED_FLAG]: true, depth };
    const entries = Object.entries(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, TRACE_MAX_OBJECT_FIELDS)) {
      out[key] = isSensitiveKey(key)
        ? TRACE_REDACTED_VALUE
        : sanitizeValue(item, depth + 1);
    }
    if (entries.length > TRACE_MAX_OBJECT_FIELDS) {
      out[TRACE_TRUNCATED_FLAG] = { count: entries.length };
    }
    return out;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
