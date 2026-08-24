/**
 * Proxy projection service: shared-scope session/turn state and event
 * identity. It translates bridge/1.0 native facts into the canonical
 * gian.proxy/2.0 event vocabulary and owns the wire sequence per stream, the
 * stable sourceTurnId / eventId derivation, and the finalizing rules the Host
 * validator enforces (no open interactions/activities/steps/content at Turn
 * Terminal).
 */

import { createHash } from 'node:crypto';
import type { BridgeNotification } from '../runtime/bridge-client.js';

export const PLUGIN_ID = 'ai.deepseek.harness';
export const PLUGIN_VERSION = '0.1.1';
export const PLUGIN_NAME = 'DeepSeek Harness';

export type ConfigValue = string | boolean | number | null;
export type SessionStateName = 'idle' | 'running' | 'waiting_interaction' | 'stale' | 'closed' | 'error';

export interface AttachedSession {
  id: string;
  nativeSessionId: string | null;
  streamId: string;
  cwd: string;
  roots: string[];
  sessionConfig: Record<string, ConfigValue>;
  state: SessionStateName;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  closed: boolean;
  turnConfigOptionsRevision: string | null;
  acceptedTurns: Set<string>;
  activeTurn: string | null;
  sourceTurnByGianTurn: Map<string, string>;
  turnState: Map<string, TurnState>;
  createFingerprint: string;
  externalUserMessages: Array<{ seq: number; data: Record<string, unknown> }>;
  pendingGianTurns: string[];
}

export interface TurnState {
  gianTurnId: string;
  sourceTurnId: string;
  started: boolean;
  terminal: boolean;
  interactions: Map<string, InteractionState>;
  activities: Map<string, ActivityState>;
  steps: Map<string, StepState>;
  content: Map<string, ContentState>;
  usageSteps: Set<string>;
  sequenceBase: number;
  interruptAccepted: boolean;
}

export interface InteractionState {
  id: string;
  actions: string[];
  requested: boolean;
  resolved: boolean;
  respondAccepted: boolean;
}
export interface ActivityState {
  id: string;
  status: string;
  enteredRunning: boolean;
}
export interface StepState {
  id: string;
  status: 'running' | 'completed' | 'failed';
  enteredRunning: boolean;
}
export interface ContentState {
  id: string;
  kind: string;
  open: boolean;
}

export interface EmittedEvent {
  method: string;
  params: Record<string, unknown>;
}

export interface InputItem {
  type: 'text' | 'localFile' | 'localImage' | 'skill';
  text?: string;
  path?: string;
  name?: string;
  mime?: string;
  size?: number;
}

export interface ServiceOptions {
  emit: (event: EmittedEvent) => void;
  pluginVersion?: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic hash identity with a stable namespace/format (plan §8.2). */
export function hashId(parts: unknown[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(parts));
  return hash.digest('hex').slice(0, 32);
}

/** `sourceTurnId` is derived from the native session id + native turn ordinal. */
export function sourceTurnId(nativeSessionId: string, nativeTurn: number): string {
  return `${nativeSessionId}:turn:${nativeTurn}`;
}

/** `stepId` is derived from sourceTurnId + native step ordinal (plan §4). */
export function stepIdFor(sourceTurnIdValue: string, nativeStep: number): string {
  return `${sourceTurnIdValue}:step:${nativeStep}`;
}

export class DshProxyService {
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly sourceTurnByIdentity = new Set<string>();
  private readonly catalogRevision = `dsh-catalog-${PLUGIN_VERSION}`;

  constructor(private readonly options: ServiceOptions) {}

  private emit(method: string, params: Record<string, unknown>): void {
    this.options.emit({ method, params });
  }

  /* ---------------- Session administration ---------------- */

  listSessions(): AttachedSession[] {
    return [...this.sessions.values()];
  }

  getSession(sessionId: string): AttachedSession | undefined {
    return this.sessions.get(sessionId);
  }

  requireSession(sessionId: string): AttachedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ServiceError('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    return session;
  }

  requireStream(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireSession(sessionId);
    if (session.streamId !== streamId) {
      throw new ServiceError('SESSION_STALE', `Stream ${streamId} is no longer active.`);
    }
    return session;
  }

