import type {
  FileChangeSummary,
  NativeApprovalOption,
  ProxyNotification,
  ToolExecutionData,
  UnifiedEvent,
} from '@gian/shared';

function event<T extends UnifiedEvent['type']>(
  sessionId: string,
  turn: number,
  callId: string,
  type: T,
  data: UnifiedEvent<T>['data'],
): UnifiedEvent {
  return {
    session_id: sessionId,
    turn,
    call_id: callId,
    ts: Date.now(),
    type,
    data,
  } as UnifiedEvent;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function contentText(value: unknown): string {
  const content = record(value);
  return content.type === 'text' && typeof content.text === 'string'
    ? content.text
    : '';
}

function toolStatus(value: unknown): ToolExecutionData['status'] {
  switch (value) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'failed':
      return 'error';
    case 'completed':
    default:
      return 'success';
  }
}

function nativeOptions(value: unknown): NativeApprovalOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(option => {
    const item = record(option);
    if (typeof item.optionId !== 'string' || typeof item.name !== 'string') return [];
    return [{
      optionId: item.optionId,
      label: item.name,
      kind: typeof item.kind === 'string' ? item.kind : 'unknown',
    }];
  });
}

function planText(update: Record<string, unknown>): string {
  if (typeof update.text === 'string') return update.text;
  if (!Array.isArray(update.entries)) return '';
  return update.entries.map(entry => {
    const item = record(entry);
    const content = String(item.content ?? item.title ?? '');
    const status = String(item.status ?? 'pending');
    const mark = status === 'completed' ? 'x' : ' ';
    return `- [${mark}] ${content}`;
  }).join('\n');
}

interface KimiAgentOutput {
  agentId?: string;
  taskId?: string;
  agentType?: string;
  status?: 'running' | 'done' | 'error';
  body?: string;
}

/**
 * Kimi's Agent tool returns a provider-native header followed by an optional
 * `[summary]` block. The outer ACP tool can report `completed` while a
 * background child is still running, so the child header is authoritative.
 */
function parseAgentOutput(value: unknown): KimiAgentOutput {
  if (typeof value !== 'string' || !value.trim()) return {};
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const parsed: KimiAgentOutput = {};
  const body: string[] = [];
  let sawHeader = false;

  for (const line of lines) {
    const header = /^(task_id|agent_id|actual_subagent_type|status)\s*:\s*(.*?)\s*$/i.exec(line);
    if (header) {
      sawHeader = true;
      const key = header[1]!.toLowerCase();
      const v = header[2]!;
      if (key === 'task_id' && v) parsed.taskId = v;
      else if (key === 'agent_id' && v) parsed.agentId = v;
      else if (key === 'actual_subagent_type' && v) parsed.agentType = v;
      else if (key === 'status') {
        const status = v.toLowerCase();
        parsed.status =
          status === 'running' || status === 'pending' ? 'running'
          : status === 'failed' || status === 'error' ? 'error'
          : status === 'completed' || status === 'done' || status === 'success' ? 'done'
          : undefined;
      }
      continue;
    }
    if (/^\s*\[summary\]\s*$/i.test(line)) {
      sawHeader = true;
      continue;
    }
    body.push(line);
  }

  const cleaned = body.join('\n').trim();
  if (cleaned && (!sawHeader || parsed.status !== 'running')) parsed.body = cleaned;
  return parsed;
}

