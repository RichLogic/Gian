/**
 * Proxy projection service: shared-scope session/turn state and event
 * identity. It translates bridge/1.0 native facts into the canonical
 * gian.proxy/2.1 event vocabulary and owns the wire sequence per stream, the
 * stable sourceTurnId / eventId derivation, and the finalizing rules the Host
 * validator enforces (no open interactions/activities/steps/content at Turn
 * Terminal).
 */

import { createHash, randomUUID } from 'node:crypto';
import type { BridgeNotification } from '../runtime/bridge-client.js';

export const PLUGIN_ID = 'ai.deepseek.harness';
export const PLUGIN_VERSION = '0.3.5-Dev';
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
  acceptedTurns: Map<string, string>;
  activeTurn: string | null;
  sourceTurnByGianTurn: Map<string, string>;
  turnState: Map<string, TurnState>;
  createFingerprint: string;
  externalUserMessages: Array<{ seq: number; data: Record<string, unknown> }>;
  pendingGianTurns: string[];
  /** Set by the adapter when this turn's saved model is no longer advertised. */
  pendingModelReselect: {
    turnId: string;
    retiredModel: string;
    fallbackModel: string;
  } | null;
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
  format?: string;
  stepId?: string;
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

/**
 * One content stream per native step and assistant block. `gian.proxy/2`
 * freezes `kind` / `format` / `stepId` for a contentId, so text and reasoning
 * must never share an identity or leak into each other's presentation.
 */
export function contentIdFor(
  sourceTurnIdValue: string,
  nativeStep: number,
  kind = 'text',
  index = 0,
): string {
  const stepId = stepIdFor(sourceTurnIdValue, nativeStep);
  return kind === 'text' && index === 0
    ? `assistant-${stepId}`
    : `assistant-${kind}-${index}-${stepId}`;
}