  /** Create or idempotently return a session attachment. */
  attach(params: {
    sessionId: string;
    cwd: string;
    roots: string[];
    sessionConfig: Record<string, ConfigValue>;
    nativeSessionId: string | null;
    createFingerprint: string;
  }): AttachedSession {
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      if (existing.createFingerprint !== params.createFingerprint) {
        throw new ServiceError('CONFLICT', `Session ${params.sessionId} was reused with different params.`);
      }
      return existing;
    }
    const createdAt = nowIso();
    const session: AttachedSession = {
      id: params.sessionId,
      nativeSessionId: params.nativeSessionId,
      streamId: `stream-${params.sessionId}-${createdAt}`,
      cwd: params.cwd,
      roots: params.roots,
      sessionConfig: params.sessionConfig,
      state: 'idle',
      createdAt,
      updatedAt: createdAt,
      sequence: 0,
      closed: false,
      turnConfigOptionsRevision: null,
      acceptedTurns: new Set(),
      activeTurn: null,
      sourceTurnByGianTurn: new Map(),
      turnState: new Map(),
      createFingerprint: params.createFingerprint,
      externalUserMessages: [],
      pendingGianTurns: [],
    };
    this.sessions.set(params.sessionId, session);
    return session;
  }

  /** Register a Gian-issued turnId before native turn correlation (6.4). */
  prepareTurn(sessionId: string, turnId: string): void {
    this.requireSession(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) session.pendingGianTurns.push(turnId);
  }

  closeSession(sessionId: string, streamId: string): void {
    const session = this.requireStream(sessionId, streamId);
    session.closed = true;
    session.state = 'closed';
    session.updatedAt = nowIso();
    // session.close is a request whose success response is authoritative; the
    // Host validator deletes the attach on the response, so no session.updated
    // notification may follow it (10.11.4 step 7).
  }

  /* ---------------- Notifications ---------------- */

  private nextEventId(session: AttachedSession, projectionKind: string, nativeSeq: number): string {
    return hashId([
      PLUGIN_ID,
      session.nativeSessionId ?? session.id,
      projectionKind,
      nativeSeq,
      session.turnConfigOptionsRevision ?? this.catalogRevision,
    ]);
  }

  private emitSessionUpdated(session: AttachedSession): void {
    this.emit('session.updated', {
      eventId: this.nextEventId(session, 'session-updated', session.sequence),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      emittedAt: nowIso(),
      data: {
        state: session.state,
        updatedAt: session.updatedAt,
      },
    });
  }

  handleBridgeNotification(notification: BridgeNotification): void {
    const { method } = notification;
    if (method === 'catalog.changed') {
      this.emit('catalog.changed', {
        eventId: hashId(['catalog', this.catalogRevision, Date.now()]),
        emittedAt: nowIso(),
        data: { reason: 'catalog-changed' },
      });
      return;
    }
    // All other bridge notifications must be attributable to a session.
    const sessionId = notification.params.sessionId as string | undefined;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (method === 'agent.status') {
      const status = notification.params.status;
      if (status === 'running') {
        session.state = 'running';
      } else if (session.state === 'running' || session.state === 'waiting_interaction') {
        session.state = 'idle';
      }
      session.updatedAt = nowIso();
      return;
    }

    if (method === 'agent.error' || method === 'runtime.error') {
      session.state = 'error';
      session.updatedAt = nowIso();
      session.sequence += 1;
      this.emitSessionUpdated(session);
      return;
    }

    if (method === 'interaction.requested') {
      this.onInteractionRequested(session, notification);
      return;
    }
    if (method === 'interaction.resolved') {
      this.onInteractionResolved(session, notification);
      return;
    }
    if (method === 'subagent.started' || method === 'subagent.finished') {
      this.onSubagent(session, method, notification);
      return;
    }
    if (method === 'session.event') {
      this.onSessionEvent(session, notification);
    }
  }

