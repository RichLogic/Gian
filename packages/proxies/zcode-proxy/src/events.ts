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
  /** Called when the projector observes interaction requests. */
  onInteractionRequested?: (request: {
    interactionId: string;
    turnId: string | null;
    presentation: { kind: string; tone: string };
    title?: string;
    description?: string;
    inputs: Array<{ id: string; type: string; label: string; required: boolean; choices?: Array<{ value: string; displayName: string }> }>;
    actions: Array<{ id: string; label: string; style: string }>;
    context: Record<string, unknown>;
    native: { method: string; params: Record<string, unknown> };
  }) => void;
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

interface PendingInteraction {
  interactionId: string;
}

interface ActiveTurn {
  gianTurnId: string;
  nativeTurnId: string;
  interruptAccepted: boolean;
  foregroundExecutionId: string | null;
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
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private activeTurn: ActiveTurn | null = null;
  private lastUsage: Record<string, unknown> | null = null;
  private terminalSent = false;
  private observedTextContent = false;

  constructor(private readonly services: ProjectorServices) {}

  bindTurn(gianTurnId: string, nativeTurnId: string): void {
    this.activeTurn = {
      gianTurnId,
      nativeTurnId,
      interruptAccepted: false,
      foregroundExecutionId: null,
    };
    this.terminalSent = false;
    this.observedTextContent = false;
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
      // Iteration/model bookkeeping is not a user-visible activity.
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
    if (toolCallId === null) {
      this.emitGenericActivity('tool:unidentified', nativeEventId, payload);
      return;
    }
    const existing = this.openActivities.get(toolCallId);
    const toolName = typeof payload.toolName === 'string'
      ? payload.toolName
      : typeof payload.tool === 'string'
        ? payload.tool
        : typeof payload.name === 'string'
          ? payload.name
          : existing?.toolName ?? 'tool';
    const status = typeof payload.status === 'string' ? payload.status : null;
    const sourceId = nativeEventId ?? `${toolCallId}:${this.lastNativeSeq}`;

    if (status === 'completed' || status === 'failed' || payload.result !== undefined) {
      const result = (payload.result ?? payload.output ?? {}) as Record<string, unknown>;
      const success = status === 'failed' || result.success === false ? 'failed' : 'succeeded';
      const boundedOutput = bounded(result.content ?? result.output ?? result);
      this.emitTurnEvent('activity.updated', `${sourceId}:terminal`, {
        activityId: toolCallId,
        kind: `tool:${toolName}`,
        title: existing?.title ?? toolName,
        status: success,
        presentation: {
          type: 'tool',
          data: {
            name: toolName,
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
      title: existing?.title ?? toolName,
      toolName,
      input,
      output: existing?.output,
      status: 'running',
    });
    this.emitTurnEvent('activity.updated', sourceId, {
      activityId: toolCallId,
      kind: `tool:${toolName}`,
      title: toolName,
      status: 'running',
      presentation: {
        type: 'tool',
        data: {
          name: toolName,
          ...(input !== undefined ? { input } : {}),
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
          if (this.activeTurn.nativeTurnId === '') {
            this.activeTurn.nativeTurnId = turnId;
            this.emitTurnStarted(this.activeTurn.gianTurnId, turnId, nativeEventId);
          }
          return;
        }
        if (turnId === null) return;
        this.activeTurn = {
          gianTurnId: turnId,
          nativeTurnId: turnId,
          interruptAccepted: false,
          foregroundExecutionId: null,
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

  /** Handle an interaction reverse request surfaced by the adapter. */
  handlePermissionRequest(request: {
    requestId: string;
    nativeTurnId?: string;
    toolCallId?: string;
    toolName?: string;
    reason?: string;
    riskLevel?: string;
    input?: unknown;
    options?: Array<{ optionId?: string; kind?: string; name?: string; description?: string; response?: Record<string, unknown> }>;
    raw: Record<string, unknown>;
  }): boolean {
    const turn = this.activeTurn;
    if (turn === null) return false;
    // ZCode's permission reverse request carries the native turnId; bind it
    // when the typed turn-started has not arrived yet (WP0 G2 schema).
    if (turn.nativeTurnId === '' && typeof request.nativeTurnId === 'string' && request.nativeTurnId !== '') {
      turn.nativeTurnId = request.nativeTurnId;
    }
    if (turn.nativeTurnId === '') return false; // no stable identity: fail closed
    const interactionId = `int:${request.requestId}`;
    if (this.pendingInteractions.has(interactionId)) {
      // Desktop retries the same reverse request while the user is deciding.
      // Keep the newest transport request deferred in the adapter, but do not
      // emit duplicate interaction facts or consume outer sequence numbers.
      return true;
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
    if (actions.length === 0) return false;

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
    this.pendingInteractions.set(interactionId, { interactionId });
    this.services.onInteractionRequested?.({
      interactionId,
      turnId: turn.gianTurnId,
      presentation: { kind: 'permission', tone },
      title: request.toolName ?? 'Permission required',
      ...(request.reason !== undefined ? { description: request.reason } : {}),
      inputs: [],
      actions,
      context: { toolCallId: request.toolCallId ?? '' },
      native: { method: 'interaction/requestPermission', params: request.raw },
    });
    return true;
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

export type { InnerNativeEvent };
