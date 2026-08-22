import type { DisplayEvent, FileChangeSummary } from '@gian/shared';
import {
  ccApprovalDescription,
  ccApprovalSubject,
  parseAskUserQuestionInput,
  parseCcApprovalInput,
} from './normalize-cc.js';

/** Persisted gian.proxy/1 envelopes. Not the live 2.0 notification union. */
interface HistoricalProtocolNotification {
  method: string;
  params: {
    eventId?: string;
    streamId?: string;
    sequence?: number;
    sessionId?: string;
    turnId?: string;
    emittedAt: string;
    data?: unknown;
  };
}

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
  notification: HistoricalProtocolNotification,
  sessionId: string,
  turn: number,
): DisplayEvent[] {
  if (!('sessionId' in notification.params) || !notification.params.sessionId) return [];
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
      if (!data?.toolCallId) return [];
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
      if (!data?.toolCallId) return [];
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
      if (!data?.toolCallId) return [];
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
      if (!Array.isArray(data?.steps)) return [];
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
      if (!Array.isArray(data?.options)) return [];
      const nativeOptions = data.options.map((option: {
        id: string;
        label: string;
        kind: string;
      }) => ({
        optionId: option.id,
        label: option.label,
        kind: option.kind,
      }));
      const category = protocolCategory(data.category);
      const scopeOptions = [
        ...(data.options.some((option: { kind: string }) => option.kind === 'allow_once') ? ['once' as const] : []),
        ...(data.options.some((option: { kind: string }) => option.kind === 'allow_session') ? ['session' as const] : []),
      ];

      // cc-proxy rides its tool identity on payload.{toolName,inputPreview}
      // (kimi/grok payloads carry different shapes — they keep the generic
      // path below). Reuse the legacy cc parser so the live protocol-v1 card
      // matches what the JSONL replay path produces: structured questions for
      // AskUserQuestion, plan subject + three-way actions for ExitPlanMode.
      const payload = data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload)
        ? data.payload as Record<string, unknown>
        : {};
      const toolName = typeof payload['toolName'] === 'string' ? payload['toolName'] : '';
      const inputPreview = typeof payload['inputPreview'] === 'string' ? payload['inputPreview'] : undefined;

      if (toolName || inputPreview) {
        const parsedQuestions = parseAskUserQuestionInput(inputPreview);
        if (toolName === 'AskUserQuestion' || parsedQuestions.length > 0) {
          const firstQuestion = parsedQuestions[0]?.question?.trim();
          return [{
            session_id: sessionId,
            turn,
            call_id: data.approvalId,
            ts,
            type: 'interaction.question',
            data: {
              approvalId: data.approvalId,
              category: 'question',
              risk: 'low',
              title: firstQuestion || 'Claude is asking you a question',
              description: '',
              scopeOptions: ['once'],
              ...(toolName ? { toolName } : {}),
              questions: parsedQuestions,
            },
          }];
        }

        const parsedInput = parseCcApprovalInput(inputPreview);
        const subject = ccApprovalSubject(toolName, parsedInput);
        const description = ccApprovalDescription(toolName, parsedInput) ?? data.description;
        return [{
          session_id: sessionId,
          turn,
          call_id: data.approvalId,
          ts,
          type: category === 'question' ? 'interaction.question' : 'interaction.approval',
          data: {
            approvalId: data.approvalId,
            category,
            risk: 'medium',
            title: category === 'exit_plan_mode' ? 'Plan ready for review' : data.title,
            description,
            ...(subject ? { subject } : {}),
            // cc has no native session scope; offer it only for the
            // categories the ApprovalManager can allowlist, same as the
            // legacy normalize-cc path.
            scopeOptions: category === 'command' || category === 'file_write_outside_ws' || category === 'network'
              ? scopeOptions
              : ['once' as const],
            nativeOptions,
            ...(category === 'exit_plan_mode'
              ? { planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'] as const }
              : {}),
            ...(toolName ? { toolName } : {}),
          },
        }];
      }

      // grok-proxy rides the command identity inside payload.{rawInput,_meta,title}
      // (cc-proxy rides payload.{toolName,inputPreview} handled above). Surface
      // it as `subject` so the pending card shows what is being approved;
      // fall back to the payload description for the card's supporting text.
      const rawInput = payload.rawInput && typeof payload.rawInput === 'object'
        ? payload.rawInput as Record<string, unknown>
        : {};
      const toolMeta = payload._meta && typeof payload._meta === 'object'
        ? payload._meta as Record<string, unknown>
        : {};
      const toolInput = toolMeta['x.ai/tool'] && typeof toolMeta['x.ai/tool'] === 'object'
        ? (toolMeta['x.ai/tool'] as Record<string, unknown>).input
        : undefined;
      const toolInputRecord = toolInput && typeof toolInput === 'object'
        ? toolInput as Record<string, unknown>
        : {};
      const subject = String(
        rawInput.command
        ?? toolInputRecord.command
        ?? payload.title
        ?? '',
      );
      const description = String(
        rawInput.description
        ?? toolInputRecord.description
        ?? payload.description
        ?? data.description,
      );

      return [{
        session_id: sessionId,
        turn,
        call_id: data.approvalId,
        ts,
        type: category === 'question'
          ? 'interaction.question'
          : 'interaction.approval',
        data: {
          approvalId: data.approvalId,
          category,
          risk: 'medium',
          title: data.title,
          description,
          ...(subject ? { subject } : {}),
          scopeOptions,
          nativeOptions,
        },
      }];
    }
    case 'approval.resolved': {
      const option = data.optionId ?? '';
      // AskUserQuestion answers ride along (optional additive field) so the
      // resolved question card can show what was picked, matching the replay
      // path.
      const answers = data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers)
        ? data.answers as Record<string, string | string[]>
        : undefined;
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
          ...(answers ? { answers } : {}),
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
      if (!data?.error || typeof data.error.message !== 'string') return [];
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
      if (typeof data?.message !== 'string' || !notification.params.eventId) return [];
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
