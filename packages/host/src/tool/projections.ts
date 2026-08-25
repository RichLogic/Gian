import type {
  ApprovalRequestedData,
  AskQuestion,
  ConfigOption,
  EventEnvelope,
  GianToolInteraction,
  GianToolMessage,
  GianToolTurnInteraction,
  InteractionInput,
  NativeApprovalOption,
  Session,
} from '@gian/shared';
import type { ApprovalRecord } from '../approval/manager.js';

function payloadArray<T>(record: ApprovalRecord, key: string): T[] {
  const value = record.payload?.[key];
  return Array.isArray(value) ? value as T[] : [];
}

export function projectInteraction(record: ApprovalRecord): GianToolInteraction {
  const questions = payloadArray<AskQuestion>(record, 'questions').map((question) => ({
    id: question.question,
    prompt: question.question,
    multiple: question.multiSelect,
    input_type: question.multiSelect ? 'multi_select' as const : 'single_select' as const,
    options: question.options.map(option => ({
      value: option.label,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  }));
  const inputs = payloadArray<InteractionInput>(record, 'inputs').map((input) => ({
    id: input.id,
    prompt: input.label,
    multiple: input.type === 'multi_select',
    input_type: input.type,
    options: (input.choices ?? []).map(choice => ({
      value: choice.value,
      label: choice.displayName,
    })),
  }));
  const planActions = payloadArray<string>(record, 'planActions');
  const scopeOptions = payloadArray<string>(record, 'scopeOptions');
  const nativeOptions = record.nativeOptions ?? [];
  const allowed = nativeOptions.length > 0
    ? []
    : record.category === 'question'
      ? ['submit_answers']
      : record.category === 'exit_plan_mode'
        ? planActions.length > 0 ? planActions : ['accept_with_auto', 'accept_with_ask', 'keep_planning']
        : ['allow_once', ...(scopeOptions.includes('session') ? ['allow_session'] : []), 'decline'];
  return {
    id: record.id,
    session_id: record.sessionId,
    turn_id: record.turnId,
    kind: nativeOptions.length > 0
      ? 'native_choice'
      : record.category === 'question'
        ? 'question'
        : record.category === 'exit_plan_mode'
          ? 'exit_plan_mode'
          : 'approval',
    category: record.category,
    risk: record.risk,
    description: record.description,
    ...(record.subject ? { subject: record.subject } : {}),
    ...((questions.length > 0 || inputs.length > 0) ? { questions: [...questions, ...inputs] } : {}),
    ...(nativeOptions.length > 0 ? { native_options: nativeOptions } : {}),
    allowed_decisions: allowed,
    created_at: new Date(record.createdAt).toISOString(),
  };
}

export function projectMessages(events: EventEnvelope[]): Map<number, GianToolMessage[]> {
  const byTurn = new Map<number, GianToolMessage[]>();
  const assistantByTurn = new Map<number, Map<string, GianToolMessage>>();
  for (const event of events) {
    const turn = event.turn;
    const messages = byTurn.get(turn) ?? [];
    byTurn.set(turn, messages);
    if (event.event === 'user_message' && typeof event.data['text'] === 'string') {
      messages.push({ role: 'user', text: event.data['text'], created_at: new Date(event.ts).toISOString() });
      continue;
    }
    if (event.display?.type !== 'message' || typeof event.display.data.text !== 'string') continue;
    const keyed = assistantByTurn.get(turn) ?? new Map<string, GianToolMessage>();
    assistantByTurn.set(turn, keyed);
    const existing = keyed.get(event.call_id);
    if (existing) {
      existing.text = event.display.data.delta
        ? `${existing.text}${event.display.data.text}`
        : event.display.data.text;
    } else {
      const message: GianToolMessage = {
        role: 'assistant',
        text: event.display.data.text,
        created_at: new Date(event.ts).toISOString(),
      };
      keyed.set(event.call_id, message);
      messages.push(message);
    }
  }
  return byTurn;
}

export function projectTurnInteractions(events: EventEnvelope[]): Map<number, GianToolTurnInteraction[]> {
  const byTurn = new Map<number, Map<string, GianToolTurnInteraction>>();
  for (const event of events) {
    const display = event.display;
    if (display?.type === 'interaction.approval' || display?.type === 'interaction.question') {
      const data = display.data as ApprovalRequestedData;
      const turn = byTurn.get(event.turn) ?? new Map<string, GianToolTurnInteraction>();
      byTurn.set(event.turn, turn);
      turn.set(data.approvalId, {
        id: data.approvalId,
        kind: data.nativeOptions && data.nativeOptions.length > 0
          ? 'native_choice'
          : data.category === 'question'
            ? 'question'
            : data.category === 'exit_plan_mode'
              ? 'exit_plan_mode'
              : 'approval',
        description: data.description,
        status: 'pending',
      });
      continue;
    }
    if (display?.type === 'interaction.resolved') {
      const turn = byTurn.get(event.turn) ?? new Map<string, GianToolTurnInteraction>();
      byTurn.set(event.turn, turn);
      const data = display.data;
      const existing = turn.get(data.approvalId);
      turn.set(data.approvalId, {
        id: data.approvalId,
        kind: existing?.kind ?? 'approval',
        description: existing?.description ?? '',
        status: 'resolved',
        decision: data.nativeOptionId ?? data.decision,
      });
    }
  }
  return new Map([...byTurn].map(([turn, interactions]) => [turn, [...interactions.values()]]));
}

export function validateConfigValue(option: ConfigOption, value: unknown): void {
  if (value === null && !option.required) return;
  if (option.control === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`${option.id} must be a boolean`);
  }
  if (option.control === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${option.id} must be a finite number`);
  }
  if ((option.control === 'text' || option.control === 'select') && typeof value !== 'string') {
    throw new Error(`${option.id} must be a string`);
  }
  if (option.choices && !option.choices.some(choice => Object.is(choice.value, value))) {
    throw new Error(`${option.id} must use one of the advertised choices`);
  }
  if (typeof value === 'number') {
    if (option.constraints?.minimum !== undefined && value < option.constraints.minimum) {
      throw new Error(`${option.id} is below its minimum`);
    }
    if (option.constraints?.maximum !== undefined && value > option.constraints.maximum) {
      throw new Error(`${option.id} is above its maximum`);
    }
  }
  if (typeof value === 'string') {
    if (option.constraints?.minimumLength !== undefined && value.length < option.constraints.minimumLength) {
      throw new Error(`${option.id} is shorter than its minimum length`);
    }
    if (option.constraints?.maximumLength !== undefined && value.length > option.constraints.maximumLength) {
      throw new Error(`${option.id} is longer than its maximum length`);
    }
  }
}

export function resolvedConfig(session: Session): import('@gian/shared').GianToolResolvedSessionConfig {
  return {
    agent_id: session.agent_id ?? null,
    agent_name: session.agent_name ?? null,
    proxy: session.executor,
    model: session.model,
    thinking_effort: session.thinking_effort,
    approval_mode: session.approval_mode,
    service_tier: session.service_tier,
    session: { ...session.executor_config.values },
    turn: { ...(session.turn_config ?? {}) },
  };
}

export function configOptionsByRole(options: ConfigOption[], role: string): ConfigOption | undefined {
  return options.find(option => option.role === role);
}

export function nativeOptionIds(options: NativeApprovalOption[] | undefined): Set<string> {
  return new Set((options ?? []).map(option => option.optionId));
}

export type NormalizedApprovalPayload = Pick<ApprovalRequestedData, 'questions' | 'actions' | 'inputs'>;
