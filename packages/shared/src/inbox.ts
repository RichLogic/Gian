/** Host-local Inbox wire shapes. Display fields only — no provider payload. */

export const INBOX_SOURCE_KINDS = [
  'session.question',
  'session.approval',
  'system.repair',
  'system.pairing',
  'product.update',
] as const;

export type InboxSourceKind = typeof INBOX_SOURCE_KINDS[number];

export const INBOX_STATUSES = [
  'pending',
  'resolved',
  'rejected',
  'cancelled',
  'expired',
] as const;

export type InboxStatus = typeof INBOX_STATUSES[number];

export const INBOX_ACTIONS = [
  'open',
  'answer',
  'cancel',
  'approve',
  'reject',
  'skip_version',
  'retry',
] as const;

export type InboxAction = typeof INBOX_ACTIONS[number];

export type InboxApprovalCategory = 'command' | 'permission' | 'browser' | 'plan' | 'schedule';

export type InboxRepairScope = 'account' | 'runtime' | 'schedule';

export type InboxUpdatePhase = 'available' | 'downloaded' | 'failed';

/** Navigation target. An unknown shape is rejected; it is never coerced to the current session. */
export type InboxTarget =
  | {
      type: 'session';
      session_id: string;
      turn: number | null;
      interaction_id: string | null;
    }
  | {
      type: 'system_repair';
      repair: InboxRepairScope;
      subject_id: string;
    }
  | {
      type: 'pairing';
      request_id: string;
    }
  | {
      type: 'update';
      product: 'gian' | 'integration';
      target_id: string;
      version: string;
      channel: string;
    }
  | {
      type: 'unavailable';
      reason: 'missing' | 'revoked' | 'unknown';
    };

export type InboxDisplay =
  | { kind: 'session.question'; interaction_id: string }
  | { kind: 'session.approval'; interaction_id: string; category: InboxApprovalCategory }
  | { kind: 'system.repair'; scope: InboxRepairScope; subject_id: string }
  | { kind: 'system.pairing'; request_id: string }
  | {
      kind: 'product.update';
      product: 'gian' | 'integration';
      target_id: string;
      version: string;
      channel: string;
      phase: InboxUpdatePhase;
      skipped_version: string | null;
    };

export interface InboxItemPublic {
  id: string;
  source_kind: InboxSourceKind;
  status: InboxStatus;
  generation: number;
  revision: number;
  /** True when this generation has no user read. Independent of `status`. */
  unread: boolean;
  read_at: string | null;
  title: string;
  summary: string;
  target: InboxTarget;
  display: InboxDisplay;
  /** Labels for later surfaces. Approve/reject are not Inbox endpoints. */
  actions: InboxAction[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface InboxSyncSnapshot {
  inbox_revision: number;
  pending_count: number;
  items: InboxItemPublic[];
  truncated: boolean;
}

export interface InboxPage {
  items: InboxItemPublic[];
  next_cursor: string | null;
  pending_count: number;
  inbox_revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isOneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value);
}

export function isInboxTarget(value: unknown): value is InboxTarget {
  if (!isRecord(value)) return false;
  if (value.type === 'session') {
    return isString(value.session_id) && value.session_id.length > 0
      && (value.turn === null || isInteger(value.turn))
      && (value.interaction_id === null || isString(value.interaction_id));
  }
  if (value.type === 'system_repair') {
    return isOneOf(value.repair, ['account', 'runtime', 'schedule'])
      && isString(value.subject_id) && value.subject_id.length > 0;
  }
  if (value.type === 'pairing') {
    return isString(value.request_id) && value.request_id.length > 0;
  }
  if (value.type === 'update') {
    return isOneOf(value.product, ['gian', 'integration'])
      && isString(value.target_id) && value.target_id.length > 0
      && isString(value.version) && value.version.length > 0
      && isString(value.channel) && value.channel.length > 0;
  }
  if (value.type === 'unavailable') {
    return isOneOf(value.reason, ['missing', 'revoked', 'unknown']);
  }
  return false;
}

export function isInboxDisplay(value: unknown): value is InboxDisplay {
  if (!isRecord(value)) return false;
  if (value.kind === 'session.question') return isString(value.interaction_id) && value.interaction_id.length > 0;
  if (value.kind === 'session.approval') {
    return isString(value.interaction_id) && value.interaction_id.length > 0
      && isOneOf(value.category, ['command', 'permission', 'browser', 'plan', 'schedule']);
  }
  if (value.kind === 'system.repair') {
    return isOneOf(value.scope, ['account', 'runtime', 'schedule'])
      && isString(value.subject_id) && value.subject_id.length > 0;
  }
  if (value.kind === 'system.pairing') return isString(value.request_id) && value.request_id.length > 0;
  if (value.kind === 'product.update') {
    return isOneOf(value.product, ['gian', 'integration'])
      && isString(value.target_id) && value.target_id.length > 0
      && isString(value.version) && value.version.length > 0
      && isString(value.channel) && value.channel.length > 0
      && isOneOf(value.phase, ['available', 'downloaded', 'failed'])
      && (value.skipped_version === null || isString(value.skipped_version));
  }
  return false;
}

export function isInboxItemPublic(value: unknown): value is InboxItemPublic {
  if (!isRecord(value)) return false;
  return isString(value.id) && value.id.length > 0
    && isOneOf(value.source_kind, INBOX_SOURCE_KINDS)
    && isOneOf(value.status, INBOX_STATUSES)
    && isInteger(value.generation) && value.generation >= 1
    && isInteger(value.revision) && value.revision >= 1
    && typeof value.unread === 'boolean'
    && (value.read_at === null || isString(value.read_at))
    && isString(value.title)
    && isString(value.summary)
    && isInboxTarget(value.target)
    && isInboxDisplay(value.display)
    && Array.isArray(value.actions) && value.actions.every(action => isOneOf(action, INBOX_ACTIONS))
    && isString(value.created_at)
    && isString(value.updated_at)
    && (value.closed_at === null || isString(value.closed_at))
    && !('command' in value)
    && !('token' in value)
    && !('payload' in value);
}

export function isInboxSyncSnapshot(value: unknown): value is InboxSyncSnapshot {
  if (!isRecord(value)) return false;
  return isInteger(value.inbox_revision) && value.inbox_revision >= 0
    && isInteger(value.pending_count) && value.pending_count >= 0
    && typeof value.truncated === 'boolean'
    && Array.isArray(value.items) && value.items.every(isInboxItemPublic);
}
