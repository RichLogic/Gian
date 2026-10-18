import { isAbsolute } from 'node:path';

import type {
  ContentBlock,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import type {
  AntigravityRuntimeClient,
  AntigravityService,
  ConfigValues,
  CreateServiceSession,
  InteractionOutcome,
  RuntimeStopped,
  ServiceEvent,
  ServiceSession,
  SessionState,
  StartServiceTurn,
} from '../contracts.js';
import { ConfigValidationError, validateConfigValues } from './catalog.js';
import { AntigravityProxyError, type AntigravityErrorDetails } from './errors.js';
import { normalizeInputItems } from './input.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SESSIONS = 32;
/** Per-native queue. The next update invalidates the stream instead of dropping a prefix. */
export const MAX_BUFFER_PER_NATIVE = 200;
/** Process-wide queue. Overflow invalidates the stream that could not be stored. */
export const MAX_BUFFER_TOTAL = 1_000;
/** Drain iterations. Leftovers invalidate the stream instead of being discarded. */
export const MAX_DRAIN_ROUNDS = 50;

type Phase = 'attaching' | 'flushing' | 'live' | 'dead';
type TurnPhase = 'idle' | 'starting' | 'prompting' | 'cancelling';

interface InternalSession {
  id: string;
  nativeSessionId: string;
  cwd: string;
  state: SessionState;
  activeTurnId: string | null;
  turnSettled: boolean;
  turnPhase: TurnPhase;
  /** True only while this service invocation is inside native cancel. */
  cancelInFlight: boolean;
  /** True once `dispatchPrompt` is invoked, until that native turn is settled. */
  nativePromptLive: boolean;
  phase: Phase;
  generation: number;
  configOptions: SessionConfigOption[];
  lastError: string | null;
  /** Set when a bounded queue invalidates this session. */
  invalidation: AntigravityProxyError | null;
  createdAt: string;
  updatedAt: string;
}

interface BufferedUpdate {
  generation: number;
  replay: boolean;
  notification: SessionNotification;
}

interface PendingPermission {
  interactionId: string;
  sessionId: string;
  turnId: string;
  generation: number;
  optionIds: readonly string[];
  settled: boolean;
  resolve: (response: RequestPermissionResponse) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface NativeHold {
  uncertain: boolean;
}

export interface AntigravityProxyServiceOptions {
  runtime: AntigravityRuntimeClient;
  approvalTimeoutMs?: number;
  cancelTimeoutMs?: number;
  maxSessions?: number;
  now?: () => Date;
}

/**
 * Gian session lifecycle in front of one shared Antigravity ACP runtime.
 * Native session ids are mapped, never used as Gian ids. `startTurn` returns
 * after `dispatchPrompt` accepts the turn. An unexpected runtime exit marks
 * every affected session stale and does not send the prompt again. Close
 * detaches only after a confirmed native terminal result or a runtime exit.
 * An unconfirmed cancel leaves the session attached. `closeSession` does not
 * stop the shared runtime while another session is live. `close` owns every
 * session: it always attempts a bounded runtime stop and reports cleanup
 * failures. `close` rejects later admission for this service instance.
 * `closeSession` does not: after one session closes, another may be created.
 * After the last live session stops the runtime, a later create or list
 * starts a new generation without resending old prompts. A buffer overflow
 * that drops a live prompt sends one bounded `session/cancel` for that native
 * id, keeps the id uncertain, and does not invent a terminal result. A late
 * cancel timeout or rejection is ignored once that runtime generation is gone.
 */
export class AntigravityProxyService implements AntigravityService {
  private readonly runtime: AntigravityRuntimeClient;
  private readonly approvalTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly now: () => Date;
  private sink: ((event: ServiceEvent) => void) | null = null;
  private readonly sessions = new Map<string, InternalSession>();
  /** Live Gian owner, or `retained:<nativeId>` after a local detach. */
  private readonly nativeOwners = new Map<string, string>();
  private readonly retained = new Map<string, NativeHold>();
  private reservations = 0;
  private readonly buffers = new Map<string, BufferedUpdate[]>();
  private readonly overflowed = new Set<string>();
  private bufferTotal = 0;
  private readonly pendingReplay = new Set<string>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly turnWaiters = new Map<string, Array<() => void>>();
  private permissionSeq = 0;
  private generation = 0;
  private ready = false;
  private runtimeStopped = false;
  private runtimeStopSeen = false;
  private acceptUpdates = false;
  private stopInFlight: Promise<void> | null = null;
  /** Stays set after `close` begins. `closeSession` does not set it. */
  private admissionClosed = false;
  /** Native ids whose lost prompt already received one bounded cancel. */
  private readonly lostCancels = new Set<string>();

  constructor(options: AntigravityProxyServiceOptions) {
    this.runtime = options.runtime;
    this.approvalTimeoutMs = finiteDuration(options.approvalTimeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS, 'approvalTimeoutMs');
    this.cancelTimeoutMs = finiteDuration(options.cancelTimeoutMs, DEFAULT_CANCEL_TIMEOUT_MS, 'cancelTimeoutMs');
    this.maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS, 'maxSessions');
    this.now = options.now ?? (() => new Date());
    this.runtime.setPermissionHandler((request) => this.onPermission(request));
    this.runtime.on('sessionUpdate', (notification) => this.onSessionUpdate(notification));
    this.runtime.on('runtimeStopped', (event) => this.onRuntimeStopped(event));
  }

  setEventSink(sink: (event: ServiceEvent) => void): void {
    this.sink = sink;
  }

  async initialize(): Promise<InitializeResponse> {
    this.assertAdmitting();
    if (!this.ready || this.runtimeStopped) {
      // A stopped runtime is reusable. Bump past the previous generation so
      // its buffered updates cannot be drained into the new process. Stale
      // and closed sessions stay as they are; nothing is dispatched again.
      if (this.generation === 0 || this.runtimeStopped) this.generation += 1;
      this.clearBuffers();
      this.pendingReplay.clear();
      this.runtimeStopped = false;
      this.runtimeStopSeen = false;
      this.acceptUpdates = false;
    }
    let response: InitializeResponse;
    try {
      response = await this.runtime.ensureStarted();
    } catch (error) {
      this.ready = false;
      this.acceptUpdates = false;
      throw wrapRuntime(error, 'Runtime failed to start.');
    }
    if (this.admissionClosed || this.runtimeStopped) {
      this.ready = false;
      this.acceptUpdates = false;
      if (this.admissionClosed) {
        // ensureStarted already returned. Do not claim that no runtime exists.
        throw this.error(
          'RUNTIME_UNAVAILABLE',
          'Admission is retired. The runtime start is uncertain and was not resent.',
          false,
          { resent: false, uncertain: true },
        );
      }
      throw this.error(
        'RUNTIME_UNAVAILABLE',
        'Runtime exited during initialize. No prompt was sent.',
        true,
        { resent: false },
      );
    }
    this.runtime.setPermissionHandler((request) => this.onPermission(request));
    this.ready = true;
    this.acceptUpdates = true;
    return response;
  }

  async createSession(params: CreateServiceSession): Promise<ServiceSession> {
    this.assertAdmitting();
    await this.ensureRuntime();
    this.assertAdmitting();
    const sessionId = requireText(params.sessionId, 'sessionId');
    const cwd = requireCwd(params.cwd);
    const existing = this.sessions.get(sessionId);
    if (existing && existing.phase !== 'dead') {
      throw this.error('CONFLICT', `Session ${sessionId} is already attached.`, false, { sessionId });
    }
    if (existing) this.sessions.delete(sessionId);
    const restoring = params.nativeSessionId !== undefined;
    const nativeSessionId = restoring ? requireText(params.nativeSessionId, 'nativeSessionId') : '';
    if (params.resumeMode !== undefined && params.resumeMode !== 'load' && params.resumeMode !== 'resume') {
      throw this.error('CONFIG_VALUE_INVALID', 'resumeMode must be "load" or "resume".', false);
    }
    if (params.resumeMode !== undefined && !restoring) {
      throw this.error('CONFIG_VALUE_INVALID', 'resumeMode requires an exact nativeSessionId.', false);
    }
    assertMcpServers(params.mcpServers);
    const mode = params.resumeMode ?? (restoring ? 'load' : undefined);
    const session = this.blankSession(sessionId, cwd);
    this.sessions.set(sessionId, session);
    let reservedNew = false;
    let ownedNative = false;
    try {
      let responseConfig: SessionConfigOption[] | null | undefined;
      if (restoring) {
        this.holdNative(nativeSessionId, sessionId);
        ownedNative = true;
        session.nativeSessionId = nativeSessionId;
        this.pendingReplay.add(nativeSessionId);
        if (mode === 'resume') {
          const response = await this.runtime.resumeSession(resumeRequest(nativeSessionId, cwd, params.mcpServers));
          responseConfig = response.configOptions;
        } else {
          const response = await this.runtime.loadSession(loadRequest(nativeSessionId, cwd, params.mcpServers));
          responseConfig = response.configOptions;
        }
      } else {
        this.reserveNewNative();
        reservedNew = true;
        const response = await this.runtime.newSession({
          cwd,
          mcpServers: params.mcpServers ?? [],
        });
        const createdId = nativeIdFromNew(response);
        this.claimReservedNative(createdId, sessionId);
        reservedNew = false;
        ownedNative = true;
        session.nativeSessionId = createdId;
        responseConfig = response.configOptions;
      }
      this.assertAttachCurrent(session);
      this.adoptConfigOptions(session, responseConfig ?? []);
      this.drainAttach(session);
      this.assertAttachCurrent(session);
      // Options exist only after the native create/load/resume response.
      const config = { ...params.config };
      // New sessions start conservatively; resume retains its native mode.
      if (!restoring && !Object.hasOwn(config, 'mode') && session.configOptions.some(option => (
        option.id === 'mode' && option.type === 'select'
        && (option.currentValue === 'auto_edit' || option.currentValue === 'yolo'
          || option.options.some(choice => 'value' in choice && choice.value === 'default'))
      ))) config.mode = 'default';
      await this.applyStringConfig(session, config);
      this.assertAttachCurrent(session);
      this.drainAttach(session);
      this.assertAttachCurrent(session);
      this.assertAdmitting();
      session.phase = 'live';
      session.state = 'idle';
      session.updatedAt = this.timestamp();
      const snapshot = this.snapshot(session);
      this.emit({ kind: 'session.changed', session: snapshot });
      return snapshot;
    } catch (error) {
      const proxyError = error instanceof AntigravityProxyError
        ? error
        : wrapRuntime(error, 'Native session attach failed.');
      const enriched = annotateNative(proxyError, session.nativeSessionId);
      if (this.runtimeStopped || isDead(session)) throw enriched;
      this.abandonCreate(session, reservedNew, ownedNative);
      throw enriched;
    }
  }

  getSession(sessionId: string): ServiceSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw this.error('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`, false, { sessionId });
    }
    return this.snapshot(session);
  }

  async startTurn(params: StartServiceTurn): Promise<{ turnId: string }> {
    this.assertAdmitting();
    const session = this.requireOperable(params.sessionId);
    const turnId = requireText(params.turnId, 'turnId');
    const prompt = normalizeInputItems(params.prompt);
    if (session.activeTurnId !== null || session.state === 'running' || session.state === 'waiting_interaction') {
      throw this.error('SESSION_BUSY', `Session ${session.id} already has an active turn.`, true, {
        sessionId: session.id,
        turnId: session.activeTurnId,
      });
    }
    session.activeTurnId = turnId;
    session.turnSettled = false;
    session.turnPhase = 'starting';
    session.state = 'running';
    session.updatedAt = this.timestamp();
    try {
      await this.applyStringConfig(session, params.config);
      this.assertTurnCurrent(session, turnId);
      this.assertAdmitting();
      session.nativePromptLive = true;
      const dispatched = await this.runtime.dispatchPrompt({
        sessionId: session.nativeSessionId,
        prompt,
      });
      // Attach before any later refusal. A cancellation or exit race can
      // reject this promise after dispatch returns, and that rejection must
      // stay observed even when startTurn throws.
      this.watchPrompt(dispatched.response, session.id, turnId);
      if (this.admissionClosed) {
        this.cancelLostPrompt(session.nativeSessionId);
        throw this.error(
          'RUNTIME_UNAVAILABLE',
          'Admission is retired. The dispatched turn is uncertain and was not resent.',
          false,
          { sessionId: session.id, turnId, resent: false, uncertain: true },
        );
      }
      if (isDead(session) && !this.runtimeStopped) {
        throw this.invalidationError(session, 'The turn was invalidated before it was accepted. The prompt was not resent.');
      }
      if (session.turnSettled || isDead(session) || this.runtimeStopped) {
        throw this.error(
          'RUNTIME_UNAVAILABLE',
          'Runtime exited before the turn was accepted. The prompt was not resent.',
          true,
          { sessionId: session.id, turnId, resent: false },
        );
      }
      this.emit({ kind: 'turn.started', sessionId: session.id, turnId });
      this.emit({ kind: 'session.changed', session: this.snapshot(session) });
      // Interrupt during dispatch already moved the turn to cancelling.
      // Promoting it back to prompting would open another approval wait.
      if ((session.turnPhase as TurnPhase) !== 'cancelling') session.turnPhase = 'prompting';
      this.drainTurnUpdates(session);
      if (isDead(session) || this.overflowed.has(session.nativeSessionId)) {
        throw this.invalidationError(session, 'Turn updates were invalidated. The prompt was not resent.');
      }
      return { turnId };
    } catch (error) {
      const proxyError = error instanceof AntigravityProxyError
        ? error
        : wrapRuntime(error, 'The turn was not dispatched.');
      this.rollbackUnstartedTurn(session, turnId);
      throw proxyError;
    }
  }

  async interruptTurn(sessionId: string, turnId?: string): Promise<void> {
    const session = this.requireKnown(sessionId);
    if (session.state === 'closed') {
      throw this.error('SESSION_CLOSED', `Session ${sessionId} is closed.`, false, { sessionId });
    }
    if (session.state === 'stale' || isDead(session)) {
      throw this.error('SESSION_STALE', `Session ${sessionId} is stale.`, true, { sessionId });
    }
    if (session.activeTurnId === null || session.turnSettled) {
      if (turnId !== undefined) {
        throw this.error('TURN_NOT_FOUND', `Turn ${turnId} is not active.`, false, { sessionId, turnId });
      }
      return;
    }
    if (turnId !== undefined && turnId !== session.activeTurnId) {
      throw this.error('TURN_NOT_FOUND', `Turn ${turnId} is not the active turn.`, false, {
        sessionId,
        turnId,
        activeTurnId: session.activeTurnId,
      });
    }
    const activeTurnId = session.activeTurnId;
    if (!session.cancelInFlight) {
      session.cancelInFlight = true;
      session.turnPhase = 'cancelling';
      session.updatedAt = this.timestamp();
      this.settleTurnPermissions(session, activeTurnId, 'cancelled');
      if (session.state === 'waiting_interaction' && !session.turnSettled) {
        session.state = 'running';
        this.emit({ kind: 'session.changed', session: this.snapshot(session) });
      }
      try {
        await this.runtime.cancel(session.nativeSessionId);
      } catch (error) {
        session.cancelInFlight = false;
        if (this.runtimeStopped || isDead(session) || session.turnSettled) return;
        throw wrapRuntime(error, 'Native cancel failed.');
      }
    }
    try {
      const finished = await this.waitForTurn(session.id, activeTurnId);
      if (!finished) {
        throw this.error(
          'RUNTIME_ERROR',
          'Cancel timed out before the native turn reached a terminal result. The turn was not marked cancelled and the prompt was not resent.',
          true,
          { sessionId, turnId: activeTurnId, resent: false },
        );
      }
    } finally {
      session.cancelInFlight = false;
    }
  }

  respondPermission(params: {
    sessionId: string;
    interactionId: string;
    optionId?: string;
    cancelled?: boolean;
  }): void {
    const pending = this.permissions.get(params.interactionId);
    if (!pending || pending.settled || pending.sessionId !== params.sessionId || pending.generation !== this.generation) {
      throw this.error('INTERACTION_NOT_FOUND', 'The permission request is unknown, expired, or belongs to another session.', false, {
        sessionId: params.sessionId,
        interactionId: params.interactionId,
      });
    }
    const session = this.sessions.get(params.sessionId);
    if (!session || session.activeTurnId !== pending.turnId || isDead(session)) {
      throw this.error('INTERACTION_NOT_FOUND', 'The permission request is no longer active for this turn.', false, {
        sessionId: params.sessionId,
        interactionId: params.interactionId,
      });
    }
    if (params.cancelled === true || params.optionId === undefined) {
      this.settlePermission(pending, 'cancelled', cancelledPermission());
      return;
    }
    if (!pending.optionIds.includes(params.optionId)) {
      throw this.error('INTERACTION_ACTION_NOT_FOUND', `Permission option "${params.optionId}" was not advertised for this request.`, false, {
        sessionId: params.sessionId,
        interactionId: params.interactionId,
        optionId: params.optionId,
      });
    }
    this.settlePermission(pending, 'submitted', {
      outcome: { outcome: 'selected', optionId: params.optionId },
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw this.error('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`, false, { sessionId });
    }
    if (session.state === 'closed') {
      if (this.liveCount() === 0) await this.stopRuntime();
      return;
    }
    if (session.phase !== 'dead' && session.activeTurnId !== null && !session.turnSettled) {
      try {
        await this.interruptTurn(sessionId, session.activeTurnId);
      } catch (error) {
        if (this.runtimeStopped || isDead(session)) {
          // Runtime exit is a real terminal boundary and may detach below.
        } else {
          this.markCancelUnconfirmed(session, error);
          throw error;
        }
      }
    }
    if (
      session.phase !== 'dead'
      && !this.runtimeStopped
      && session.activeTurnId !== null
      && !session.turnSettled
    ) {
      const error = this.error(
        'RUNTIME_ERROR',
        'Close rejected because the native turn has not reached a terminal result. The session stays attached and the prompt was not resent.',
        true,
        { sessionId, turnId: session.activeTurnId, resent: false },
      );
      this.markCancelUnconfirmed(session, error);
      throw error;
    }
    if ((session.state as SessionState) !== 'closed') this.detach(session, false);
    if (this.liveCount() === 0) await this.stopRuntime();
  }

  async listNativeSessions(params?: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.assertAdmitting();
    await this.ensureRuntime();
    this.assertAdmitting();
    return this.runtime.listSessions(params);
  }

  async close(): Promise<void> {
    this.admissionClosed = true;
    const failures: unknown[] = [];
    try {
      for (const id of [...this.sessions.keys()]) {
        try {
          await this.closeSession(id);
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      try {
        await this.stopRuntime();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw this.shutdownFailure(failures);
  }

  private onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    try {
      return this.openPermission(request);
    } catch {
      return Promise.resolve(cancelledPermission());
    }
  }

  /** Registers the pending request and returns its promise. Does not call the runtime. */
  private openPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const nativeId = typeof request.sessionId === 'string' ? request.sessionId : '';
    const session = nativeId ? this.findLiveNative(nativeId) : null;
    const optionIds = Array.isArray(request.options)
      ? request.options.map((option) => option.optionId)
      : [];
    const turnId = session?.activeTurnId;
    const acceptable = session
      && session.generation === this.generation
      && (session.turnPhase === 'starting' || session.turnPhase === 'prompting')
      && turnId
      && optionIds.length > 0
      && optionIds.every((id) => typeof id === 'string' && id.length > 0)
      && new Set(optionIds).size === optionIds.length;
    if (!acceptable || !session || !turnId) return Promise.resolve(cancelledPermission());
    const interactionId = `perm:${session.id}:${turnId}:${++this.permissionSeq}`;
    return new Promise((resolve) => {
      const pending: PendingPermission = {
        interactionId,
        sessionId: session.id,
        turnId,
        generation: session.generation,
        optionIds,
        settled: false,
        resolve,
      };
      this.permissions.set(interactionId, pending);
      session.state = 'waiting_interaction';
      session.updatedAt = this.timestamp();
      this.emit({
        kind: 'permission.requested',
        sessionId: session.id,
        turnId,
        interactionId,
        request,
      });
      this.emit({ kind: 'session.changed', session: this.snapshot(session) });
      if (pending.settled) return;
      const timer = setTimeout(() => {
        this.settlePermission(pending, 'expired', cancelledPermission());
      }, this.approvalTimeoutMs);
      unrefTimer(timer);
      pending.timer = timer;
    });
  }

  private onSessionUpdate(notification: SessionNotification): void {
    if (!this.acceptUpdates || this.runtimeStopped || this.generation === 0) return;
    const nativeId = notification.sessionId;
    if (typeof nativeId !== 'string' || nativeId.length === 0) return;
    const session = this.findLiveNative(nativeId);
    if (session && session.generation !== this.generation) return;
    if (session && session.generation === this.generation && session.phase === 'live') {
      if (session.turnPhase === 'starting') {
        this.pushBuffer(nativeId, { generation: this.generation, replay: false, notification });
        return;
      }
      this.publishUpdate(session, notification, false);
      return;
    }
    this.pushBuffer(nativeId, {
      generation: this.generation,
      replay: this.pendingReplay.has(nativeId),
      notification,
    });
  }

  private onRuntimeStopped(event: RuntimeStopped): void {
    if (this.runtimeStopSeen) return;
    this.runtimeStopSeen = true;
    this.runtimeStopped = true;
    this.ready = false;
    this.acceptUpdates = false;
    this.generation += 1;
    this.clearBuffers();
    this.pendingReplay.clear();
    this.lostCancels.clear();
    this.reservations = 0;
    const message = unexpectedExitMessage(event);
    for (const pending of [...this.permissions.values()]) {
      this.settlePermission(pending, 'runtime_ended', cancelledPermission(), true);
    }
    for (const session of this.sessions.values()) {
      if (session.state === 'closed') continue;
      const turnId = session.activeTurnId;
      if (turnId && !session.turnSettled) {
        session.turnSettled = true;
        session.activeTurnId = null;
        session.turnPhase = 'idle';
        session.cancelInFlight = false;
        const error = this.error(
          'RUNTIME_ERROR',
          'Turn result is uncertain because the Antigravity runtime exited. The prompt was not resent.',
          false,
          { sessionId: session.id, turnId, uncertain: true, resent: false },
        );
        session.lastError = error.message;
        this.emit({ kind: 'turn.failed', sessionId: session.id, turnId, error });
        this.notifyTurnWaiter(session.id, turnId);
      }
      session.phase = 'dead';
      session.state = 'stale';
      session.lastError = message;
      session.activeTurnId = null;
      session.updatedAt = this.timestamp();
      this.emit({ kind: 'session.changed', session: this.snapshot(session) });
    }
    this.retained.clear();
    this.nativeOwners.clear();
    this.notifyAllWaiters();
    this.emit({ kind: 'runtime.stopped', event });
  }

  private watchPrompt(response: Promise<PromptResponse>, sessionId: string, turnId: string): void {
    void response.then(
      (result) => { this.completeTurn(sessionId, turnId, result); },
      (error: unknown) => { this.failTurn(sessionId, turnId, error, false); },
    ).catch(() => undefined);
  }

  private completeTurn(sessionId: string, turnId: string, response: PromptResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.activeTurnId !== turnId || session.turnSettled) return;
    if (this.runtimeStopped || isDead(session) || session.generation !== this.generation) {
      this.failTurn(sessionId, turnId, this.error(
        'RUNTIME_ERROR',
        'Turn result is uncertain because the session is no longer live. The prompt was not resent.',
        false,
        { sessionId, turnId, uncertain: true, resent: false },
      ), true);
      return;
    }
    session.turnSettled = true;
    this.settleTurnPermissions(session, turnId, 'turn_ended');
    session.activeTurnId = null;
    session.turnPhase = 'idle';
    session.cancelInFlight = false;
    session.nativePromptLive = false;
    session.state = 'idle';
    session.lastError = null;
    session.updatedAt = this.timestamp();
    this.emit({ kind: 'turn.completed', sessionId, turnId, response });
    this.emit({ kind: 'session.changed', session: this.snapshot(session) });
    this.notifyTurnWaiter(sessionId, turnId);
  }

  private failTurn(sessionId: string, turnId: string, error: unknown, uncertain: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.activeTurnId !== turnId || session.turnSettled) return;
    session.turnSettled = true;
    this.settleTurnPermissions(session, turnId, uncertain ? 'runtime_ended' : 'turn_ended');
    session.activeTurnId = null;
    session.turnPhase = 'idle';
    session.cancelInFlight = false;
    session.nativePromptLive = false;
    const proxyError = uncertain
      ? (error instanceof AntigravityProxyError ? error : this.error(
        'RUNTIME_ERROR',
        'Turn result is uncertain. The prompt was not resent.',
        false,
        { sessionId, turnId, uncertain: true, resent: false },
      ))
      : (error instanceof AntigravityProxyError ? error : wrapRuntime(error, 'The native turn failed. The prompt was not resent.'));
    session.lastError = proxyError.message;
    session.state = isDead(session) || this.runtimeStopped ? 'stale' : 'error';
    session.updatedAt = this.timestamp();
    this.emit({ kind: 'turn.failed', sessionId, turnId, error: proxyError });
    this.emit({ kind: 'session.changed', session: this.snapshot(session) });
    this.notifyTurnWaiter(sessionId, turnId);
  }

  private rollbackUnstartedTurn(session: InternalSession, turnId: string): void {
    if (session.activeTurnId !== turnId || session.turnSettled) return;
    session.turnSettled = true;
    session.activeTurnId = null;
    session.turnPhase = 'idle';
    session.cancelInFlight = false;
    session.nativePromptLive = false;
    if (session.phase === 'live' && !this.runtimeStopped && !this.admissionClosed) session.state = 'idle';
    session.updatedAt = this.timestamp();
    if (session.nativeSessionId) this.takeBuffer(session.nativeSessionId, session.generation);
    this.settleTurnPermissions(session, turnId, 'turn_ended');
    this.notifyTurnWaiter(session.id, turnId);
  }

  private async applyStringConfig(session: InternalSession, config: ConfigValues | undefined): Promise<void> {
    if (!config) return;
    const attaching = session.phase === 'attaching';
    const turnId = session.activeTurnId;
    // Catalog accepts or rejects the whole batch before any native write.
    // Model selectors stay first. Each later value is checked again because
    // a model write can replace effort choices.
    const settings = this.validatedConfig(session.configOptions, config);
    settings.sort((left, right) => (
      configRank(left.configId, session.configOptions) - configRank(right.configId, session.configOptions)
    ));
    for (const setting of settings) {
      const [approved] = this.validatedConfig(session.configOptions, {
        [setting.configId]: setting.value,
      });
      if (!approved) continue;
      const option = session.configOptions.find((item) => item.id === approved.configId);
      if (option?.type === 'select' && option.currentValue === approved.value) continue;
      let updated: unknown;
      try {
        updated = await this.runtime.setConfigOption({
          sessionId: session.nativeSessionId,
          configId: approved.configId,
          value: approved.value,
        });
      } catch (error) {
        throw error instanceof AntigravityProxyError
          ? error
          : wrapRuntime(error, `Setting config option "${approved.configId}" failed.`);
      }
      // A setter response must not resurrect state after cancellation/retirement.
      if (attaching) this.assertAttachCurrent(session);
      else if (turnId !== null) this.assertTurnCurrent(session, turnId);
      this.assertAdmitting();
      if (!this.adoptConfigResponse(session, updated)) {
        if (updated && typeof updated === 'object' && 'configOptions' in updated) {
          throw this.error('RUNTIME_ERROR', 'The native runtime returned unreadable config options. The prompt was not sent.', false);
        }
        this.rememberSelectValue(session, approved.configId, approved.value);
      }
      const selected = session.configOptions.find(item => item.id === approved.configId);
      if (selected?.type !== 'select' || selected.currentValue !== approved.value) {
        throw this.error('CONFIG_VALUE_INVALID', 'The native runtime did not select the requested configuration. The prompt was not sent.', false, { configId: approved.configId });
      }
    }
    // A later setter may refresh/drop model choices. Recheck the original pair
    // against the final advertisement before admitting the prompt.
    this.validatedConfig(session.configOptions, config);
    for (const setting of settings) {
      const selected = session.configOptions.find(item => item.id === setting.configId);
      if (selected?.type !== 'select' || selected.currentValue !== setting.value) {
        throw this.error('CONFIG_VALUE_INVALID', 'The native configuration changed while applying settings. The prompt was not sent.', false, { configId: setting.configId });
      }
    }
  }

  private validatedConfig(
    options: SessionConfigOption[],
    values: ConfigValues,
  ): Array<{ configId: string; value: string }> {
    try {
      return validateConfigValues(options, values);
    } catch (error) {
      if (error instanceof ConfigValidationError) throw this.configValidationError(error);
      throw error;
    }
  }

  private configValidationError(error: ConfigValidationError): AntigravityProxyError {
    return new AntigravityProxyError(
      error.domainCode,
      error.message,
      error.retryable,
      error.configId.length > 0 ? { configId: error.configId } : undefined,
    );
  }

  private settlePermission(
    pending: PendingPermission,
    outcome: InteractionOutcome,
    response: RequestPermissionResponse,
    keepState = false,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.permissions.delete(pending.interactionId);
    pending.resolve(response);
    const optionId = response.outcome.outcome === 'selected' ? response.outcome.optionId : undefined;
    this.emit(optionId === undefined
      ? {
        kind: 'permission.resolved',
        sessionId: pending.sessionId,
        turnId: pending.turnId,
        interactionId: pending.interactionId,
        outcome,
      }
      : {
        kind: 'permission.resolved',
        sessionId: pending.sessionId,
        turnId: pending.turnId,
        interactionId: pending.interactionId,
        outcome,
        optionId,
      });
    if (keepState) return;
    const session = this.sessions.get(pending.sessionId);
    if (!session || session.state !== 'waiting_interaction' || session.activeTurnId !== pending.turnId) return;
    const stillWaiting = [...this.permissions.values()].some((item) => (
      item.sessionId === session.id && item.turnId === pending.turnId
    ));
    if (stillWaiting) return;
    session.state = 'running';
    session.updatedAt = this.timestamp();
    this.emit({ kind: 'session.changed', session: this.snapshot(session) });
  }

  private settleTurnPermissions(session: InternalSession, turnId: string, outcome: InteractionOutcome): void {
    for (const pending of [...this.permissions.values()]) {
      if (pending.sessionId === session.id && pending.turnId === turnId) {
        this.settlePermission(pending, outcome, cancelledPermission(), true);
      }
    }
  }

  private publishUpdate(session: InternalSession, notification: SessionNotification, replay: boolean): void {
    if (isDead(session) || session.generation !== this.generation) return;
    if (notification.sessionId !== session.nativeSessionId) return;
    const update = notification.update;
    if (update.sessionUpdate === 'config_option_update' && this.adoptConfigOptions(session, update.configOptions)) {
      session.updatedAt = this.timestamp();
      this.emit({ kind: 'session.changed', session: this.snapshot(session) });
    }
    const attributable = session.turnPhase === 'prompting' || session.turnPhase === 'cancelling';
    const turnId = !replay && attributable && session.activeTurnId !== null
      ? session.activeTurnId
      : undefined;
    this.emit(turnId === undefined
      ? { kind: 'native.update', sessionId: session.id, notification, replay }
      : { kind: 'native.update', sessionId: session.id, turnId, notification, replay });
  }

  private drainAttach(session: InternalSession): void {
    if (!session.nativeSessionId || isDead(session)) return;
    session.phase = 'flushing';
    this.pendingReplay.delete(session.nativeSessionId);
    this.drainNative(session, false);
    if (isDead(session)) return;
    session.phase = 'attaching';
  }

  private drainTurnUpdates(session: InternalSession): void {
    this.drainNative(session, true);
  }

  private drainNative(session: InternalSession, liveTurn: boolean): void {
    if (isDead(session)) return;
    if (this.overflowed.has(session.nativeSessionId)) {
      this.invalidateOverflow(session.nativeSessionId, 0, MAX_BUFFER_PER_NATIVE);
      return;
    }
    let guard = 0;
    while (guard < MAX_DRAIN_ROUNDS) {
      if (isDead(session)) return;
      const batch = this.takeBuffer(session.nativeSessionId, session.generation);
      if (batch.length === 0) return;
      for (const item of batch) {
        if (isDead(session)) return;
        const replay = liveTurn ? false : item.replay;
        this.publishUpdate(session, item.notification, replay);
      }
      guard += 1;
    }
    if (isDead(session)) return;
    const leftover = this.buffers.get(session.nativeSessionId);
    if (leftover && leftover.length > 0) {
      this.invalidateOverflow(session.nativeSessionId, leftover.length, MAX_DRAIN_ROUNDS);
    }
  }

  private pushBuffer(nativeId: string, item: BufferedUpdate): void {
    if (item.generation !== this.generation) return;
    if (this.overflowed.has(nativeId)) return;
    const queue = this.buffers.get(nativeId);
    const projectedQueue = (queue?.length ?? 0) + 1;
    const projectedTotal = this.bufferTotal + 1;
    if (projectedQueue > MAX_BUFFER_PER_NATIVE || projectedTotal > MAX_BUFFER_TOTAL) {
      const perNative = projectedQueue > MAX_BUFFER_PER_NATIVE;
      this.invalidateOverflow(
        nativeId,
        perNative ? projectedQueue : projectedTotal,
        perNative ? MAX_BUFFER_PER_NATIVE : MAX_BUFFER_TOTAL,
      );
      return;
    }
    const next = queue ?? [];
    if (!queue) this.buffers.set(nativeId, next);
    next.push(item);
    this.bufferTotal += 1;
  }

  private invalidateOverflow(nativeId: string, attempted: number, limit: number): void {
    this.overflowed.add(nativeId);
    this.discardNativeBuffer(nativeId);
    const session = this.findLiveNative(nativeId);
    if (!session || isDead(session) || session.generation !== this.generation) return;
    this.invalidateSession(session, this.overflowError(nativeId, attempted, limit));
  }

  private overflowError(nativeId: string, attempted: number, limit: number): AntigravityProxyError {
    return this.error(
      'RUNTIME_ERROR',
      'Buffered session updates exceeded a bounded queue. The transcript was invalidated instead of being truncated.',
      false,
      { nativeSessionId: nativeId, buffered: attempted, limit, resent: false },
    );
  }

  private invalidateSession(session: InternalSession, error: AntigravityProxyError): void {
    if (isDead(session) || this.runtimeStopped) return;
    session.invalidation = error;
    const turnId = session.activeTurnId;
    const nativeId = session.nativeSessionId;
    // Read this before failTurn clears it. A dispatched prompt can still be
    // executing after local tracking is dropped.
    const lostPrompt = session.nativePromptLive && !session.turnSettled && nativeId.length > 0;
    if (turnId && !session.turnSettled) this.failTurn(session.id, turnId, error, false);
    if (isDead(session) || this.runtimeStopped) return;
    session.phase = 'dead';
    session.state = 'error';
    session.lastError = error.message;
    session.activeTurnId = null;
    session.turnPhase = 'idle';
    session.cancelInFlight = false;
    session.nativePromptLive = false;
    session.turnSettled = true;
    session.updatedAt = this.timestamp();
    if (nativeId) {
      this.retained.set(nativeId, { uncertain: true });
      this.nativeOwners.set(nativeId, retainedKey(nativeId));
      this.pendingReplay.delete(nativeId);
      this.discardNativeBuffer(nativeId);
    }
    this.emit({ kind: 'session.changed', session: this.snapshot(session) });
    if (turnId) this.notifyTurnWaiter(session.id, turnId);
    // One bounded session/cancel for this native id only. Cancel RPC
    // acceptance is not a terminal result, so the id stays uncertain.
    if (lostPrompt && !this.runtimeStopped) this.cancelLostPrompt(nativeId);
  }

  private cancelLostPrompt(nativeId: string): void {
    if (!nativeId || this.runtimeStopped || this.lostCancels.has(nativeId)) return;
    this.lostCancels.add(nativeId);
    void this.boundedNativeCancel(nativeId);
  }

  /**
   * Asks one native session to stop. The timer is not unref'd.
   * Success only means the cancel RPC returned. It does not complete the
   * Gian turn, clear uncertain ownership, or stop any other session.
   * A late rejection or timeout from an older runtime generation is ignored.
   */
  private boundedNativeCancel(nativeId: string): Promise<void> {
    const generation = this.generation;
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      const unconfirmed = () => {
        if (settled || this.generation !== generation) return;
        this.noteLostCancelUnconfirmed(nativeId, generation);
      };
      timer = setTimeout(() => {
        if (settled) return;
        unconfirmed();
        finish();
      }, this.cancelTimeoutMs);
      let cancelResult: Promise<void>;
      try {
        cancelResult = this.runtime.cancel(nativeId);
      } catch (error) {
        cancelResult = Promise.reject(error);
      }
      void cancelResult.then(
        () => { finish(); },
        () => {
          unconfirmed();
          finish();
        },
      );
    });
  }

  private noteLostCancelUnconfirmed(nativeId: string, generation: number): void {
    if (this.generation !== generation || this.runtimeStopped) return;
    for (const session of this.sessions.values()) {
      if (session.generation !== generation) continue;
      if (session.nativeSessionId !== nativeId || session.state === 'closed') continue;
      if (session.lastError?.includes('not confirmed stopped')) continue;
      const prefix = session.lastError ?? 'The session lost its native prompt.';
      session.lastError = `${prefix} The native prompt was not confirmed stopped, was not marked cancelled, and was not resent.`;
      session.updatedAt = this.timestamp();
      this.retained.set(nativeId, { uncertain: true });
      this.nativeOwners.set(nativeId, retainedKey(nativeId));
      this.emit({ kind: 'session.changed', session: this.snapshot(session) });
    }
  }

  private assertAdmitting(): void {
    if (!this.admissionClosed) return;
    throw this.admissionError();
  }

  private admissionError(): AntigravityProxyError {
    return this.error(
      'RUNTIME_UNAVAILABLE',
      'The Antigravity service is closing. No session or turn was admitted and the prompt was not sent.',
      false,
      { resent: false },
    );
  }

  private discardNativeBuffer(nativeId: string): void {
    const queue = this.buffers.get(nativeId);
    if (!queue) return;
    this.bufferTotal -= queue.length;
    if (this.bufferTotal < 0) this.bufferTotal = 0;
    this.buffers.delete(nativeId);
  }

  private takeBuffer(nativeId: string, generation: number): BufferedUpdate[] {
    const queue = this.buffers.get(nativeId);
    if (!queue) return [];
    this.buffers.delete(nativeId);
    const kept: BufferedUpdate[] = [];
    for (const item of queue) {
      this.bufferTotal -= 1;
      if (item.generation === generation) kept.push(item);
    }
    if (this.bufferTotal < 0) this.bufferTotal = 0;
    return kept;
  }

  private clearBuffers(): void {
    this.buffers.clear();
    this.bufferTotal = 0;
    this.overflowed.clear();
    this.lostCancels.clear();
  }

  private detach(session: InternalSession, uncertain: boolean): void {
    const nativeId = session.nativeSessionId;
    session.phase = 'dead';
    session.state = 'closed';
    session.activeTurnId = null;
    session.turnPhase = 'idle';
    session.cancelInFlight = false;
    session.updatedAt = this.timestamp();
    const keepUncertain = uncertain || (nativeId
      ? this.retained.get(nativeId)?.uncertain === true || this.overflowed.has(nativeId)
      : false);
    if (nativeId && !this.runtimeStopped) {
      this.retained.set(nativeId, { uncertain: keepUncertain });
      this.nativeOwners.set(nativeId, retainedKey(nativeId));
    } else if (nativeId) {
      this.nativeOwners.delete(nativeId);
      this.retained.delete(nativeId);
    }
    this.pendingReplay.delete(nativeId);
    this.emit({ kind: 'session.changed', session: this.snapshot(session) });
  }

  private abandonCreate(session: InternalSession, reservedNew: boolean, ownedNative: boolean): void {
    this.pendingReplay.delete(session.nativeSessionId);
    if (session.nativeSessionId) this.takeBuffer(session.nativeSessionId, session.generation);
    if (reservedNew) this.reservations = Math.max(0, this.reservations - 1);
    if (ownedNative && session.nativeSessionId && !this.runtimeStopped) {
      this.retained.set(session.nativeSessionId, { uncertain: false });
      this.nativeOwners.set(session.nativeSessionId, retainedKey(session.nativeSessionId));
    } else if (session.nativeSessionId) {
      const owner = this.nativeOwners.get(session.nativeSessionId);
      if (owner === session.id) this.nativeOwners.delete(session.nativeSessionId);
    }
    session.phase = 'dead';
    this.sessions.delete(session.id);
  }

  private holdNative(nativeId: string, gianId: string): void {
    const owner = this.nativeOwners.get(nativeId);
    const retained = this.retained.get(nativeId);
    if (owner && owner !== gianId) {
      if (retained && !retained.uncertain && owner === retainedKey(nativeId)) {
        this.retained.delete(nativeId);
        this.nativeOwners.set(nativeId, gianId);
        return;
      }
      throw this.error(
        'CONFLICT',
        `Native session ${nativeId} is already owned by another Gian session.`,
        false,
        { nativeSessionId: nativeId, sessionId: gianId },
      );
    }
    if (!owner && this.nativeOwners.size + this.reservations >= this.maxSessions) {
      throw this.capacityError();
    }
    this.nativeOwners.set(nativeId, gianId);
  }

  private reserveNewNative(): void {
    if (this.nativeOwners.size + this.reservations >= this.maxSessions) throw this.capacityError();
    this.reservations += 1;
  }

  private claimReservedNative(nativeId: string, gianId: string): void {
    const owner = this.nativeOwners.get(nativeId);
    if (owner && owner !== gianId) {
      throw this.error('CONFLICT', `Native session ${nativeId} is already owned.`, false, {
        nativeSessionId: nativeId,
        sessionId: gianId,
      });
    }
    this.reservations = Math.max(0, this.reservations - 1);
    this.nativeOwners.set(nativeId, gianId);
  }

  private capacityError(): AntigravityProxyError {
    return this.error(
      'CONFLICT',
      `Antigravity is already retaining ${this.maxSessions} native sessions. No running turn was killed. Close the shared runtime at an idle boundary before creating another.`,
      false,
      { maxSessions: String(this.maxSessions), retained: String(this.nativeOwners.size + this.reservations) },
    );
  }

  private async stopRuntime(): Promise<void> {
    if (this.runtimeStopped) return;
    if (this.stopInFlight) {
      await this.stopInFlight;
      return;
    }
    const operation = this.finishStop();
    this.stopInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.stopInFlight === operation) this.stopInFlight = null;
    }
  }

  /**
   * Bounds `runtime.stop`. The timer is not unref'd: a hung stop must settle.
   * A resolved stop with no exit event is an expected stop. A rejection or
   * timeout with no exit event leaves retained ownership uncertain and throws.
   * A late resolution after that timeout must not invent a successful stop.
   */
  private finishStop(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (failure?: AntigravityProxyError) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (failure) reject(failure);
        else resolve();
      };
      timer = setTimeout(() => {
        if (settled) return;
        if (this.runtimeStopped) {
          finish();
          return;
        }
        this.markStopUncertain();
        finish(this.stopFailure(new Error('Runtime stop timed out before the process exit was observed.')));
      }, this.cancelTimeoutMs);
      let stopResult: Promise<void>;
      try {
        stopResult = this.runtime.stop();
      } catch (error) {
        stopResult = Promise.reject(error);
      }
      void stopResult.then(
        () => {
          if (settled) return;
          if (!this.runtimeStopped) {
            this.onRuntimeStopped({ code: null, signal: null, expected: true });
          }
          finish();
        },
        (error: unknown) => {
          if (settled) return;
          if (!this.runtimeStopped) this.markStopUncertain();
          finish(this.stopFailure(error));
        },
      );
    });
  }

  private markStopUncertain(): void {
    for (const nativeId of this.retained.keys()) {
      this.retained.set(nativeId, { uncertain: true });
    }
  }

  private stopFailure(error: unknown): AntigravityProxyError {
    if (error instanceof AntigravityProxyError) return error;
    const reason = error instanceof Error && error.message ? error.message : 'Runtime stop failed.';
    return this.error(
      'RUNTIME_ERROR',
      `${reason} Shutdown was not confirmed. Retained native sessions are uncertain and the prompt was not resent.`,
      true,
      { resent: false, uncertain: true },
    );
  }

  private shutdownFailure(failures: readonly unknown[]): Error {
    const first = failures[0];
    if (failures.length === 1 && first instanceof Error) return first;
    const messages = failures.slice(0, 5).map((failure) => (
      failure instanceof Error && failure.message ? failure.message : 'Unknown shutdown failure.'
    ));
    return this.error(
      'RUNTIME_ERROR',
      `Shutdown reported ${failures.length} failures. ${messages.join(' ')}`,
      true,
      { resent: false, uncertain: true, failures: failures.length },
    );
  }

  private invalidationError(session: InternalSession, fallback: string): AntigravityProxyError {
    const prior = session.invalidation;
    const details: AntigravityErrorDetails = {
      ...(prior?.details ?? {}),
      sessionId: session.id,
      resent: false,
    };
    if (session.nativeSessionId) details.nativeSessionId = session.nativeSessionId;
    return this.error(
      prior?.domainCode ?? 'RUNTIME_ERROR',
      prior?.message ?? session.lastError ?? fallback,
      prior?.retryable ?? false,
      details,
    );
  }

  private waitForTurn(sessionId: string, turnId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.activeTurnId !== turnId || session.turnSettled) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const key = waiterKey(sessionId, turnId);
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.turnWaiters.get(key);
        if (waiters) {
          const next = waiters.filter((item) => item !== onDone);
          if (next.length === 0) this.turnWaiters.delete(key);
          else this.turnWaiters.set(key, next);
        }
        resolve(value);
      };
      const onDone = () => finish(true);
      const existing = this.turnWaiters.get(key);
      if (existing) existing.push(onDone);
      else this.turnWaiters.set(key, [onDone]);
      const timer = setTimeout(() => finish(false), this.cancelTimeoutMs);
      unrefTimer(timer);
    });
  }

  private notifyTurnWaiter(sessionId: string, turnId: string): void {
    const key = waiterKey(sessionId, turnId);
    const waiters = this.turnWaiters.get(key);
    if (!waiters) return;
    this.turnWaiters.delete(key);
    for (const waiter of waiters) waiter();
  }

  private notifyAllWaiters(): void {
    const waiters = [...this.turnWaiters.values()].flat();
    this.turnWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  private findLiveNative(nativeId: string): InternalSession | null {
    for (const session of this.sessions.values()) {
      if (session.nativeSessionId === nativeId && (session.phase === 'live' || session.phase === 'flushing' || session.phase === 'attaching')) {
        return session;
      }
    }
    return null;
  }

  private liveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.phase === 'live' || session.phase === 'attaching' || session.phase === 'flushing') count += 1;
    }
    return count;
  }

  private markCancelUnconfirmed(session: InternalSession, error: unknown): void {
    if (isDead(session) || session.state === 'closed' || session.turnSettled) return;
    session.turnPhase = 'cancelling';
    session.cancelInFlight = false;
    session.state = 'running';
    session.lastError = error instanceof Error
      ? error.message
      : 'Cancel was not confirmed. The session stays attached.';
    session.updatedAt = this.timestamp();
    this.emit({ kind: 'session.changed', session: this.snapshot(session) });
  }

  private async ensureRuntime(): Promise<void> {
    // Protocol initialize is once per host. After the last live session stops
    // the shared process, an explicit create or list starts a new generation.
    // startTurn does not: restarting there would resend an uncertain prompt.
    // service.close keeps admission closed so this cannot restart underneath it.
    this.assertAdmitting();
    if (this.ready && !this.runtimeStopped) return;
    await this.initialize();
  }

  private assertAttachCurrent(session: InternalSession): void {
    if (this.runtimeStopped || session.generation !== this.generation) {
      throw this.error(
        'RUNTIME_UNAVAILABLE',
        'Runtime exited while attaching the session. The prompt was not sent.',
        true,
        { sessionId: session.id, resent: false },
      );
    }
    if (isDead(session)) {
      throw this.invalidationError(session, 'The session was invalidated while attaching. The prompt was not sent.');
    }
  }

  private assertTurnCurrent(session: InternalSession, turnId: string): void {
    if (this.runtimeStopped || session.generation !== this.generation) {
      throw this.error(
        'RUNTIME_UNAVAILABLE',
        'Runtime exited before the turn was dispatched. The prompt was not sent.',
        true,
        { sessionId: session.id, turnId, resent: false },
      );
    }
    if (isDead(session)) {
      throw this.invalidationError(session, 'The turn was invalidated before it was accepted. The prompt was not resent.');
    }
    if (session.phase !== 'live') {
      throw this.error('SESSION_STALE', `Session ${session.id} is not live.`, true, { sessionId: session.id });
    }
  }

  private requireOperable(sessionId: string): InternalSession {
    const session = this.requireKnown(sessionId);
    if (session.state === 'closed') {
      throw this.error('SESSION_CLOSED', `Session ${sessionId} is closed.`, false, { sessionId });
    }
    if (session.state === 'stale' || isDead(session)) {
      throw this.error('SESSION_STALE', `Session ${sessionId} is stale.`, true, { sessionId });
    }
    if (!this.ready || this.runtimeStopped) {
      throw this.error('RUNTIME_UNAVAILABLE', 'The Antigravity runtime is not available. No prompt was sent.', true, {
        sessionId,
        resent: false,
      });
    }
    return session;
  }

  private requireKnown(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw this.error('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`, false, { sessionId });
    }
    return session;
  }

  private blankSession(id: string, cwd: string): InternalSession {
    const timestamp = this.timestamp();
    return {
      id,
      nativeSessionId: '',
      cwd,
      state: 'idle',
      activeTurnId: null,
      turnSettled: true,
      turnPhase: 'idle',
      cancelInFlight: false,
      nativePromptLive: false,
      phase: 'attaching',
      generation: this.generation,
      configOptions: [],
      lastError: null,
      invalidation: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private snapshot(session: InternalSession): ServiceSession {
    return {
      id: session.id,
      nativeSessionId: session.nativeSessionId,
      cwd: session.cwd,
      state: session.state,
      activeTurnId: session.activeTurnId,
      configOptions: cloneConfigOptions(session.configOptions),
      lastError: session.lastError,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private adoptConfigResponse(session: InternalSession, response: unknown): boolean {
    if (!response || typeof response !== 'object') return false;
    const configOptions = (response as { configOptions?: unknown }).configOptions;
    if (!Array.isArray(configOptions)) return false;
    return this.adoptConfigOptions(session, configOptions);
  }

  private adoptConfigOptions(session: InternalSession, value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const next: SessionConfigOption[] = [];
    for (const entry of value) {
      if (!isSessionConfigOption(entry)) return false;
      next.push(entry);
    }
    session.configOptions = cloneConfigOptions(next);
    return true;
  }

  private rememberSelectValue(session: InternalSession, configId: string, value: string): void {
    session.configOptions = session.configOptions.map((option) => (
      option.id === configId && option.type === 'select' ? { ...option, currentValue: value } : option
    ));
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private emit(event: ServiceEvent): void {
    this.sink?.(event);
  }

  private error(
    domainCode: AntigravityProxyError['domainCode'],
    message: string,
    retryable: boolean,
    details?: AntigravityErrorDetails,
  ): AntigravityProxyError {
    return new AntigravityProxyError(domainCode, message, retryable, details);
  }
}

function cancelledPermission(): RequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } };
}

function annotateNative(error: AntigravityProxyError, nativeSessionId: string): AntigravityProxyError {
  if (!nativeSessionId || error.details?.nativeSessionId === nativeSessionId) return error;
  return new AntigravityProxyError(error.domainCode, error.message, error.retryable, {
    ...(error.details ?? {}),
    nativeSessionId,
  });
}

function retainedKey(nativeId: string): string {
  return `retained:${nativeId}`;
}

function waiterKey(sessionId: string, turnId: string): string {
  return `${sessionId}\0${turnId}`;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AntigravityProxyError('CONFIG_VALUE_INVALID', `${name} must be a non-empty string.`, false, { configId: name });
  }
  return value;
}

