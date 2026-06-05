import type { Approval, EventEnvelope, Session } from '@gian/shared';
import type { NotificationPrefs } from './notifications.js';

/**
 * Inbox = the dock's persistent, in-app "attention center". It mirrors the
 * same three event classes the desktop notifications (notifications.ts) fire
 * on, but keeps them around so you can come back to them:
 *
 *   - approval : a session is paused waiting for your decision  → blocking
 *   - error    : a session failed                                → blocking
 *   - done     : a turn finished (FYI, only for non-active ones)  → fyi
 *
 * It is fed entirely from the live `event` envelope stream plus a `state_sync`
 * snapshot — no extra host plumbing. Crucially this is the *envelope* stream
 * (`approval_requested`/`approval_resolved`), which fires for BOTH structured
 * and TTY/Beta runtimes, so TTY approvals finally show up here (the old inbox
 * only read the structured `approval:created` channel and was empty for TTY).
 *
 * Dedup id uses `approvalId`, the one key carried by every approval signal
 * (request/resolve envelopes, the structured create/update messages, and
 * `Approval.id` in state_sync), so the sources converge on one item.
 */

export type InboxKind = 'approval' | 'error' | 'done';
export type InboxTier = 'blocking' | 'fyi';

export interface InboxItem {
  id: string;
  sessionId: string;
  kind: InboxKind;
  /** One-line human subject: approval action title / error message / turn summary. */
  subject: string;
  ts: number;
  read: boolean;
}

/** Keep the list bounded. Blocking items are always retained; only FYI (done)
 *  items are dropped when over the cap. */
export const INBOX_CAP = 50;

export function tierOf(kind: InboxKind): InboxTier {
  return kind === 'done' ? 'fyi' : 'blocking';
}

export function blockingCount(items: InboxItem[]): number {
  return items.reduce((n, i) => (tierOf(i.kind) === 'blocking' ? n + 1 : n), 0);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function approvalKey(approvalId: string): string {
  return `approval:${approvalId}`;
}

function prefsAllow(kind: InboxKind, prefs: NotificationPrefs): boolean {
  return kind === 'approval' ? prefs.approvalNeeded
    : kind === 'error' ? prefs.errors
    : prefs.sessionDone;
}

function add(items: InboxItem[], item: InboxItem): InboxItem[] {
  const merged = [item, ...items.filter(i => i.id !== item.id)].sort((a, b) => b.ts - a.ts);
  if (merged.length <= INBOX_CAP) return merged;
  // Over cap: keep every blocking item, drop the oldest FYI ones.
  const blocking = merged.filter(i => tierOf(i.kind) === 'blocking');
  const fyi = merged.filter(i => tierOf(i.kind) === 'fyi');
  const room = Math.max(0, INBOX_CAP - blocking.length);
  return [...blocking, ...fyi.slice(0, room)].sort((a, b) => b.ts - a.ts);
}

interface Classified {
  kind: InboxKind;
  id: string;
  subject: string;
}

/** Map a live event envelope to an inbox class, or null if it isn't one we
 *  surface. Mirrors the taxonomy in notifications.ts (kept separate because the
 *  two render very differently — an English OS toast vs an i18n in-app row). */
export function classifyEnvelope(env: EventEnvelope): Classified | null {
  const sid = env.session_id;
  if (env.event === 'approval_requested') {
    const approvalId = str(env.data.approvalId) || env.call_id;
    return { kind: 'approval', id: approvalKey(approvalId), subject: str(env.data.title) || str(env.data.subject) };
  }
  if (env.event === 'session_error') {
    return { kind: 'error', id: `error:${sid}`, subject: str(env.data.message) };
  }
  if (env.event === 'turn_completed') {
    return { kind: 'done', id: `done:${sid}:${env.turn}`, subject: str(env.data.summary).trim() };
  }
  return null;
}

export interface IngestCtx {
  prefs: NotificationPrefs;
  activeSessionId: string | null;
}

/** Fold one live `event` envelope into the inbox list. */
export function ingestEnvelope(items: InboxItem[], env: EventEnvelope, ctx: IngestCtx): InboxItem[] {
  // Resolutions clear the matching approval (works for structured + TTY).
  if (env.event === 'approval_resolved') {
    const approvalId = str(env.data.approvalId) || env.call_id;
    return items.filter(i => i.id !== approvalKey(approvalId));
  }
  const cls = classifyEnvelope(env);
  if (!cls || !prefsAllow(cls.kind, ctx.prefs)) return items;
  // You're already watching this session — don't ping for its own completions.
  if (cls.kind === 'done' && env.session_id === ctx.activeSessionId) return items;
  let next = items;
  // A completed turn means the session recovered — drop any stale error row.
  if (cls.kind === 'done') next = clearSessionError(next, env.session_id);
  return add(next, {
    id: cls.id,
    sessionId: env.session_id,
    kind: cls.kind,
    subject: cls.subject,
    ts: env.ts,
    read: false,
  });
}

/** Apply a structured `approval:created` message. Pending → add; any resolved
 *  status (incl. auto-approved) → remove, so auto-handled approvals never
 *  linger. Self-dedups against the envelope path via the shared approvalId. */
export function applyApprovalCreated(
  items: InboxItem[],
  approval: { id: string; session_id: string; description: string; status: string },
  prefs: NotificationPrefs,
  ts: number,
): InboxItem[] {
  const id = approvalKey(approval.id);
  if (approval.status !== 'pending') return items.filter(i => i.id !== id);
  if (!prefs.approvalNeeded) return items;
  return add(items, {
    id,
    sessionId: approval.session_id,
    kind: 'approval',
    subject: approval.description || '',
    ts,
    read: false,
  });
}

/** Remove an approval by id (structured `approval:updated`, which carries only
 *  the approvalId — no session_id). */
export function removeApproval(items: InboxItem[], approvalId: string): InboxItem[] {
  return items.filter(i => i.id !== approvalKey(approvalId));
}

/** Rebuild the actionable (blocking) items from a state_sync snapshot. `done`
 *  is FYI and intentionally not reconstructed — it's fine to lose on reload. */
export function reconcileFromSync(approvals: Approval[], sessions: Session[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const a of approvals) {
    if (a.status !== 'pending') continue;
    items.push({
      id: approvalKey(a.id),
      sessionId: a.session_id,
      kind: 'approval',
      subject: a.title ?? '',
      ts: Date.parse(a.created_at) || 0,
      read: true,
    });
  }
  for (const s of sessions) {
    if (s.status !== 'error') continue;
    items.push({
      id: `error:${s.id}`,
      sessionId: s.id,
      kind: 'error',
      subject: '',
      ts: Date.parse(s.updated_at) || 0,
      read: true,
    });
  }
  return items.sort((a, b) => b.ts - a.ts);
}

export function removeSession(items: InboxItem[], sessionId: string): InboxItem[] {
  return items.filter(i => i.sessionId !== sessionId);
}

export function clearSessionError(items: InboxItem[], sessionId: string): InboxItem[] {
  return items.filter(i => i.id !== `error:${sessionId}`);
}

export function markAllRead(items: InboxItem[]): InboxItem[] {
  return items.some(i => !i.read) ? items.map(i => (i.read ? i : { ...i, read: true })) : items;
}

export function markSessionRead(items: InboxItem[], sessionId: string): InboxItem[] {
  return items.some(i => i.sessionId === sessionId && !i.read)
    ? items.map(i => (i.sessionId === sessionId && !i.read ? { ...i, read: true } : i))
    : items;
}

export function clearFyi(items: InboxItem[]): InboxItem[] {
  return items.filter(i => tierOf(i.kind) !== 'fyi');
}
