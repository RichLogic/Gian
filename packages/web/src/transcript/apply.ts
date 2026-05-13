import type { EventEnvelope } from '@gian/shared';
import type {
  AgentSpawnItem,
  ApprovalItem,
  CommandItem,
  DiffFile,
  DiffItem,
  FileReadItem,
  FileSearchItem,
  MsgItem,
  TokenUsage,
  TranscriptItem,
  WebSearchItem,
} from '../types.js';
import { truncate } from '../utils/format.js';

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
      next[idx] = { ...existing, text: existing.text + chunk };
      return next;
    }
    const created: MsgItem = {
      kind: 'assistant', id: itemId,
      text: chunk, exec: executor,
      ts: env.ts, turn: env.turn,
    };
    return [...items, created];
  }

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
    return item ? [...items, item] : items;
  }

  // ── approval_resolved (unified + legacy) ──
  if (ev === 'approval_resolved' || ev === 'approval.resolved') {
    const approvalId = String(data.approvalId ?? '');
    const decision = String(data.decision ?? '');
    if (!approvalId) return items;
    const idx = items.findIndex(i => i.kind === 'approval' && i.approvalId === approvalId);
    if (idx < 0) return items;
    const existing = items[idx] as ApprovalItem;
    const next = items.slice();
    next[idx] = { ...existing, status: mapApprovalDecision(decision) };
    return next;
  }

  // ── file_change / diff.updated (legacy codex) ──
  if (ev === 'file_change' || ev === 'diff.updated') {
    const item = parseDiffUpdated(env);
    return item ? [...items, item] : items;
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

  // ── remaining legacy events ──
  const item = legacyEnvelopeToItem(env, executor);
  return item ? [...items, item] : items;
}

/**
 * Handles legacy raw event names that don't yet have a unified counterpart
 * routed above.
 */
function legacyEnvelopeToItem(env: EventEnvelope, executor: 'claude' | 'codex'): TranscriptItem | null {
  const data = (env.data ?? {}) as Record<string, unknown>;
  switch (env.event) {
    case 'user_message':
      return {
        kind: 'user', id: env.call_id,
        text: String(data.text ?? ''), exec: executor,
        ts: env.ts, turn: env.turn,
      };
    case 'output.text':
      return {
        kind: 'assistant', id: env.call_id,
        text: String(data.text ?? ''), exec: executor,
        ts: env.ts, turn: env.turn,
      };
    case 'tool.use': {
      const name = String(data.toolName ?? data.name ?? 'tool');
      const summary = data.input ? truncate(JSON.stringify(data.input), 200) : '';
      return { kind: 'tool', id: env.call_id, name, summary, ts: env.ts, turn: env.turn };
    }
    case 'turn.started':
      return { kind: 'turn-start', id: env.call_id, text: `Turn ${env.turn}`, ts: env.ts, turn: env.turn };
    // token_usage.updated never becomes a transcript item
    case 'token_usage.updated':
      return null;
    default:
      return null;
  }
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
  // to read the real model id from `system init`, where the alias-probe
  // resolved id (200k variant) was stored even though CLI was running the
  // 1M variant. Bump to the next plausible ceiling so the bar stops
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
