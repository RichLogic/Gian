/**
 * Live event projection (Revision 2 §9.3, §10).
 *
 * Identity rules:
 * - Outer `eventId` = sha256(pluginId, nativeSessionId, sourceNativeEventIdentity,
 *   projectionKind, ordinal) — one native fact may project several outer events,
 *   so the raw native eventId is never reused verbatim.
 * - Outer `sequence` is adapter-local per session stream, starting at 1;
 *   native seq/revision/eventSeq counters never leak onto the wire.
 * - `sourceTurnId` is the native turnId (stable across live and replay, WP0 G6).
 *
 * Dedup rules:
 * - `session/event` seq cursor per native session (monotonic; gaps tolerated).
 * - typed computer-use events and payload events share the native eventId
 *   (WP0 G6); the seen-set guarantees a single projection per native fact.
 *
 * Terminal finalizer (§9.3): before the single terminal event, pending
 * interactions resolve (turn_ended), open content completes, running
 * activities reach a terminal status, the last usage is flushed, and only then
 * does exactly one turn.completed / turn.failed go out.
 */

import { createHash } from 'node:crypto';
import { PLUGIN_ID } from './identity.js';
import type { InnerNativeEvent } from './inner/model.js';

export interface OuterNotification {
  method: string;
  params: Record<string, unknown>;
  extensions?: Record<string, { schemaVersion: number; payload: unknown }>;
}

export interface InteractionResolution {
  interactionId: string;
  outcome: 'submitted' | 'cancelled' | 'expired' | 'turn_ended' | 'runtime_ended';
  actionId?: string;
}

export interface ProjectorServices {
  gianSessionId: string;
  nativeSessionId: string;
  /** Assign the next outer sequence for this session stream. */
  nextSequence: () => number;
  emit: (notification: OuterNotification) => void;
}

function eventIdFor(parts: unknown[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([PLUGIN_ID, ...parts]));
  return hash.digest('hex').slice(0, 32);
}

export function terminalEventIdFor(
  nativeSessionId: string,
  nativeTurnId: string,
  method: 'turn.completed' | 'turn.failed',
): string {
  return eventIdFor([nativeSessionId, nativeTurnId, method]);
}

function nowIso(): string {
  return new Date().toISOString();
}

const MAX_ACTIVITY_BYTES = 64 * 1024;

const INTERNAL_SESSION_EVENT_TYPES = new Set([
  'model_request_started',
  'model_request_completed',
  'model_request_failed',
  'model_retry_scheduled',
  'model_stream_stalled',
]);

function bounded(value: unknown): { value: unknown; truncated: boolean } {
  const json = JSON.stringify(value ?? null);
  if (json.length <= MAX_ACTIVITY_BYTES) return { value, truncated: false };
  return {
    value: {
      truncated: true,
      originalBytes: json.length,
      preview: typeof value === 'string' ? value.slice(0, 2_000) : json.slice(0, 2_000),
    },
    truncated: true,
  };
}

interface OpenContent {
  contentId: string;
  kind: 'text' | 'reasoning';
  text: string;
}

interface OpenActivity {
  activityId: string;
  title: string;
  toolName: string;
  input: unknown;
  output: unknown;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

/** A pending interaction plus the exact native answer builder. The adapter
 *  stores the transport request id; the projector owns the payload mapping
 *  so the EXACT native response shape is preserved (§11.1). */
export interface PendingInteractionEntry {
  interactionId: string;
  /** Build the native answer for interaction.respond. Throws ServiceError
   *  INTERACTION_ACTION_NOT_FOUND for unadvertised actionIds. */
  respond: (actionId: string, values: Record<string, unknown>) => Record<string, unknown>;
}

interface ActiveTurn {
  gianTurnId: string;
  nativeTurnId: string;
  interruptAccepted: boolean;
  foregroundExecutionId: string | null;
  /** turn.started for this gian turn has been emitted (the typed
   *  turn-started can arrive once, but a duplicate must not double it). */
  startedEmitted: boolean;
}

/** Native todo/plan statuses (contracts/src/tools/todo.ts:26-30). */
const PLAN_STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
};

/** Plan facts come from the TodoWrite/UpdatePlan tool (contracts/src/tools/todo.ts
 *  TodoWriteInputSchema; session-mapper.ts:1124-1246 builds snapshot todos from
 *  the same tool parts). */
const PLAN_TOOL_NAMES = new Set(['TodoWrite', 'UpdatePlan']);

interface NativeTodo {
  content?: unknown;
  status?: unknown;
  priority?: unknown;
}

/** Normalize a native todos array into outer plan.updated steps. */
export function mapTodoSteps(todos: NativeTodo[]): Array<{ id: string; text: string; status: string }> {
  const steps: Array<{ id: string; text: string; status: string }> = [];
  for (const [index, todo] of todos.entries()) {
    const text = typeof todo.content === 'string' ? todo.content : '';
    if (text === '') continue;
    const status = typeof todo.status === 'string' ? PLAN_STATUS_MAP[todo.status] : undefined;
    steps.push({
      id: `step-${index}`,
      text,
      status: status ?? 'pending',
    });
  }
  return steps;
}

/** jsdiff hunks (core/src/tool/diff.ts createStructuredPatch → DiffHunk[]). */
interface NativePatchHunk {
  oldStart?: unknown;
  oldLines?: unknown;
  newStart?: unknown;
  newLines?: unknown;
  lines?: unknown;
}

/** Render native structuredPatch hunks as a unified diff for outer
 *  diff.updated (bounded by MAX_DIFF_UTF8_BYTES on the wire). */
export function renderUnifiedDiff(path: string, hunks: NativePatchHunk[]): string {
  const parts: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    const oldStart = typeof hunk.oldStart === 'number' ? hunk.oldStart : 0;
    const oldLines = typeof hunk.oldLines === 'number' ? hunk.oldLines : 0;
    const newStart = typeof hunk.newStart === 'number' ? hunk.newStart : 0;
    const newLines = typeof hunk.newLines === 'number' ? hunk.newLines : 0;
    parts.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    if (Array.isArray(hunk.lines)) {
      for (const line of hunk.lines) {
        if (typeof line === 'string') parts.push(line);
      }
    }
  }
  return parts.join('\n');
}

