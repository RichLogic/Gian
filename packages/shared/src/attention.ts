/**
 * Attention wire contract for OS notifications and the Desktop attention socket.
 * Legacy clients still accept title/body. A 0.6.7 Host sets `event`,
 * `session_name`, and `target` together. `inbox_ref` is present only after
 * the canonical Inbox occurrence exists.
 * A schedule confirmation uses `approval_needed` and
 * `target.type === 'schedule_confirmation'`. It omits `turn` and requires
 * `inbox_ref`. A client whose guard still requires `turn` drops that frame,
 * so it does not open a fabricated turn. Session, Timer, and settings
 * navigation objects stay as they are.
 * The attention socket may carry these frames and nothing from the transcript.
 */
import type { Executor } from './model.js';
import { isInboxTarget, type InboxTarget } from './inbox.js';
import { isProxyPluginId } from './plugin-id.js';

export const ATTENTION_EVENTS = [
  'turn_complete',
  'answer_needed',
  'approval_needed',
  'plan_review_needed',
  'turn_failed',
] as const;

export type AttentionEvent = typeof ATTENTION_EVENTS[number];

/** English fallback for clients that still render `body`. New clients localize `event`. */
export const ATTENTION_EVENT_LABELS: Record<AttentionEvent, string> = {
  turn_complete: 'Turn complete',
  answer_needed: 'Answer needed',
  approval_needed: 'Approval needed',
  plan_review_needed: 'Plan review needed',
  turn_failed: 'Turn failed',
};

/** Preference kind that already gates delivery. Plan review stays an approval. */
export const ATTENTION_EVENT_KINDS = {
  turn_complete: 'turn-completed',
  answer_needed: 'question',
  approval_needed: 'approval',
  plan_review_needed: 'approval',
  turn_failed: 'error',
} as const;

export const ATTENTION_SESSION_NAME_MAX = 120;
export const ATTENTION_LOOKUP_MAX = 32;

export interface AttentionInboxRef {
  id: string;
  generation: number;
}

export type AttentionNavigationTarget =
  | InboxTarget
  | {
      type: 'side_chat';
      parent_session_id: string;
      sidechat_id: string;
      turn: number | null;
      interaction_id: string | null;
    };

export interface AttentionControlItem {
  id: string;
  generation: number;
  revision: number;
  read: boolean;
  terminal: boolean;
}

/** Host → attention socket. Identifiers and read/terminal state only. */
export interface AttentionControlMessage {
  type: 'attention:control';
  items: AttentionControlItem[];
}

/** Attention socket → Host. Reconnect reconciliation for stored OS refs. */
export interface AttentionLookupMessage {
  type: 'attention:lookup';
  refs: AttentionInboxRef[];
}

/**
 * Lightweight global signal. It carries no provider payload and no transcript.
 * `event` + `session_name` + `target` are set together by a 0.6.7 Host.
 * Omitted together, they remain a legacy title/body notification.
 * Session messages keep a required `turn`. A schedule confirmation is a
 * separate arm: no `turn` property, `approval_needed`, and a required
 * `inbox_ref`. Narrow with `isScheduleConfirmationAttentionMessage` before
 * reading either shape.
 */
interface AttentionMessageFields {
  type: 'attention';
  /** Stable across duplicate delivery attempts for the same display event. */
  id: string;
  session_id: string;
  kind: 'turn-completed' | 'approval' | 'question' | 'error';
  /** Unix milliseconds copied from the canonical display event. */
  timestamp: number;
  /** Legacy title. On a semantic message this equals `session_name`. */
  title: string;
  /** Legacy body. On a semantic message this is the English event label. */
  body: string;
  provider: Executor;
}

/** Session and legacy attention. `turn` stays a number on this arm. */
export interface SessionAttentionMessage extends AttentionMessageFields {
  /** 1-based Host turn. Not rendered in the OS notification. */
  turn: number;
  /** Scheduled-run navigation retained for existing Timer clicks. */
  schedule?: { schedule_id: string; run_id: string };
  /** Semantic event. Clients localize this; they do not parse `body`. */
  event?: AttentionEvent;
  /** Conversation name only. Empty means the client supplies a localized untitled label. */
  session_name?: string;
  /** Typed open target. A schedule confirmation is not a session target. */
  target?: Exclude<AttentionNavigationTarget, { type: 'schedule_confirmation' }>;
  /** Canonical Inbox occurrence. Absent for completion and failure alerts. */
  inbox_ref?: AttentionInboxRef;
}

