import { createHash } from 'node:crypto';

export const EXCLUDED_EXTENSIONS = [
  'rewind',
  'cancel_rewind',
  'feedback',
  'relay',
  'share',
  'plugin',
  'marketplace',
  'announcements',
  'queue',
  'follow_ups',
  'leader',
  'scheduled_task',
  // Request-shaped MCP methods are never notifications; only status
  // notifications (init_progress, tools_changed, servers_updated,
  // server_status, elicit_complete) translate to notices.
  'mcp/list',
  'mcp/call',
  'mcp/read_resource',
  'mcp/auth',
  'mcp/setup',
  'mcp/toggle',
  'mcp/upsert',
  'mcp/delete',
] as const;

export interface TranslatedEvent {
  method: string;
  data: Record<string, unknown>;
  terminal?: 'completed' | 'failed';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}

/** gian.proxy/2 `diff.updated` data. File path lives only in `files`. */
export function grokDiffUpdatedData(path: string, diff: string) {
  return {
    diffId: stableId('diff', { path, diff }),
    diff,
    truncated: false,
    files: [{ path, status: 'modified' as const }],
  };
}

export function jsonClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function extensionName(method: string): string {
  return method.replace(/^_?x\.ai\//, '');
}

export function isExcludedExtension(name: string): boolean {
  const normalized = name.toLowerCase();
  return EXCLUDED_EXTENSIONS.some(token => normalized.includes(token));
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function parsePromptUsage(meta: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
} | null {
  if (!meta || typeof meta !== 'object') return null;
  const value = meta as Record<string, unknown>;
  const usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  } = {};
  const inputTokens = numberOr(value.inputTokens);
  const outputTokens = numberOr(value.outputTokens);
  const cachedInputTokens = numberOr(value.cachedReadTokens);
  const thoughtTokens = numberOr(value.reasoningTokens);
  const totalTokens = numberOr(value.totalTokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (thoughtTokens !== undefined) usage.thoughtTokens = thoughtTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

function textFromContent(value: unknown): string {
  const block = record(value);
  const inner = record(block.content);
  if (typeof inner.text === 'string') return inner.text;
  if (typeof block.text === 'string') return block.text;
  return '';
}

function toolContentText(content: unknown): string {
  return Array.isArray(content) ? content.map(textFromContent).join('') : '';
}

function activityStatus(value: unknown): 'running' | 'succeeded' | 'failed' {
  if (value === 'failed') return 'failed';
  if (value === 'completed') return 'succeeded';
  return 'running';
}

function noticeActivity(params: {
  noticeId: string;
  title: string;
  message: string;
  code?: string;
  status?: 'succeeded' | 'failed';
}): TranslatedEvent {
  return {
    method: 'activity.updated',
    data: {
      activityId: params.noticeId,
      kind: 'notice',
      title: params.title,
      status: params.status ?? 'succeeded',
      presentation: {
        type: 'notice',
        data: {
          message: params.message,
          title: params.title,
          ...(params.code ? { code: params.code } : {}),
        },
      },
    },
  };
}

function genericActivity(name: string, payload: Record<string, unknown>): TranslatedEvent {
  return {
    method: 'activity.updated',
    data: {
      activityId: `grok-${name}-${stableId('upd', payload)}`,
      kind: 'generic',
      title: name,
      status: 'succeeded',
      presentation: {
        type: 'generic',
        data: { name, payload: jsonClone(payload) },
      },
    },
  };
}

/** Native subagent lifecycle (subagent_spawned/progress/finished updates). */
function subagentActivity(
  kind: 'subagent_spawned' | 'subagent_progress' | 'subagent_finished',
  value: Record<string, unknown>,
): TranslatedEvent | null {
  const subagentId = typeof value.subagentId === 'string' && value.subagentId
    ? value.subagentId
    : typeof value.subagent_id === 'string' && value.subagent_id
      ? value.subagent_id
      : '';
  if (!subagentId) return null;
  const status = kind === 'subagent_finished'
    ? (String(value.status ?? '') === 'failed'
      ? 'failed' as const
      : String(value.status ?? '') === 'cancelled'
        ? 'cancelled' as const
        : 'succeeded' as const)
    : 'running' as const;
  const description = typeof value.description === 'string' ? value.description : '';
  const childSessionId = typeof value.childSessionId === 'string'
    ? value.childSessionId
    : typeof value.child_session_id === 'string' ? value.child_session_id : undefined;
  const subagentType = typeof value.subagentType === 'string'
    ? value.subagentType
    : typeof value.subagent_type === 'string' ? value.subagent_type : undefined;
  return {
    method: 'activity.updated',
    data: {
      activityId: `grok-subagent-${subagentId}`,
      kind: 'agent',
      title: description || `Subagent ${subagentId}`,
      status,
      presentation: {
        type: 'agent',
        data: {
          agentId: subagentId,
          state: kind === 'subagent_finished'
            ? (status === 'failed' ? 'failed' : status === 'cancelled' ? 'interrupted' : 'completed')
            : 'running',
          ...(childSessionId ? { childSessionId } : {}),
          ...(subagentType ? { subagentType } : {}),
          ...(kind === 'subagent_finished' && typeof value.error === 'string' && value.error
            ? { error: value.error }
            : {}),
          ...(kind === 'subagent_progress'
            ? {
              turnCount: typeof value.turnCount === 'number'
                ? value.turnCount
                : typeof value.turn_count === 'number' ? value.turn_count : undefined,
              toolCallCount: typeof value.toolCallCount === 'number'
                ? value.toolCallCount
                : typeof value.tool_call_count === 'number' ? value.tool_call_count : undefined,
            }
            : {}),
        },
      },
    },
  };
}

export function translateSessionUpdate(update: unknown): TranslatedEvent[] {
  const value = record(update);
  const kind = String(value.sessionUpdate ?? '');

  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'user_message_chunk') {
    const text = textFromContent(value.content ?? value);
    const contentKind = kind === 'agent_thought_chunk' ? 'reasoning' : 'text';
    if (kind === 'user_message_chunk') {
      // The CLI echoes the Host's own input back to us. input.recorded is a
      // session.replay-only notification and the Host rejects it on the live
      // stream, so the echo contributes nothing live.
      return [];
    }
    return [{
      method: 'content.delta',
      data: { kind: contentKind, delta: text },
    }];
  }

  if (kind === 'tool_call') {
    return [{
      method: 'activity.updated',
      data: {
        activityId: String(value.toolCallId || 'grok-tool'),
        kind: 'tool',
        title: String(value.title ?? 'Tool'),
        status: 'running',
        presentation: {
          type: 'tool',
          data: { name: String(value.kind ?? value.title ?? 'tool') },
        },
        ...(value.rawInput !== undefined || value.input !== undefined
          ? { details: jsonClone(value.rawInput ?? value.input ?? null) }
          : {}),
      },
    }];
  }

  if (kind === 'tool_call_update') {
    const activityId = String(value.toolCallId ?? '');
    const content = Array.isArray(value.content) ? value.content : [];
    const text = toolContentText(content);
    const events: TranslatedEvent[] = [];
    for (const item of content) {
      const payload = record(item);
      if (payload.type !== 'diff') continue;
      events.push({
        method: 'diff.updated',
        data: grokDiffUpdatedData(
          String(payload.path ?? 'unknown'),
          String(payload.diff ?? payload.unifiedDiff ?? ''),
        ),
      });
    }
    const status = activityStatus(value.status);
    events.push({
      method: 'activity.updated',
      data: {
        activityId: activityId || 'grok-tool',
        kind: 'tool',
        title: String(value.title ?? 'Tool'),
        status,
        presentation: {
          type: 'tool',
          data: { name: String(value.kind ?? value.title ?? 'tool') },
        },
        ...(value.rawOutput !== undefined || text || Array.isArray(value.locations)
          ? {
            details: jsonClone({
              ...(value.rawOutput !== undefined ? { output: value.rawOutput } : {}),
              ...(text ? { outputDelta: text } : {}),
              ...(Array.isArray(value.locations) ? { locations: value.locations } : {}),
              content,
            }),
          }
          : {}),
      },
    });
    return events;
  }

  if (kind === 'subagent_spawned' || kind === 'subagent_progress' || kind === 'subagent_finished') {
    const activity = subagentActivity(kind, value);
    return activity ? [activity] : [];
  }

  if (kind === 'plan' || kind === 'plan_update') {
    const entries = Array.isArray(value.entries) ? value.entries : [];
    return [{
      method: 'plan.updated',
      data: {
        planId: 'grok-plan',
        title: typeof value.title === 'string' ? value.title : 'Plan',
        steps: entries.map((entry, index) => {
          const item = record(entry);
          return {
            id: String(item.id ?? `step-${index}`),
            text: String(item.content ?? item.text ?? `Step ${index + 1}`),
            status: item.status === 'completed' || item.status === 'failed' || item.status === 'in_progress'
              ? item.status
              : 'pending',
          };
        }),
      },
    }];
  }

  if (kind === 'current_mode_update' || kind === 'current_model_update' || kind === 'config_update') {
    return [{
      method: 'session.updated',
      data: { updatedAt: new Date().toISOString() },
    }];
  }

  if (kind === 'available_commands_update') {
    return [];
  }

  if (kind === 'usage_update') {
    const used = numberOr(value.used);
    if (used === undefined) return [];
    const window = numberOr(value.size);
    return [{
      method: 'usage.updated',
      data: {
        context: {
          used,
          ...(window !== undefined && window > 0 ? { window } : {}),
        },
      },
    }];
  }

  return [genericActivity(
    kind ? `session-update-${kind}` : 'session-update-unknown',
    value,
  )];
}

export function sessionUpdateText(update: unknown): string {
  return textFromContent(record(update).content ?? update);
}

function compactEvents(name: string): TranslatedEvent[] {
  const failed = /fail/.test(name);
  const started = /start/.test(name);
  const cancelled = /cancel/.test(name);
  const suffix = started ? 'started' : failed ? 'failed' : cancelled ? 'cancelled' : 'completed';
  const events: TranslatedEvent[] = [];
  if (started) {
    events.push({
      method: 'usage.updated',
      data: {
        conversation: { mode: 'reset' },
      },
    });
  }
  events.push(noticeActivity({
    noticeId: `grok-compact-${suffix}`,
    title: started
      ? 'Grok is compacting context'
      : failed
        ? 'Grok compact failed'
        : cancelled
          ? 'Grok compact cancelled'
          : 'Grok compact completed',
    message: started
      ? 'Grok started compacting the session context.'
      : failed
        ? 'Grok compact failed.'
        : cancelled
          ? 'Grok compact was cancelled.'
          : 'Grok finished compacting the session context.',
    code: `GROK_COMPACT_${suffix.toUpperCase()}`,
    status: failed ? 'failed' : 'succeeded',
  }));
  return events;
}

export function translateExtension(method: string, params: unknown): TranslatedEvent[] {
  const name = extensionName(method);
  if (isExcludedExtension(name)) return [];
  const payload = record(params);
  const normalized = name.toLowerCase();

  // x.ai/session_notification wraps a SessionNotification payload; grok's own
  // subagent lifecycle updates (subagent_spawned/progress/finished) and title
  // updates arrive through it, so the inner update is translated directly.
  if (normalized === 'session_notification' || normalized === 'session/notification') {
    const update = record(payload.update ?? payload.sessionUpdate);
    if (Object.keys(update).length === 0) return [];
    return translateSessionUpdate(update);
  }
  // x.ai/sessions/changed: the native session directory changed (create,
  // rename, delete, or sync elsewhere). Session-scoped, not turn-scoped.
  if (normalized === 'sessions_changed' || normalized === 'sessions/changed') {
    return [{
      method: 'session.updated',
      data: { nativeSessionsChanged: true, updatedAt: new Date().toISOString() },
    }];
  }
  if (/git_head/.test(normalized)) {
    return [noticeActivity({
      noticeId: 'grok-git-head-changed',
      title: 'Grok detected a new git HEAD',
      message: String(payload.message ?? payload.head ?? 'The workspace git HEAD changed outside the session.'),
      code: 'GROK_GIT_HEAD_CHANGED',
    })];
  }
  // Host MCP status: surfaced as notices so the Host can observe server
  // initialization, tool-list changes, and failures without dialing anything.
  if (/^mcp(_|\/)/.test(normalized) || normalized.includes('mcp_')) {
    const failed = /error|fail/.test(normalized);
    return [noticeActivity({
      noticeId: `grok-${name}`,
      title: failed ? 'Grok MCP server problem' : 'Grok MCP status',
      message: String(payload.message ?? payload.status ?? payload.serverName ?? name),
      code: `GROK_MCP_${failed ? 'FAILED' : 'UPDATE'}`,
      ...(failed ? { status: 'failed' as const } : {}),
    })];
  }
  if (/turn[_-]?completed/.test(normalized)) {
    return [{
      method: 'turn.completed',
      data: { stopReason: payload.stopReason === 'cancelled' ? 'cancelled' : 'completed' },
      terminal: 'completed',
    }];
  }
  if (/turn[_-]?failed/.test(normalized)) {
    return [{
      method: 'turn.failed',
      data: {
        error: {
          domainCode: 'RUNTIME_ERROR',
          message: String(payload.message ?? 'Grok turn failed.'),
          retryable: false,
          details: {},
        },
      },
      terminal: 'failed',
    }];
  }
  if (/compact/.test(normalized)) return compactEvents(normalized);
  if (/retry|auto[_-]?recover/.test(normalized)) {
    return [{
      method: 'content.delta',
      data: {
        kind: 'status',
        delta: String(payload.message ?? payload.status ?? name),
      },
    }];
  }
  if (/diff/.test(normalized)) {
    return [{
      method: 'diff.updated',
      data: grokDiffUpdatedData(
        String(payload.path ?? payload.file ?? 'unknown'),
        String(payload.diff ?? payload.unifiedDiff ?? ''),
      ),
    }];
  }
  if (/model/.test(normalized)) {
    const model = typeof payload.modelId === 'string'
      ? payload.modelId
      : typeof payload.model === 'string' ? payload.model : null;
    return [
      {
        method: 'session.updated',
        data: { updatedAt: new Date().toISOString() },
      },
      noticeActivity({
        noticeId: `grok-${name}`,
        title: 'Grok model changed',
        message: model ? `Grok switched to ${model}.` : 'Grok changed the active model.',
        code: 'GROK_MODEL_CHANGED',
      }),
    ];
  }
  if (/subagent|background|monitor|workflow|goal/.test(normalized)) {
    const state = /fail/.test(normalized)
      ? 'failed' as const
      : /cancel|interrupt/.test(normalized)
        ? 'interrupted' as const
        : /finish|done|complete/.test(normalized)
          ? 'completed' as const
          : 'running' as const;
    const status = state === 'failed'
      ? 'failed' as const
      : state === 'interrupted'
        ? 'cancelled' as const
        : state === 'completed'
          ? 'succeeded' as const
          : 'running' as const;
    const agentId = String(payload.agentId ?? payload.id ?? name);
    return [{
      method: 'activity.updated',
      data: {
        activityId: agentId,
        kind: 'agent',
        title: String(payload.description ?? payload.title ?? name),
        status,
        presentation: {
          type: 'agent',
          data: { agentId, state },
        },
      },
    }];
  }
  if (/memory|flush|dream|session[_-]?saved/.test(normalized)) {
    return [noticeActivity({
      noticeId: `grok-${name}`,
      title: name,
      message: String(payload.message ?? name),
      code: 'GROK_SESSION_NOTICE',
    })];
  }
  if (/image/.test(normalized) && /compress|drop/.test(normalized)) {
    return [noticeActivity({
      noticeId: `grok-${name}`,
      title: 'A Grok image input was compressed or dropped',
      message: String(payload.message ?? 'Grok could not keep the original image payload.'),
      code: 'GROK_IMAGE_DROPPED',
    })];
  }
  if (/hook/.test(normalized)) {
    const events: TranslatedEvent[] = [genericActivity(name, payload)];
    if (/error|fail/.test(normalized)) {
      events.push(noticeActivity({
        noticeId: `grok-${name}`,
        title: 'Grok hook failed',
        message: String(payload.message ?? name),
        code: 'GROK_HOOK_FAILED',
        status: 'failed',
      }));
    }
    return events;
  }

  return [genericActivity(name, payload)];
}