function requireCwd(value: unknown): string {
  const cwd = requireText(value, 'cwd');
  if (!isAbsolute(cwd)) {
    throw new AntigravityProxyError('CONFIG_VALUE_INVALID', 'cwd must be an absolute path.', false, { configId: 'cwd' });
  }
  return cwd;
}

function assertMcpServers(value: McpServer[] | undefined): void {
  if (value !== undefined && !Array.isArray(value)) {
    throw new AntigravityProxyError('CONFIG_VALUE_INVALID', 'mcpServers must be an array.', false);
  }
}

function loadRequest(nativeId: string, cwd: string, mcpServers: McpServer[] | undefined): LoadSessionRequest {
  return { sessionId: nativeId, cwd, mcpServers: mcpServers ?? [] };
}

function resumeRequest(nativeId: string, cwd: string, mcpServers: McpServer[] | undefined): ResumeSessionRequest {
  const request: ResumeSessionRequest = { sessionId: nativeId, cwd };
  if (mcpServers !== undefined) request.mcpServers = mcpServers;
  return request;
}

function nativeIdFromNew(response: NewSessionResponse): string {
  if (typeof response.sessionId !== 'string' || response.sessionId.length === 0) {
    throw new AntigravityProxyError('RUNTIME_ERROR', 'Runtime did not return a native session id.', false);
  }
  return response.sessionId;
}

