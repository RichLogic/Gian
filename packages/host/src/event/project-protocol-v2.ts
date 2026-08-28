import type { DisplayEvent, FileChangeSummary } from '@gian/shared';
import { INTERACTION_KINDS, PRESENTATION_TONES, type ProxyNotification } from '@gian/proxy-protocol';

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function activityStatus(status: string): 'running' | 'success' | 'error' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'running';
}

function turnCompletionStatus(stopReason: unknown): 'completed' | 'stopped' {
  return stopReason === 'interrupted' || stopReason === 'cancelled'
    ? 'stopped'
    : 'completed';
}

function diffFiles(
  files: Array<{ path: string; status: string }> | undefined,
  diff: string,
): FileChangeSummary[] {
  if (files) {
    return files.map((file) => ({
      path: file.path,
      kind: file.status === 'added'
        ? 'create'
        : file.status === 'deleted' ? 'delete' : 'update',
    }));
  }
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)) {
    if (match[1] && match[1] !== '/dev/null') paths.add(match[1]);
  }
  return [...paths].map((path) => ({ path, kind: 'update' as const }));
}

function projectActivity(
  data: Record<string, unknown>,
  sessionId: string,
  turn: number,
  ts: number,
): DisplayEvent[] {
  const activityId = String(data.activityId ?? '');
  const presentation = asRecord(data.presentation);
  const presentationData = asRecord(presentation.data);
  const type = typeof presentation.type === 'string' ? presentation.type : 'generic';
  const status = activityStatus(String(data.status ?? 'running'));
  const title = String(data.title ?? type);
  const summary = typeof data.summary === 'string' ? data.summary : undefined;

  if (type === 'command') {
    return [{
      session_id: sessionId,
      turn,
      call_id: activityId,
      ts,
      type: 'activity.command',
      data: {
        command: String(presentationData.command ?? title),
        status,
        itemId: activityId,
        ...(summary ? { stdout: summary } : {}),
      },
    }];
  }
  if (type === 'file') {
    const operation = String(presentationData.operation ?? 'write');
    if (operation === 'read') {
      return [{
        session_id: sessionId,
        turn,
        call_id: activityId,
        ts,
        type: 'activity.file-read',
        data: {
          path: String(presentationData.path ?? ''),
        },
      }];
    }
    return [{
      session_id: sessionId,
      turn,
      call_id: activityId,
      ts,
      type: 'activity.file-change',
      data: {
        files: [{
          path: String(presentationData.path ?? ''),
          kind: operation === 'delete' ? 'delete' : 'update',
        }],
      },
    }];
  }
  if (type === 'search') {
    return [{
      session_id: sessionId,
      turn,
      call_id: activityId,
      ts,
      type: 'activity.web-search',
        data: {
          query: String(presentationData.query ?? title),
        },
    }];
  }
  if (type === 'agent') {
    const state = String(presentationData.state ?? 'running');
    return [{
      session_id: sessionId,
      turn,
      call_id: activityId,
      ts,
      type: 'agent',
      data: {
        agentId: String(presentationData.agentId ?? activityId),
        description: title,
        status: state === 'completed' ? 'done' : state === 'running' ? 'running' : 'error',
        ...(typeof presentationData.displayName === 'string'
          ? { agentType: presentationData.displayName }
          : {}),
        ...(typeof presentationData.output === 'string' ? { output: presentationData.output } : {}),
      },
    }];
  }
  if (type === 'notice') {
    return [{
      session_id: sessionId,
      turn,
      call_id: activityId,
      ts,
      type: 'activity.notice',
      data: {
        severity: presentation.tone === 'danger'
          ? 'error' as const
          : presentation.tone === 'warning' ? 'warning' as const : 'info' as const,
        code: typeof presentationData.code === 'string' ? presentationData.code : type,
        title,
        message: String(presentationData.message ?? summary ?? title),
      },
    }];
  }
  return [{
    session_id: sessionId,
    turn,
    call_id: activityId,
    ts,
    type: 'activity.tool',
    data: {
      itemId: activityId,
      title,
      kind: String(presentationData.name ?? data.kind ?? type),
      status,
      ...(presentationData.input !== undefined ? { input: presentationData.input } : {}),
      ...(presentationData.output !== undefined ? { output: presentationData.output } : {}),
      ...(summary && presentationData.output === undefined ? { output: summary } : {}),
    },
  }];
}