  private onSessionEvent(session: AttachedSession, notification: BridgeNotification): void {
    const type = notification.params.type as string;
    const data = (notification.params.data ?? {}) as Record<string, unknown>;
    const nativeSeq = typeof notification.params.nativeSeq === 'number'
      ? notification.params.nativeSeq
      : session.sequence;
    switch (type) {
      case 'turn/start':
        this.onTurnStart(session, data, nativeSeq);
        return;
      case 'turn/end':
        this.onTurnEnd(session, data, nativeSeq);
        return;
      case 'step/start':
        this.onStepStart(session, data, nativeSeq);
        return;
      case 'step/end':
        this.onStepEnd(session, data, nativeSeq);
        return;
      case 'assistant/chunk':
        this.onAssistantChunk(session, data, nativeSeq);
        return;
      case 'assistant/message':
        this.onAssistantMessage(session, data, nativeSeq);
        return;
      case 'tool/call':
        this.onToolCall(session, data, nativeSeq);
        return;
      case 'tool/result':
        this.onToolResult(session, data, nativeSeq);
        return;
      case 'user/message':
        this.onUserMessage(session, data, nativeSeq);
        return;
      case 'request/header':
        this.onRequestHeader(session, data, nativeSeq);
        return;
      case 'request/context':
        this.onRequestContext(session, data, nativeSeq);
        return;
      case 'todo/write':
        this.onTodoWrite(session, data, nativeSeq);
        return;
      default:
        // Inbox bookkeeping is an internal correlation fact; it never becomes
        // a user-visible Activity and must not leave an open lifecycle.
        if (type.startsWith('agent/inbox/')) return;
        // Unknown durable event → generic activity (plan §7.1).
        this.onGenericEvent(session, type, data, nativeSeq);
    }
  }

  private turnForNative(session: AttachedSession, nativeTurn: number): TurnState | null {
    for (const turn of session.turnState.values()) {
      if (turn.sourceTurnId === sourceTurnId(session.nativeSessionId ?? session.id, nativeTurn)) {
        return turn;
      }
    }
    return null;
  }

  private acceptTurn(session: AttachedSession, nativeTurn: number): { turn: TurnState; isNew: boolean } {
    const found = this.turnForNative(session, nativeTurn);
    if (found) return { turn: found, isNew: false };
    const pending = session.pendingGianTurns.shift();
    const gianTurn = pending ?? `t-${nativeTurn}`;
    const identity = sourceTurnId(session.nativeSessionId ?? session.id, nativeTurn);
    if (this.sourceTurnByIdentity.has(identity)) {
      throw new ServiceError('CONFLICT', `sourceTurnId ${identity} is already active.`);
    }
    const turn: TurnState = {
      gianTurnId: gianTurn,
      sourceTurnId: identity,
      started: false,
      terminal: false,
      interactions: new Map(),
      activities: new Map(),
      steps: new Map(),
      content: new Map(),
      usageSteps: new Set(),
      sequenceBase: session.sequence,
      interruptAccepted: false,
    };
    session.turnState.set(gianTurn, turn);
    session.sourceTurnByGianTurn.set(gianTurn, identity);
    this.sourceTurnByIdentity.add(identity);
    return { turn, isNew: true };
  }