function finiteDuration(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new AntigravityProxyError('CONFIG_VALUE_INVALID', `${name} must be a non-negative finite number.`, false, {
      configId: name,
    });
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new AntigravityProxyError('CONFIG_VALUE_INVALID', `${name} must be an integer of at least 1.`, false, {
      configId: name,
    });
  }
  return value;
}

function wrapRuntime(error: unknown, fallback: string): AntigravityProxyError {
  if (error instanceof AntigravityProxyError) return error;
  const message = error instanceof Error && error.message ? error.message : fallback;
  return new AntigravityProxyError('RUNTIME_ERROR', message, false, { resent: false });
}

function unexpectedExitMessage(event: RuntimeStopped): string {
  const signal = event.signal ? ` signal ${event.signal}` : '';
  const code = event.code === null ? '' : ` code ${event.code}`;
  return `Antigravity runtime exited${code}${signal}. Affected sessions are stale and uncertain prompts were not resent.`;
}

// Event callbacks can change phase across awaits and synchronous event emission.
function isDead(session: InternalSession): boolean {
  return session.phase === 'dead';
}

function configRank(configId: string, options: readonly SessionConfigOption[]): number {
  if (configId === 'model') return 0;
  return options.some((option) => option.id === configId && option.category === 'model') ? 0 : 1;
}

function isSessionConfigOption(value: unknown): value is SessionConfigOption {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return false;
  if (record.type === 'select') return typeof record.currentValue === 'string' && Array.isArray(record.options);
  if (record.type === 'boolean') return typeof record.currentValue === 'boolean';
  return false;
}

function cloneConfigOptions(options: SessionConfigOption[]): SessionConfigOption[] {
  if (options.length === 0) return [];
  return structuredClone(options);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') timer.unref();
}
