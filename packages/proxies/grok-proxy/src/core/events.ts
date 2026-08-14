export const EXCLUDED_EXTENSIONS = [
  'rewind',
  'cancel_rewind',
  'feedback',
  'relay',
  'share',
  'plugin',
  'marketplace',
  'mcp',
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

export function translateSessionUpdate(update: unknown): TranslatedEvent[] {
  const value = record(update);
  const kind = String(value.sessionUpdate ?? '');

  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'user_message_chunk') {
    const text = textFromContent(value.content ?? value);
    const contentKind = kind === 'agent_thought_chunk'
      ? 'reasoning'
      : kind === 'user_message_chunk'
        ? 'input'
        : 'text';
    if (contentKind === 'input') {
      if (!text.trim()) return [];
      return [{
        method: 'input.recorded',
        data: {
          inputId: 'grok-user-chunk',
          input: [{ type: 'text', text }],
        },
      }];
    }
    return [{
      method: 'content.delta',
      data: { kind: contentKind, delta: text },
    }];
  }

  if (kind === 'tool_call') {
    return [{
      method: 'tool.started',
      data: {
        toolCallId: String(value.toolCallId || 'grok-tool'),
        name: String(value.title ?? value.kind ?? 'tool'),
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        input: jsonClone(value.rawInput ?? value.input ?? null),
      },
    }];
  }

  if (kind === 'tool_call_update') {
    const toolCallId = String(value.toolCallId ?? '');
    const content = Array.isArray(value.content) ? value.content : [];
    const text = toolContentText(content);
    const events: TranslatedEvent[] = [];
    for (const item of content) {
      const payload = record(item);
      if (payload.type !== 'diff') continue;
      const path = String(payload.path ?? 'unknown');
      events.push({
        method: 'diff.updated',
        data: {
          path,
          diff: String(payload.diff ?? payload.unifiedDiff ?? ''),
          files: [{ path, status: 'modified' }],
        },
      });
    }
    if (value.status === 'completed' || value.status === 'failed') {
      events.push({
        method: 'tool.completed',
        data: {
          toolCallId,
          status: value.status === 'failed' ? 'failed' : 'succeeded',
          output: jsonClone(value.rawOutput ?? text),
        },
      });
    } else {
      events.push({
        method: 'tool.updated',
        data: {
          toolCallId,
          ...(text ? { outputDelta: text } : {}),
          data: jsonClone({
            ...(Array.isArray(value.locations) ? { locations: value.locations } : {}),
            content,
          }),
        },
      });
    }
    return events;
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
    const mode = typeof value.currentModeId === 'string'
      && (value.currentModeId === 'default'
        || value.currentModeId === 'auto'
        || value.currentModeId === 'always_approve')
      ? value.currentModeId
      : undefined;
    const data = {
      ...(mode ? { mode } : {}),
      ...(typeof value.currentModelId === 'string' ? { model: value.currentModelId } : {}),
    };
    return Object.keys(data).length > 0
      ? [{ method: 'session.updated', data: { ...data, reason: 'runtime-state-changed' } }]
      : [];
  }

  if (kind === 'available_commands_update') {
    return [];
  }

  if (kind === 'usage_update') {
    return [{
      method: 'usage.updated',
      data: {
        context: {
          ...(numberOr(value.used) !== undefined ? { used: numberOr(value.used) } : {}),
          ...(numberOr(value.size) !== undefined ? { window: numberOr(value.size) } : {}),
        },
      },
    }];
  }

  return [];
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
        reason: 'compact_started',
      },
    });
  }
  events.push({
    method: 'notice.created',
    data: {
      noticeId: `grok-compact-${suffix}`,
      severity: failed ? 'error' : 'info',
      code: `GROK_COMPACT_${suffix.toUpperCase()}`,
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
    },
  });
  return events;
}

export function translateExtension(method: string, params: unknown): TranslatedEvent[] {
  const name = extensionName(method);
  if (isExcludedExtension(name)) return [];
  const payload = record(params);
  const normalized = name.toLowerCase();

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
          code: 'RUNTIME_ERROR',
          message: String(payload.message ?? 'Grok turn failed.'),
          retryable: false,
          data: {},
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
    const path = String(payload.path ?? payload.file ?? 'unknown');
    return [{
      method: 'diff.updated',
      data: {
        path,
        diff: String(payload.diff ?? payload.unifiedDiff ?? ''),
        files: [{ path, status: 'modified' }],
      },
    }];
  }
  if (/model/.test(normalized)) {
    const model = typeof payload.modelId === 'string'
      ? payload.modelId
      : typeof payload.model === 'string' ? payload.model : null;
    return [
      ...(model ? [{
        method: 'session.updated',
        data: { model, reason: 'runtime-state-changed' as const },
      }] : []),
      {
        method: 'notice.created',
        data: {
          noticeId: `grok-${name}`,
          severity: 'info',
          code: 'GROK_MODEL_CHANGED',
          title: 'Grok model changed',
          message: model ? `Grok switched to ${model}.` : 'Grok changed the active model.',
        },
      },
    ];
  }
  if (/subagent|background|monitor|workflow|goal/.test(normalized)) {
    const status = /fail/.test(normalized)
      ? 'failed'
      : /finish|done|complete/.test(normalized)
        ? 'completed'
        : 'running';
    return [{
      method: 'agent.updated',
      data: {
        agentId: String(payload.agentId ?? payload.id ?? name),
        status,
        description: String(payload.description ?? payload.title ?? name),
      },
    }];
  }
  if (/memory|flush|dream|session[_-]?saved/.test(normalized)) {
    return [{
      method: 'notice.created',
      data: {
        noticeId: `grok-${name}`,
        severity: 'info',
        code: 'GROK_SESSION_NOTICE',
        title: name,
        message: String(payload.message ?? name),
      },
    }];
  }
  if (/image/.test(normalized) && /compress|drop/.test(normalized)) {
    return [{
      method: 'notice.created',
      data: {
        noticeId: `grok-${name}`,
        severity: 'warning',
        code: 'GROK_IMAGE_DROPPED',
        title: 'A Grok image input was compressed or dropped',
        message: String(payload.message ?? 'Grok could not keep the original image payload.'),
      },
    }];
  }
  if (/hook/.test(normalized)) {
    const events: TranslatedEvent[] = [{
      method: 'extension.event',
      data: {
        namespace: 'grok',
        name,
        schemaVersion: 1,
        payload,
      },
    }];
    if (/error|fail/.test(normalized)) {
      events.push({
        method: 'notice.created',
        data: {
          noticeId: `grok-${name}`,
          severity: 'error',
          code: 'GROK_HOOK_FAILED',
          title: 'Grok hook failed',
          message: String(payload.message ?? name),
        },
      });
    }
    return events;
  }
  if (/recap|summary/.test(normalized)) {
    return [{
      method: 'extension.event',
      data: {
        namespace: 'grok',
        name,
        schemaVersion: 1,
        payload,
      },
    }];
  }

  return [{
    method: 'extension.event',
    data: {
      namespace: 'grok',
      name,
      schemaVersion: 1,
      payload,
    },
  }];
}
