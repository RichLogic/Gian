/**
 * Live event projection: Kimi `/api/v1/ws` session-event frames → gian
 * notifications, for ONE session.
 *
 * Identity rules:
 * - Durable-fact events (turn.started, activities, terminal) derive their
 *   eventId from stable native identities (prompt_id, tool_call_id), so live
 *   and replay projections of the same fact share one identity.
 * - Kimi Code 2.1.1 volatile frames reuse the current durable journal seq
 *   and are not replayed. They must not advance `lastSeq`. `assistant.delta`
 *   and `thinking.delta` carry `offset` (length before append; reset when
 *   `turn.step.started` begins the next step).
 * - Assistant text and thinking each get a content id per step
 *   (`assistant:<promptId>:<step>` / `thinking:<promptId>:<step>`). Text stays
 *   kind `text`, so the host renders it as a message outside the Working
 *   basket. Thinking stays kind `reasoning` and remains inside that basket.
 * - A content.delta eventId includes the prompt, the step, the offset, and
 *   the delta: identical text at the same position in two turns stays
 *   distinct, frames that share a seq stay distinct, and an identical
 *   redelivery stays idempotent.
 * - Durable frames at or before the last delivered durable seq are dropped,
 *   so cursor-based reconnect replays stay idempotent. A volatile frame is
 *   dropped only when its seq is strictly older than that watermark.
 *
 * Main-agent filtering: only `agentId === "main"` frames project as turn
 * content/tools; subagent work arrives via the dedicated `subagent.*` /
 * `task.*` lifecycle frames and becomes agent activities.
 */

import { createHash } from 'node:crypto';

import { terminalEventIdFor } from './replay.js';
import type { KimiToolDisplay } from './types.js';

export interface OuterNotification {
  method: string;
  params: Record<string, unknown>;
}

/** One `/api/v1/ws` session-event frame. `volatile` and `offset` are envelope
 *  fields on Kimi Code 2.1.1, not payload fields. */
export interface KimiProjectedFrame {
  type: string;
  seq: number;
  volatile?: boolean;
  offset?: number;
  payload: Record<string, unknown>;
}

export interface KimiErrorLike {
  code?: string | undefined;
  message?: string | undefined;
  retryable?: boolean | undefined;
}

export interface ProjectorServices {
  gianSessionId: string;
  nativeSessionId: string;
  nextSequence: () => number;
  emit: (notification: OuterNotification) => void;
  /** Called after every terminal finalization completes. */
  onFinalized?: () => void;
  /** Turn-start buffer overflowed: the service must fence the turn (stop the
   *  native prompt, then fail it); a bare local failure would leave native
   *  work running unattributed. */
  onBindingOverflow?: (gianTurnId: string) => void;
  /** Async terminal hooks; failures skip the facet honestly (never fake). */
  finalUsage: () => Promise<Record<string, unknown> | null>;
  fileDiff: (nativeTurnId: number) => Promise<{ diff: string; truncated: boolean; files: Array<Record<string, unknown>> } | null>;
}

function sha16(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

const PLAN_STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  in_progress: 'in_progress',
  done: 'completed',
};

/** Hard cap on the optional terminal facets (final usage, file diff): they
 *  may enrich the terminal, never delay it beyond this budget. */
const FINAL_FACET_BUDGET_MS = 10_000;
/** Frames buffered between prompt submission and turn binding. */
const BINDING_BUFFER_LIMIT = 4_096;

interface ActiveTurn {
  gianTurnId: string;
  promptId: string;
  nativeTurnId: number | null;
  interruptAccepted: boolean;
}

interface OpenActivity {
  name: string;
  input: unknown;
  title?: string;
  presentation?: { type: string; data: Record<string, unknown> };
}

interface OpenContent {
  kind: 'text' | 'reasoning';
  text: string;
  /** Length of this step's text, matching the server offset cursor. */
  stepLength: number;
}

export interface PendingInteractionState {
  interactionId: string;
  kind: 'approval' | 'question';
  nativeId: string;
  turnId: string;
  /** Question input ids/types at projection time; respondInteraction needs
   *  them to wrap raw UI values into the native kind-discriminated answers. */
  inputs?: Array<{ id: string; type: string }>;
}

