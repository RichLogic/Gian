import type { DisplayEventType, EventEnvelope, Executor } from '@gian/shared';
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
  ToolItem,
  TranscriptItem,
  WebSearchItem,
} from '../types.js';

const ATTACHED_IMAGE_RE = /\[Attached image:\s*([^\]]+?)\s*\]/g;
const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic',
};

const TOOL_ITEM_KINDS = new Set<TranscriptItem['kind']>([
  'command',
  'tool',
  'file-read',
  'file-search',
  'web-search',
  'diff',
]);

const LEGACY_DISPLAY_TYPES: Record<string, DisplayEventType | undefined> = {
  assistant_text: 'message',
  'output.text': 'message',
  'output.text.delta': 'message',
  reasoning: 'activity.reasoning',
  plan_update: 'plan',
  command_execution: 'activity.command',
  file_change: 'activity.file-change',
  'diff.updated': 'activity.file-change',
  file_read: 'activity.file-read',
  file_search: 'activity.file-search',
  web_search: 'activity.web-search',
  tool_execution: 'activity.tool',
  agent_spawn: 'agent',
  approval_requested: 'interaction.approval',
  'approval.requested': 'interaction.approval',
  approval_resolved: 'interaction.resolved',
  'approval.resolved': 'interaction.resolved',
  auto_classifier_denied: 'activity.classifier-denied',
  auto_circuit_breaker: 'activity.circuit-breaker',
  turn_started: 'state.turn-started',
  'turn.started': 'state.turn-started',
  turn_completed: 'state.turn-completed',
  'turn.completed': 'state.turn-completed',
  session_error: 'state.error',
  'turn.failed': 'state.error',
};

export function displayTypeForEnvelope(env: EventEnvelope): DisplayEventType | undefined {
  return env.display?.type ?? LEGACY_DISPLAY_TYPES[env.event];
}

export function displayDataForEnvelope(env: EventEnvelope): Record<string, unknown> {
  return (env.display?.data ?? env.data ?? {}) as Record<string, unknown>;
}