const RESULT_TYPE_STOP_REASONS: Record<string, string> = {
  success: 'completed',
  cancelled: 'cancelled',
  error_max_turns: 'limit_reached',
  error_max_budget: 'limit_reached',
  error_max_tool_calls: 'limit_reached',
};

export class SessionProjector {
  private readonly seenNativeEvents = new Set<string>();
  private lastNativeSeq = 0;
  private openContent = new Map<string, OpenContent>();
  private openActivities = new Map<string, OpenActivity>();
  private readonly pendingInteractions = new Map<string, PendingInteractionEntry>();
  private activeTurn: ActiveTurn | null = null;
  private lastUsage: Record<string, unknown> | null = null;
  private terminalSent = false;
  private observedTextContent = false;
  private lastPlanFingerprint: string | null = null;

  constructor(private readonly services: ProjectorServices) {}

  bindTurn(gianTurnId: string, nativeTurnId: string): void {
    this.activeTurn = {
      gianTurnId,
      nativeTurnId,
      interruptAccepted: false,
      foregroundExecutionId: null,
      startedEmitted: false,
    };
    this.terminalSent = false;
    this.observedTextContent = false;
  }

  /** Release the turn binding when no native turn was actually started
   *  (e.g. the send was rejected): a later turn-started must not be
   *  attributed to this gian turn. */
  clearTurn(): void {
    this.activeTurn = null;
  }