const ASSISTANT_CONTENT_KIND = 'text';
const ASSISTANT_CONTENT_FORMAT = 'markdown';

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

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  discardAttachment(sessionId: string, createFingerprint: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.createFingerprint === createFingerprint && session.activeTurn === null) {
      this.sessions.delete(sessionId);
    }
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
      if (existing.createFingerprint !== params.createFingerprint
        || (params.nativeSessionId !== null && params.nativeSessionId !== existing.nativeSessionId)) {
        throw new ServiceError('CONFLICT', `Session ${params.sessionId} was reused with different params.`);
      }
      return existing;
    }
    const createdAt = nowIso();
    const session: AttachedSession = {
      id: params.sessionId,
      nativeSessionId: params.nativeSessionId,
      // Wall-clock milliseconds can collide across a rapid Proxy restart;
      // every attach generation must have a fresh stream identity.
      streamId: `stream-${params.sessionId}-${randomUUID()}`,
      cwd: params.cwd,
      roots: params.roots,
      sessionConfig: params.sessionConfig,
      state: 'idle',
      createdAt,
      updatedAt: createdAt,
      sequence: 0,
      closed: false,
      turnConfigOptionsRevision: null,
      acceptedTurns: new Map(),
      activeTurn: null,
      sourceTurnByGianTurn: new Map(),
      turnState: new Map(),
      createFingerprint: params.createFingerprint,
      externalUserMessages: [],
      pendingGianTurns: [],
      pendingModelReselect: null,
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

  /**
   * Side Chat close barrier (10.5.4): finalize the active turn and every open
   * child lifecycle now — interactions settle as `turn_ended`, open work is
   * cancelled, and the terminal turn event is emitted before the close
   * response is written — then drop the route so no notification is ever
   * projected for this Side Chat again.
   */
  closeSidechatRoute(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const turn = session.activeTurn !== null ? session.turnState.get(session.activeTurn) : undefined;
    if (turn) {
      this.terminalEvent(session, turn, 'turn.completed', { stopReason: 'cancelled' }, session.sequence + 1);
    }
    session.closed = true;
    session.state = 'closed';
    this.sessions.delete(sessionId);
  }

  /* ---------------- Notifications ---------------- */

  private nextEventId(
    session: AttachedSession,
    projectionKind: string,
    nativeSeq: number,
    ...identity: unknown[]
  ): string {
    return hashId([
      PLUGIN_ID,
      session.nativeSessionId ?? session.id,
      projectionKind,
      nativeSeq,
      ...identity,
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
    if (method === 'subagent.activity') {
      this.onSubagentActivity(session, notification);
      return;
    }
    if (method === 'session.event') {
      this.onSessionEvent(session, notification);
    }
  }

  /**
   * The shared DSH Host process exited. Every attached session's open turn
   * fails with a durable terminal error and every pending interaction settles
   * as `runtime_ended`; no session may stay open-ended across a crash.
   */
  handleRuntimeExited(): void {
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      for (const turn of session.turnState.values()) {
        this.terminalEvent(session, turn, 'turn.failed', {
          error: {
            domainCode: 'RUNTIME_ERROR',
            message: 'The shared DSH runtime process exited before the turn reached a terminal state.',
            retryable: false,
            details: { runtimeExited: true },
          },
        }, session.sequence + 1, 'runtime_ended');
      }
      if (session.state !== 'closed' && session.state !== 'error') {
        session.state = 'error';
        session.updatedAt = nowIso();
        session.sequence += 1;
        this.emitSessionUpdated(session);
      }
    }
  }

  private onSessionEvent(session: AttachedSession, notification: BridgeNotification): void {
    const type = notification.params.type as string;
    const data = (notification.params.data ?? {}) as Record<string, unknown>;
    const nativeSeq = typeof notification.params.nativeSeq === 'number'
      ? notification.params.nativeSeq
      : session.sequence;
    // Re-checked against @deepseek-ai/dsh@0.2.0-rc.2 KNOWN_SESSION_EVENT_TYPES.
    // tool/result.meta stays opaque JSON; FsDiffMeta is still { diffs, operation? }.
    // session/title and team/* stay on the generic path. This migration does
    // not adopt Team mode or SessionTitleService.rename.
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
      case 'approval/asked':
      case 'approval/decided':
      case 'session/end-seed':
        // Durable audit/fork-lineage facts. Live approvals are projected from
        // the dedicated interaction notifications; replay projects them from
        // these same events (replayEventFor). The fork cut marker is native
        // bookkeeping with no user-visible surface.
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
    this.emitRetiredModelNotice(session, turn, nativeSeq);
  }

  /**
   * A saved model id that pi-ai no longer advertises is replaced before the
   * bridge call. Tell the user on this turn so the fallback is not silent.
   * The activity is already terminal, so turn completion does not cancel it.
   */
  private emitRetiredModelNotice(session: AttachedSession, turn: TurnState, nativeSeq: number): void {
    const pending = session.pendingModelReselect;
    if (pending === null || pending.turnId !== turn.gianTurnId) return;
    session.pendingModelReselect = null;
    const activityId = `model-reselect-${turn.gianTurnId}`;
    turn.activities.set(activityId, {
      id: activityId,
      status: 'succeeded',
      enteredRunning: true,
    });
    session.sequence += 1;
    this.emit('activity.updated', {
      eventId: this.nextEventId(session, 'model-reselect', nativeSeq, activityId),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        activityId,
        kind: 'model-reselect',
        title: 'Reselect model',
        status: 'succeeded',
        presentation: {
          type: 'notice',
          tone: 'warning',
          data: {
            message: `Saved model "${pending.retiredModel}" is no longer available. This turn uses "${pending.fallbackModel}". Reselect a model for later turns.`,
          },
        },
      },
    });
  }

  private onTurnStart(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const nativeTurn = typeof data.turn === 'number' ? data.turn : 0;
    const { turn } = this.acceptTurn(session, nativeTurn);
    this.startTurnEvent(session, turn, nativeSeq);
  }

  private terminalEvent(
    session: AttachedSession,
    turn: TurnState,
    method: 'turn.completed' | 'turn.failed',
    data: Record<string, unknown>,
    nativeSeq: number,
    finalizeOutcome: 'turn_ended' | 'runtime_ended' = 'turn_ended',
  ): void {
    if (turn.terminal) return;
    // Finalize open interactions, activities, steps, and content first.
    for (const [, interaction] of turn.interactions) {
      if (interaction.resolved === false) {
        interaction.resolved = true;
        session.sequence += 1;
        this.emit('interaction.resolved', {
          eventId: this.nextEventId(session, 'interaction-resolved', nativeSeq, interaction.id),
          sessionId: session.id,
          streamId: session.streamId,
          sequence: session.sequence,
          turnId: turn.gianTurnId,
          sourceTurnId: turn.sourceTurnId,
          emittedAt: nowIso(),
          data: { interactionId: interaction.id, outcome: finalizeOutcome },
        });
      }
    }
    for (const [, activity] of turn.activities) {
      if (activity.enteredRunning && !TERMINAL_ACTIVITY.has(activity.status)) {
        activity.status = 'cancelled';
        session.sequence += 1;
        this.emit('activity.updated', {
          eventId: this.nextEventId(session, 'activity-final', nativeSeq, activity.id),
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
          eventId: this.nextEventId(session, 'step-final', nativeSeq, step.id),
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
          eventId: this.nextEventId(session, 'content-final', nativeSeq, content.id),
          sessionId: session.id,
          streamId: session.streamId,
          sequence: session.sequence,
          turnId: turn.gianTurnId,
          sourceTurnId: turn.sourceTurnId,
          emittedAt: nowIso(),
          data: {
            contentId: content.id,
            kind: content.kind,
            ...(content.format !== undefined ? { format: content.format } : {}),
            ...(content.stepId !== undefined ? { stepId: content.stepId } : {}),
          },
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

  private assistantContent(
    turn: TurnState,
    step: number,
    kind: 'text' | 'reasoning',
    index: number,
  ): ContentState {
    const stepId = stepIdFor(turn.sourceTurnId, step);
    const contentId = contentIdFor(turn.sourceTurnId, step, kind, index);
    const prior = turn.content.get(contentId);
    if (prior) return prior;
    const state: ContentState = {
      id: contentId,
      kind,
      ...(kind === ASSISTANT_CONTENT_KIND ? { format: ASSISTANT_CONTENT_FORMAT } : {}),
      stepId,
      open: true,
    };
    turn.content.set(contentId, state);
    return state;
  }

  private onAssistantChunk(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = this.turnForNative(session, numberField(data, 'turn'));
    if (!turn) return;
    const step = numberField(data, 'step');
    const chunk = (data.chunk ?? {}) as Record<string, unknown>;
    const kind = chunk.type === 'reasoning-delta'
      ? 'reasoning'
      : chunk.type === 'text-delta'
        ? 'text'
        : null;
    if (!kind) return;
    const index = typeof chunk.index === 'number' && Number.isSafeInteger(chunk.index)
      ? chunk.index
      : 0;
    const delta = typeof chunk.text === 'string' ? chunk.text : String(chunk.delta ?? '');
    if (delta === '') return;
    const state = this.assistantContent(turn, step, kind, index);
    if (state.open === false) return;
    session.sequence += 1;
    this.emit('content.delta', {
      eventId: typeof data.liveAttemptId === 'string' && Number.isSafeInteger(data.liveChunkIndex)
        ? hashId([session.nativeSessionId ?? session.id, 'assistant-stream', data.liveAttemptId, data.liveChunkIndex])
        : this.nextEventId(session, 'content-delta', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        contentId: state.id,
        kind: state.kind,
        ...(state.format !== undefined ? { format: state.format } : {}),
        ...(state.stepId !== undefined ? { stepId: state.stepId } : {}),
        delta,
      },
    });
  }

  private onAssistantMessage(session: AttachedSession, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = this.turnForNative(session, numberField(data, 'turn'));
    if (!turn) return;
    const step = numberField(data, 'step');
    const message = (data.message ?? {}) as Record<string, unknown>;
    const blocks = Array.isArray(message.content)
      ? message.content as Array<Record<string, unknown>>
      : [];
    for (const [index, block] of blocks.entries()) {
      const kind = block.type === 'reasoning' ? 'reasoning' : block.type === 'text' ? 'text' : null;
      if (!kind) continue;
      const state = this.assistantContent(turn, step, kind, index);
      if (state.open === false) continue;
      state.open = false;
      session.sequence += 1;
      this.emit('content.completed', {
        eventId: this.nextEventId(session, 'content-completed', nativeSeq, state.id),
        sessionId: session.id,
        streamId: session.streamId,
        sequence: session.sequence,
        turnId: turn.gianTurnId,
        sourceTurnId: turn.sourceTurnId,
        emittedAt: nowIso(),
        data: {
          contentId: state.id,
          kind: state.kind,
          ...(state.format !== undefined ? { format: state.format } : {}),
          ...(state.stepId !== undefined ? { stepId: state.stepId } : {}),
          content: String(block.text ?? ''),
        },
      });
    }

    // Per-step usage → Turn-scoped usage.updated delta + stepId, at most once.
    const usage = data.usage as Record<string, unknown> | undefined;
    if (usage && turn.usageSteps.has(stepIdFor(turn.sourceTurnId, step)) === false) {
      turn.usageSteps.add(stepIdFor(turn.sourceTurnId, step));
      const inputTokens = numberField(usage, 'inputTokens') ?? 0;
      const outputTokens = numberField(usage, 'outputTokens') ?? 0;
      const cacheReadTokens = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
      const cacheWriteTokens = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
      const cachedInputTokens = cacheReadTokens + cacheWriteTokens;
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
          conversation: {
            mode: 'delta',
            inputTokens,
            outputTokens,
            ...(cachedInputTokens === 0 ? {} : { cachedInputTokens }),
            totalTokens: inputTokens + outputTokens + cachedInputTokens,
          },
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
    // dsh-tool-fs attaches its result-time contextual diff hunks on the
    // tool/result meta (`FsDiffMeta`); each file becomes one diff.updated with
    // a diffId derived from the durable call identity. No meta → no diff.
    const diffs = diffsFromMeta(data.meta);
    if (diffs !== null) {
      for (const [fileIndex, file] of diffs.entries()) {
        session.sequence += 1;
        const diffId = hashId([session.nativeSessionId ?? session.id, 'diff', callId || String(nativeSeq), file.path, fileIndex]);
        this.emit('diff.updated', {
          eventId: this.nextEventId(session, 'diff-updated', nativeSeq, diffId),
          sessionId: session.id,
          streamId: session.streamId,
          sequence: session.sequence,
          turnId: turn.gianTurnId,
          sourceTurnId: turn.sourceTurnId,
          emittedAt: nowIso(),
          data: {
            diffId,
            diff: unifiedDiff(file),
            truncated: false,
            files: [{ path: file.path, status: diffStatusFor(file) }],
          },
        });
      }
    }
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
    const todos = Array.isArray(data.todos) ? data.todos as Array<Record<string, unknown>> : [];
    // DSH `todo/write` is a whole-list snapshot with stable content lines and
    // no per-item id, so step identity is derived from the durable facts
    // (position + content) and the plan id from the native session — the same
    // derivation replay uses.
    const nativeSessionId = session.nativeSessionId ?? session.id;
    const planId = `plan-${nativeSessionId}`;
    session.sequence += 1;
    this.emit('plan.updated', {
      eventId: this.nextEventId(session, 'plan-updated', nativeSeq),
      sessionId: session.id,
      streamId: session.streamId,
      sequence: session.sequence,
      turnId: turn.gianTurnId,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: nowIso(),
      data: {
        planId,
        title: 'Todo list',
        steps: todos.map((todo, index) => ({
          id: hashId([nativeSessionId, 'todo', index, String(todo.content ?? '')]),
          text: String(todo.content ?? ''),
          status: todoStatusFor(todo.status),
        })),
      },
    });
  }

  private onSubagentActivity(session: AttachedSession, notification: BridgeNotification): void {
    const turn = session.activeTurn ? session.turnState.get(session.activeTurn) : undefined;
    if (!turn) return;
    const agentId = typeof notification.params.agentId === 'string' ? notification.params.agentId : '';
    if (agentId.length === 0) return;
    const callId = typeof notification.params.callId === 'string' ? notification.params.callId : '';
    const name = typeof notification.params.name === 'string' ? notification.params.name : 'tool';
    const isCall = notification.params.kind === 'tool/call';
    const status = isCall ? 'running' : notification.params.error === true ? 'failed' : 'succeeded';
    const activityId = `child-${agentId}${callId.length > 0 ? `-${callId}` : ''}`;
    const existing = turn.activities.get(activityId);
    if (existing) existing.status = status;
    else turn.activities.set(activityId, { id: activityId, status, enteredRunning: true });
    session.sequence += 1;
    this.emit('activity.updated', {
      eventId: this.nextEventId(session, 'subagent-activity', session.sequence, activityId),
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
        status,
        presentation: {
          type: 'tool',
          data: { name, agentId },
        },
        details: {
          subagent: agentId,
          childNativeId: notification.params.childNativeId ?? null,
        },
      },
    });
  }

  private onGenericEvent(session: AttachedSession, type: string, data: Record<string, unknown>, nativeSeq: number): void {
    const turn = session.activeTurn ? session.turnState.get(session.activeTurn) : undefined;
    if (!turn) return;
    const activityId = `generic-${turn.sourceTurnId}-${nativeSeq}`;
    // Track generic activities in the turn state so turn terminal can finalize
    // any still-running projection (HostProtocolValidator: no open activities).
    turn.activities.set(activityId, { id: activityId, status: 'succeeded', enteredRunning: true });
    session.sequence += 1;
    this.emit('activity.updated', {
      eventId: this.nextEventId(session, 'activity-generic', nativeSeq, activityId),
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
        status: 'succeeded',
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
      context?: Record<string, unknown>;
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
    // The bridge anchors the interaction identity on the durable ask event's
    // native seq when it can observe one; otherwise the stream sequence is the
    // only available (live-only) identity basis.
    const identitySeq = typeof notification.params.nativeSeq === 'number'
      ? notification.params.nativeSeq
      : session.sequence;
    this.emit('interaction.requested', {
      eventId: this.nextEventId(session, 'interaction-requested', identitySeq, interactionId),
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
        presentation: { kind: data.kind === 'approval' ? 'permission' : data.kind === 'question' ? 'question' : data.kind === 'plan_review' ? 'confirmation' : 'choice' },
        inputs,
        actions,
        ...(data.context !== null && typeof data.context === 'object'
          ? { context: data.context as Record<string, never> }
          : {}),
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
    const identitySeq = typeof notification.params.nativeSeq === 'number'
      ? notification.params.nativeSeq
      : session.sequence;
    this.emit('interaction.resolved', {
      eventId: this.nextEventId(session, 'interaction-resolved', identitySeq, interactionId),
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
        ...(typeof notification.params.displaySummary === 'string'
          ? { displaySummary: notification.params.displaySummary }
          : {}),
      },
    });
  }

  private onSubagent(session: AttachedSession, method: string, notification: BridgeNotification): void {
    const turn = session.activeTurn ? session.turnState.get(session.activeTurn) : undefined;
    if (!turn) return;
    const agentId = (notification.params.agentId as string) ?? `child-${Date.now()}`;
    const rawState = method === 'subagent.started'
      ? 'running'
      : typeof notification.params.state === 'string' ? notification.params.state : 'completed';
    // Presentation state uses the protocol AGENT_STATES vocabulary; the
    // activity status uses the ACTIVITY_STATUSES vocabulary.
    const agentState = rawState === 'running' || rawState === 'completed'
      || rawState === 'failed' || rawState === 'interrupted'
      ? rawState
      : rawState === 'cancelled' ? 'interrupted' : 'completed';
    const activityStatus = agentState === 'running'
      ? 'running'
      : agentState === 'completed' ? 'succeeded' : agentState === 'failed' ? 'failed' : 'cancelled';
    session.sequence += 1;
    this.emit('activity.updated', {
      eventId: this.nextEventId(session, `subagent-${method}`, session.sequence, agentId),
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
        status: activityStatus,
        presentation: { type: 'agent', data: { agentId, state: agentState } },
        ...(typeof notification.params.stopReason === 'string'
          ? { details: { stopReason: notification.params.stopReason } }
          : {}),
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

/* ------------------------------------------------------------------ *
 * Native diff / plan derivations shared by live projection and replay.
 * ------------------------------------------------------------------ */

export interface NativeFileDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

/**
 * Narrow the opaque `tool/result.meta` to the `FsDiffMeta` shape
 * (`@deepseek-ai/dsh-tool-fs` diff.d.ts). Absent or malformed metadata yields
 * null — a diff is never guessed from tool arguments.
 */
export function diffsFromMeta(meta: unknown): NativeFileDiff[] | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const raw = (meta as { diffs?: unknown }).diffs;
  if (Array.isArray(raw) === false || raw.length === 0) return null;
  const diffs: NativeFileDiff[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.path !== 'string' || candidate.path.length === 0) return null;
    const oldText = candidate.oldText === null ? null
      : typeof candidate.oldText === 'string' ? candidate.oldText : undefined;
    if (oldText === undefined) return null;
    if (typeof candidate.newText !== 'string') return null;
    diffs.push({ path: candidate.path, oldText, newText: candidate.newText });
  }
  return diffs;
}

/** Protocol DIFF_FILE_STATUSES projection of one native hunk. */
export function diffStatusFor(diff: NativeFileDiff): 'added' | 'modified' | 'deleted' {
  if (diff.oldText === null) return 'added';
  if (diff.newText.length === 0) return 'deleted';
  return 'modified';
}

/**
 * Render one native contextual hunk as a unified-diff-style patch. DSH
 * exposes result-time hunks (3 context lines, no absolute line offsets), so
 * the hunk header carries line COUNTS with hunk-relative starts rather than
 * fabricated file offsets; the content lines are verbatim native data.
 */
export function unifiedDiff(diff: NativeFileDiff): string {
  const lines: string[] = [`--- a/${diff.path}`, `+++ b/${diff.path}`];
  const before = diff.oldText === null ? [] : diff.oldText.split('\n');
  const after = diff.newText.split('\n');
  if (before.length > 0 && before[before.length - 1] === '') before.pop();
  if (after.length > 0 && after[after.length - 1] === '') after.pop();
  lines.push(`@@ -1,${before.length} +1,${after.length} @@`);
  for (const line of before) lines.push(`-${line}`);
  for (const line of after) lines.push(`+${line}`);
  return lines.join('\n');
}

/** Protocol PLAN_STEP_STATUSES projection of a native todo status. */
export function todoStatusFor(status: unknown): 'pending' | 'in_progress' | 'completed' | 'failed' {
  return status === 'in_progress' ? 'in_progress'
    : status === 'completed' ? 'completed'
    : status === 'failed' ? 'failed'
    : 'pending';
}
