import type { ProxyNotification } from '@gian/shared';
import type {
  ApprovalRequestedData,
  ApprovalResolvedData,
  FileChangeSummary,
  UnifiedEvent,
} from '@gian/shared';

/**
 * Translate a raw codex-proxy notification into 0..N unified events.
 *
 * Mapping coverage:
 *   output.text.delta       → assistant_text  (delta:true)
 *   output.reasoning.delta  → reasoning       (kind: 'summary' | 'full')
 *   output.plan.delta       → plan_update     (delta:true)
 *   output.plan.final       → plan_update     (delta:false)
 *   output.command.delta    → command_execution (stdoutDelta stream)
 *   diff.updated            → file_change     (unified diff parsed)
 *   approval.requested      → approval_requested
 *   approval.resolved       → approval_resolved
 *   turn.started            → (no transcript event — only flips pending UI state
 *                              via the WS broadcast layer)
 *   turn.completed          → turn_completed
 *   turn.failed             → session_error
 *   runtime.error           → session_error
 *   token_usage.updated     → (no unified event — M2 session stats layer)
 *   debug                   → (discard)
 *
 * Per-tool slots (`file_read`, `file_search`, `web_search`, `agent_spawn`) stay
 * cc-only for now — codex emits a generic `item/tool/call` that would need a
 * unified `tool_call` slot to map cleanly. Deferred.
 */