export class KimiSessionProjector {
  private streamId = '';
  /** Last durable journal seq. Volatile frames reuse this value and must not move it. */
  private lastSeq = -1;
  /** Bumps on each main-agent `turn.step.started`. Each step owns its content ids. */
  private contentStep = 0;
  /** Identity for text deltas that arrive without an offset. */
  private unoffsetDelta = 0;
  private activeTurn: ActiveTurn | null = null;
  private readonly openContent = new Map<string, OpenContent>();
  private readonly openActivities = new Map<string, OpenActivity>();
  readonly pendingInteractions = new Map<string, PendingInteractionState>();
  private lastPlanFingerprint: string | null = null;
  private lastUsageFingerprint: string | null = null;
  private lastError: KimiErrorLike | null = null;
  private terminalSent = false;
  /** Set by failTurn while a finalization is already running: the optional
   *  REST facets are skipped so the terminal goes out immediately. */
  private facetsAborted = false;
  /** Turn-start binding window: frames that beat the prompt-submission
   *  response are buffered and flushed by bindTurn, never projected blind. */
  private binding = false;
  private bufferedFrames: KimiProjectedFrame[] = [];
  private bindingOverflowed = false;

  constructor(private readonly services: ProjectorServices) {}

  setStreamId(streamId: string): void {
    this.streamId = streamId;
  }

  /** Open the turn-start window. Until bindTurn or discardBinding, incoming
   *  frames are buffered in arrival order instead of being dropped for lack
   *  of an active turn. */
  beginBinding(): void {
    this.binding = true;
    this.bufferedFrames = [];
    this.bindingOverflowed = false;
  }

  discardBinding(): void {
    this.binding = false;
    this.bufferedFrames = [];
    this.bindingOverflowed = false;
  }

  bindTurn(turn: { gianTurnId: string; promptId: string }): void {
    this.activeTurn = { gianTurnId: turn.gianTurnId, promptId: turn.promptId, nativeTurnId: null, interruptAccepted: false };
    this.terminalSent = false;
    this.lastError = null;
    this.lastUsageFingerprint = null;
    this.lastPlanFingerprint = null;
    this.contentStep = 0;
    this.unoffsetDelta = 0;
    this.facetsAborted = false;
    const buffered = this.bufferedFrames;
    const overflowed = this.bindingOverflowed;
    this.binding = false;
    this.bufferedFrames = [];
    this.bindingOverflowed = false;
    for (const frame of buffered) this.handleFrame(frame);
    if (overflowed) {
      // Fencing belongs to the service: it stops the native prompt before
      // failing the turn, so no native work keeps running unattributed.
      const onOverflow = this.services.onBindingOverflow;
      if (onOverflow !== undefined) {
        onOverflow(turn.gianTurnId);
      } else {
        void this.failTurn(
          'The Kimi event stream overflowed the turn-start buffer; the turn was fenced rather than projected incompletely.',
          true,
        );
      }
    }
  }

