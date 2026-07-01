import type { EventEnvelope } from '@gian/shared';
import { stripManagerSystemPrefix, stripGianRolePrefix, stripGianActionBlocks, GIAN_ACTION_CLOSE } from '@gian/shared';

/** Strip complete gian:action blocks from accumulating assistant text — only
 *  once a CLOSE sentinel is present, so a block split across streaming deltas is
 *  never half-stripped (which would corrupt on the next append). No-op when no
 *  block is present (the default, and always when the feature is off). */
function stripSettledActionBlocks(text: string): string {
  return text.includes(GIAN_ACTION_CLOSE) ? stripGianActionBlocks(text) : text;
}
import type {
  AgentSpawnItem,
  ApprovalItem,
  AutoNoticeItem,
  CommandItem,
  DiffFile,
  DiffItem,
  FileReadItem,
  FileSearchItem,
  MsgItem,
  ReasoningItem,
  TokenUsage,
  TranscriptItem,
  WebSearchItem,
} from '../types.js';

const ATTACHED_IMAGE_RE = /\[Attached image:\s*([^\]]+?)\s*\]/g;
const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic',
};

/**
 * Beta/TTY image sends arrive as a JSONL echo with NO structured attachments —
 * the image is referenced inline as `[Attached image: <abs path>]` (the framing
 * `planBetaComposerSend` injects so the PTY's `claude` reads it). Recover any
 * host-served per-session attachment (`…/attachments/<sid>/<file>`) into a real
 * `MessageAttachment` so the bubble shows a thumbnail like Chat, and strip the
 * framing from the displayed text. Non-attachment paths / non-images are left
 * untouched (the normal linkify path still makes them clickable).
 */