export function normalizeCodexNotification(
  raw: ProxyNotification,
  sessionId: string,
  turn: number,
): UnifiedEvent[] {
  const data = (raw.params.data ?? {}) as Record<string, unknown>;
  const callId = (): string =>
    String((raw.params as Record<string, unknown>).itemId ?? data.itemId ?? crypto.randomUUID());

  switch (raw.method) {
    case 'output.text.delta': {
      const itemId = String(data.itemId ?? crypto.randomUUID());
      const text = String(data.delta ?? data.text ?? '');
      if (!text) return [];
      return [
        {
          session_id: sessionId,
          turn,
          call_id: itemId,
          ts: Date.now(),
          type: 'assistant_text',
          data: { text, delta: true, itemId },
        },
      ];
    }

    case 'output.reasoning.delta': {
      const itemId = String(data.itemId ?? crypto.randomUUID());
      const text = String(data.delta ?? data.text ?? '');
      if (!text) return [];
      const kind = data.kind === 'summary' ? 'summary' : 'full';
      return [
        {
          session_id: sessionId,
          turn,
          call_id: itemId,
          ts: Date.now(),
          type: 'reasoning',
          data: { text, delta: true, itemId, kind },
        },
      ];
    }

    case 'output.plan.delta': {
      const itemId = String(data.itemId ?? 'plan');
      const text = String(data.delta ?? '');
      if (!text) return [];
      return [
        {
          session_id: sessionId,
          turn,
          call_id: itemId,
          ts: Date.now(),
          type: 'plan_update',
          data: { text, delta: true },
        },
      ];
    }

    case 'output.plan.final': {
      const text = String(data.text ?? '');
      return [
        {
          session_id: sessionId,
          turn,
          call_id: 'plan',
          ts: Date.now(),
          type: 'plan_update',
          data: { text, delta: false },
        },
      ];
    }

    case 'output.command.delta': {
      const itemId = String(data.itemId ?? crypto.randomUUID());
      const stdoutDelta = String(data.delta ?? data.stdout ?? '');
      return [
        {
          session_id: sessionId,
          turn,
          call_id: itemId,
          ts: Date.now(),
          type: 'command_execution',
          data: {
            command: String(data.command ?? ''),
            cwd: data.cwd != null ? String(data.cwd) : undefined,
            status: 'running',
            stdoutDelta,
            itemId,
          },
        },
      ];
    }

    case 'diff.updated': {
      // codex wraps the diff under data.params.diff or data.diff
      const inner = (data.params ?? data) as Record<string, unknown>;
      const diffText = String(inner.diff ?? inner.unified ?? '');
      if (!diffText.trim()) return [];
      const files = parseUnifiedDiffSummary(diffText);
      if (files.length === 0) return [];
      return [
        {
          session_id: sessionId,
          turn,
          call_id: callId(),
          ts: Date.now(),
          type: 'file_change',
          data: { files, diff: diffText },
        },
      ];
    }

    case 'approval.requested': {
      const approvalId = String(data.approvalId ?? crypto.randomUUID());
      const method = String(data.method ?? '');
      const payload = (data.payload ?? {}) as Record<string, unknown>;
      const permissionsKind = typeof data.permissionsKind === 'string'
        ? data.permissionsKind as 'network' | 'file' | 'mixed' | 'other'
        : undefined;
      // Prefer the proxy's explicit `reason` (added 2026-05-17); fall back to
      // `description` for older proxy builds and finally to the legacy `risk`
      // field which used to carry the prose. Empty string is a real signal
      // (proxy had nothing to say) — don't synthesize boilerplate here.
      const description = typeof data.reason === 'string' && data.reason
        ? data.reason
        : typeof data.description === 'string' && data.description
          ? data.description
          : typeof data.risk === 'string' && data.risk
            ? data.risk
            : '';
      return [
        {
          session_id: sessionId,
          turn,
          call_id: approvalId,
          ts: Date.now(),
          type: 'approval_requested',
          data: {
            approvalId,
            category: mapCodexMethodToCategory(method, permissionsKind),
            // Prefer the proxy's explicit `severity` over the legacy `risk`
            // field (which carried prose, not severity).
            risk: mapCodexRisk(data.severity ?? data.risk),
            title: String(data.title ?? 'Review request'),
            description,
            subject: extractCodexSubject(payload),
            scopeOptions: mapScopeOptions(data.scopeOptions),
          } satisfies ApprovalRequestedData,
        },
      ];
    }

    case 'approval.resolved': {
      const approvalId = String(data.approvalId ?? '');
      if (!approvalId) return [];
      // codex uses data.decision: 'accept'|'decline', data.scope: 'once'|'session'
      const decision = mapCodexDecision(String(data.decision ?? ''), String(data.scope ?? ''));
      return [
        {
          session_id: sessionId,
          turn,
          call_id: approvalId,
          ts: Date.now(),
          type: 'approval_resolved',
          data: {
            approvalId,
            decision,
            auto: Boolean(data.auto ?? false),
          } satisfies ApprovalResolvedData,
        },
      ];
    }

    case 'turn.completed': {
      const summary = (data.summary ?? {}) as Record<string, unknown>;
      const turnId = String(raw.params.turnId ?? summary.turnId ?? turn);
      return [
        {
          session_id: sessionId,
          turn,
          call_id: turnId,
          ts: Date.now(),
          type: 'turn_completed',
          data: {
            turnId,
            summary: summary.assistantText != null ? String(summary.assistantText) : undefined,
          },
        },
      ];
    }

    case 'turn.failed': {
      const msg = String(data.error ?? data.message ?? 'turn failed');
      return [
        {
          session_id: sessionId,
          turn,
          call_id: crypto.randomUUID(),
          ts: Date.now(),
          type: 'session_error',
          data: {
            message: msg,
            retryable: isRetryable(msg),
          },
        },
      ];
    }

    case 'runtime.error': {
      return [
        {
          session_id: sessionId,
          turn,
          call_id: crypto.randomUUID(),
          ts: Date.now(),
          type: 'session_error',
          data: {
            message: String(data.message ?? 'runtime error'),
            retryable: false,
            code: data.code != null ? String(data.code) : undefined,
          },
        },
      ];
    }

    case 'turn.started': {
      return [
        {
          session_id: sessionId,
          turn,
          call_id: 'turn-start',
          ts: Date.now(),
          type: 'turn_started',
          data: { turnId: String((raw.params as { turnId?: unknown }).turnId ?? '') },
        },
      ];
    }

    // Intentionally dropped — no unified slot yet:
    case 'token_usage.updated': // M2 session stats layer
    case 'debug':               // discard
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapCodexMethodToCategory(
  method: string,
  permissionsKind?: 'network' | 'file' | 'mixed' | 'other',
): 'command' | 'network' | 'file_write_outside_ws' | 'other' {
  if (method === 'shell' || method === 'exec' || method.includes('command')) return 'command';
  if (method === 'network' || method.includes('http') || method.includes('fetch')) return 'network';
  // Permissions requests carry permissionsKind from the proxy. Route
  // network-only grants to `network` and file-only to `file_write_outside_ws`
  // so the UI shows the right card; mixed/other stay generic. Without this
  // the old fallthrough mapped every permissions request to `other`.
  if (method === 'item/permissions/requestApproval' || method.includes('permission')) {
    if (permissionsKind === 'network') return 'network';
    if (permissionsKind === 'file') return 'file_write_outside_ws';
    return 'other';
  }
  if (method === 'write' || method.includes('file')) return 'file_write_outside_ws';
  return 'other';
}

function mapCodexRisk(v: unknown): 'low' | 'medium' | 'high' {
  const s = String(v ?? '').toLowerCase();
  if (s === 'high' || s.includes('danger')) return 'high';
  if (s === 'low') return 'low';
  return 'medium';
}

function extractCodexSubject(payload: Record<string, unknown>): string | undefined {
  const v = payload.command ?? payload.cmd ?? payload.path ?? payload.url;
  return v != null ? String(v) : undefined;
}

function mapScopeOptions(v: unknown): ('once' | 'session')[] {
  if (!Array.isArray(v)) return ['once', 'session'];
  return (v as unknown[])
    .map(s => String(s))
    .filter((s): s is 'once' | 'session' => s === 'once' || s === 'session');
}

function mapCodexDecision(
  decision: string,
  scope: string,
): 'allow_once' | 'allow_session' | 'decline' {
  if (decision === 'decline' || decision === 'declined' || decision === 'deny') return 'decline';
  if (scope === 'session') return 'allow_session';
  return 'allow_once';
}

function isRetryable(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('rate limit') ||
    lower.includes('network') ||
    lower.includes('econnreset') ||
    lower.includes('socket')
  );
}

/**
 * Parse a unified diff string into FileChangeSummary records.
 * Mirrors the idea in packages/web/src/transcript/apply.ts#parseUnifiedDiff
 * but only returns what FileChangeData.files requires.
 */
function parseUnifiedDiffSummary(text: string): FileChangeSummary[] {
  const chunks = text.split(/^diff --git .*$/m).map(c => c.trim()).filter(Boolean);
  if (chunks.length === 0 && text.trim()) chunks.push(text.trim());

  return chunks.map(chunk => {
    const lines = chunk.split('\n');
    let path = '';
    let isNew = false;
    let isDelete = false;
    let added = 0;
    let removed = 0;

    for (const line of lines) {
      if (line.startsWith('+++ b/')) path = line.slice(6);
      else if (line.startsWith('+++ /dev/null')) isDelete = true;
      else if (line.startsWith('--- /dev/null')) isNew = true;
      else if (!path && line.startsWith('--- a/')) path = line.slice(6);
      else if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }

    let kind: 'create' | 'update' | 'delete';
    if (isDelete) kind = 'delete';
    else if (isNew) kind = 'create';
    else kind = 'update';

    return { path: path || '(unknown)', kind, added, removed };
  });
}