  markInterruptAccepted(): void {
    if (this.activeTurn) this.activeTurn.interruptAccepted = true;
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  activePromptId(): string | null {
    return this.activeTurn?.promptId ?? null;
  }

  activeGianTurnId(): string | null {
    return this.activeTurn?.gianTurnId ?? null;
  }

  /** Claim resolution through REST. A native WS resolution may already
   *  have won; only the caller that removes pending emits a terminal fact. */
  resolveInteraction(interactionId: string): boolean {
    return this.pendingInteractions.delete(interactionId);
  }

  private frameParams(source: unknown, turn: ActiveTurn | null): Record<string, unknown> {
    return {
      // Native activity/plan identifiers can repeat in a later turn. A live
      // fact belongs to its native prompt, not just to the whole session.
      eventId: `evt-${sha16(turn === null
        ? [this.services.nativeSessionId, source]
        : [this.services.nativeSessionId, turn.promptId, source])}`,
      sessionId: this.services.gianSessionId,
      streamId: this.streamId,
      sequence: this.services.nextSequence(),
      emittedAt: new Date().toISOString(),
      ...(turn !== null ? { turnId: turn.gianTurnId, sourceTurnId: turn.promptId } : {}),
    };
  }

  private emitTurn(method: string, source: unknown, data: Record<string, unknown>, turn: ActiveTurn | null): void {
    const params = this.frameParams(source, turn);
    params.data = data;
    this.services.emit({ method, params });
  }

  /** Feed one wire frame. Returns false when the seq guard drops it. */
  handleFrame(frame: KimiProjectedFrame): boolean {
    if (this.binding) {
      if (this.bufferedFrames.length >= BINDING_BUFFER_LIMIT) {
        this.bindingOverflowed = true;
        return true;
      }
      this.bufferedFrames.push(frame);
      return true;
    }
    if (frame.volatile === true) {
      if (frame.seq < this.lastSeq) return false;
    } else {
      if (frame.seq <= this.lastSeq) return false;
      this.lastSeq = frame.seq;
    }
    const payload = frame.payload;
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : 'main';
    const turn = this.activeTurn;

    switch (frame.type) {
      case 'turn.started': {
        if (agentId !== 'main' || turn === null) return true;
        if (typeof payload.turnId === 'number') turn.nativeTurnId = payload.turnId;
        return true;
      }
      case 'turn.step.started': {
        if (agentId !== 'main') return true;
        this.contentStep += 1;
        return true;
      }
      case 'assistant.delta':
      case 'thinking.delta': {
        if (agentId !== 'main' || turn === null) return true;
        const kind = frame.type === 'assistant.delta' ? 'text' as const : 'reasoning' as const;
        const contentId = `${kind === 'text' ? 'assistant' : 'thinking'}:${turn.promptId}:${this.contentStep}`;
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        const open = this.openContent.get(contentId) ?? { kind, text: '', stepLength: 0 };
        const offset = typeof frame.offset === 'number' && Number.isFinite(frame.offset) ? frame.offset : null;
        if (offset !== null) {
          if (offset < open.stepLength) return true;
          if (offset > open.stepLength) open.stepLength = offset;
        }
        this.openContent.set(contentId, open);
        if (delta === '') return true;
        const position = offset ?? this.unoffsetDelta++;
        open.text += delta;
        open.stepLength += delta.length;
        this.emitTurn('content.delta', [frame.type, turn.promptId, this.contentStep, position, delta], { contentId, kind, delta }, turn);
        return true;
      }
      case 'tool.call.started': {
        if (agentId !== 'main' || turn === null) return true;
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
        if (toolCallId === '') return true;
        const name = typeof payload.name === 'string' ? payload.name : 'tool';
        const display = (payload.display ?? undefined) as KimiToolDisplay | undefined;
        if (display?.kind === 'todo_list' && Array.isArray(display.items)) {
          this.emitPlan(display.items);
        } else if (display?.kind === 'plan_review' && typeof display.plan === 'string') {
          this.emitPlanReview(display);
        }
        const projected = projectToolCall(name, display, payload.args);
        this.openActivities.set(toolCallId, {
          name,
          input: payload.args,
          title: projected.title,
          presentation: projected.presentation,
        });
        this.emitTurn('activity.updated', [toolCallId, 'activity:running'], {
          activityId: toolCallId,
          kind: `tool:${name}`,
          title: projected.title,
          status: 'running',
          presentation: projected.presentation,
          ...(display !== undefined ? { details: { display } } : {}),
        }, turn);
        return true;
      }
      case 'tool.result': {
        if (agentId !== 'main' || turn === null) return true;
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
        if (toolCallId === '') return true;
        const open = this.openActivities.get(toolCallId);
        const name = open?.name ?? 'tool';
        this.openActivities.delete(toolCallId);
        const presentation = open?.presentation ?? projectToolCall(name, undefined, open?.input).presentation;
        const data: Record<string, unknown> = { ...presentation.data, output: payload.output ?? null };
        this.emitTurn('activity.updated', [toolCallId, 'activity:terminal'], {
          activityId: toolCallId,
          kind: `tool:${name}`,
          title: open?.title ?? name,
          status: payload.isError === true ? 'failed' : 'succeeded',
          ...(typeof payload.output === 'string' ? { summary: payload.output } : {}),
          presentation: { type: presentation.type, data },
        }, turn);
        return true;
      }
      case 'agent.status.updated': {
        if (agentId !== 'main') return true;
        const usage = (payload.usage ?? null) as Record<string, unknown> | null;
        const rawTotal: unknown = usage?.total;
        if (rawTotal !== null && rawTotal !== undefined && typeof rawTotal === 'object') {
          const total = rawTotal as Record<string, unknown>;
          const fingerprint = JSON.stringify(total);
          if (fingerprint !== this.lastUsageFingerprint) {
            this.lastUsageFingerprint = fingerprint;
            const inputTokens = (numberOr(total.inputOther) ?? 0) + (numberOr(total.inputCacheRead) ?? 0) + (numberOr(total.inputCacheCreation) ?? 0);
            const outputTokens = numberOr(total.output);
            const cached = numberOr(total.inputCacheRead);
            this.emitTurn('usage.updated', ['usage', turn?.promptId ?? '', fingerprint], {
              conversation: {
                mode: 'absolute',
                ...(inputTokens > 0 ? { inputTokens } : {}),
                ...(outputTokens !== null ? { outputTokens } : {}),
                ...(cached !== null && cached > 0 ? { cachedInputTokens: cached } : {}),
              },
            }, turn);
          }
        }
        return true;
      }
      case 'subagent.spawned':
      case 'subagent.started': {
        if (frame.type === 'subagent.started' && this.openActivities.has(String(payload.subagentId ?? ''))) return true;
        this.emitSubagent(frame, payload, 'running');
        return true;
      }
      case 'subagent.completed': {
        this.emitSubagent(frame, payload, 'succeeded');
        return true;
      }
      case 'subagent.failed': {
        this.emitSubagent(frame, payload, 'failed');
        return true;
      }
      case 'subagent.cancelled':
      case 'subagent.suspended': {
        this.emitSubagent(frame, payload, 'cancelled');
        return true;
      }
      case 'task.started':
      case 'background.task.started': {
        const info = (payload.info ?? {}) as Record<string, unknown>;
        this.emitTask(frame, info, 'running');
        return true;
      }
      case 'task.terminated':
      case 'background.task.terminated': {
        const info = (payload.info ?? {}) as Record<string, unknown>;
        const status = typeof info.status === 'string' ? info.status : 'completed';
        this.emitTask(frame, info, status === 'completed' ? 'succeeded' : status === 'failed' || status === 'timed_out' ? 'failed' : 'cancelled');
        return true;
      }
      case 'event.approval.requested': {
        const approvalId = typeof payload.approval_id === 'string' ? payload.approval_id : '';
        if (approvalId === '' || turn === null) return true;
        const interactionId = `apr:${approvalId}`;
        if (this.pendingInteractions.has(interactionId)) return true;
        this.pendingInteractions.set(interactionId, {
          interactionId,
          kind: 'approval',
          nativeId: approvalId,
          turnId: turn.gianTurnId,
        });
        this.emitTurn('interaction.requested', [approvalId, 'interaction.requested'], {
          interactionId,
          title: typeof payload.tool_name === 'string' ? payload.tool_name : 'Permission required',
          ...(typeof payload.action === 'string' ? { description: `Kimi requests: ${payload.action}` } : {}),
          presentation: { kind: 'permission', tone: 'warning' },
          inputs: [],
          actions: [
            { id: 'approved', label: 'Allow', style: 'primary' },
            { id: 'rejected', label: 'Deny', style: 'danger' },
          ],
          context: {
            approvalId,
            toolName: payload.tool_name ?? '',
            ...(payload.tool_input_display !== undefined ? { input: payload.tool_input_display } : {}),
            ...(typeof payload.expires_at === 'string' ? { expiresAt: payload.expires_at } : {}),
          },
        }, turn);
        return true;
      }
      case 'event.approval.resolved': {
        const approvalId = typeof payload.approval_id === 'string' ? payload.approval_id : '';
        const interactionId = `apr:${approvalId}`;
        if (approvalId === '' || !this.pendingInteractions.delete(interactionId)) return true;
        // Resolved elsewhere (expired/another client): report honestly.
        this.emitTurn('interaction.resolved', [approvalId, 'interaction.resolved:external'], {
          interactionId,
          outcome: 'cancelled',
        }, turn);
        return true;
      }
      case 'event.question.requested': {
        const questionId = typeof payload.question_id === 'string' ? payload.question_id : '';
        if (questionId === '' || turn === null) return true;
        const interactionId = `q:${questionId}`;
        if (this.pendingInteractions.has(interactionId)) return true;
        const questions = Array.isArray(payload.questions) ? payload.questions as Array<Record<string, unknown>> : [];
        if (questions.length === 0) return true;
        const inputs = questions.map((question, index) => {
          const options = Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [];
          // Interaction choices have only value/displayName in the shared
          // protocol. Preserve native option help in the input description.
          const descriptions = options
            .filter((option) => typeof option.description === 'string' && option.description !== '')
            .map((option) => `${typeof option.label === 'string' ? option.label : String(option.id)}: ${String(option.description)}`);
          if (question.allow_other === true) descriptions.push('You may provide your own answer in the note field.');
          return {
            id: typeof question.id === 'string' ? question.id : `q_${index}`,
            type: question.multi_select === true ? 'multi_select' : 'single_select',
            label: typeof question.question === 'string' ? question.question : `Question ${index + 1}`,
            required: true,
            ...(options.length > 0
              ? {
                  choices: options
                    .filter((option) => typeof option.id === 'string')
                    .map((option) => ({
                      value: option.id as string,
                      displayName: typeof option.label === 'string' ? option.label : option.id as string,
                    })),
                }
              : {}),
            ...(descriptions.length > 0 ? { description: descriptions.join('\n') } : {}),
          };
        });
        this.pendingInteractions.set(interactionId, {
          interactionId,
          kind: 'question',
          nativeId: questionId,
          turnId: turn.gianTurnId,
          inputs: inputs.map((input) => ({ id: input.id, type: input.type })),
        });
        this.emitTurn('interaction.requested', [questionId, 'interaction.requested'], {
          interactionId,
          title: 'Question',
          presentation: { kind: 'questions', tone: 'info' },
          inputs,
          actions: [
            { id: 'accept', label: 'Submit', style: 'primary' },
            { id: 'decline', label: 'Dismiss', style: 'danger' },
          ],
          context: { questionId, 'gian.cancelInputOptionalActions': ['decline'] },
        }, turn);
        return true;
      }
      case 'event.question.answered':
      case 'event.question.dismissed': {
        const questionId = typeof payload.question_id === 'string' ? payload.question_id : '';
        const interactionId = `q:${questionId}`;
        if (questionId === '' || !this.pendingInteractions.delete(interactionId)) return true;
        this.emitTurn('interaction.resolved', [questionId, 'interaction.resolved:external'], {
          interactionId,
          outcome: 'cancelled',
        }, turn);
        return true;
      }
      case 'prompt.steered': {
        if (agentId !== 'main' || turn === null) return true;
        this.emitTurn('activity.updated', [frame.seq, 'steer'], {
          activityId: `steer-${sha16([frame.seq])}`.slice(0, 24),
          kind: 'kimi:turn-steer',
          title: 'Steer delivered',
          status: 'succeeded',
          presentation: { type: 'notice', data: { message: 'The queued input was steered into the running turn.' } },
        }, turn);
        return true;
      }
      case 'skill.activated': {
        if (agentId !== 'main' || turn === null) return true;
        this.emitTurn('activity.updated', [frame.seq, 'skill'], {
          activityId: `skill-${sha16([frame.seq])}`.slice(0, 24),
          kind: 'kimi:skill-activation',
          title: `Skill activated: ${String(payload.skillName ?? 'unknown')}`,
          status: 'succeeded',
          presentation: {
            type: 'notice',
            data: { message: `Kimi activated the skill "${String(payload.skillName ?? 'unknown')}".` },
          },
        }, turn);
        return true;
      }
      case 'error': {
        if (agentId !== 'main') return true;
        this.lastError = {
          code: typeof payload.code === 'string' ? payload.code : undefined,
          message: typeof payload.message === 'string' ? payload.message : undefined,
          retryable: payload.retryable === true,
        };
        return true;
      }
      case 'turn.ended': {
        if (agentId !== 'main' || turn === null) return true;
        if (typeof payload.turnId === 'number') turn.nativeTurnId = payload.turnId;
        const reason = typeof payload.reason === 'string' ? payload.reason : 'completed';
        if (payload.error !== undefined && payload.error !== null) {
          const error = payload.error as KimiErrorLike;
          this.lastError = {
            code: typeof error.code === 'string' ? error.code : this.lastError?.code,
            message: typeof error.message === 'string' ? error.message : this.lastError?.message,
            retryable: error.retryable === true || this.lastError?.retryable === true,
          };
        }
        // Defer the terminal finalization to a macrotask: the REST facets
        // (final usage, file diff) must never interleave with the synchronous
        // projection of frames that are still in flight on the wire.
        setTimeout(() => {
          void this.finalizeTurn(reason).catch(() => undefined);
        }, 0);
        return true;
      }
      default:
        return true;
    }
  }

  private emitSubagent(frame: { seq: number }, payload: Record<string, unknown>, state: 'running' | 'succeeded' | 'failed' | 'cancelled'): void {
    const subagentId = typeof payload.subagentId === 'string' ? payload.subagentId : '';
    if (subagentId === '') return;
    if (state === 'running' && this.openActivities.has(`agent:${subagentId}`)) return;
    if (state !== 'running') this.openActivities.delete(`agent:${subagentId}`);
    else this.openActivities.set(`agent:${subagentId}`, { name: 'subagent', input: undefined });
    const title = typeof payload.description === 'string' && payload.description !== ''
      ? payload.description
      : typeof payload.subagentName === 'string' ? payload.subagentName : 'subagent';
    const gianState = state === 'running' ? 'running' : state === 'succeeded' ? 'completed' : state === 'failed' ? 'failed' : 'interrupted';
    this.emitTurn('activity.updated', [frame.seq, 'subagent', subagentId], {
      activityId: subagentId,
      kind: 'subagent:kimi',
      title,
      status: state === 'running' ? 'running' : state === 'succeeded' ? 'succeeded' : state === 'failed' ? 'failed' : 'cancelled',
      presentation: {
        type: 'agent',
        data: {
          agentId: subagentId,
          state: gianState,
          ...(typeof payload.parentToolCallId === 'string' ? { parentToolCallId: payload.parentToolCallId } : {}),
          ...(typeof payload.subagentName === 'string' ? { subagentType: payload.subagentName } : {}),
          ...(state === 'succeeded' && typeof payload.resultSummary === 'string' ? { summary: payload.resultSummary } : {}),
          ...(state === 'failed' && typeof payload.error === 'string' ? { summary: payload.error } : {}),
        },
      },
    }, this.activeTurn);
  }

  private emitTask(frame: { seq: number }, info: Record<string, unknown>, status: 'running' | 'succeeded' | 'failed' | 'cancelled'): void {
    const taskId = typeof info.taskId === 'string' ? info.taskId : '';
    if (taskId === '') return;
    const activityId = `task:${taskId}`;
    if (status === 'running' && this.openActivities.has(activityId)) return;
    if (status !== 'running') this.openActivities.delete(activityId);
    else this.openActivities.set(activityId, { name: 'task', input: undefined });
    this.emitTurn('activity.updated', [frame.seq, 'task', taskId], {
      activityId,
      kind: `task:${typeof info.kind === 'string' ? info.kind : 'process'}`,
      title: typeof info.description === 'string' && info.description !== '' ? info.description : taskId,
      status,
      presentation: {
        type: 'agent',
        data: {
          agentId: taskId,
          state: status === 'running' ? 'running' : status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted',
        },
      },
    }, this.activeTurn);
  }

  private emitPlan(items: Array<{ title: string; status: string }>): void {
    if (this.activeTurn === null) return;
    const steps = items
      .filter((item) => typeof item.title === 'string' && item.title !== '')
      .map((item, index) => ({
        id: `step-${index}`,
        text: item.title,
        status: PLAN_STATUS_MAP[item.status] ?? 'pending',
      }));
    const fingerprint = JSON.stringify(steps);
    if (fingerprint === this.lastPlanFingerprint) return;
    this.lastPlanFingerprint = fingerprint;
    this.emitTurn('plan.updated', ['plan', fingerprint], {
      planId: `kimi:todos:${this.services.nativeSessionId}`,
      title: 'Plan',
      steps,
    }, this.activeTurn);
  }

  private emitPlanReview(display: KimiToolDisplay): void {
    if (this.activeTurn === null) return;
    const steps = [{ id: 'step-0', text: display.plan ?? '', status: 'completed' }];
    const fingerprint = JSON.stringify(steps);
    if (fingerprint === this.lastPlanFingerprint) return;
    this.lastPlanFingerprint = fingerprint;
    this.emitTurn('plan.updated', ['plan-review', fingerprint], {
      planId: `kimi:plan:${this.services.nativeSessionId}`,
      title: 'Plan',
      steps,
    }, this.activeTurn);
  }

  /** Force-fail the active turn (interrupt settle timeout, resync, runtime
   *  loss): the terminal is emitted deterministically with the given error.
   *  When a finalization is already in flight its outcome is known and
   *  stands; this only expedites its optional facets. */
  async failTurn(message: string, retryable: boolean): Promise<void> {
    if (this.terminalSent) {
      this.facetsAborted = true;
      return;
    }
    this.lastError = { message, retryable };
    await this.finalizeTurn('failed');
  }

  /** Deterministic terminal finalization. Async facets (final usage, file
   *  diff) are fetched best-effort; failures skip the facet. */
  async finalizeTurn(reason: string): Promise<void> {
    if (this.terminalSent || this.activeTurn === null) return;
    this.terminalSent = true;
    const turn = this.activeTurn;

    for (const [interactionId] of this.pendingInteractions) {
      this.emitTurn('interaction.resolved', [interactionId, 'resolved:turn_ended'], {
        interactionId,
        outcome: 'turn_ended',
      }, turn);
    }
    this.pendingInteractions.clear();

    for (const [contentId, content] of this.openContent) {
      this.emitTurn('content.completed', [contentId, 'content:finalizer'], {
        contentId,
        kind: content.kind,
        content: content.text,
      }, turn);
    }
    this.openContent.clear();

    for (const [activityId, activity] of this.openActivities) {
      const presentation = activity.presentation ?? {
        type: 'tool',
        data: { name: activity.name },
      };
      this.emitTurn('activity.updated', [activityId, 'activity:finalizer'], {
        activityId,
        kind: `tool:${activity.name}`,
        title: activity.title ?? activity.name,
        status: turn.interruptAccepted ? 'cancelled' : 'failed',
        presentation,
      }, turn);
    }
    this.openActivities.clear();

    const facetDeadline = Date.now() + FINAL_FACET_BUDGET_MS;

    if (!this.facetsAborted) {
      const usage = await this.withFacetDeadline(this.services.finalUsage(), facetDeadline);
      if (usage !== null && !this.facetsAborted) {
        this.emitTurn('usage.updated', ['final-usage', turn.promptId, usage], {
          conversation: {
            mode: 'absolute',
            ...(numberOr(usage.input_tokens) !== null ? { inputTokens: numberOr(usage.input_tokens) } : {}),
            ...(numberOr(usage.output_tokens) !== null ? { outputTokens: numberOr(usage.output_tokens) } : {}),
            ...(numberOr(usage.cache_read_tokens) !== null ? { cachedInputTokens: numberOr(usage.cache_read_tokens) } : {}),
          },
        }, turn);
      }
    }

    if (!this.facetsAborted && turn.nativeTurnId !== null) {
      const diff = await this.withFacetDeadline(this.services.fileDiff(turn.nativeTurnId), facetDeadline);
      if (diff !== null && !this.facetsAborted && (diff.diff !== '' || diff.files.length > 0)) {
        this.emitTurn('diff.updated', ['diff', turn.nativeTurnId, sha16(diff.diff).slice(0, 8)], {
          diffId: `turn-${turn.nativeTurnId}`,
          diff: diff.diff,
          truncated: diff.truncated,
          ...(diff.files.length > 0 ? { files: diff.files } : {}),
        }, turn);
      }
    }

    const error = this.lastError;
    if (reason === 'failed') {
      if (error?.code === 'loop.max_steps_exceeded') {
        this.emitTerminal('turn.completed', 'limit_reached', turn);
        this.services.onFinalized?.();
        return;
      }
      const domain = mapKimiErrorCode(error?.code);
      this.services.emit({
        method: 'turn.failed',
        params: {
          eventId: terminalEventIdFor(this.services.nativeSessionId, turn.promptId, 'turn.failed'),
          sessionId: this.services.gianSessionId,
          streamId: this.streamId,
          sequence: this.services.nextSequence(),
          turnId: turn.gianTurnId,
          sourceTurnId: turn.promptId,
          emittedAt: new Date().toISOString(),
          data: {
            error: {
              domainCode: domain,
              message: error?.message ?? `Kimi turn ended with reason "${reason}".`,
              retryable: error?.retryable === true || domain === 'RUNTIME_AUTH_REQUIRED',
              details: error?.code !== undefined ? { nativeCode: error.code } : {},
            },
          },
        },
      });
      this.services.onFinalized?.();
      return;
    }
    const stopReason = reason === 'cancelled'
      ? (turn.interruptAccepted ? 'interrupted' : 'cancelled')
      : reason === 'blocked' ? 'other' : 'completed';
    this.emitTerminal('turn.completed', stopReason, turn);
    this.services.onFinalized?.();
  }

  /** Optional terminal facets never delay the terminal itself: the shared
   *  deadline caps the facet phase, and a hung or failed fetch resolves to a
   *  skipped facet rather than a stuck finalization. */
  private withFacetDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | null> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve(null);
    return Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), remaining);
        timer.unref();
      }),
    ]);
  }

  private emitTerminal(method: 'turn.completed' | 'turn.failed', stopReason: string, turn: ActiveTurn): void {
    this.services.emit({
      method,
      params: {
        eventId: terminalEventIdFor(this.services.nativeSessionId, turn.promptId, method),
        sessionId: this.services.gianSessionId,
        streamId: this.streamId,
        sequence: this.services.nextSequence(),
        turnId: turn.gianTurnId,
        sourceTurnId: turn.promptId,
        emittedAt: new Date().toISOString(),
        data: method === 'turn.completed' ? { stopReason } : {
          error: { domainCode: 'RUNTIME_ERROR', message: 'Kimi turn failed.', retryable: false, details: {} },
        },
      },
    });
  }
}

function argsRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function argString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

interface ToolProjection {
  title: string;
  presentation: { type: string; data: Record<string, unknown> };
}

function genericTool(name: string, args: unknown): ToolProjection {
  return {
    title: name,
    presentation: {
      type: 'tool',
      data: {
        name,
        ...(args !== undefined ? { input: args } : {}),
      },
    },
  };
}

/** Map a Kimi tool display onto a basket row. Assistant prose is not a tool
 *  and never comes through here. */
function projectToolCall(name: string, display: KimiToolDisplay | undefined, args: unknown): ToolProjection {
  const record = argsRecord(args);
  if (display?.kind === 'command') {
    const command = (typeof display.command === 'string' && display.command !== '' ? display.command : null)
      ?? argString(record, 'command');
    if (command !== null) {
      return { title: command, presentation: { type: 'command', data: { command } } };
    }
  }
  if (display?.kind === 'url_fetch') {
    const query = (typeof display.url === 'string' && display.url !== '' ? display.url : null)
      ?? argString(record, 'url');
    if (query !== null) {
      return { title: query, presentation: { type: 'search', data: { query } } };
    }
  }
  if (display?.kind === 'file_io') {
    const path = display.path ?? argString(record, 'path') ?? argString(record, 'file_path') ?? '';
    const operation = display.operation ?? '';
    if (path !== '' && (operation === 'read' || operation === 'write' || operation === 'delete' || operation === 'rename')) {
      return { title: path, presentation: { type: 'file', data: { path, operation } } };
    }
    if (path !== '' && operation === 'edit') {
      return { title: path, presentation: { type: 'file', data: { path, operation: 'write' } } };
    }
    if (operation === 'grep' || operation === 'glob' || operation === 'search') {
      const pattern = argString(record, 'pattern')
        ?? argString(record, 'glob')
        ?? argString(record, 'query')
        ?? (typeof display.query === 'string' && display.query !== '' ? display.query : null)
        ?? name;
      return {
        title: pattern,
        presentation: {
          type: 'file-search',
          data: {
            pattern,
            searchKind: operation === 'glob' ? 'glob' : 'grep',
            ...(path !== '' ? { path } : {}),
          },
        },
      };
    }
  }
  return genericTool(name, args);
}

function numberOr(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Map a Kimi error code to a gian DomainCode (subset that matters). */
export function mapKimiErrorCode(code: string | undefined): string {
  switch (code) {
    case 'auth.login_required':
    case 'auth.token_missing':
    case 'auth.token_unauthorized':
    case 'auth.provisioning_required':
    case 'auth.model_not_resolved':
      return 'RUNTIME_AUTH_REQUIRED';
    case 'context.overflow':
      return 'SESSION_ERROR';
    case 'session.busy':
    case 'turn.agent_busy':
      return 'SESSION_BUSY';
    case 'activity.disposed':
    case 'activity.disposing':
      return 'SESSION_CLOSED';
    default:
      return 'RUNTIME_ERROR';
  }
}