function recoverInlineImageAttachments(text: string): {
  text: string; attachments: import('@gian/shared').MessageAttachment[];
} {
  const attachments: import('@gian/shared').MessageAttachment[] = [];
  const stripped = text.replace(ATTACHED_IMAGE_RE, (whole, rawPath: string) => {
    const m = /\/attachments\/([^/]+)\/([^/?#]+)$/.exec(String(rawPath).trim());
    const sid = m?.[1];
    const filename = m?.[2];
    if (!sid || !filename) return whole;
    const mime = IMAGE_EXT_MIME[filename.toLowerCase().split('.').pop() ?? ''];
    if (!mime) return whole;
    attachments.push({ name: filename, mime, url: `/api/sessions/${sid}/attachments/${filename}` });
    return '';
  });
  return { text: stripped.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), attachments };
}

/**
 * A `question` approval still `pending` once the conversation has moved on (a
 * new user turn arrived) was answered/cancelled out-of-band — its resolution
 * just wasn't recorded (e.g. a cancelled TTY question whose JSONL has no
 * tool_result, leaving an orphaned `approval_requested`). Dismiss it as
 * `declined` so it stops rendering as an actionable pending card on reload.
 * Only the genuinely-live question at the tail (no later user turn) stays
 * pending. Returns the same array reference when nothing changed.
 */
function dismissStalePendingQuestions(items: TranscriptItem[]): TranscriptItem[] {
  let changed = false;
  const next = items.map(it => {
    if (it.kind === 'approval' && it.category === 'question' && it.status === 'pending') {
      changed = true;
      return { ...it, status: 'declined' as const };
    }
    return it;
  });
  return changed ? next : items;
}

/**
 * Folds one envelope into the transcript. Unified type names are the primary
 * path; legacy raw names (still emitted by un-normalized host paths) fall
 * through to the same helpers so nothing breaks during the M1 transition.
 *
 * Returns the same array reference if the event was a no-op so the caller
 * can skip a state update.
 */
export function applyEnvelope(
  items: TranscriptItem[],
  env: EventEnvelope,
  executor: 'claude' | 'codex',
): TranscriptItem[] {
  const data = (env.data ?? {}) as Record<string, unknown>;
  const ev = env.event;

  // ── assistant_text (unified) / output.text.delta (legacy codex streaming) ──
  if (ev === 'assistant_text' || ev === 'output.text.delta') {
    const itemId = String(data.itemId ?? env.call_id);
    // unified: data.text is the delta when data.delta===true; legacy: data.delta
    // is a string chunk. Beware: data.delta can also be the JSON boolean
    // `false` (cc final-text events carry `delta: false`), which `??` would
    // pass through — so explicitly require a string before using delta.
    const chunk = String(
      data.delta === true
        ? data.text
        : typeof data.delta === 'string'
          ? data.delta
          : (data.text ?? ''),
    );
    if (!chunk) return items;
    const idx = items.findIndex(i => i.kind === 'assistant' && i.id === itemId);
    if (idx >= 0) {
      const existing = items[idx] as MsgItem;
      const next = items.slice();
      next[idx] = { ...existing, text: stripSettledActionBlocks(existing.text + chunk) };
      return next;
    }
    const created: MsgItem = {
      kind: 'assistant', id: itemId,
      text: stripSettledActionBlocks(chunk), exec: executor,
      ts: env.ts, turn: env.turn,
    };
    return [...items, created];
  }

  // ── reasoning (unified) — codex's "thinking" content. summary and full
  // forms each get their own ReasoningItem, keyed by itemId. Deltas append
  // into the existing card; non-delta full snapshots replace text.
  if (ev === 'reasoning') {
    const itemId = String(data.itemId ?? env.call_id);
    const chunk = String(data.text ?? '');
    if (!chunk) return items;
    const variant = data.kind === 'summary' ? 'summary' : 'full';
    const idx = items.findIndex(i => i.kind === 'reasoning' && i.id === itemId);
    if (idx >= 0) {
      const existing = items[idx] as ReasoningItem;
      const next = items.slice();
      next[idx] = {
        ...existing,
        text: data.delta === false ? chunk : existing.text + chunk,
      };
      return next;
    }
    const created: ReasoningItem = {
      kind: 'reasoning', id: itemId,
      text: chunk, variant,
      ts: env.ts, turn: env.turn,
    };
    return [...items, created];
  }

  // ── plan_update (unified) — codex plan-mode output. We don't fold this
  // into the transcript; PlanChip subscribes separately and renders the
  // current plan markdown in a popover. Drop from transcript here.
  if (ev === 'plan_update') return items;

  // ── turn_started (unified) — signal only, not a transcript entry. App.tsx
  // listens for this to flip pendingBySession=true.
  if (ev === 'turn_started') return items;

  // ── command_execution (unified) ──
  if (ev === 'command_execution') {
    const itemId = String(data.itemId ?? env.call_id);
    if (data.stdoutDelta !== undefined) {
      // streaming delta — update existing item or create
      const idx = items.findIndex(i => i.kind === 'command' && i.id === itemId);
      if (idx >= 0) {
        const existing = items[idx] as CommandItem;
        const next = items.slice();
        next[idx] = {
          ...existing,
          stdout: existing.stdout + String(data.stdoutDelta),
          status: (data.status as CommandItem['status']) ?? existing.status,
        };
        return next;
      }
    }
    // full event or first delta
    const idx = items.findIndex(i => i.kind === 'command' && i.id === itemId);
    if (idx >= 0) {
      // update status / exitCode on an existing card
      const existing = items[idx] as CommandItem;
      const next = items.slice();
      next[idx] = {
        ...existing,
        status: (data.status as CommandItem['status']) ?? existing.status,
        exitCode: data.exitCode !== undefined ? Number(data.exitCode) : existing.exitCode,
        stdout: data.stdout !== undefined
          ? String(data.stdout)
          : existing.stdout + String(data.stdoutDelta ?? ''),
        stderr: data.stderr !== undefined ? String(data.stderr) : existing.stderr,
      };
      return next;
    }
    const item: CommandItem = {
      kind: 'command', id: itemId,
      command: String(data.command ?? ''),
      cwd: data.cwd !== undefined ? String(data.cwd) : undefined,
      status: (data.status as CommandItem['status']) ?? 'running',
      exitCode: data.exitCode !== undefined ? Number(data.exitCode) : undefined,
      stdout: String(data.stdout ?? data.stdoutDelta ?? ''),
      stderr: data.stderr !== undefined ? String(data.stderr) : undefined,
      ts: env.ts, turn: env.turn,
    };
    return [...items, item];
  }

  // ── file_read (unified) ──
  if (ev === 'file_read') {
    const item: FileReadItem = {
      kind: 'file-read', id: env.call_id,
      path: String(data.path ?? '(unknown)'),
      startLine: data.startLine !== undefined ? Number(data.startLine) : undefined,
      endLine: data.endLine !== undefined ? Number(data.endLine) : undefined,
      ts: env.ts, turn: env.turn,
    };
    return [...items, item];
  }

  // ── file_search (unified) ──
  if (ev === 'file_search') {
    const matches = Array.isArray(data.matches)
      ? (data.matches as unknown[]).map(m => String(m))
      : undefined;
    const item: FileSearchItem = {
      kind: 'file-search', id: env.call_id,
      pattern: String(data.pattern ?? ''),
      searchKind: data.kind === 'glob' ? 'glob' : 'grep',
      matchCount: data.matchCount !== undefined ? Number(data.matchCount) : matches?.length,
      matches,
      ts: env.ts, turn: env.turn,
    };
    return [...items, item];
  }

  // ── web_search (unified) ──
  if (ev === 'web_search') {
    const item: WebSearchItem = {
      kind: 'web-search', id: env.call_id,
      query: String(data.query ?? ''),
      resultCount: data.resultCount !== undefined ? Number(data.resultCount) : undefined,
      ts: env.ts, turn: env.turn,
    };
    return [...items, item];
  }

  // ── agent_spawn (unified) ──
  if (ev === 'agent_spawn') {
    const item: AgentSpawnItem = {
      kind: 'agent-spawn', id: env.call_id,
      description: String(data.description ?? ''),
      status: (data.status as AgentSpawnItem['status']) ?? 'running',
      ts: env.ts, turn: env.turn,
    };
    return [...items, item];
  }

  // ── approval_requested (unified + legacy) ──
  if (ev === 'approval_requested' || ev === 'approval.requested') {
    const item = parseApprovalRequested(env);
    if (!item) return items;
    // A single AskUserQuestion can surface twice in TTY mode: the live
    // PreToolUse hook broadcasts it while the tool is pending, then the JSONL
    // watcher re-emits the same approvalId once the tool_use lands in the
    // transcript. Dedupe by approvalId so it renders one card — and keep the
    // existing item (and its status) so a late duplicate request can't
    // resurrect an already-resolved card.
    if (items.some(i => i.kind === 'approval' && i.approvalId === item.approvalId)) {
      return items;
    }
    return [...items, item];
  }

  // ── approval_resolved (unified + legacy) ──
  if (ev === 'approval_resolved' || ev === 'approval.resolved') {
    const approvalId = String(data.approvalId ?? '');
    const decision = String(data.decision ?? '');
    if (!approvalId) return items;
    const idx = items.findIndex(i => i.kind === 'approval' && i.approvalId === approvalId);
    if (idx < 0) return items;
    const existing = items[idx] as ApprovalItem;
    // A late auto-decline (TtyManager clears stranded question cards on
    // SessionEnd / tty.exited / stop) must NOT clobber a card the user already
    // answered. Once an approval is non-pending, ignore any `auto:true` resolve.
    if (data.auto === true && existing.status !== 'pending') {
      return items;
    }
    const next = items.slice();
    // Capture the picked answer(s) for a question resolve so the resolved card
    // can show "answered with …". Only the synthetic local resolve (TTY paste)
    // carries answers; the later JSONL watcher resolve does not, so preserve
    // any value we already have rather than blanking it.
    const answeredWith = formatAnsweredWith(data.answers) ?? existing.answeredWith;
    next[idx] = {
      ...existing,
      status: mapApprovalDecision(decision),
      ...(answeredWith ? { answeredWith } : {}),
    };
    return next;
  }

  // ── file_change / diff.updated (legacy codex) ──
  if (ev === 'file_change' || ev === 'diff.updated') {
    const item = parseDiffUpdated(env);
    return item ? [...items, item] : items;
  }

  // ── auto_classifier_denied (cc auto-mode) ──
  if (ev === 'auto_classifier_denied') {
    const item: AutoNoticeItem = {
      kind: 'auto-notice', id: env.call_id,
      variant: 'classifier-denied',
      action: String(data.action ?? ''),
      reason: String(data.reason ?? ''),
      consecutive: Number(data.consecutive ?? 0),
      total: Number(data.total ?? 0),
      ts: env.ts, turn: env.turn,
    };
    return [...items, item];
  }

  // ── auto_circuit_breaker (cc auto-mode trip) ──
  if (ev === 'auto_circuit_breaker') {
    const item: AutoNoticeItem = {
      kind: 'auto-notice', id: env.call_id,
      variant: 'circuit-breaker',
      trigger: data.trigger === 'total' ? 'total' : 'consecutive',
      consecutive: Number(data.consecutive ?? 0),
      total: Number(data.total ?? 0),
      ts: env.ts, turn: env.turn,
    };
    return [...items, item];
  }

  // ── session_error (unified) / turn.failed (legacy) ──
  if (ev === 'session_error' || ev === 'turn.failed') {
    return [
      ...items,
      {
        kind: 'error', id: env.call_id,
        text: String(data.message ?? data.error ?? 'error'),
        ts: env.ts, turn: env.turn,
      },
    ];
  }

  // ── turn_completed (unified) / turn.started / turn.completed (legacy) ──
  if (ev === 'turn_completed' || ev === 'turn.completed') {
    return [...items, { kind: 'turn-end', id: env.call_id, text: `Turn ${env.turn} · complete`, ts: env.ts, turn: env.turn }];
  }

  // ── user_message — host-side event (not a proxy event, so no normalizer);
  // SessionManager persists/broadcasts it directly when message:send arrives.
  // Reconciles with the client-side optimistic echo if present.
  if (env.event === 'user_message') {
    // A new user turn means any question still pending from earlier was already
    // dealt with — dismiss orphans so they don't re-surface on reload.
    const base = dismissStalePendingQuestions(items);
    let text = String(data.text ?? '');
    const rawAttachments = Array.isArray(data.attachments) ? data.attachments : [];
    let attachments = rawAttachments
      .filter((a): a is { name: string; mime: string; url: string } =>
        typeof a === 'object' && a !== null
        && typeof (a as Record<string, unknown>).name === 'string'
        && typeof (a as Record<string, unknown>).mime === 'string'
        && typeof (a as Record<string, unknown>).url === 'string',
      )
      .map(a => ({ name: a.name, mime: a.mime, url: a.url }));
    // No structured attachments (Beta/TTY JSONL echo) → recover inline
    // `[Attached image: …]` references into thumbnails, Chat-style.
    if (attachments.length === 0) {
      const recovered = recoverInlineImageAttachments(text);
      if (recovered.attachments.length > 0) {
        attachments = recovered.attachments;
        text = recovered.text;
      }
    }
    // Strip the always-hidden gian-task ROLE header from the first-turn user
    // message so it never shows in ANY transcript (normal/subtask views read
    // this stored text directly). The Manager system prefix is intentionally
    // NOT stripped here — showManagerRaw reveals it at render.
    const item: MsgItem = {
      kind: 'user', id: env.call_id, text: stripGianRolePrefix(text), exec: executor,
      ts: env.ts, turn: env.turn,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    // The host prepends a sentinel-wrapped meta block to the user text: the
    // Manager system prompt / a `create_subtask` note (<<gian:manager-system>>),
    // or the gian-task ROLE header on a task session's first turn
    // (<<gian:role>>). The server echo carries it but the client's optimistic
    // echo holds only the bare text — compare against the stripped form too, or
    // the first message reconciles against nothing and renders twice.
    const strippedItemText = stripGianRolePrefix(stripManagerSystemPrefix(item.text));
    for (let i = base.length - 1; i >= 0; i--) {
      const cand = base[i]!;
      if (
        cand.kind === 'user' && cand.pending
        && (cand.text === item.text || cand.text === strippedItemText)
        && (cand.attachments?.length ?? 0) === attachments.length
      ) {
        // Reconciled — release the optimistic blob URLs before we swap the
        // server item in. Object URLs created via createObjectURL leak the
        // underlying Blob until revoked. Wrapped because some unit tests
        // run under jsdom where URL.revokeObjectURL is a no-op stub.
        if (cand.attachments) {
          for (const a of cand.attachments) {
            try { URL.revokeObjectURL(a.url); } catch { /* noop in test envs */ }
          }
        }
        const next = base.slice();
        next[i] = { ...item };
        return next;
      }
    }
    return [...base, item];
  }

  return items;
}

/**
 * Build the optimistic user echo that App.tsx seeds onSend / on first
 * message after `session:created`. Pure over its inputs so tests can
 * exercise the SES-003 contract without mounting App.
 *
 * `now()` is injectable for deterministic ts and id generation in
 * tests; production callers pass `Date.now`.
 */
export function createOptimisticEcho(params: {
  sessionId: string;
  text: string;
  exec: 'claude' | 'codex';
  /** Defaults to `Date.now`. Tests pass a frozen value for stable ids. */
  now?: () => number;
  /** Attachments to render in the pending bubble. `url` should be a blob
   *  URL the caller still owns — reconciliation revokes it when the server
   *  user_message arrives. */
  attachments?: import('@gian/shared').MessageAttachment[];
}): MsgItem {
  const now = (params.now ?? Date.now)();
  const item: MsgItem = {
    kind: 'user',
    id: `optimistic:${params.sessionId}:${now}`,
    text: params.text,
    exec: params.exec,
    ts: now,
    turn: 0,
    pending: true,
  };
  if (params.attachments && params.attachments.length > 0) {
    item.attachments = params.attachments;
  }
  return item;
}

/**
 * Apply an `error` envelope to the App's per-session state. Returns the
 * new `items` + `pending` snapshots (only mutated entries; callers
 * spread back into the master record). Returns `null` to mean "no
 * change needed" so React identity stays stable when the session has
 * no in-flight echo.
 *
 * Encodes ERR-007 / WS-003 / SES-003's error path: flip pending to
 * false AND mark the latest pending echo as failed, atomically per
 * session.
 */
export interface ErrorEnvelopeDelta {
  items: TranscriptItem[];
  pending: boolean;
}

export function applyErrorEnvelopeToSession(
  prevItems: TranscriptItem[] | undefined,
  sessionId: string,
): ErrorEnvelopeDelta | null {
  void sessionId; // session id is the caller's index key; not used inside the delta
  if (!prevItems) return null;
  const nextItems = markLatestPendingEchoFailed(prevItems);
  // `pending: false` is unconditional — the contract is "clear pending
  // even when there's no echo to fail" so a spinner from a non-echo
  // source (e.g. queue-driven turn_started) is also cleared.
  return { items: nextItems, pending: false };
}

/**
 * Decide the next per-session pending-state for an incoming envelope.
 * Centralizes the EVT-008 contract (turn_started → true, turn_completed
 * / session_error → false) and the SES-003 / ERR-007 / WS-003 contract
 * (any failure surface clears the pending spinner).
 *
 * Returns `true` / `false` for an explicit flip, or `null` when the
 * envelope doesn't change pending state.
 */
export function nextPendingFromEnvelope(env: EventEnvelope): boolean | null {
  if (env.event === 'turn_started') return true;
  if (env.event === 'turn_completed' || env.event === 'session_error') return false;
  return null;
}

/**
 * Apply a `plan_update` envelope to the per-session plan accumulator
 * that PlanChip / PlanSheet subscribe to. `data.delta === true` means an
 * append; anything else replaces.
 *
 * Pure over its inputs — App.tsx uses this inside a `setPlanBySession`
 * functional updater so EVT-007 can be exercised without mounting the
 * full App.
 */
export function applyPlanUpdate(prev: string | undefined, env: EventEnvelope): string {
  const data = (env.data ?? {}) as Record<string, unknown>;
  const text = String(data.text ?? '');
  const isDelta = data.delta === true;
  return isDelta ? (prev ?? '') + text : text;
}

/**
 * Walk the transcript backwards and mark the most recent pending user-echo
 * item as failed. Used by the App when an `error` envelope arrives with a
 * session_id — see ERR-007. Returns the original array if no pending echo
 * was found so React identity stays stable.
 */
export function markLatestPendingEchoFailed(items: TranscriptItem[]): TranscriptItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'user' && it.pending) {
      const next = items.slice();
      next[i] = { ...it, pending: false, failed: true };
      return next;
    }
  }
  return items;
}