function upsertToolItem(
  items: TranscriptItem[],
  item: TranscriptItem,
): TranscriptItem[] {
  const index = items.findIndex(
    current => current.id === item.id && TOOL_ITEM_KINDS.has(current.kind),
  );
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

/**
 * Older image sends arrived as a JSONL echo with NO structured attachments —
 * the image is referenced inline as `[Attached image: <abs path>]` (the framing
 * the composer used to inject so the PTY's `claude` would read it). Recover any
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
 * just wasn't recorded (e.g. a cancelled legacy question whose JSONL has no
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
 * Folds one provider-native envelope into the transcript using only its UI
 * display projection. Historical rows are translated at this read boundary.
 *
 * Returns the same array reference if the event was a no-op so the caller
 * can skip a state update.
 */
export function applyEnvelope(
  items: TranscriptItem[],
  env: EventEnvelope,
  executor: Executor,
): TranscriptItem[] {
  const data = displayDataForEnvelope(env);
  const ev = displayTypeForEnvelope(env);
  const displayEnv = data === env.data ? env : { ...env, data };

  // ── assistant_text (unified) / output.text.delta (legacy codex streaming) ──
  if (ev === 'message') {
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
  if (ev === 'activity.reasoning') {
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
  if (ev === 'plan') return items;

  // ── turn_started (unified) — signal only, not a transcript entry. App.tsx
  // listens for this to flip pendingBySession=true.
  if (ev === 'state.turn-started') return items;

  // ── command_execution (unified) ──
  if (ev === 'activity.command') {
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
    return upsertToolItem(items, item);
  }

  if (ev === 'activity.tool') {
    const itemId = String(data.itemId ?? env.call_id);
    const existing = items.find(item => item.kind === 'tool' && item.id === itemId) as ToolItem | undefined;
    const summary = data.input === undefined
      ? existing?.summary ?? ''
      : typeof data.input === 'string'
        ? data.input
        : JSON.stringify(data.input);
    const status: ToolItem['status'] = data.status === 'pending'
      || data.status === 'running'
      || data.status === 'success'
      || data.status === 'error'
      ? data.status
      : existing?.status ?? 'running';
    const output = data.output === undefined
      ? existing?.output
      : typeof data.output === 'string'
        ? data.output
        : JSON.stringify(data.output, null, 2);
    const nextItem = {
      kind: 'tool' as const,
      id: itemId,
      name: String(data.title ?? data.kind ?? existing?.name ?? 'Tool'),
      summary,
      status,
      ...(output !== undefined ? { output } : {}),
      ts: env.ts,
      turn: env.turn,
    };
    return upsertToolItem(items, nextItem);
  }

  // ── file_read (unified) ──
  if (ev === 'activity.file-read') {
    const item: FileReadItem = {
      kind: 'file-read', id: env.call_id,
      path: String(data.path ?? '(unknown)'),
      startLine: data.startLine !== undefined ? Number(data.startLine) : undefined,
      endLine: data.endLine !== undefined ? Number(data.endLine) : undefined,
      ts: env.ts, turn: env.turn,
    };
    return upsertToolItem(items, item);
  }

  // ── file_search (unified) ──
  if (ev === 'activity.file-search') {
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
    return upsertToolItem(items, item);
  }

  // ── web_search (unified) ──
  if (ev === 'activity.web-search') {
    const item: WebSearchItem = {
      kind: 'web-search', id: env.call_id,
      query: String(data.query ?? ''),
      resultCount: data.resultCount !== undefined ? Number(data.resultCount) : undefined,
      ts: env.ts, turn: env.turn,
    };
    return upsertToolItem(items, item);
  }

  // ── agent_spawn (unified) ──
  if (ev === 'agent') {
    const itemId = String(env.call_id);
    const status: AgentSpawnItem['status'] =
      data.status === 'done' || data.status === 'error' ? data.status : 'running';
    const description = typeof data.description === 'string' ? data.description : '';
    const idx = items.findIndex(i => i.kind === 'agent-spawn' && i.id === itemId);
    if (idx >= 0) {
      const existing = items[idx] as AgentSpawnItem;
      const nextDescription =
        description && description.toLowerCase() !== 'agent'
          ? description
          : existing.description || description;
      const next = items.slice();
      next[idx] = {
        ...existing,
        provider: executor,
        description: nextDescription,
        status,
        agentId: typeof data.agentId === 'string' ? data.agentId : existing.agentId,
        taskId: typeof data.taskId === 'string' ? data.taskId : existing.taskId,
        agentType: typeof data.agentType === 'string' ? data.agentType : existing.agentType,
        model: typeof data.model === 'string' ? data.model : existing.model,
        output: typeof data.output === 'string' ? data.output : existing.output,
        outputFile: typeof data.outputFile === 'string' ? data.outputFile : existing.outputFile,
        background: typeof data.background === 'boolean' ? data.background : existing.background,
        input: data.input && typeof data.input === 'object'
          ? { ...(existing.input ?? {}), ...(data.input as Record<string, unknown>) }
          : existing.input,
        updatedAt: env.ts,
        completedAt: typeof data.completedAt === 'number'
          ? data.completedAt
          : status === 'running' ? existing.completedAt : env.ts,
      };
      return next;
    }
    const item: AgentSpawnItem = {
      kind: 'agent-spawn',
      id: itemId,
      provider: executor,
      agentId: typeof data.agentId === 'string' ? data.agentId : undefined,
      description,
      status,
      taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
      agentType: typeof data.agentType === 'string' ? data.agentType : undefined,
      model: typeof data.model === 'string' ? data.model : undefined,
      output: typeof data.output === 'string' ? data.output : undefined,
      outputFile: typeof data.outputFile === 'string' ? data.outputFile : undefined,
      background: typeof data.background === 'boolean' ? data.background : undefined,
      input: data.input && typeof data.input === 'object'
        ? data.input as Record<string, unknown>
        : undefined,
      startedAt: typeof data.startedAt === 'number' ? data.startedAt : env.ts,
      updatedAt: env.ts,
      completedAt: typeof data.completedAt === 'number'
        ? data.completedAt
        : status === 'running' ? undefined : env.ts,
      ts: env.ts, turn: env.turn,
    };
    return [...items, item];
  }

  // ── approval_requested (unified + legacy) ──
  if (ev === 'interaction.approval' || ev === 'interaction.question') {
    const item = parseApprovalRequested(displayEnv);
    if (!item) return items;
    // A single AskUserQuestion can arrive through both the live proxy and a
    // native-history replay. Dedupe by approvalId so it renders one card and keep the
    // existing item (and its status) so a late duplicate request can't
    // resurrect an already-resolved card.
    if (items.some(i => i.kind === 'approval' && i.approvalId === item.approvalId)) {
      return items;
    }
    return [...items, item];
  }

  // ── approval_resolved (unified + legacy) ──
  if (ev === 'interaction.resolved') {
    const approvalId = String(data.approvalId ?? '');
    const decision = String(data.decision ?? '');
    if (!approvalId) return items;
    const idx = items.findIndex(i => i.kind === 'approval' && i.approvalId === approvalId);
    if (idx < 0) return items;
    const existing = items[idx] as ApprovalItem;
    // A late auto-decline during session shutdown must NOT clobber a card the user already
    // answered. Once an approval is non-pending, ignore any `auto:true` resolve.
    if (data.auto === true && existing.status !== 'pending') {
      return items;
    }
    const next = items.slice();
    // Capture the picked answer(s) for a question resolve so the resolved card
    // can show "answered with …". Only the synthetic local resolve (the legacy
    // paste path) carried answers; the later JSONL watcher resolve did not, so
    // preserve any value we already have rather than blanking it.
    const answeredWith = formatAnsweredWith(data.answers) ?? existing.answeredWith;
    next[idx] = {
      ...existing,
      status: mapApprovalDecision(decision),
      resolvedAt: env.ts,
      ...(answeredWith ? { answeredWith } : {}),
      ...(typeof data.nativeOptionId === 'string'
        ? { nativeOptionId: data.nativeOptionId }
        : {}),
    };
    return next;
  }

  // ── file_change / diff.updated (legacy codex) ──
  if (ev === 'activity.file-change') {
    const item = parseDiffUpdated(displayEnv);
    return item ? upsertToolItem(items, item) : items;
  }

  // ── auto_classifier_denied (cc auto-mode) ──
  if (ev === 'activity.classifier-denied') {
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
  if (ev === 'activity.circuit-breaker') {
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
  if (ev === 'state.error') {
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
  if (ev === 'state.turn-completed') {
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
      .filter((a): a is { name: string; mime: string; url: string; size?: number } =>
        typeof a === 'object' && a !== null
        && typeof (a as Record<string, unknown>).name === 'string'
        && typeof (a as Record<string, unknown>).mime === 'string'
        && typeof (a as Record<string, unknown>).url === 'string'
        && (
          (a as Record<string, unknown>).size === undefined
          || typeof (a as Record<string, unknown>).size === 'number'
        ),
      )
      .map(a => ({
        name: a.name,
        mime: a.mime,
        url: a.url,
        ...(a.size !== undefined ? { size: a.size } : {}),
      }));
    // No structured attachments (older JSONL echo) → recover inline
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
    // NOT stripped here (legacy manager sessions predate the web removal;
    // stripping is a render-time concern).
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
    // The Host receives message:send frames in wire order and broadcasts each
    // accepted canonical user_message before its correlated result. Match the
    // oldest still-local compatible echo (FIFO), not the newest: two sends may
    // have identical visible text but distinct run ids and outcomes.
    let optimisticIndex = -1;
    for (let i = 0; i < base.length; i++) {
      const cand = base[i]!;
      if (
        cand.kind === 'user' && cand.pending
        && !cand.sendCanonical
        && (cand.text === item.text || cand.text === strippedItemText)
        && (cand.attachments?.length ?? 0) === attachments.length
      ) {
        optimisticIndex = i;
        break;
      }
    }

    const optimistic = optimisticIndex >= 0 ? base[optimisticIndex] : undefined;
    const releaseOptimisticAttachments = (candidate = optimistic) => {
      if (candidate?.kind !== 'user' || !candidate.attachments) return;
      // Object URLs created via createObjectURL retain their Blob until
      // revoked. Wrapped for test/browser environments without this API.
      for (const attachment of candidate.attachments) {
        try { URL.revokeObjectURL(attachment.url); } catch { /* noop */ }
      }
    };

    const retainCorrelatedSend = (candidate: MsgItem): MsgItem => {
      if (candidate.kind !== 'user' || !candidate.sendRunId) return item;
      const correlatedRetry = candidate.sendRetry
        ? {
            ...candidate.sendRetry,
            ...(candidate.sendRetry.attachments
              ? {
                  attachments: candidate.sendRetry.attachments.map((attachment, index) => ({
                    ...attachment,
                    previewUrl: attachments[index]?.url ?? attachment.previewUrl,
                  })),
                }
              : {}),
          }
        : undefined;
      return {
        ...item,
        pending: true,
        sendCanonical: true,
        sendRunId: candidate.sendRunId,
        ...(correlatedRetry ? { sendRetry: correlatedRetry } : {}),
      };
    };

    // HTTP hydration, latest-page refresh and the live WS frame can arrive in
    // any order. Upsert the canonical item and also retire a matching pending
    // echo if both are temporarily present in state.
    const canonicalIndex = base.findIndex(candidate => (
      candidate.kind === 'user' && candidate.id === item.id
    ));
    if (canonicalIndex >= 0) {
      const next = base.slice();
      const existingCanonical = base[canonicalIndex]!;
      next[canonicalIndex] = existingCanonical.kind === 'user'
        && existingCanonical.pending
        && existingCanonical.sendCanonical
        ? retainCorrelatedSend(existingCanonical)
        : item;
      if (optimisticIndex >= 0) {
        releaseOptimisticAttachments();
        next.splice(optimisticIndex, 1);
      }
      return next;
    }
    if (optimisticIndex >= 0) {
      releaseOptimisticAttachments();
      const next = base.slice();
      next[optimisticIndex] = optimistic?.kind === 'user'
        ? retainCorrelatedSend(optimistic)
        : item;
      return next;
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
  exec: Executor;
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
  const type = displayTypeForEnvelope(env);
  if (type === 'state.turn-started') return true;
  if (type === 'state.turn-completed' || type === 'state.error') return false;
  return null;
}

/**
 * Apply a `plan_update` envelope to the per-session plan accumulator
 * that PlanChip / PlanSheet subscribe to. `data.delta === true` means an
 * append; anything else replaces.
 *
 * Pure over its inputs so EVT-007 can be exercised without mounting the
 * full App.
 */
export function applyPlanUpdate(prev: string | undefined, env: EventEnvelope): string {
  const data = displayDataForEnvelope(env);
  const text = String(data.text ?? '');
  const isDelta = data.delta === true;
  return isDelta ? (prev ?? '') + text : text;
}

/** True only for a structured checklist whose every step is complete. */
export function isPlanChecklistComplete(plan: string | undefined): boolean {
  if (!plan) return false;
  const steps = plan.match(/^\s*[-*]\s+\[([ xX])\]\s+/gm) ?? [];
  return steps.length > 0 && steps.every(step => /\[[xX]\]/.test(step));
}

export interface PlanLifecycleState {
  text?: string;
  completed: boolean;
  /** Page-level presentation state. A plan may span turns, but it must not
   *  keep looking live after the executor has stopped producing output. */
  status?: 'active' | 'paused' | 'completed';
  /** Turn that most recently changed the plan lifecycle (update or stop). */
  turn?: number;
}

/**
 * Fold plan updates and terminal turn signals into the page-level lifecycle.
 * Completion is evaluated only at `turn_completed`, never mid-stream; an
 * incomplete or failed turn pauses the plan instead of leaving it live.
 */
export function applyPlanLifecycle(
  prev: PlanLifecycleState,
  env: EventEnvelope,
): PlanLifecycleState {
  const type = displayTypeForEnvelope(env);
  if (type === 'plan') {
    return {
      text: applyPlanUpdate(prev.text, env),
      completed: false,
      status: 'active',
      turn: env.turn,
    };
  }
  if (type === 'state.turn-completed' && prev.text) {
    const completed = isPlanChecklistComplete(prev.text);
    return {
      ...prev,
      completed,
      status: completed ? 'completed' : 'paused',
      turn: env.turn,
    };
  }
  if (type === 'state.error' && prev.text) {
    return {
      ...prev,
      completed: false,
      status: 'paused',
      turn: env.turn,
    };
  }
  return prev;
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
  const nativeOptions = Array.isArray(data.nativeOptions)
    ? (data.nativeOptions as unknown[]).flatMap(option => {
        if (!option || typeof option !== 'object') return [];
        const value = option as Record<string, unknown>;
        if (typeof value.optionId !== 'string' || typeof value.label !== 'string') return [];
        return [{
          optionId: value.optionId,
          label: value.label,
          kind: typeof value.kind === 'string' ? value.kind : 'unknown',
        }];
      })
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
    ...(nativeOptions && nativeOptions.length > 0 ? { nativeOptions } : {}),
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
  if (d === 'declined' || d === 'decline' || d === 'keep_planning') return 'declined';
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