/**
 * One newly opened schedule confirmation. There is no `turn` property.
 * `inbox_ref` is the occurrence that was just inserted.
 */
export interface ScheduleConfirmationAttentionMessage extends AttentionMessageFields {
  kind: 'approval';
  event: 'approval_needed';
  /** Conversation name only. Empty means the client supplies a localized untitled label. */
  session_name: string;
  target: Extract<AttentionNavigationTarget, { type: 'schedule_confirmation' }>;
  inbox_ref: AttentionInboxRef;
}

export type AttentionMessage = SessionAttentionMessage | ScheduleConfirmationAttentionMessage;

const ATTENTION_KEYS = new Set([
  'type', 'id', 'session_id', 'turn', 'kind', 'timestamp', 'title', 'body',
  'provider', 'schedule', 'event', 'session_name', 'target', 'inbox_ref',
]);
const CONTROL_MESSAGE_KEYS = new Set(['type', 'items']);
const CONTROL_ITEM_KEYS = new Set(['id', 'generation', 'revision', 'read', 'terminal']);
const LOOKUP_KEYS = new Set(['type', 'refs']);
const REF_KEYS = new Set(['id', 'generation']);
const SCHEDULE_KEYS = new Set(['schedule_id', 'run_id']);
const TARGET_KEYS: Record<string, readonly string[]> = {
  session: ['type', 'session_id', 'turn', 'interaction_id'],
  system_repair: ['type', 'repair', 'subject_id'],
  pairing: ['type', 'request_id'],
  update: ['type', 'product', 'target_id', 'version', 'channel'],
  schedule_confirmation: ['type', 'confirmation_id'],
  unavailable: ['type', 'reason'],
  side_chat: ['type', 'parent_session_id', 'sidechat_id', 'turn', 'interaction_id'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string> | readonly string[]): boolean {
  const keys = allowed instanceof Set ? allowed : new Set(allowed);
  return Object.keys(value).every(key => keys.has(key));
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string'
    && !value.includes('\0')
    && value.length >= min
    && value.length <= max;
}

/**
 * Provider interaction ids are `z.string().min(1)`: NUL, spaces, slashes, and
 * lengths above 1024 are valid. The only cap is one protocol line, matching
 * `boundedInteractionId`, so a real pending id is not dropped.
 */
const OPAQUE_INTERACTION_ID_MAX_BYTES = 16 * 1024 * 1024;

function isOpaqueInteractionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && new TextEncoder().encode(value).byteLength <= OPAQUE_INTERACTION_ID_MAX_BYTES;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Conversation display name safe for an OS notification title.
 * Absolute paths, file URLs, control characters, and over-long names are rejected.
 * An empty string is the untitled placeholder; the client localizes it.
 */
export function safeAttentionSessionName(value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (cleaned !== value) return null;
  if (/^(?:file:\/\/|~\/|\/|[A-Za-z]:\\)/iu.test(cleaned)) return null;
  if (Array.from(cleaned).length > ATTENTION_SESSION_NAME_MAX) return null;
  return cleaned;
}

/** Canonical notification title. Paths and control characters become untitled. */
export function attentionSessionName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (/^(?:file:\/\/|~\/|\/|[A-Za-z]:\\)/iu.test(cleaned)) return '';
  const safe = Array.from(cleaned).slice(0, ATTENTION_SESSION_NAME_MAX).join('');
  return safeAttentionSessionName(safe) ?? '';
}

export function isAttentionInboxRef(value: unknown): value is AttentionInboxRef {
  return isRecord(value)
    && exactKeys(value, REF_KEYS)
    && isBoundedString(value.id, 1, 128)
    && isPositiveInt(value.generation);
}

export function isAttentionNavigationTarget(value: unknown): value is AttentionNavigationTarget {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  const allowed = TARGET_KEYS[value.type];
  if (!allowed || !exactKeys(value, allowed)) return false;
  if (value.type === 'side_chat') {
    return isBoundedString(value.parent_session_id, 1, 512)
      && isBoundedString(value.sidechat_id, 1, 512)
      && (value.turn === null || isPositiveInt(value.turn))
      && (value.interaction_id === null || isOpaqueInteractionId(value.interaction_id));
  }
  return isInboxTarget(value);
}

/** A confirmation target is never validated as a session event, even with a turn. */
function isScheduleConfirmationAttention(value: Record<string, unknown>): boolean {
  return isRecord(value.target) && value.target.type === 'schedule_confirmation';
}