  markInterruptAccepted(): void {
    if (this.activeTurn) this.activeTurn.interruptAccepted = true;
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  activeNativeTurnId(): string | null {
    return this.activeTurn?.nativeTurnId ?? null;
  }

  activeGianTurnId(): string | null {
    return this.activeTurn?.gianTurnId ?? null;
  }

  activeForegroundExecutionId(): string | null {
    return this.activeTurn?.foregroundExecutionId ?? null;
  }

  pendingInteractionCount(): number {
    return this.pendingInteractions.size;
  }

  /** Feed one inner notification; returns true when it was consumed. */
  handleNotification(method: string, params: Record<string, unknown>): boolean {
    if (method === 'session/event') {
      this.handleSessionEvent(params);
      return true;
    }
    if (method === 'computer-use/operation-event') {
      this.handleOperationEvent(params);
      return true;
    }
    return false; // state.updated / v4 telemetry / process diagnostics: ignored
  }

  private handleSessionEvent(params: Record<string, unknown>): void {
    const nativeSeq = typeof params.seq === 'number' ? params.seq : 0;
    if (nativeSeq > this.lastNativeSeq) this.lastNativeSeq = nativeSeq;
    const nativeEventId = typeof params.eventId === 'string' ? params.eventId : null;
    const payload = (params.payload ?? {}) as Record<string, unknown>;
    const kind = typeof payload.kind === 'string' ? payload.kind : null;
    const eventType = typeof params.type === 'string'
      ? params.type
      : typeof payload.type === 'string'
        ? payload.type
        : null;
    if (
      this.activeTurn !== null
      && typeof payload.foregroundExecutionId === 'string'
      && payload.foregroundExecutionId !== ''
    ) {
      this.activeTurn.foregroundExecutionId = payload.foregroundExecutionId;
    }
    const turnId = this.nativeTurnIdFor(payload);
    if (nativeEventId !== null) {
      if (this.seenNativeEvents.has(nativeEventId)) return;
      this.seenNativeEvents.add(nativeEventId);
      if (this.seenNativeEvents.size > 5_000) {
        for (const seen of this.seenNativeEvents) {
          this.seenNativeEvents.delete(seen);
          if (this.seenNativeEvents.size <= 2_500) break;
        }
      }
    }

    if (kind !== null) {
      this.handleStreamPayload(nativeEventId, kind, payload, turnId);
      return;
    }
    // Non-stream payloads (WP0 G6: these carry no `kind` field).
    if (typeof payload.resultType === 'string') {
      this.handleTurnTerminal(nativeEventId, payload);
      return;
    }
    if (typeof payload.stopReason === 'string' && typeof payload.usage !== 'undefined') {
      this.emitTerminalTextIfNeeded(payload.content);
      this.handleMessageCompleted(nativeEventId, payload);
      return;
    }
    if (eventType === 'session.updated') {
      // Default-arm session.updated carries several internal facts. Subagent
      // lifecycle arrives here (session-mapper.ts default mapping); the rest
      // is iteration/model bookkeeping and not user-visible.
      this.handleSubagentFact(nativeEventId, payload);
      return;
    }
    if (eventType !== null && eventType.startsWith('turn.steer')) {
      this.handleSteerEvent(eventType, nativeEventId, payload);
      return;
    }
    if (eventType !== null && INTERNAL_SESSION_EVENT_TYPES.has(eventType)) {
      // Provider network diagnostics can contain headers, request ids and
      // endpoints. They are neither transcript facts nor safe generic data.
      return;
    }
    if (typeof payload.toolName === 'string' || typeof payload.tool === 'string') {
      this.handleToolLifecycle(nativeEventId, payload);
      return;
    }
    if (typeof payload.title === 'string' && payload.kind === undefined) {
      // Title generation: not user-visible content in the transcript stream.
      return;
    }
    if (typeof payload.turnNumber === 'number' && typeof payload.input === 'string') {
      // Live user input: the Host already persisted it as the turn Action;
      // contract §14.2 forbids duplicate input.recorded on the live stream.
      return;
    }
    // Unknown visible payload: degrade to a generic bounded activity (§14.3).
    this.emitGenericActivity(`payload:${kind ?? 'unknown'}`, nativeEventId, payload);
  }

  private nativeTurnIdFor(payload: Record<string, unknown>): string | null {
    if (typeof payload.assistantMessageId === 'string') {
      // Stream chunks do not carry the native turnId; use the bound turn.
      return this.activeTurn?.nativeTurnId ?? null;
    }
    if (typeof payload.turnId === 'string') return payload.turnId;
    return this.activeTurn?.nativeTurnId ?? null;
  }

  private turnScopedParams(sourceIdentity: string): Record<string, unknown> | null {
    const turn = this.activeTurn;
    if (turn === null) return null;
    return {
      eventId: eventIdFor([this.services.nativeSessionId, sourceIdentity, 'turn-envelope']),
      sessionId: this.services.gianSessionId,
      streamId: this.currentStreamId(),
      sequence: this.services.nextSequence(),
      turnId: turn.gianTurnId,
      sourceTurnId: turn.nativeTurnId,
      emittedAt: nowIso(),
    };
  }

  /** The adapter injects the live streamId here at construction time via
   *  services.nextSequence side channel; projector keeps a mutable holder. */
  private streamIdHolder = '';
  setStreamId(streamId: string): void {
    this.streamIdHolder = streamId;
  }
  private currentStreamId(): string {
    return this.streamIdHolder;
  }

  private emitTurnEvent(
    method: string,
    sourceIdentity: string,
    data: Record<string, unknown>,
  ): void {
    const params = this.turnScopedParams(`${sourceIdentity}:${method}`);
    if (params === null) return;
    params.data = data;
    this.services.emit({ method, params });
  }

  private handleStreamPayload(
    nativeEventId: string | null,
    kind: string,
    payload: Record<string, unknown>,
    turnId: string | null,
  ): void {
    const sourceId = nativeEventId ?? `seq:${this.lastNativeSeq}`;
    switch (kind) {
      case 'text_start':
      case 'reasoning_start': {
        const contentId = typeof payload.assistantMessageId === 'string'
          ? payload.assistantMessageId
          : 'assistant';
        this.openContent.set(contentId, {
          contentId,
          kind: kind === 'text_start' ? 'text' : 'reasoning',
          text: '',
        });
        if (kind === 'text_start') this.observedTextContent = true;
        this.emitTurnEvent('content.delta', sourceId, {
          contentId,
          kind: kind === 'text_start' ? 'text' : 'reasoning',
          delta: '',
        });
        return;
      }
      case 'text_delta':
      case 'reasoning_delta': {
        const contentId = typeof payload.assistantMessageId === 'string'
          ? payload.assistantMessageId
          : 'assistant';
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        const existing = this.openContent.get(contentId) ?? {
          contentId,
          kind: kind === 'text_delta' ? 'text' as const : 'reasoning' as const,
          text: '',
        };
        existing.text += delta;
        this.openContent.set(contentId, existing);
        if (kind === 'text_delta') this.observedTextContent = true;
        this.emitTurnEvent('content.delta', sourceId, {
          contentId,
          kind: existing.kind,
          delta,
        });
        return;
      }
      case 'text_end':
      case 'reasoning_end': {
        const contentId = typeof payload.assistantMessageId === 'string'
          ? payload.assistantMessageId
          : 'assistant';
        const existing = this.openContent.get(contentId);
        const text = existing?.text
          ?? (typeof payload.content === 'string' ? payload.content : '');
        this.openContent.delete(contentId);
        if (kind === 'text_end') this.observedTextContent = true;
        this.emitTurnEvent('content.completed', sourceId, {
          contentId,
          kind: kind === 'text_end' ? 'text' : 'reasoning',
          content: text,
        });
        return;
      }
      case 'tool_call': {
        this.handleToolLifecycle(nativeEventId, payload);
        return;
      }
      case 'result': {
        // Real Desktop delivery completes a tool with a compact result
        // payload (toolCallId/result) rather than another tool_call frame.
        this.handleToolLifecycle(nativeEventId, payload);
        return;
      }
      case 'error': {
        if (typeof payload.toolCallId === 'string') {
          this.handleToolLifecycle(nativeEventId, { ...payload, status: 'failed' });
          return;
        }
        // Stream-level model errors surface through the turn terminal payload;
        // record a bounded diagnostic activity so the UI can show context.
        this.emitGenericActivity('stream:error', nativeEventId, payload);
        return;
      }
      case 'batch':
      case 'tool_result':
      case 'tool_error':
      case 'scheduled':
      case 'started':
      case 'progress': {
        // Aggregate/commit/recovery frames duplicate the typed tool lifecycle
        // and the result payload. They must not become standalone activities.
        return;
      }
      case 'start':
      case 'finish':
      case 'tool_input_start':
      case 'tool_input_delta':
      case 'tool_input_end': {
        // Input echo / framing chunks: no独立 user-visible fact beyond the
        // tool lifecycle events that follow with their own identities.
        return;
      }
      default: {
        void turnId;
        this.emitGenericActivity(`payload:${kind}`, nativeEventId, payload);
      }
    }
  }

  private handleToolLifecycle(nativeEventId: string | null, payload: Record<string, unknown>): void {
    const toolCallId = typeof payload.toolCallId === 'string'
      ? payload.toolCallId
      : typeof payload.callID === 'string'
        ? payload.callID
        : null;
    const toolName = typeof payload.toolName === 'string'
      ? payload.toolName
      : typeof payload.tool === 'string'
        ? payload.tool
        : typeof payload.name === 'string'
          ? payload.name
          : undefined;
    if (toolCallId === null) {
      this.emitGenericActivity('tool:unidentified', nativeEventId, payload);
      return;
    }
    // Plan facts: TodoWrite/UpdatePlan carry the canonical todo list
    // (input.todos). Project them to plan.updated instead of tool activity.
    if (toolName !== undefined && PLAN_TOOL_NAMES.has(toolName)) {
      const input = (payload.input ?? {}) as Record<string, unknown>;
      const todos = Array.isArray(input.todos) ? input.todos as NativeTodo[] : [];
      this.emitPlanUpdated(todos);
      return;
    }
    const existing = this.openActivities.get(toolCallId);
    const status = typeof payload.status === 'string' ? payload.status : null;
    const sourceId = nativeEventId ?? `${toolCallId}:${this.lastNativeSeq}`;

    if (status === 'completed' || status === 'failed' || payload.result !== undefined) {
      const result = (payload.result ?? payload.output ?? {}) as Record<string, unknown>;
      // Diff facts: Edit/Write results carry jsdiff structuredPatch hunks
      // (core/src/tool/handlers/edit.ts:530-553, write.ts:154).
      const patch = Array.isArray(result.structuredPatch) ? result.structuredPatch as NativePatchHunk[] : null;
      if (patch !== null && patch.length > 0 && typeof result.filePath === 'string') {
        this.emitDiffUpdated(toolCallId, result.filePath, patch, result);
      }
      const success = status === 'failed' || result.success === false ? 'failed' : 'succeeded';
      const boundedOutput = bounded(result.content ?? result.output ?? result);
      this.emitTurnEvent('activity.updated', `${sourceId}:terminal`, {
        activityId: toolCallId,
        kind: `tool:${toolName ?? existing?.toolName ?? 'tool'}`,
        title: existing?.title ?? toolName ?? 'tool',
        status: success,
        presentation: {
          type: 'tool',
          data: {
            name: toolName ?? existing?.toolName ?? 'tool',
            ...(existing?.input !== undefined ? { input: existing.input } : {}),
            output: boundedOutput.value,
          },
        },
        ...(boundedOutput.truncated ? { details: { truncated: true } } : {}),
      });
      this.openActivities.delete(toolCallId);
      return;
    }

    // scheduled / started / input streaming: one running activity upsert.
    const input = payload.input !== undefined ? bounded(payload.input).value : existing?.input;
    this.openActivities.set(toolCallId, {
      activityId: toolCallId,
      title: existing?.title ?? toolName ?? 'tool',
      toolName: toolName ?? existing?.toolName ?? 'tool',
      input,
      output: existing?.output,
      status: 'running',
    });
    this.emitTurnEvent('activity.updated', sourceId, {
      activityId: toolCallId,
      kind: `tool:${toolName ?? existing?.toolName ?? 'tool'}`,
      title: toolName ?? existing?.title ?? 'tool',
      status: 'running',
      presentation: {
        type: 'tool',
        data: {
          name: toolName ?? existing?.toolName ?? 'tool',
          ...(input !== undefined ? { input } : {}),
        },
      },
    });
  }

  /** Emit outer plan.updated from the canonical native todo list. Repeats
   *  with identical content are collapsed (upstream re-emits todos on every
   *  TodoWrite call, including no-op reads). */
  private emitPlanUpdated(todos: NativeTodo[]): void {
    const steps = mapTodoSteps(todos);
    const fingerprint = JSON.stringify(steps);
    if (fingerprint === this.lastPlanFingerprint) return;
    this.lastPlanFingerprint = fingerprint;
    if (this.activeTurn === null) return;
    this.emitTurnEvent('plan.updated', `plan:${fingerprint.length}:${steps.length}:${steps.at(-1)?.id ?? 'none'}`, {
      planId: `zcode:todos:${this.services.nativeSessionId}`,
      title: 'Plan',
      steps,
    });
  }

  private emitDiffUpdated(
    toolCallId: string,
    filePath: string,
    hunks: NativePatchHunk[],
    result: Record<string, unknown>,
  ): void {
    if (this.activeTurn === null) return;
    const diff = renderUnifiedDiff(filePath, hunks);
    const truncated = Buffer.byteLength(diff, 'utf8') > MAX_ACTIVITY_BYTES;
    const before = result.originalFile ?? result.oldString ?? result.before ?? '';
    const status = (typeof before === 'string' && before === '') ? 'added' : 'modified';
    this.emitTurnEvent('diff.updated', `${toolCallId}:diff:${hunks.length}:${diff.length}`, {
      diffId: toolCallId,
      diff: truncated ? diff.slice(0, 16_000) : diff,
      truncated,
      files: [{ path: filePath, status }],
    });
  }

  /** Subagent lifecycle arrives on default-arm session.updated payloads
   *  (core/src/subagent/runner.ts:231-245 spawn, 351-367 stop). */
  private handleSubagentFact(nativeEventId: string | null, payload: Record<string, unknown>): void {
    const childSessionId = typeof payload.childSessionId === 'string' ? payload.childSessionId : null;
    if (childSessionId === null) return;
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : childSessionId;
    const agentType = typeof payload.agentType === 'string' ? payload.agentType : 'subagent';
    const title = typeof payload.description === 'string' && payload.description !== ''
      ? payload.description
      : agentType;
    let state: string;
    if (payload.status === 'running') {
      state = 'running';
    } else if (payload.status === 'completed' || payload.status === 'success') {
      state = 'completed';
    } else if (payload.status === 'failed' || payload.status === 'lost' || payload.status === 'error') {
      state = 'failed';
    } else if (payload.status === 'cancelled' || payload.status === 'interrupted') {
      state = 'interrupted';
    } else {
      return;
    }
    const sourceId = nativeEventId ?? `${childSessionId}:${payload.status ?? ''}:${this.lastNativeSeq}`;
    this.emitTurnEvent('activity.updated', `${sourceId}:subagent`, {
      activityId: childSessionId,
      kind: `subagent:${agentType}`,
      title,
      status: state === 'running' ? 'running' : state === 'completed' ? 'succeeded' : state === 'failed' ? 'failed' : 'cancelled',
      presentation: {
        type: 'agent',
        data: {
          agentId: childSessionId,
          state,
          ...(agentId !== childSessionId ? { nativeAgentId: agentId } : {}),
          ...(typeof payload.parentToolCallId === 'string' ? { parentToolCallId: payload.parentToolCallId } : {}),
        },
      },
    });
  }

  /** Native steer facts (contracts/src/events/session.events.ts:484-584):
   *  turn.steerQueued / turn.steerDrained confirm the guide reached the
   *  CURRENT turn; rejections and fallbacks surface as notice activities. */
  private handleSteerEvent(eventType: string, nativeEventId: string | null, payload: Record<string, unknown>): void {
    const messages: Record<string, { title: string; message: string }> = {
      'turn.steerQueued': { title: 'Steer accepted', message: 'Guide input was queued onto the running turn.' },
      'turn.steerDrained': { title: 'Steer delivered', message: 'Guide input was inlined into the running turn.' },
      'turn.steerRejected': {
        title: 'Steer rejected',
        message: typeof payload.reason === 'string' ? `Guide input was rejected: ${payload.reason}.` : 'Guide input was rejected.',
      },
      'turn.steerDeliveryChanged': {
        title: 'Steer re-routed',
        message: typeof payload.fallbackReasonCode === 'string'
          ? `Guide input fell back to the next turn (${payload.fallbackReasonCode}).`
          : 'Guide input fell back to the next turn.',
      },
      'turn.steerDiscarded': { title: 'Steer discarded', message: 'Queued guide input was discarded.' },
    };
    const fact = messages[eventType];
    if (fact === undefined) return;
    const activityId = typeof payload.pendingInputId === 'string'
      ? payload.pendingInputId
      : nativeEventId ?? `steer:${this.lastNativeSeq}`;
    this.emitTurnEvent('activity.updated', `${activityId}:${eventType}`, {
      activityId,
      kind: 'zcode:turn-steer',
      title: fact.title,
      status: eventType === 'turn.steerRejected' || eventType === 'turn.steerDiscarded' ? 'failed' : 'succeeded',
      presentation: {
        type: 'notice',
        data: {
          message: fact.message,
          ...(typeof payload.delivery === 'string' ? { delivery: payload.delivery } : {}),
          ...(typeof payload.targetTurnId === 'string' ? { targetTurnId: payload.targetTurnId } : {}),
        },
      },
    });
  }

  private handleMessageCompleted(nativeEventId: string | null, payload: Record<string, unknown>): void {
    const usage = (payload.usage ?? {}) as Record<string, unknown>;
    const inputTokens = numberOr(usage.inputTokens);
    const outputTokens = numberOr(usage.outputTokens);
    const cached = numberOr(usage.cacheReadTokens);
    const total = numberOr(usage.totalTokens);
    if (inputTokens === null && outputTokens === null && cached === null && total === null) return;
    this.lastUsage = {
      inputTokens: inputTokens ?? undefined,
      outputTokens: outputTokens ?? undefined,
      cachedInputTokens: cached ?? undefined,
      totalTokens: total ?? undefined,
    };
    this.emitTurnEvent('usage.updated', nativeEventId ?? `usage:${this.lastNativeSeq}`, {
      conversation: {
        mode: 'absolute',
        ...(inputTokens !== null ? { inputTokens } : {}),
        ...(outputTokens !== null ? { outputTokens } : {}),
        ...(cached !== null ? { cachedInputTokens: cached } : {}),
        ...(total !== null ? { totalTokens: total } : {}),
      },
    });
  }

  private handleTurnTerminal(nativeEventId: string | null, payload: Record<string, unknown>): void {
    const resultType = typeof payload.resultType === 'string' ? payload.resultType : 'success';
    this.emitTerminalTextIfNeeded(payload.response);
    this.handleMessageCompleted(nativeEventId, payload);
    this.finalizeTurn(resultType, payload);
  }

  private emitTerminalTextIfNeeded(value: unknown): void {
    if (this.observedTextContent || typeof value !== 'string' || value.length === 0) return;
    this.observedTextContent = true;
    const contentId = `assistant:${this.activeTurn?.nativeTurnId || 'current'}`;
    this.emitTurnEvent('content.delta', `${contentId}:fallback-delta`, {
      contentId,
      kind: 'text',
      delta: value,
    });
    this.emitTurnEvent('content.completed', `${contentId}:fallback-completed`, {
      contentId,
      kind: 'text',
      content: value,
    });
  }

  /** Deterministic terminal finalization (§9.3). */
  finalizeTurn(resultType: string, nativeDetails: Record<string, unknown>): void {
    if (this.terminalSent) return;
    this.terminalSent = true;

    // 1. pending interactions -> turn_ended
    const runtimeFailure = nativeDetails.runtimeFailure !== null
      && typeof nativeDetails.runtimeFailure === 'object'
      ? nativeDetails.runtimeFailure as {
          providerCode?: string;
          domainCode?: string;
          message?: string;
          retryable?: boolean;
        }
      : null;
    for (const [interactionId] of this.pendingInteractions) {
      this.services.emit({
        method: 'interaction.resolved',
        params: {
          eventId: eventIdFor([this.services.nativeSessionId, interactionId, 'resolved', 'turn_ended']),
          sessionId: this.services.gianSessionId,
          streamId: this.currentStreamId(),
          sequence: this.services.nextSequence(),
          turnId: this.activeTurn?.gianTurnId ?? '',
          sourceTurnId: this.activeTurn?.nativeTurnId ?? '',
          emittedAt: nowIso(),
          data: { interactionId, outcome: runtimeFailure ? 'runtime_ended' : 'turn_ended' },
        },
      });
    }
    this.pendingInteractions.clear();

    // 2. open content -> content.completed
    for (const [contentId, content] of this.openContent) {
      this.emitTurnEvent('content.completed', `${contentId}:finalizer`, {
        contentId,
        kind: content.kind,
        content: content.text,
      });
    }
    this.openContent.clear();

    // 3. running activities -> terminal status
    for (const [activityId, activity] of this.openActivities) {
      const interrupted = this.activeTurn?.interruptAccepted === true;
      this.emitTurnEvent('activity.updated', `${activityId}:finalizer`, {
        activityId,
        kind: `tool:${activity.toolName}`,
        title: activity.title,
        status: interrupted ? 'cancelled' : 'failed',
        presentation: {
          type: 'tool',
          data: {
            name: activity.toolName,
            ...(activity.input !== undefined ? { input: activity.input } : {}),
          },
        },
      });
    }
    this.openActivities.clear();

    // 4. last usage already flushed via handleMessageCompleted.

    // 5. exactly one terminal event. Mapping (§9.3, WP0 G5): observed success
    // -> completed (never reshape a stop race into an interrupt); cancelled ->
    // interrupted only when OUR interrupt was accepted; error_* -> turn.failed
    // with the native resultType in the namespaced extension.
    const interrupted = this.activeTurn?.interruptAccepted === true;
    if (resultType === 'success') {
      this.emitCompleted('completed');
      return;
    }
    if (resultType === 'cancelled') {
      this.emitCompleted(interrupted ? 'interrupted' : 'cancelled');
      return;
    }
    if (RESULT_TYPE_STOP_REASONS[resultType] === 'limit_reached') {
      this.emitCompleted('limit_reached');
      return;
    }
    const errorDetails = runtimeFailure?.providerCode
      ? { providerCode: runtimeFailure.providerCode }
      : {};
    this.services.emit({
      method: 'turn.failed',
      params: {
        eventId: terminalEventIdFor(
          this.services.nativeSessionId,
          this.activeTurn?.nativeTurnId ?? '',
          'turn.failed',
        ),
        sessionId: this.services.gianSessionId,
        streamId: this.currentStreamId(),
        sequence: this.services.nextSequence(),
        turnId: this.activeTurn?.gianTurnId ?? '',
        sourceTurnId: this.activeTurn?.nativeTurnId ?? '',
        emittedAt: nowIso(),
        data: {
          error: {
            domainCode: runtimeFailure?.domainCode ?? 'RUNTIME_ERROR',
            message: runtimeFailure?.message ?? `ZCode turn ended with ${resultType}.`,
            retryable: runtimeFailure?.retryable ?? false,
            details: errorDetails,
          },
        },
      },
      extensions: {
        [PLUGIN_ID]: {
          schemaVersion: 1,
          payload: { nativeResultType: resultType },
        },
      },
    });
  }

  private emitCompleted(stopReason: string): void {
    const turn = this.activeTurn;
    this.services.emit({
      method: 'turn.completed',
      params: {
        eventId: terminalEventIdFor(
          this.services.nativeSessionId,
          turn?.nativeTurnId ?? '',
          'turn.completed',
        ),
        sessionId: this.services.gianSessionId,
        streamId: this.currentStreamId(),
        sequence: this.services.nextSequence(),
        turnId: turn?.gianTurnId ?? '',
        sourceTurnId: turn?.nativeTurnId ?? '',
        emittedAt: nowIso(),
        data: { stopReason },
      },
    });
  }

  private handleOperationEvent(params: Record<string, unknown>): void {
    const kind = typeof params.kind === 'string' ? params.kind : '';
    const nativeEventId = typeof params.eventId === 'string' ? params.eventId : null;
    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    if (process.env.GIAN_ZCODE_TRACE_EVENTS === '1') {
      this.services.emit({
        method: 'debug',
        params: { message: `[zcode] op-event kind=${kind} eventId=${nativeEventId} turnId=${turnId} activeTurn=${this.activeTurn ? `${this.activeTurn.gianTurnId}:${this.activeTurn.nativeTurnId || '-'}` : 'null'}` },
      });
    }
    if (kind === 'turn-completed' || kind === 'turn-failed' || kind === 'session-closed') {
      // The typed operation is emitted before the richer session/event and
      // intentionally shares its eventId. Do not consume the shared identity,
      // otherwise the terminal payload (resultType/usage/response) is lost.
      return;
    }
    if (nativeEventId !== null) {
      if (this.seenNativeEvents.has(nativeEventId)) return;
      this.seenNativeEvents.add(nativeEventId);
    }
    switch (kind) {
      case 'turn-started': {
        // Runtime confirmation: only now may the outer stream claim
        // turn.started (contract §11.1; response barrier keeps ordering).
        if (this.activeTurn !== null && turnId !== null) {
          // The native identity may already be bound by a reverse request
          // (interaction/requestPermission carries the native turnId and can
          // precede the typed event). Emit exactly once per bound turn: the
          // pre-ack arrival of the typed event must not swallow the fact,
          // and a duplicate typed event must not double it.
          if (this.activeTurn.nativeTurnId === '' || this.activeTurn.nativeTurnId === turnId) {
            if (this.activeTurn.nativeTurnId === '') {
              this.activeTurn.nativeTurnId = turnId;
            }
            if (this.activeTurn.startedEmitted !== true) {
              this.activeTurn.startedEmitted = true;
              this.emitTurnStarted(this.activeTurn.gianTurnId, turnId, nativeEventId);
            } else if (process.env.GIAN_ZCODE_TRACE_EVENTS === '1') {
              this.services.emit({
                method: 'debug',
                params: { message: `[zcode] duplicate turn-started ignored for ${this.activeTurn.gianTurnId}` },
              });
            }
          } else if (process.env.GIAN_ZCODE_TRACE_EVENTS === '1') {
            this.services.emit({
              method: 'debug',
              params: { message: `[zcode] turn-started for foreign turn ${turnId} ignored (activeTurn ${this.activeTurn.gianTurnId} bound to ${this.activeTurn.nativeTurnId})` },
            });
          }
          return;
        }
        if (turnId === null) return;
        this.activeTurn = {
          gianTurnId: turnId,
          nativeTurnId: turnId,
          interruptAccepted: false,
          foregroundExecutionId: null,
          startedEmitted: true,
        };
        this.emitTurnStarted(turnId, turnId, nativeEventId);
        return;
      }
      case 'tool-scheduled':
      case 'tool-started': {
        const toolCallId = typeof params.toolCallId === 'string' ? params.toolCallId : null;
        if (toolCallId !== null && this.openActivities.has(toolCallId) === false) {
          const toolName = typeof params.toolName === 'string' ? params.toolName : 'tool';
          this.openActivities.set(toolCallId, {
            activityId: toolCallId,
            title: toolName,
            toolName,
            input: undefined,
            output: undefined,
            status: 'running',
          });
          this.emitTurnEvent('activity.updated', nativeEventId ?? toolCallId, {
            activityId: toolCallId,
            kind: `tool:${toolName}`,
            title: toolName,
            status: 'running',
            presentation: { type: 'tool', data: { name: toolName } },
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private emitTurnStarted(gianTurnId: string, nativeTurnId: string, nativeEventId: string | null): void {
    this.services.emit({
      method: 'turn.started',
      params: {
        eventId: eventIdFor([this.services.nativeSessionId, nativeEventId ?? nativeTurnId, 'turn.started']),
        sessionId: this.services.gianSessionId,
        streamId: this.currentStreamId(),
        sequence: this.services.nextSequence(),
        turnId: gianTurnId,
        sourceTurnId: nativeTurnId,
        emittedAt: nowIso(),
        data: {},
      },
    });
  }

  private emitGenericActivity(source: string, nativeEventId: string | null, payload: Record<string, unknown>): void {
    const boundedPayload = bounded(payload);
    const turn = this.activeTurn;
    const params: Record<string, unknown> = {
      eventId: eventIdFor([this.services.nativeSessionId, nativeEventId ?? source, 'generic', this.lastNativeSeq]),
      sessionId: this.services.gianSessionId,
      streamId: this.currentStreamId(),
      sequence: this.services.nextSequence(),
      emittedAt: nowIso(),
      data: {
        activityId: eventIdFor([this.services.nativeSessionId, source, 'generic-activity']).slice(0, 24),
        kind: `zcode:${source}`,
        title: `ZCode ${source}`,
        status: 'succeeded',
        presentation: { type: 'generic' },
        ...(boundedPayload.truncated ? { details: boundedPayload.value } : { details: { payload: boundedPayload.value } }),
      },
    };
    if (turn !== null) {
      params.turnId = turn.gianTurnId;
      params.sourceTurnId = turn.nativeTurnId;
    }
    this.services.emit({ method: 'activity.updated', params });
  }

  /** Handle an interaction reverse request surfaced by the adapter. Returns
   *  the pending entry (with the exact native answer builder) or null when
   *  the request cannot be faithfully relayed. */
  handlePermissionRequest(request: {
    requestId: string;
    nativeTurnId?: string;
    toolCallId?: string;
    toolName?: string;
    reason?: string;
    riskLevel?: string;
    input?: unknown;
    origin?: Record<string, unknown>;
    options?: Array<{ optionId?: string; kind?: string; name?: string; description?: string; response?: Record<string, unknown> }>;
    raw: Record<string, unknown>;
  }): PendingInteractionEntry | null {
    const turn = this.activeTurn;
    if (turn === null) return null;
    // ZCode's permission reverse request carries the native turnId; bind it
    // when the typed turn-started has not arrived yet (WP0 G2 schema).
    if (turn.nativeTurnId === '' && typeof request.nativeTurnId === 'string' && request.nativeTurnId !== '') {
      turn.nativeTurnId = request.nativeTurnId;
    }
    if (turn.nativeTurnId === '') return null; // no stable identity: fail closed
    const interactionId = `int:${request.requestId}`;
    const existing = this.pendingInteractions.get(interactionId);
    if (existing !== undefined) {
      // Desktop retries the same reverse request while the user is deciding.
      // Keep the newest transport request deferred in the adapter, but do not
      // emit duplicate interaction facts or consume outer sequence numbers.
      return existing;
    }
    const options = request.options ?? [];
    const actions: Array<{ id: string; label: string; style: string }> = [];
    const safeOptions: Array<{ optionId: string; response: Record<string, unknown> }> = [];
    for (const option of options) {
      const optionId = option.optionId;
      if (typeof optionId !== 'string' || optionId === '') continue;
      if (option.response === undefined || option.response === null) continue;
      if (typeof option.response.decision !== 'string') continue;
      actions.push({
        id: optionId,
        label: typeof option.name === 'string' ? option.name : optionId,
        style: option.response.decision === 'deny' ? 'danger' : option.kind === 'allow_always' ? 'secondary' : 'primary',
      });
      safeOptions.push({ optionId, response: option.response });
    }
    if (actions.length === 0) return null;

    const tone = request.riskLevel === 'high' || request.riskLevel === 'critical' ? 'danger' : 'warning';
    const boundedInput = bounded(request.input).value;
    this.services.emit({
      method: 'interaction.requested',
      params: {
        eventId: eventIdFor([this.services.nativeSessionId, request.requestId, 'interaction.requested']),
        sessionId: this.services.gianSessionId,
        streamId: this.currentStreamId(),
        sequence: this.services.nextSequence(),
        turnId: turn.gianTurnId,
        sourceTurnId: turn.nativeTurnId,
        emittedAt: nowIso(),
        data: {
          interactionId,
          title: request.toolName ?? 'Permission required',
          ...(typeof request.reason === 'string' ? { description: request.reason } : {}),
          presentation: { kind: 'permission', tone },
          inputs: [],
          actions,
          ...(boundedInput !== undefined
            ? { context: { toolName: request.toolName ?? '', input: boundedInput } }
            : { context: { toolName: request.toolName ?? '' } }),
        },
      },
      extensions: {
        [PLUGIN_ID]: { schemaVersion: 1, payload: { nativeMethod: 'interaction/requestPermission', requestId: request.requestId, riskLevel: request.riskLevel ?? '' } },
      },
    });
    const entry: PendingInteractionEntry = {
      interactionId,
      respond: (actionId: string) => {
        const nativeResponse = safeOptions.find((option) => option.optionId === actionId)?.response;
        if (nativeResponse === undefined) {
          throw new SessionInteractionActionError(actionId);
        }
        return nativeResponse;
      },
    };
    this.pendingInteractions.set(interactionId, entry);
    return entry;
  }

  /** `interaction/requestUserInput` — AskUserQuestion and the ExitPlanMode
   *  approval both surface here (interaction-broker.ts:195-345). Structured
   *  questions keep their options; nothing is flattened into plain text. */
  handleUserInputRequest(request: {
    requestId: string;
    nativeTurnId?: string;
    toolCallId?: string;
    toolName?: string;
    prompt?: string;
    questions?: Array<{
      question?: string;
      header?: string;
      options?: Array<{ value?: string; label?: string; description?: string; preview?: string }>;
      multiSelect?: boolean;
    }>;
    input?: unknown;
    origin?: Record<string, unknown>;
    schema?: Record<string, unknown>;
    raw: Record<string, unknown>;
  }): PendingInteractionEntry | null {
    const turn = this.activeTurn;
    if (turn === null) return null;
    if (turn.nativeTurnId === '' && typeof request.nativeTurnId === 'string' && request.nativeTurnId !== '') {
      turn.nativeTurnId = request.nativeTurnId;
    }
    if (turn.nativeTurnId === '') return null;
    const interactionId = `int:${request.requestId}`;
    const existing = this.pendingInteractions.get(interactionId);
    if (existing !== undefined) return existing;

    const questions = (request.questions ?? []).filter((question) => typeof question.question === 'string' && question.question !== '');
    const isPlanApproval = request.schema?.interaction === 'plan_approval';
    const inputs: Array<Record<string, unknown>> = [];
    const actions: Array<{ id: string; label: string; style: string }> = [];
    for (const [index, question] of questions.entries()) {
      const choices = (question.options ?? [])
        .filter((option) => typeof option.value === 'string' && option.value !== '')
        .map((option) => ({
          value: option.value as string,
          displayName: typeof option.label === 'string' && option.label !== '' ? option.label : option.value as string,
        }));
      inputs.push({
        id: `q${index}`,
        type: question.multiSelect === true ? 'multi_select' : 'single_select',
        label: question.question as string,
        required: true,
        ...(choices.length > 0 ? { choices } : {}),
      });
    }
    if (isPlanApproval) {
      actions.push({ id: 'approve', label: 'Approve plan', style: 'primary' });
      actions.push({ id: 'feedback', label: 'Request changes', style: 'secondary' });
      actions.push({ id: 'decline', label: 'Decline', style: 'danger' });
      inputs.push({
        id: 'feedback',
        type: 'multiline_text',
        label: 'Feedback for the plan (required for "Request changes")',
        required: false,
        multiline: true,
      });
    } else {
      actions.push({ id: 'accept', label: 'Submit', style: 'primary' });
      actions.push({ id: 'decline', label: 'Decline', style: 'danger' });
    }
    if (inputs.length === 0 || actions.length === 0) return null;

    const boundedInput = bounded(request.input).value;
    const boundedOrigin = bounded(request.origin).value;
    this.services.emit({
      method: 'interaction.requested',
      params: {
        eventId: eventIdFor([this.services.nativeSessionId, request.requestId, 'interaction.requested']),
        sessionId: this.services.gianSessionId,
        streamId: this.currentStreamId(),
        sequence: this.services.nextSequence(),
        turnId: turn.gianTurnId,
        sourceTurnId: turn.nativeTurnId,
        emittedAt: nowIso(),
        data: {
          interactionId,
          title: isPlanApproval
            ? 'Plan approval'
            : typeof request.toolName === 'string' && request.toolName !== ''
              ? request.toolName
              : 'Question',
          ...(typeof request.prompt === 'string' && request.prompt !== '' ? { description: request.prompt } : {}),
          presentation: { kind: isPlanApproval ? 'plan_approval' : 'questions', tone: 'info' },
          inputs,
          actions,
          context: {
            ...(typeof request.toolName === 'string' ? { toolName: request.toolName } : {}),
            ...(Array.isArray(request.questions) ? { questions: bounded(request.questions).value } : {}),
            ...(boundedInput !== undefined ? { input: boundedInput } : {}),
            ...(boundedOrigin !== undefined ? { origin: boundedOrigin } : {}),
          },
        },
      },
      extensions: {
        [PLUGIN_ID]: {
          schemaVersion: 1,
          payload: {
            nativeMethod: 'interaction/requestUserInput',
            requestId: request.requestId,
            interaction: isPlanApproval ? 'plan_approval' : 'askUserQuestion',
          },
        },
      },
    });

    // Native answer mapping (interaction-broker.ts):
    // - AskUserQuestion accept -> {action:"accept", content:{answers:{questionText: value}}}
    //   (normalizeAskUserQuestionAnswers: keyed by the question TEXT; arrays
    //   join with ", " per normalizeAnswerValue).
    // - Plan approval approve -> accept with answers["Review this implementation plan."]="approve";
    //   feedback -> accept with content.answer (becomes plan_approval_feedback deny upstream);
    //   decline -> {action:"decline"}.
    const entry: PendingInteractionEntry = {
      interactionId,
      respond: (actionId: string, values: Record<string, unknown>) => {
        if (isPlanApproval) {
          if (actionId === 'approve') {
            return {
              action: 'accept',
              content: { answers: { [PLAN_APPROVAL_QUESTION]: 'approve' } },
            };
          }
          if (actionId === 'feedback') {
            const feedback = readFeedbackValue(values);
            if (feedback === null) {
              throw new SessionInteractionActionError('feedback requires values.feedback text.');
            }
            return { action: 'accept', content: { answer: feedback } };
          }
          if (actionId === 'decline') return { action: 'decline' };
          throw new SessionInteractionActionError(actionId);
        }
        if (actionId === 'accept') {
          const answers: Record<string, string> = {};
          for (const [index, question] of questions.entries()) {
            const raw = values[`q${index}`];
            const normalized = normalizeAnswerValue(raw);
            if (normalized !== undefined) answers[question.question as string] = normalized;
          }
          return { action: 'accept', content: { answers } };
        }
        if (actionId === 'decline') return { action: 'decline' };
        throw new SessionInteractionActionError(actionId);
      },
    };
    this.pendingInteractions.set(interactionId, entry);
    return entry;
  }

  pendingEntry(interactionId: string): PendingInteractionEntry | undefined {
    return this.pendingInteractions.get(interactionId);
  }

  resolveInteraction(interactionId: string): void {
    this.pendingInteractions.delete(interactionId);
  }

  /** Diagnostics snapshot (bounded). */
  snapshot(): {
    lastNativeSeq: number;
    openContent: number;
    openActivities: number;
    pendingInteractions: number;
  } {
    return {
      lastNativeSeq: this.lastNativeSeq,
      openContent: this.openContent.size,
      openActivities: this.openActivities.size,
      pendingInteractions: this.pendingInteractions.size,
    };
  }
}

function numberOr(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Exact upstream ExitPlanMode approval question text
 *  (interaction-broker.ts:39). */
export const PLAN_APPROVAL_QUESTION = 'Review this implementation plan.';

/** Thrown when interaction.respond names an unadvertised actionId; the
 *  adapter maps it to INTERACTION_ACTION_NOT_FOUND. */
export class SessionInteractionActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionInteractionActionError';
  }
}

/** Mirror of upstream normalizeAnswerValue
 *  (interaction-broker.ts): strings trim; arrays join with ", ". */
function normalizeAnswerValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
      .join(', ');
  }
  return undefined;
}

function readFeedbackValue(values: Record<string, unknown>): string | null {
  const normalized = normalizeAnswerValue(values.feedback ?? values.text ?? values.q0);
  return normalized ?? null;
}

export type { InnerNativeEvent };