  private startTurnEvent(session: AttachedSession, turn: TurnState, nativeSeq: number): void {
    if (turn.started) return;
    turn.started = true;
    session.activeTurn = turn.gianTurnId;
    session.sequence += 1;
    this.emit('turn.started', {
      eventId: this.nextEventId(session, 'turn-started', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {},
    });
  }

  private onTurnStart(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const nativeTurn = typeof data.turn === 'number' ? data.turn : 0;
    const { turn } = this.acceptTurn(session, nativeTurn);
    this.startTurnEvent(session, turn, nativeSeq);
  }

  private terminalEvent(session: AttachedSession, turn: TurnState, method: 'turn.completed' | 'turn.failed', data: Record<string, unknown>, nativeSeq: number): void {
    if (turn.terminal) return;
    // Finalize open interactions, activities, steps, and content first.
    for (const [, interaction] of turn.interactions) {
      if (interaction.resolved === false) {
        interaction.resolved = true;
        session.sequence += 1;
        this.emit('interaction.resolved', {
          eventId: this.nextEventId(session, 'interaction-resolved', nativeSeq),
          sessionId: session.id,
          streamId: session.streamId,
          sequence: session.sequence,
          turnId: turn.gianTurnId,
          sourceTurnId: turn.sourceTurnId,
          emittedAt: nowIso(),
          data: { interactionId: interaction.id, outcome: 'turn_ended' },
        });
      }
    }
    for (const [, activity] of turn.activities) {
      if (activity.enteredRunning && !TERMINAL_ACTIVITY.has(activity.status)) {
        activity.status = 'cancelled';
        session.sequence += 1;
        this.emit('activity.updated', {
          eventId: this.nextEventId(session, 'activity-final', nativeSeq),
          sessionId: session.id,
          streamId: session.streamId,
          sequence: session.sequence,
          turnId: turn.gianTurnId,
          sourceTurnId: turn.sourceTurnId,
          emittedAt: nowIso(),
          data: {
            activityId: activity.id,
            kind: activity.id,
            title: activity.id,
            status: 'cancelled',
            presentation: { type: 'generic' },
          },
        });
      }
    }
    for (const [, step] of turn.steps) {
      if (step.enteredRunning && step.status === 'running') {
        step.status = 'failed';
        session.sequence += 1;
        this.emit('step.updated', {
          eventId: this.nextEventId(session, 'step-final', nativeSeq),
          sessionId: session.id,
          streamId: session.streamId,
          sequence: session.sequence,
          turnId: turn.gianTurnId,
          sourceTurnId: turn.sourceTurnId,
          emittedAt: nowIso(),
          data: { stepId: step.id, index: indexFromStepId(step.id), status: 'failed' },
        });
      }
    }
    for (const [, content] of turn.content) {
      if (content.open) {
        content.open = false;
        session.sequence += 1;
        this.emit('content.completed', {
          eventId: this.nextEventId(session, 'content-final', nativeSeq),
          sessionId: session.id,
          streamId: session.streamId,
          sequence: session.sequence,
          turnId: turn.gianTurnId,
          sourceTurnId: turn.sourceTurnId,
          emittedAt: nowIso(),
          data: { contentId: content.id, kind: content.kind },
        });
      }
    }
    turn.terminal = true;
    session.activeTurn = null;
    session.state = 'idle';
    session.sequence += 1;
    this.emit(method, {
      eventId: this.nextEventId(session, method, nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data,
    });
    session.updatedAt = nowIso();
    session.sequence += 1;
    this.emitSessionUpdated(session);
  }

  private onTurnEnd(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const nativeTurn = typeof data.turn === 'number' ? data.turn : 0;
    const turn = this.turnForNative(session, nativeTurn);
    if (!turn) return;
    const reason = (data.reason ?? {}) as Record<string, unknown>;
    const kind = typeof reason.kind === 'string' ? reason.kind : 'completed';
    const abortReason = (reason.reason ?? {}) as Record<string, unknown>;
    const abortKind = typeof abortReason.kind === 'string' ? abortReason.kind : 'unknown';
    switch (kind) {
      case 'completed':
        this.terminalEvent(session, turn, 'turn.completed', { stopReason: 'completed' }, nativeSeq);
        return;
      case 'max-tokens':
        this.terminalEvent(session, turn, 'turn.completed', { stopReason: 'limit_reached' }, nativeSeq);
        return;
      case 'blocked':
        this.terminalEvent(session, turn, 'turn.completed', { stopReason: 'refused' }, nativeSeq);
        return;
      case 'aborted':
        if (abortKind === 'user' && this.interruptAccepted(session, turn)) {
          this.terminalEvent(session, turn, 'turn.completed', { stopReason: 'interrupted' }, nativeSeq);
        } else {
          this.terminalEvent(session, turn, 'turn.completed', { stopReason: 'cancelled' }, nativeSeq);
        }
        return;
      case 'interrupted':
        // Crash-repair marker: map to turn.failed for replay (plan §7.4).
        this.terminalEvent(session, turn, 'turn.failed', {
          error: {
            domainCode: 'RUNTIME_ERROR',
            message: 'Native turn was interrupted by persistence crash repair.',
            retryable: false,
            details: { crashRepaired: true },
          },
        }, nativeSeq);
        return;
      case 'error':
        this.terminalEvent(session, turn, 'turn.failed', {
          error: {
            domainCode: 'RUNTIME_ERROR',
            message: 'Native turn failed.',
            retryable: false,
            details: { native: (reason.error ?? null) as unknown },
          },
        }, nativeSeq);
        return;
      default:
        this.terminalEvent(session, turn, 'turn.completed', { stopReason: 'other' }, nativeSeq);
    }
  }

  markInterruptAccepted(sessionId: string, turnId: string): void {
    const session = this.sessions.get(sessionId);
    const turn = session?.turnState.get(turnId);
    if (turn) turn.interruptAccepted = true;
  }

  private interruptAccepted(_session: AttachedSession, turn: TurnState): boolean {
    return turn.interruptAccepted;
  }

  private onStepStart(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = this.turnForNative(session, numberField(data, 'turn'));
    if (!turn) return;
    const step = numberField(data, 'step');
    const stepId = stepIdFor(turn.sourceTurnId, step);
    const state: StepState = { id: stepId, status: 'running', enteredRunning: true };
    turn.steps.set(stepId, state);
    session.sequence += 1;
    this.emit('step.updated', {
      eventId: this.nextEventId(session, 'step-updated', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: { stepId, index: step, status: 'running' },
    });
  }

  private onStepEnd(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = this.turnForNative(session, numberField(data, 'turn'));
    if (!turn) return;
    const step = numberField(data, 'step');
    const stepId = stepIdFor(turn.sourceTurnId, step);
    const state = turn.steps.get(stepId);
    if (state) state.status = 'completed';
    session.sequence += 1;
    this.emit('step.updated', {
      eventId: this.nextEventId(session, 'step-updated', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: { stepId, index: step, status: 'completed' },
    });
  }

  private onAssistantChunk(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = this.turnForNative(session, numberField(data, 'turn'));
    if (!turn) return;
    const step = numberField(data, 'step');
    const chunk = (data.chunk ?? {}) as Record<string, unknown>;
    const delta = typeof chunk.text === 'string' ? chunk.text : String(chunk.delta ?? '');
    if (delta === '') return;
    const contentId = `assistant-${turn.sourceTurnId}`;
    const prior = turn.content.get(contentId);
    if (prior && prior.open === false) return;
    turn.content.set(contentId, { id: contentId, kind: 'text', open: true });
    session.sequence += 1;
    this.emit('content.delta', {
      eventId: this.nextEventId(session, 'content-delta', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        contentId,
        kind: 'text',
        format: 'markdown',
        stepId: stepIdFor(turn.sourceTurnId, step),
        delta,
      },
    });
  }

  private onAssistantMessage(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = this.turnForNative(session, numberField(data, 'turn'));
    if (!turn) return;
    const step = numberField(data, 'step');
    const message = (data.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message.content) && message.content.length > 0
      ? (message.content as Array<Record<string, unknown>>).map((block) => (
        block.type === 'text' ? String(block.text ?? '')
          : block.type === 'reasoning' ? String(block.text ?? '')
            : ''
      )).join('')
      : '';
    const contentId = `assistant-${turn.sourceTurnId}`;
    const state = turn.content.get(contentId) ?? { id: contentId, kind: 'text', open: true };
    state.open = false;
    turn.content.set(contentId, state);
    session.sequence += 1;
    this.emit('content.completed', {
      eventId: this.nextEventId(session, 'content-completed', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: { contentId, kind: 'text', format: 'markdown', stepId: stepIdFor(turn.sourceTurnId, step), content },
    });

    // Per-step usage → Turn-scoped usage.updated delta + stepId, at most once.
    const usage = data.usage as Record<string, unknown> | undefined;
    if (usage && turn.usageSteps.has(stepIdFor(turn.sourceTurnId, step)) === false) {
      turn.usageSteps.add(stepIdFor(turn.sourceTurnId, step));
      const inputTokens = numberField(usage, 'inputTokens') ?? 0;
      const outputTokens = numberField(usage, 'outputTokens') ?? 0;
      session.sequence += 1;
      this.emit('usage.updated', {
        eventId: this.nextEventId(session, 'usage-updated', nativeSeq),
        sessionId: session.id,
        streamId: session.streamId,
        sequence: session.sequence,
        turnId: turn.gianTurnId,
        sourceTurnId: turn.sourceTurnId,
        emittedAt: nowIso(),
        data: {
          stepId: stepIdFor(turn.sourceTurnId, step),
          conversation: { mode: 'delta', inputTokens, outputTokens },
        },
      });
    }
  }

  private onToolCall(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = this.turnForNative(session, numberField(data, 'turn'));
    if (!turn) return;
    const callId = stringField(data, 'callId');
    const name = stringField(data, 'name');
    const step = numberField(data, 'step');
    const activityId = callId;
    turn.activities.set(activityId, { id: activityId, status: 'running', enteredRunning: true });
    session.sequence += 1;
    this.emit('activity.updated', {
      eventId: this.nextEventId(session, 'activity-updated', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        activityId,
        kind: name,
        title: name,
        status: 'running',
        stepId: stepIdFor(turn.sourceTurnId, step),
        presentation: { type: 'tool', data: { name, input: stringField(data, 'arguments') } },
      },
    });
  }

  private onToolResult(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = this.turnForNative(session, numberField(data, 'turn'));
    if (!turn) return;
    const message = (data.message ?? {}) as Record<string, unknown>;
    const callId = typeof message.callId === 'string' ? message.callId : '';
    const activity = callId ? turn.activities.get(callId) : undefined;
    const activityId = callId || `tool-${nativeSeq}`;
    const status = data.error ? 'failed' : 'succeeded';
    if (activity) activity.status = status;
    session.sequence += 1;
    this.emit('activity.updated', {
      eventId: this.nextEventId(session, 'activity-updated', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        activityId,
        kind: activityId,
        title: activityId,
        status,
        presentation: {
          type: 'tool',
          data: { name: activityId, output: JSON.stringify(message.content ?? '') },
        },
        details: {
          native: (message.content ?? null) as unknown,
        },
      },
    });
  }

  private onUserMessage(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    // Live path forbids input.recorded; only replay imports user messages
    // produced outside Gian (plan §8.4). The fake runtime emits a user/message
    // for Gian's own turn, so it is intentionally not duplicated here.
    const source = typeof data.source === 'string' ? data.source : 'gian';
    if (source === 'gian') return;
    // External user message during live → replay-only: silently record for replay.
    session.externalUserMessages ??= [];
    session.externalUserMessages.push({ seq: nativeSeq, data });
  }

  private onRequestHeader(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = this.turnForNative(session, numberField(data, 'turn'));
    if (!turn) return;
    const step = numberField(data, 'step');
    const reason = data.reason === 'resume' ? 'resume' : data.reason === 'change' ? 'change' : 'initial';
    const header = (data.header ?? {}) as Record<string, unknown>;
    const config = (header.config ?? {}) as Record<string, unknown>;
    const model = config.model !== undefined ? String(config.model) : 'deepseek-chat';
    const provider = config.provider !== undefined ? String(config.provider) : 'deepseek';
    session.sequence += 1;
    this.emit('request.updated', {
      eventId: this.nextEventId(session, 'request-updated', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        requestId: `request-${stepIdFor(turn.sourceTurnId, step)}`,
        reason,
        stepId: stepIdFor(turn.sourceTurnId, step),
        model: { provider, id: model },
        ...(typeof header.system === 'string' ? { systemPrompt: { text: header.system, truncated: false } } : {}),
        ...(Array.isArray(header.tools)
          ? { tools: (header.tools as Array<Record<string, unknown>>).map((tool) => ({ name: String(tool.name ?? '') })) }
          : {}),
      },
    });
  }

  private onRequestContext(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = session.activeTurn ? session.turnState.get(session.activeTurn) : undefined;
    if (!turn) return;
    const contextWindow = typeof data.contextWindow === 'number'
      ? data.contextWindow
      : undefined;
    session.sequence += 1;
    this.emit('request.updated', {
      eventId: this.nextEventId(session, 'request-context', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        requestId: `request-${turn.sourceTurnId}`,
        reason: 'change',
        ...(contextWindow ? { context: { window: contextWindow } } : {}),
      },
    });
  }

  private onTodoWrite(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = session.activeTurn ? session.turnState.get(session.activeTurn) : undefined;
    if (!turn) return;
    const todos = Array.isArray(data.todos) ? data.todos : [];
    session.sequence += 1;
    this.emit('activity.updated', {
      eventId: this.nextEventId(session, 'activity-todo', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        activityId: `todo-${turn.sourceTurnId}`,
        kind: 'todo',
        title: 'Todos',
        status: 'running',
        presentation: { type: 'generic' },
        details: { todos: todos as unknown },
      },
    });
  }

  private onGenericEvent(session: AttachedSession, type: string, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = session.activeTurn ? session.turnState.get(session.activeTurn) : undefined;
    if (!turn) return;
    const activityId = `generic-${turn.sourceTurnId}-${nativeSeq}`;
    // Track generic activities in the turn state so turn terminal can finalize
    // any still-running projection (HostProtocolValidator: no open activities).
    turn.activities.set(activityId, { id: activityId, status: 'running', enteredRunning: true });
    session.sequence += 1;
    this.emit('activity.updated', {
      eventId: this.nextEventId(session, 'activity-generic', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        activityId,
        kind: type,
        title: type,
        status: 'running',
        presentation: { type: 'generic' },
        details: data as unknown,
      },
    });
  }

  private onInteractionRequested(session: AttachedSession, notification: BridgeNotification): void {
    const data = notification.params as unknown as {
      interactionId: string;
      kind: string;
      title?: string;
      description?: string;
      inputs?: Array<Record<string, unknown>>;
      actions?: Array<{ id: string; label: string; style: string }>;
      turn?: number;
    };
    const turn = session.activeTurn ? session.turnState.get(session.activeTurn)
      : data.turn !== undefined ? this.turnForNative(session, data.turn) : undefined;
    if (!turn) return;
    const interactionId = data.interactionId ?? `native-interaction-${turn.sourceTurnId}`;
    if (turn.interactions.has(interactionId)) return;
    const actions = (data.actions ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      style: (action.style === 'primary' || action.style === 'secondary' || action.style === 'danger')
        ? action.style
        : 'secondary' as const,
    }));
    if (actions.length === 0) {
      actions.push({ id: 'submit', label: 'Submit', style: 'primary' as const });
    }
    const inputs = (data.inputs ?? []).map((input) => ({
      id: String(input.id ?? ''),
      type: (['text', 'multiline_text', 'single_select', 'multi_select', 'boolean'].includes(String(input.type))
        ? String(input.type)
        : 'text') as 'text',
      label: String(input.label ?? ''),
      required: input.required === true,
      ...(Array.isArray(input.choices)
        ? {
            choices: (input.choices as Array<Record<string, unknown>>).map((choice) => ({
              value: String(choice.value ?? ''),
              displayName: String(choice.displayName ?? ''),
            })),
          }
        : {}),
      ...(input.sensitive === true ? { sensitive: true } : {}),
    }));
    turn.interactions.set(interactionId, {
      id: interactionId,
      actions: actions.map((action) => action.id),
      requested: true,
      resolved: false,
      respondAccepted: false,
    });
    session.state = 'waiting_interaction';
    session.sequence += 1;
    this.emit('interaction.requested', {
      eventId: this.nextEventId(session, 'interaction-requested', session.sequence),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        interactionId,
        ...(typeof data.title === 'string' ? { title: data.title } : {}),
        ...(typeof data.description === 'string' ? { description: data.description } : {}),
        presentation: { kind: data.kind === 'approval' ? 'permission' : data.kind === 'question' ? 'question' : 'choice' },
        inputs,
        actions,
      },
    });
  }

  private onInteractionResolved(session: AttachedSession, notification: BridgeNotification): void {
    const interactionId = notification.params.interactionId as string;
    const outcome = notification.params.outcome === 'submitted' ? 'submitted' : 'cancelled';
    const actionId = notification.params.actionId as string | undefined;
    const sessionTurn = session.activeTurn ? session.turnState.get(session.activeTurn) : undefined;
    let turn = sessionTurn;
    if (!turn) {
      for (const candidate of session.turnState.values()) {
        if (candidate.interactions.has(interactionId)) { turn = candidate; break; }
      }
    }
    if (!turn) return;
    const interaction = turn.interactions.get(interactionId);
    if (!interaction || interaction.resolved) return;
    interaction.resolved = true;
    session.state = 'running';
    session.sequence += 1;
    this.emit('interaction.resolved', {
      eventId: this.nextEventId(session, 'interaction-resolved', session.sequence),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        interactionId,
        outcome,
        ...(outcome === 'submitted' && actionId !== undefined ? { actionId } : {}),
      },
    });
  }

  private onSubagent(session: AttachedSession, method: string, notification: BridgeNotification): void {
    const turn = session.activeTurn ? session.turnState.get(session.activeTurn) : undefined;
    if (!turn) return;
    const agentId = (notification.params.agentId as string) ?? `child-${Date.now()}`;
    const state = method === 'subagent.started' ? 'running' : notification.params.state === 'failed' ? 'failed' : 'completed';
    session.sequence += 1;
    this.emit('activity.updated', {
      eventId: this.nextEventId(session, `subagent-${method}`, session.sequence),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        activityId: agentId,
        kind: 'subagent',
        title: agentId,
        status: state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'succeeded',
        presentation: { type: 'agent', data: { agentId, state } },
      },
    });
  }
}

export class ServiceError extends Error {
  constructor(readonly domainCode: string, message: string) {
    super(message);
    this.name = 'DshProxyError';
  }
}

const TERMINAL_ACTIVITY = new Set(['succeeded', 'failed', 'cancelled']);

function numberField(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === 'number' ? value : 0;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

function indexFromStepId(_stepId: string): number {
  return 0;
}