/**
 * Approval needed for one confirmation. `turn` must be absent, not null or 0.
 * `inbox_ref` is required. Timer `schedule` navigation does not belong here.
 */
function scheduleConfirmationAttentionValid(value: Record<string, unknown>): boolean {
  if (Object.prototype.hasOwnProperty.call(value, 'turn')) return false;
  if (value.schedule !== undefined) return false;
  if (value.event !== 'approval_needed') return false;
  if (value.kind !== ATTENTION_EVENT_KINDS.approval_needed) return false;
  if (safeAttentionSessionName(value.session_name) !== value.session_name) return false;
  if (value.title !== value.session_name) return false;
  if (value.body !== ATTENTION_EVENT_LABELS.approval_needed) return false;
  if (!isAttentionNavigationTarget(value.target)) return false;
  if (!isAttentionInboxRef(value.inbox_ref)) return false;
  return true;
}

export function isAttentionMessage(value: unknown): value is AttentionMessage {
  if (!isRecord(value) || !exactKeys(value, ATTENTION_KEYS)) return false;
  if (value.type !== 'attention') return false;
  if (!isBoundedString(value.id, 1, 512)) return false;
  if (!isBoundedString(value.session_id, 1, 512)) return false;
  if (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) return false;
  if (!isBoundedString(value.body, 1, 512)) return false;
  if (!['turn-completed', 'approval', 'question', 'error'].includes(String(value.kind))) return false;
  if (!isProxyPluginId(value.provider)) return false;
  if (!isSchedule(value.schedule)) return false;
  const hasEvent = value.event !== undefined;
  const hasName = value.session_name !== undefined;
  const hasTarget = value.target !== undefined;
  if (hasEvent !== hasName || hasEvent !== hasTarget) return false;
  if (isScheduleConfirmationAttention(value)) return scheduleConfirmationAttentionValid(value);
  if (!isPositiveInt(value.turn)) return false;
  if (!hasEvent) {
    if (value.inbox_ref !== undefined) return false;
    return isBoundedString(value.title, 1, 256);
  }
  if (typeof value.event !== 'string' || !ATTENTION_EVENTS.includes(value.event as AttentionEvent)) return false;
  const event = value.event as AttentionEvent;
  if (value.kind !== ATTENTION_EVENT_KINDS[event]) return false;
  if (safeAttentionSessionName(value.session_name) !== value.session_name) return false;
  if (value.title !== value.session_name) return false;
  if (value.body !== ATTENTION_EVENT_LABELS[event]) return false;
  if (!isAttentionNavigationTarget(value.target)) return false;
  if (value.inbox_ref !== undefined && !isAttentionInboxRef(value.inbox_ref)) return false;
  return true;
}

/** True only for the confirmation arm. Session messages keep required `turn`. */
export function isScheduleConfirmationAttentionMessage(
  message: AttentionMessage,
): message is ScheduleConfirmationAttentionMessage {
  return !('turn' in message) && message.target?.type === 'schedule_confirmation';
}

export function isAttentionControlMessage(value: unknown): value is AttentionControlMessage {
  if (!isRecord(value) || !exactKeys(value, CONTROL_MESSAGE_KEYS)) return false;
  if (value.type !== 'attention:control' || !Array.isArray(value.items)) return false;
  if (value.items.length > ATTENTION_LOOKUP_MAX) return false;
  return value.items.every(isAttentionControlItem);
}

export function isAttentionLookupMessage(value: unknown): value is AttentionLookupMessage {
  if (!isRecord(value) || !exactKeys(value, LOOKUP_KEYS)) return false;
  if (value.type !== 'attention:lookup' || !Array.isArray(value.refs)) return false;
  if (value.refs.length > ATTENTION_LOOKUP_MAX) return false;
  return value.refs.every(isAttentionInboxRef);
}

function isAttentionControlItem(value: unknown): value is AttentionControlItem {
  return isRecord(value)
    && exactKeys(value, CONTROL_ITEM_KEYS)
    && isBoundedString(value.id, 1, 128)
    && isPositiveInt(value.generation)
    && isNonNegativeInt(value.revision)
    && typeof value.read === 'boolean'
    && typeof value.terminal === 'boolean';
}

function isSchedule(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value)
    && exactKeys(value, SCHEDULE_KEYS)
    && isBoundedString(value.schedule_id, 1, 512)
    && isBoundedString(value.run_id, 1, 512);
}