/**
 * Codex emits `approval.requested` with the approval object directly as the
 * event data: { approvalId, title, risk, payload, scopeOptions, ... }. The
 * payload carries the original method params (e.g. { command, reason } for
 * a command approval). We pluck what the UI needs and tolerate misses.
 *
 * Unified `approval_requested` carries normalized fields (category, risk,
 * title, description, subject) — the same field names work for both because
 * we fall back gracefully.
 */
export function parseApprovalRequested(env: EventEnvelope): ApprovalItem | null {
  const data = (env.data ?? {}) as Record<string, unknown>;
  const approvalId = String(data.approvalId ?? '');
  if (!approvalId) return null;
  const payload = (data.payload ?? {}) as Record<string, unknown>;
  // unified: data.subject; legacy: payload.command / .path / etc.
  const cmd = String(data.subject ?? payload.command ?? payload.cmd ?? payload.path ?? '');
  // unified: data.description; legacy: payload.reason
  const reason = String(data.description ?? payload.reason ?? data.risk ?? '');
  // Unified normalizer attaches `category` + `questions` for AskUserQuestion;
  // pass them through so ApprovalCard can render the structured variant.
  const category = typeof data.category === 'string'
    ? data.category as ApprovalItem['category']
    : undefined;
  const questions = Array.isArray(data.questions)
    ? data.questions as NonNullable<ApprovalItem['questions']>
    : undefined;
  const scopeOptions = Array.isArray(data.scopeOptions)
    ? (data.scopeOptions as unknown[]).filter(
      (s): s is 'once' | 'session' => s === 'once' || s === 'session',
    )
    : undefined;
  // exit_plan_mode approvals advertise a three-way action set instead of the
  // generic once/session/decline scopes. Pass it through so ApprovalCard can
  // pick the right button layout.
  const PLAN_ACTIONS = ['accept_with_auto', 'accept_with_ask', 'keep_planning'] as const;
  type PlanAction = typeof PLAN_ACTIONS[number];
  const isPlanAction = (s: unknown): s is PlanAction =>
    (PLAN_ACTIONS as readonly string[]).includes(s as string);
  const planActions = Array.isArray(data.planActions)
    ? (data.planActions as unknown[]).filter(isPlanAction)
    : undefined;
  return {
    kind: 'approval',
    id: env.call_id,
    approvalId,
    title: String(data.title ?? 'Review request'),
    reason,
    cmd,
    risk: normalizeRisk(data.risk),
    status: 'pending',
    ...(category ? { category } : {}),
    ...(questions ? { questions } : {}),
    ...(scopeOptions ? { scopeOptions } : {}),
    ...(planActions && planActions.length > 0 ? { planActions } : {}),
    ts: env.ts,
    turn: env.turn,
  };
}

