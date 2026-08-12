import type { DisplayEvent, FileChangeSummary } from '@gian/shared';
import type { ProxyNotification } from '@gian/proxy-protocol';

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function protocolCategory(value: string) {
  switch (value) {
    case 'command': return 'command' as const;
    case 'network': return 'network' as const;
    case 'file_write':
    case 'file_write_outside_ws': return 'file_write_outside_ws' as const;
    case 'exit_plan_mode': return 'exit_plan_mode' as const;
    case 'question': return 'question' as const;
    default: return 'other' as const;
  }
}

function diffFiles(
  files: Array<{ path: string; status: string }> | undefined,
  diff: string,
): FileChangeSummary[] {
  if (files) {
    return files.map(file => ({
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
  return [...paths].map(path => ({ path, kind: 'update' as const }));
}

export function projectProtocolV1Notification(
  notification: ProxyNotification,
  sessionId: string,
  turn: number,
): DisplayEvent[] {
  if (!('sessionId' in notification.params)) return [];
  // The union is runtime-validated before projection. Zod's nested union does
  // not preserve method -> params.data narrowing through this shared helper.
  const data = notification.params.data as any;
  const ts = timestamp(notification.params.emittedAt);
  const turnId = 'turnId' in notification.params
    ? notification.params.turnId
    : null;

  switch (notification.method) {
    case 'content.delta':
    case 'content.completed': {
      const delta = notification.method === 'content.delta';
      const text = delta ? data.delta : data.content ?? '';
      if (!text) return [];
      if (data.kind === 'text') {
        return [{
          session_id: sessionId,
          turn,
          call_id: data.contentId,
          ts,
          type: 'message',
          data: { text, delta, itemId: data.contentId },
        }];
      }
      if (data.kind === 'reasoning') {
        return [{
          session_id: sessionId,
          turn,
          call_id: data.contentId,
          ts,
          type: 'activity.reasoning',
          data: { text, delta, itemId: data.contentId, kind: 'full' },
        }];
      }
      if (data.kind === 'plan') {
        return [{
          session_id: sessionId,
          turn,
          call_id: data.contentId,
          ts,
          type: 'plan',
          data: { text, delta },
        }];
      }
      if (data.kind === 'command') {
        return [{
          session_id: sessionId,
          turn,
          call_id: data.contentId,
          ts,
          type: 'activity.command',
          data: {
            command: '',
            status: delta ? 'running' : 'success',
            ...(delta ? { stdoutDelta: text } : { stdout: text }),
            itemId: data.contentId,
          },
        }];
      }
      return [];
    }
    case 'tool.started':
      return [{
        session_id: sessionId,
        turn,
        call_id: data.toolCallId,
        ts,
        type: 'activity.tool',
        data: {
          itemId: data.toolCallId,
          title: data.title ?? data.name,
          kind: data.name,
          status: 'running',
          input: data.input,
        },
      }];
    case 'tool.updated':
      return [{
        session_id: sessionId,
        turn,
        call_id: data.toolCallId,
        ts,
        type: 'activity.tool',
        data: {
          itemId: data.toolCallId,
          title: data.statusText ?? 'Tool',
          status: 'running',
          output: data.data ?? data.outputDelta,
        },
      }];
    case 'tool.completed':
      return [{
        session_id: sessionId,
        turn,
        call_id: data.toolCallId,
        ts,
        type: 'activity.tool',
        data: {
          itemId: data.toolCallId,
          title: 'Tool',
          status: data.status === 'succeeded' ? 'success' : 'error',
          output: data.output ?? data.error?.message,
        },
      }];
    case 'plan.updated':
      return [{
        session_id: sessionId,
        turn,
        call_id: data.planId,
        ts,
        type: 'plan',
        data: {
          text: [data.title, ...data.steps.map((step: { status: string; text: string }) => (
            `- [${step.status === 'completed' ? 'x' : ' '}] ${step.text}`
          ))].filter(Boolean).join('\n'),
          delta: false,
        },
      }];
    case 'diff.updated':
      return [{
        session_id: sessionId,
        turn,
        call_id: data.diffId,
        ts,
        type: 'activity.file-change',
        data: { files: diffFiles(data.files, data.diff), diff: data.diff },
      }];
    case 'agent.updated':
      return [{
        session_id: sessionId,
        turn,
        call_id: data.agentId,
        ts,
        type: 'agent',
        data: {
          agentId: data.agentId,
          description: data.description,
          status: data.status === 'completed'
            ? 'done'
            : data.status === 'running' ? 'running' : 'error',
          agentType: data.agentType,
          model: data.model,
          output: data.output,
        },
      }];
    case 'notice.created':
      return [{
        session_id: sessionId,
        turn,
        call_id: data.noticeId,
        ts,
        type: 'activity.notice',
        data: {
          severity: data.severity,
          code: data.code,
          title: data.title,
          message: data.message,
        },
      }];
    case 'approval.requested': {
      const nativeOptions = data.options.map((option: {
        id: string;
        label: string;
        kind: string;
      }) => ({
        optionId: option.id,
        label: option.label,
        kind: option.kind,
      }));
      return [{
        session_id: sessionId,
        turn,
        call_id: data.approvalId,
        ts,
        type: protocolCategory(data.category) === 'question'
          ? 'interaction.question'
          : 'interaction.approval',
        data: {
          approvalId: data.approvalId,
          category: protocolCategory(data.category),
          risk: 'medium',
          title: data.title,
          description: data.description,
          scopeOptions: [
            ...(data.options.some((option: { kind: string }) => option.kind === 'allow_once') ? ['once' as const] : []),
            ...(data.options.some((option: { kind: string }) => option.kind === 'allow_session') ? ['session' as const] : []),
          ],
          nativeOptions,
        },
      }];
    }
    case 'approval.resolved': {
      const option = data.optionId ?? '';
      return [{
        session_id: sessionId,
        turn,
        call_id: data.approvalId,
        ts,
        type: 'interaction.resolved',
        data: {
          approvalId: data.approvalId,
          decision: option === 'allow_session' || option === 'allow_always'
            ? 'allow_session'
            : option === 'allow_once' ? 'allow_once' : 'decline',
          auto: data.resolvedBy !== 'user',
          nativeOptionId: data.optionId ?? null,
        },
      }];
    }
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
        data: { turnId },
      }] : [];
    case 'turn.failed':
      return turnId ? [{
        session_id: sessionId,
        turn,
        call_id: turnId,
        ts,
        type: 'state.error',
        data: {
          message: data.error.message,
          retryable: data.error.retryable,
          code: data.error.code,
        },
      }] : [];
    case 'runtime.error':
      return [{
        session_id: sessionId,
        turn,
        call_id: notification.params.eventId,
        ts,
        type: 'state.error',
        data: {
          message: data.message,
          retryable: data.retryable,
          code: data.code,
        },
      }];
    default:
      return [];
  }
}