function kimiAgentDescription(input: Record<string, unknown>, title: string): string {
  for (const value of [input.description, input.task, input.title]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const launched = /^Launching\s+\S+\s+agent\s*:\s*(.+)$/i.exec(title);
  if (launched?.[1]) return launched[1].trim();
  if (typeof input.prompt === 'string' && input.prompt.trim()) {
    return input.prompt.trim().split('\n')[0]!.slice(0, 180);
  }
  return title || 'Agent';
}

function normalizeTool(
  update: Record<string, unknown>,
  sessionId: string,
  turn: number,
): UnifiedEvent[] {
  const itemId = String(update.toolCallId ?? crypto.randomUUID());
  const kind = typeof update.kind === 'string' ? update.kind : 'other';
  const title = typeof update.title === 'string' ? update.title : 'Tool';
  const input = record(update.rawInput);
  const locations = Array.isArray(update.locations)
    ? update.locations.flatMap(location => {
        const item = record(location);
        if (typeof item.path !== 'string') return [];
        return [{
          path: item.path,
          ...(typeof item.line === 'number' ? { line: item.line } : {}),
        }];
      })
    : [];
  const status = toolStatus(update.status);

  if (isAgentTool(title, kind, input)) {
    const child = parseAgentOutput(update.rawOutput);
    const agentStatus =
      child.status
      ?? (status === 'error' ? 'error' : status === 'success' ? 'done' : 'running');
    return [event(sessionId, turn, itemId, 'agent_spawn', {
      agentId:
        child.agentId
        ?? (typeof input.agent_id === 'string' ? input.agent_id : undefined)
        ?? (typeof input.agentId === 'string' ? input.agentId : undefined),
      taskId:
        child.taskId
        ?? (typeof input.task_id === 'string' ? input.task_id : undefined),
      description: kimiAgentDescription(input, title),
      status: agentStatus,
      agentType: child.agentType
        ?? (typeof input.subagent_type === 'string'
        ? input.subagent_type
        : typeof input.agent_type === 'string' ? input.agent_type : undefined),
      ...(typeof input.run_in_background === 'boolean'
        ? { background: input.run_in_background }
        : {}),
      ...(child.body ? { output: child.body } : {}),
      ...(Object.keys(input).length > 0 ? { input } : {}),
    })];
  }

  if (kind === 'execute') {
    return [event(sessionId, turn, itemId, 'command_execution', {
      command: typeof input.command === 'string' ? input.command : title,
      status: status === 'running' || status === 'pending'
        ? 'running'
        : status === 'error' ? 'error' : 'success',
      ...(typeof update.rawOutput === 'string' ? { stdout: update.rawOutput } : {}),
      itemId,
    })];
  }
  if (kind === 'read' && locations[0]) {
    return [event(sessionId, turn, itemId, 'file_read', {
      path: locations[0].path,
      ...(locations[0].line ? { startLine: locations[0].line } : {}),
    })];
  }
  if (kind === 'search') {
    return [event(sessionId, turn, itemId, 'file_search', {
      pattern: String(input.pattern ?? input.query ?? title),
      kind: typeof input.glob === 'string' ? 'glob' : 'grep',
    })];
  }
  if (kind === 'fetch') {
    return [event(sessionId, turn, itemId, 'web_search', {
      query: String(input.query ?? input.url ?? title),
    })];
  }
  if ((kind === 'edit' || kind === 'delete' || kind === 'move') && locations.length > 0) {
    const files: FileChangeSummary[] = locations.map(location => ({
      path: location.path,
      kind: kind === 'delete' ? 'delete' : 'update',
    }));
    return [event(sessionId, turn, itemId, 'file_change', { files })];
  }

  return [event(sessionId, turn, itemId, 'tool_execution', {
    itemId,
    title,
    kind,
    status,
    ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
    ...(locations.length > 0 ? { locations } : {}),
  })];
}

export function normalizeKimiNotification(
  raw: ProxyNotification,
  sessionId: string,
  turn: number,
): UnifiedEvent[] {
  const data = record(raw.params?.data);
  if (raw.method === 'acp.sessionUpdate') {
    const update = record(data.update);
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = contentText(update.content);
      if (!text) return [];
      const itemId = String(update._meta && record(update._meta).itemId || raw.params.turnId || 'kimi-message');
      return [event(sessionId, turn, itemId, 'assistant_text', {
        text,
        delta: true,
        itemId,
      })];
    }
    if (kind === 'agent_thought_chunk') {
      const text = contentText(update.content);
      if (!text) return [];
      const itemId = String(raw.params.turnId ?? 'kimi-thought');
      return [event(sessionId, turn, itemId, 'reasoning', {
        text,
        delta: true,
        itemId,
        kind: 'full',
      })];
    }
    if (kind === 'plan' || kind === 'plan_update') {
      return [event(sessionId, turn, 'kimi-plan', 'plan_update', {
        text: planText(update),
        delta: kind === 'plan_update',
      })];
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      return normalizeTool(update, sessionId, turn);
    }
    return [];
  }

  if (raw.method === 'approval.requested') {
    const approvalId = String(data.approvalId ?? crypto.randomUUID());
    const options = nativeOptions(data.nativeOptions);
    const payload = record(data.payload);
    const toolCall = record(payload.toolCall);
    const input = record(toolCall.rawInput);
    const toolTitle = String(toolCall.title ?? data.title ?? '');
    const isPlanApproval = toolTitle === 'ExitPlanMode';
    const plan = String(input.plan ?? input.content ?? '').trim();
    return [event(sessionId, turn, approvalId, 'approval_requested', {
      approvalId,
      category: isPlanApproval ? 'exit_plan_mode' : 'other',
      risk: data.severity === 'high' ? 'high' : data.severity === 'low' ? 'low' : 'medium',
      title: String(data.title ?? 'Kimi permission'),
      description: String(data.reason ?? data.title ?? 'Kimi requested a decision.'),
      ...(isPlanApproval && plan ? { subject: plan } : {}),
      scopeOptions: [],
      nativeOptions: options,
    })];
  }

  if (raw.method === 'approval.resolved') {
    const approvalId = String(data.approvalId ?? '');
    return [event(sessionId, turn, approvalId || crypto.randomUUID(), 'approval_resolved', {
      approvalId,
      decision: data.cancelled ? 'decline' : 'allow_once',
      auto: false,
      nativeOptionId: typeof data.nativeOptionId === 'string' ? data.nativeOptionId : null,
    })];
  }

  if (raw.method === 'turn.started') {
    const turnId = String(data.turnId ?? raw.params.turnId ?? crypto.randomUUID());
    return [event(sessionId, turn, turnId, 'turn_started', { turnId })];
  }
  if (raw.method === 'turn.completed') {
    const turnId = String(data.turnId ?? raw.params.turnId ?? crypto.randomUUID());
    return [event(sessionId, turn, turnId, 'turn_completed', { turnId })];
  }
  if (raw.method === 'turn.failed' || raw.method === 'runtime.error') {
    return [event(sessionId, turn, String(raw.params.turnId ?? crypto.randomUUID()), 'session_error', {
      message: String(data.message ?? 'Kimi runtime failed.'),
      retryable: true,
      ...(data.code != null ? { code: String(data.code) } : {}),
    })];
  }
  // The proxy emits a turn.failed notification for every active turn before
  // this process-wide marker. Idle sessions reattach lazily, so there is no
  // transcript event to synthesize for runtime.stopped itself.
  if (raw.method === 'runtime.stopped') return [];
  return [];
}

function isAgentTool(
  title: string,
  kind: string,
  input: Record<string, unknown>,
): boolean {
  const normalized = title.trim().toLowerCase();
  return kind.toLowerCase() === 'agent'
    || normalized === 'agent'
    || normalized.startsWith('agent:')
    || normalized.startsWith('agent ')
    || typeof input.subagent_type === 'string'
    || typeof input.agent_type === 'string';
}