export function normalizeRisk(v: unknown): 'low' | 'medium' | 'high' {
  const s = String(v ?? '').toLowerCase();
  if (s.includes('high') || s.includes('danger')) return 'high';
  if (s.includes('low')) return 'low';
  return 'medium';
}

export function mapApprovalDecision(d: string): ApprovalItem['status'] {
  if (d === 'declined' || d === 'decline') return 'declined';
  if (d.includes('session')) return 'approved-session';
  return 'approved-once';
}

/**
 * Flatten an AskUserQuestion answers map into a single display string for the
 * resolved card. `{ "Pick dinner": "Rice", "Sides": ["Soup","Salad"] }` →
 * `"Rice · Soup, Salad"`. Returns null when there's nothing usable so callers
 * can fall back to a prior value.
 */
export function formatAnsweredWith(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parts = Object.values(raw as Record<string, unknown>)
    .map(v => Array.isArray(v) ? v.filter(x => typeof x === 'string').join(', ') : (typeof v === 'string' ? v : ''))
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Handles both `diff.updated` (legacy codex) and `file_change` (unified).
 * Shape (verified codex): `data.params.diff` is a unified diff string.
 * Unified shape: `data.diff` or `data.files` array (if no raw diff available
 * the card will render from the files summary).
 */
export function parseDiffUpdated(env: EventEnvelope): DiffItem | null {
  const data = (env.data ?? {}) as Record<string, unknown>;
  const params = (data.params ?? data) as Record<string, unknown>;
  const text = String(params.diff ?? params.unified ?? data.diff ?? '');
  if (text.trim()) {
    const files = parseUnifiedDiff(text);
    if (files.length > 0) {
      return { kind: 'diff', id: env.call_id, files, ts: env.ts, turn: env.turn };
    }
  }
  // unified file_change: data.files[] without raw diff text
  if (Array.isArray(data.files) && data.files.length > 0) {
    const files: DiffFile[] = (data.files as Array<Record<string, unknown>>).map(f => ({
      path: String(f.path ?? '(unknown)'),
      add: Number(f.added ?? 0),
      del: Number(f.removed ?? 0),
      hunks: [],
    }));
    return { kind: 'diff', id: env.call_id, files, ts: env.ts, turn: env.turn };
  }
  return null;
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  // Split on `diff --git` markers. The first chunk before any marker is empty.
  const chunks = text.split(/^diff --git .*$/m).map(c => c.trim()).filter(Boolean);
  // If no markers, treat the whole thing as one anonymous file.
  if (chunks.length === 0 && text.trim()) chunks.push(text.trim());

  return chunks.map(chunk => {
    const lines = chunk.split('\n');
    let path = '';
    const hunks: DiffFile['hunks'] = [];
    let add = 0;
    let del = 0;
    let cur: DiffFile['hunks'][number] | null = null;

    for (const line of lines) {
      if (line.startsWith('+++ b/')) path = line.slice(6);
      else if (!path && line.startsWith('--- a/')) path = line.slice(6);
      else if (line.startsWith('@@ ')) {
        cur = { header: line, lines: [] };
        hunks.push(cur);
      } else if (cur) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          cur.lines.push({ kind: 'add', text: line.slice(1) });
          add++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          cur.lines.push({ kind: 'del', text: line.slice(1) });
          del++;
        } else if (line.startsWith(' ')) {
          cur.lines.push({ kind: 'ctx', text: line.slice(1) });
        }
        // ignore index/no-newline markers and others
      }
    }

    return { path: path || '(unknown)', add, del, hunks };
  });
}