function projectInteractionRequested(
  data: Record<string, unknown>,
  sessionId: string,
  turn: number,
  ts: number,
): DisplayEvent[] {
  const presentation = asRecord(data.presentation);
  const kind = typeof presentation.kind === 'string' ? presentation.kind : 'question';
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const inputs = Array.isArray(data.inputs) ? data.inputs : [];
  const protocolActions = actions
    .filter((action): action is Record<string, unknown> => (
      Boolean(action) && typeof action === 'object' && !Array.isArray(action)
    ))
    .map((action) => {
      const style: 'primary' | 'secondary' | 'danger' = action.style === 'primary' || action.style === 'danger'
        ? action.style
        : 'secondary';
      return {
        id: String(action.id ?? ''),
        label: String(action.label ?? action.id ?? ''),
        style,
      };
    });
  const protocolInputs = inputs
    .filter((input): input is Record<string, unknown> => (
      Boolean(input) && typeof input === 'object' && !Array.isArray(input)
    ))
    .map((input) => ({
      id: String(input.id ?? ''),
      type: (input.type === 'multiline_text'
        || input.type === 'single_select'
        || input.type === 'multi_select'
        || input.type === 'boolean'
        ? input.type
        : 'text') as 'text' | 'multiline_text' | 'single_select' | 'multi_select' | 'boolean',
      label: String(input.label ?? input.id ?? ''),
      required: input.required === true,
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      ...(typeof input.sensitive === 'boolean' ? { sensitive: input.sensitive } : {}),
      ...(typeof input.placeholder === 'string' ? { placeholder: input.placeholder } : {}),
      ...(typeof input.multiline === 'boolean' ? { multiline: input.multiline } : {}),
      ...(Array.isArray(input.choices) ? { choices: input.choices } : {}),
    }));
  const nativeOptions = protocolActions.map((action) => ({
    optionId: action.id,
    label: action.label,
    kind: action.id || 'other',
  }));
  // §12 rendering hints: pass the presentation kind/tone through verbatim
  // (whitelisted) so the web card can label and tint itself instead of
  // re-deriving them from the flattened event type/risk.
  const interactionKind = (INTERACTION_KINDS as readonly string[]).includes(kind)
    ? kind as 'question' | 'choice' | 'confirmation' | 'permission'
    : undefined;
  const tone = typeof presentation.tone === 'string'
    && (PRESENTATION_TONES as readonly string[]).includes(presentation.tone)
    ? presentation.tone as 'neutral' | 'info' | 'warning' | 'danger'
    : undefined;
  // cc-proxy sends context.subject = { toolName, inputPreview }; flatten it
  // to "toolName\ninputPreview" so the web's cmd fallback (data.subject)
  // picks it up. A plain-string subject passes through as-is.
  const rawSubject = asRecord(data.context).subject;
  let subject: string | undefined;
  if (typeof rawSubject === 'string') {
    subject = rawSubject;
  } else if (rawSubject && typeof rawSubject === 'object' && !Array.isArray(rawSubject)) {
    const subjectRecord = rawSubject as Record<string, unknown>;
    const toolName = typeof subjectRecord.toolName === 'string' ? subjectRecord.toolName : '';
    const inputPreview = typeof subjectRecord.inputPreview === 'string' ? subjectRecord.inputPreview : '';
    if (toolName) subject = inputPreview ? `${toolName}\n${inputPreview}` : toolName;
  }
  return [{
    session_id: sessionId,
    turn,
    call_id: String(data.interactionId ?? ''),
    ts,
    type: kind === 'permission' ? 'interaction.approval' : 'interaction.question',
    data: {
      approvalId: String(data.interactionId ?? ''),
      category: kind === 'permission' ? 'other' : 'question',
      risk: presentation.tone === 'danger' ? 'high' : presentation.tone === 'warning' ? 'medium' : 'low',
      title: String(data.title ?? (kind === 'permission' ? 'Permission required' : 'Question')),
      description: String(data.description ?? ''),
      scopeOptions: ['once'] as Array<'once' | 'session'>,
      nativeOptions,
      ...(interactionKind ? { interactionKind } : {}),
      ...(tone ? { tone } : {}),
      ...(subject ? { subject } : {}),
      ...(protocolActions.length > 0 ? { actions: protocolActions } : {}),
      ...(protocolInputs.length > 0 ? { inputs: protocolInputs } : {}),
    },
  }];
}