/**
 * Pulls token usage out of a `token_usage.updated` event. Both proxies wrap
 * usage as `{ params: { tokenUsage: { total, [last], modelContextWindow } } }`
 * but the meaning of `total` differs:
 *   - codex `total` = cumulative session lifetime (grows past contextWindow)
 *   - codex `last`  = last turn (last.inputTokens ≈ current context window
 *                     usage, since each turn ships the whole prior history;
 *                     drops after /compact)
 *   - cc    `total` = last turn (inputTokens excludes cache; full prompt
 *                     size is inputTokens + cachedInputTokens)
 *
 * `contextUsed` reconciles these into one "what's in the window right now"
 * number that the context bar can divide by `contextWindow`. Returns null
 * if the shape doesn't match — UI just won't render a chip.
 */
export function parseTokenUsage(data: unknown): TokenUsage | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;
  const params = (root.params ?? root) as Record<string, unknown>;
  const tu = params.tokenUsage as Record<string, unknown> | undefined;
  if (!tu) return null;
  const total = tu.total as Record<string, number> | undefined;
  if (!total) return null;
  const last = tu.last as Record<string, number> | undefined;
  const cw = tu.modelContextWindow;
  // codex emits `last` (per-turn breakdown alongside cumulative `total`); cc
  // doesn't, so fall back to per-turn `total` where inputTokens excludes the
  // cached portion — add them back to recover the prompt size that was sent.
  const contextUsed = last
    ? Number(last.inputTokens ?? 0)
    : Number(total.inputTokens ?? 0) + Number(total.cachedInputTokens ?? 0);
  // Self-correct when the recorded window is obviously smaller than the
  // observed usage — happens for sessions started before cc-proxy learned
  // to read the real model id from `system init`, where the stored model id
  // could say 200k even though CLI was running the 1M variant. Bump to the
  // next plausible ceiling so the bar stops
  // showing "771k / 200k · compact soon".
  let contextWindow = typeof cw === 'number' ? cw : undefined;
  if (contextWindow && contextUsed > contextWindow) {
    contextWindow = contextUsed > 200_000 ? 1_000_000 : contextWindow;
  }
  return {
    total: Number(total.totalTokens ?? 0),
    input: Number(total.inputTokens ?? 0),
    output: Number(total.outputTokens ?? 0),
    cached: Number(total.cachedInputTokens ?? 0),
    contextUsed,
    contextWindow,
  };
}