export function projectProtocolV2Notification(
  notification: ProxyNotification,
  sessionId: string,
  turn: number,
): DisplayEvent[] {
  if (!('sessionId' in notification.params) && notification.method !== 'catalog.changed') {
    return [];
  }
  const data = asRecord('data' in notification.params ? notification.params.data : {});
  const ts = timestamp(
    'emittedAt' in notification.params ? notification.params.emittedAt : new Date().toISOString(),
  );
  const turnId = 'turnId' in notification.params ? notification.params.turnId : null;

  switch (notification.method) {
    case 'content.delta':
    case 'content.completed': {
      const delta = notification.method === 'content.delta';
      const text = delta ? String(data.delta ?? '') : String(data.content ?? '');
      if (!text) return [];
      if (data.kind === 'text') {
        return [{
          session_id: sessionId,
          turn,
          call_id: String(data.contentId ?? ''),
          ts,
          type: 'message',
          data: { text, delta, itemId: String(data.contentId ?? '') },
        }];
      }
      if (data.kind === 'reasoning') {
        return [{
          session_id: sessionId,
          turn,
          call_id: String(data.contentId ?? ''),
          ts,
          type: 'activity.reasoning',
          data: { text, delta, itemId: String(data.contentId ?? ''), kind: 'full' },
        }];
      }
      if (data.kind === 'status') {
        return [{
          session_id: sessionId,
          turn,
          call_id: String(data.contentId ?? ''),
          ts,
          type: 'activity.notice',
          data: { severity: 'info', code: 'status', title: 'Status', message: text },
        }];
      }
      return [];
    }
    case 'activity.updated':
      return projectActivity(data, sessionId, turn, ts);
    case 'interaction.requested':
      return projectInteractionRequested(data, sessionId, turn, ts);
    case 'interaction.resolved':
      return [{
        session_id: sessionId,
        turn,
        call_id: String(data.interactionId ?? ''),
        ts,
        type: 'interaction.resolved',
        data: {
          approvalId: String(data.interactionId ?? ''),
          decision: data.outcome === 'submitted' ? 'allow_once' : 'decline',
          auto: data.outcome !== 'submitted',
          nativeOptionId: typeof data.actionId === 'string' ? data.actionId : null,
          ...(typeof data.displaySummary === 'string' ? { answers: { summary: data.displaySummary } } : {}),
        },
      }];
    case 'plan.updated': {
      const steps = Array.isArray(data.steps) ? data.steps : [];
      return [{
        session_id: sessionId,
        turn,
        call_id: String(data.planId ?? ''),
        ts,
        type: 'plan',
        data: {
          text: [
            data.title,
            ...steps.map((step) => {
              const row = asRecord(step);
              return `- [${row.status === 'completed' ? 'x' : ' '}] ${String(row.text ?? '')}`;
            }),
          ].filter(Boolean).join('\n'),
          delta: false,
        },
      }];
    }
    case 'diff.updated':
      return [{
        session_id: sessionId,
        turn,
        call_id: String(data.diffId ?? ''),
        ts,
        type: 'activity.file-change',
        data: {
          files: diffFiles(
            Array.isArray(data.files) ? data.files as Array<{ path: string; status: string }> : undefined,
            String(data.diff ?? ''),
          ),
          diff: String(data.diff ?? ''),
        },
      }];
    case 'step.updated':
    case 'request.updated':
      // Trace-only execution evidence; neither event belongs in the transcript.
      return [];
    case 'turn.started':
      return turnId ? [{
        session_id: sessionId,
        turn,
        call_id: turnId,
        ts,
        type: 'state.turn-started',
        data: { turnId },
      }] : [];
    case 'turn.completed':
      return turnId ? [{
        session_id: sessionId,
        turn,
        call_id: turnId,
        ts,
        type: 'state.turn-completed',
        data: {
          turnId,
          sourceTurnId: notification.params.sourceTurnId,
          status: turnCompletionStatus(data.stopReason),
        },
      }] : [];
    case 'turn.failed':
    case 'runtime.error': {
      const error = notification.method === 'turn.failed' ? asRecord(data.error) : data;
      return [{
        session_id: sessionId,
        turn,
        call_id: turnId ?? String(error.domainCode ?? 'runtime'),
        ts,
        type: 'state.error',
        data: {
          message: String(error.message ?? 'Runtime error'),
          retryable: error.retryable === true,
          code: String(error.domainCode ?? error.code ?? 'INTERNAL'),
        },
      }];
    }
    default:
      return [];
  }
}
