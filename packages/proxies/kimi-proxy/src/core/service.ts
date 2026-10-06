/**
 * KimiProxyService — orchestration over the Kimi local server API
 * (`kimi web` REST + `/api/v1/ws`), replacing the retired ACP transport.
 *
 * Semantics kept from the ACP generation: exclusive attach per native
 * session, stream-scoped turn ledger at the adapter, detach-only close,
 * opaque sidechat resume refs, and honest state mapping. Everything the ACP
 * build had to synthesize (turn identities, replay capture windows, hidden
 * /usage prompts, proxy-owned tool terminals) is GONE: the server API carries
 * native ids, cursors and server-side tool execution.
 */

import { createHash } from 'node:crypto';

import { OpaqueSidechatResumeStore } from '@gian/proxy-protocol';

import { KimiCustomizationScanner, ScanTimeoutError } from './customization.js';
import { renderUnifiedDiff } from './diff.js';
import { buildPromptInput, type OuterInputItem } from './input.js';
import { KimiSessionProjector, type OuterNotification } from './projector.js';
import { buildReplayEvents } from './replay.js';
import type {
  KimiFileChange,
  KimiModelInfo,
  KimiMessage,
  KimiSessionInfo,
} from './types.js';
import { KimiServerRuntime, type ResyncNotice, type SessionCursor } from '../runtime/kimi-server.js';
import { KimiApiError, KimiTransportError } from '../runtime/rest-client.js';
import { KimiProtocolError } from '../transport/protocol.js';

export interface KimiServiceOptions {
  kimiBin: string;
  dataDir?: string | null;
  /** Test seam / externally managed endpoint: skips spawning `kimi web`. */
  endpoint?: { baseUrl: string; token: string };
}

export interface SessionRecord {
  sessionId: string;
  streamId: string;
  nativeSessionId: string;
  cwd: string;
  state: 'attaching' | 'idle' | 'running' | 'waiting_interaction' | 'stale';
  activeTurn: { gianTurnId: string; promptId: string; nativeTurnId: number | null; interruptAccepted: boolean } | null;
  lastCompleted: { gianTurnId: string; promptId: string; nativeTurnId: number | null } | null;
  readonly projector: KimiSessionProjector;
  isSidechat: boolean;
  parentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnConfigMap {
  model?: string;
  thinking?: string;
  approval_mode?: string;
}

const INTERRUPT_SETTLE_MS = 15_000;
// kap-server 2.1.1 routes/messages.ts and routes/sessions.ts each validate
// page_size as integer 1..100. These are native API limits, not replay limits.
const MESSAGE_PAGE_SIZE = 100;
const NATIVE_SESSION_PAGE_SIZE = 100;
/** Best-effort native abort while fencing a turn must not hang. */
const FENCE_ABORT_TIMEOUT_MS = 3_000;
/** Terminal-facet REST budgets: enrichment may never stall a terminal. */
const FINAL_USAGE_TIMEOUT_MS = 8_000;
const DIFF_REQUEST_TIMEOUT_MS = 5_000;
const DIFF_PHASE_BUDGET_MS = 8_000;

function sha32(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/** The 2.1.1 server validates question answers as a kind-discriminated union
 *  ({kind:"single",option_id} / {kind:"multi",option_ids} / {kind:"other",text});
 *  raw UI values (string / string[]) are rejected. Each value is wrapped by
 *  the input type recorded when the question was projected. */
function wrapQuestionAnswers(
  inputs: Array<{ id: string; type: string }> | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const inputTypes = new Map((inputs ?? []).map((input) => [input.id, input.type]));
  const answers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === 'note') continue;
    const type = inputTypes.get(key);
    if (type === 'single_select' && typeof value === 'string') {
      answers[key] = { kind: 'single', option_id: value };
    } else if (type === 'multi_select' && Array.isArray(value)) {
      answers[key] = { kind: 'multi', option_ids: value };
    } else if (typeof value === 'string') {
      answers[key] = { kind: 'other', text: value };
    } else if (Array.isArray(value)) {
      answers[key] = { kind: 'multi', option_ids: value };
    } else {
      answers[key] = value;
    }
  }
  return answers;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class KimiProxyService {
  private readonly runtime: KimiServerRuntime;
  private readonly records = new Map<string, SessionRecord>();
  private readonly byNative = new Map<string, string>();
  private readonly sequences = new Map<string, number>();
  private readonly sidechatStore: OpaqueSidechatResumeStore;
  private readonly customization = new KimiCustomizationScanner();
  private readonly interruptTimers = new Map<string, NodeJS.Timeout>();
  private emitSink: (notification: OuterNotification) => void = () => undefined;
  private stopped = false;

  constructor(private readonly options: KimiServiceOptions) {
    this.runtime = new KimiServerRuntime({
      kimiBin: options.kimiBin,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    });
    this.sidechatStore = new OpaqueSidechatResumeStore(options.dataDir ?? null);
    this.runtime.on('session-event', (frame) => this.handleFrame(frame));
    this.runtime.on('resync', (notice) => { void this.handleResync(notice); });
    this.runtime.on('down', () => this.handleRuntimeDown());
  }

  setEmitSink(sink: (notification: OuterNotification) => void): void {
    this.emitSink = sink;
  }

  private nextSequence(sessionId: string): number {
    const next = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, next);
    return next;
  }

  private async ensureStarted(): Promise<void> {
    if (this.stopped) throw new KimiProtocolError('SESSION_CLOSED', 'The proxy service is shutting down.');
    await this.runtime.start();
  }

  // ---- registry ----

  private register(record: Omit<SessionRecord, 'streamId' | 'createdAt' | 'updatedAt' | 'projector' | 'lastCompleted'> & {
    streamId?: string;
  }): SessionRecord {
    const attached = this.byNative.get(record.nativeSessionId);
    if (attached !== undefined && attached !== record.sessionId) {
      // Exclusive attach: one native session belongs to one Gian session.
      throw new KimiProtocolError('CONFLICT', `Kimi session ${record.nativeSessionId} is already attached to session ${attached}.`);
    }
    const now = nowIso();
    const projector = new KimiSessionProjector({
      gianSessionId: record.sessionId,
      nativeSessionId: record.nativeSessionId,
      nextSequence: () => this.nextSequence(record.sessionId),
      emit: (notification) => this.emitSink(notification),
      onFinalized: () => this.onTurnFinalizedById(record.sessionId),
      onBindingOverflow: (gianTurnId) => {
        const current = this.records.get(record.sessionId);
        if (current === undefined) return;
        void this.fenceActiveTurn(
          current,
          gianTurnId,
          'The Kimi event stream overflowed the turn-start buffer; the turn was fenced rather than projected incompletely.',
        );
      },
      finalUsage: async () => {
        const info = await this.runtime.rest.request<KimiSessionInfo>(
          'GET', `/api/v1/sessions/${record.nativeSessionId}`,
          { timeoutMs: FINAL_USAGE_TIMEOUT_MS },
        );
        return (info.usage ?? null) as Record<string, unknown> | null;
      },
      fileDiff: async (nativeTurnId: number) => this.fetchFileDiff(record.nativeSessionId, nativeTurnId),
    });
    const full: SessionRecord = {
      ...record,
      streamId: record.streamId ?? `stream-${sha32([record.sessionId, now])}`,
      lastCompleted: null,
      createdAt: now,
      updatedAt: now,
      projector,
    };
    full.projector.setStreamId(full.streamId);
    this.records.set(record.sessionId, full);
    this.byNative.set(record.nativeSessionId, record.sessionId);
    return full;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  requireSession(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId);
    if (record === undefined) {
      throw new KimiProtocolError('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    }
    return record;
  }

  requireStream(sessionId: string, streamId: string): SessionRecord {
    const record = this.requireSession(sessionId);
    if (record.streamId !== streamId) {
      throw new KimiProtocolError('SESSION_STALE', `Stream ${streamId} is no longer active.`);
    }
    return record;
  }

  private touch(record: SessionRecord): void {
    record.updatedAt = nowIso();
  }

  private setState(record: SessionRecord, state: SessionRecord['state']): void {
    record.state = state;
    this.touch(record);
  }

  /** waiting_interaction when interactions are pending on a running turn. */
  private reconcileState(record: SessionRecord): void {
    if (record.state === 'stale' || record.state === 'attaching') return;
    if (record.activeTurn !== null) {
      this.setState(record, record.projector.pendingInteractions.size > 0 ? 'waiting_interaction' : 'running');
    } else {
      this.setState(record, 'idle');
    }
  }

  private onTurnFinalizedById(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record === undefined) return;
    if (record.activeTurn !== null) {
      record.lastCompleted = {
        gianTurnId: record.activeTurn.gianTurnId,
        promptId: record.activeTurn.promptId,
        nativeTurnId: record.activeTurn.nativeTurnId,
      };
      record.activeTurn = null;
    }
    this.clearInterruptTimer(record.sessionId);
    this.reconcileState(record);
    this.emitSessionUpdated(record);
  }

  // ---- runtime events ----

  private handleFrame(frame: {
    type: string;
    seq: number;
    session_id?: string;
    volatile?: boolean;
    offset?: number;
    payload: Record<string, unknown>;
  }): void {
    const sessionId = typeof frame.session_id === 'string' ? frame.session_id : '';
    const gianId = this.byNative.get(sessionId);
    if (gianId === undefined) return;
    const record = this.records.get(gianId);
    if (record === undefined) return;
    record.projector.handleFrame({
      type: frame.type,
      seq: frame.seq,
      payload: frame.payload,
      ...(frame.volatile === true ? { volatile: true } : {}),
      ...(typeof frame.offset === 'number' ? { offset: frame.offset } : {}),
    });
    this.reconcileState(record);
  }

  private async handleResync(notice: ResyncNotice): Promise<void> {
    const gianId = this.byNative.get(notice.sessionId);
    if (gianId === undefined) return;
    const record = this.records.get(gianId);
    if (record === undefined) return;
    const resyncTurnId = record.activeTurn?.gianTurnId ?? null;
    if (resyncTurnId !== null) {
      await this.fenceActiveTurn(record, resyncTurnId, 'The Kimi server requested a state resync while the turn was running.');
    }
    try {
      const info = await this.runtime.rest.request<KimiSessionInfo>('GET', `/api/v1/sessions/${notice.sessionId}`);
      await this.runtime.subscribe(notice.sessionId, { seq: info.last_seq ?? 0 });
    } catch {
      /* the next attach/start retries; the session stays usable */
    }
  }

  private handleRuntimeDown(): void {
    for (const record of this.records.values()) {
      const downTurnId = record.activeTurn?.gianTurnId ?? null;
      if (downTurnId !== null) {
        void this.fenceActiveTurn(record, downTurnId, 'The Kimi server exited while the turn was running.');
      }
      this.clearInterruptTimer(record.sessionId);
      this.setState(record, 'stale');
      this.emitSink({
        method: 'runtime.error',
        params: {
          eventId: `runtime-down-${sha32([record.sessionId, Date.now()])}`,
          sessionId: record.sessionId,
          streamId: record.streamId,
          sequence: this.nextSequence(record.sessionId),
          emittedAt: nowIso(),
          data: {
            domainCode: 'RUNTIME_ERROR',
            message: 'The Kimi server process exited; the session is stale and recovers on the next request.',
            retryable: true,
            details: {},
          },
        },
      });
    }
  }

  // ---- session lifecycle ----

  async createSession(params: {
    sessionId: string;
    cwd: string;
    nativeSessionId?: string;
    history?: 'none' | 'replay';
  }): Promise<{ snapshot: Record<string, unknown> }> {
    await this.ensureStarted();
    const existing = this.records.get(params.sessionId);
    if (existing !== undefined) {
      // Rebind path (proxy-side restart): the native identity must match.
      if (params.nativeSessionId !== undefined && params.nativeSessionId !== existing.nativeSessionId) {
        throw new KimiProtocolError('CONFLICT', 'Session id names a different native session.');
      }
      const info = await this.runtime.rest.request<KimiSessionInfo>(
        'GET', `/api/v1/sessions/${existing.nativeSessionId}`,
      );
      if (info.busy === true) {
        throw new KimiProtocolError('SESSION_BUSY', 'The native session is busy; refusing to rebind.');
      }
      existing.streamId = `stream-${sha32([params.sessionId, nowIso()])}`;
      existing.projector.setStreamId(existing.streamId);
      this.setState(existing, 'idle');
      await this.subscribeNative(existing, { seq: info.last_seq ?? 0 });
      // History arrives via the host's own session.replay pull; no push here.
      return { snapshot: this.snapshot(existing) };
    }

    if (params.nativeSessionId !== undefined) {
      const info = await this.runtime.rest.request<KimiSessionInfo>(
        'GET', `/api/v1/sessions/${params.nativeSessionId}`,
      ).catch((error: unknown) => {
        if (error instanceof KimiApiError && error.code === 40401) {
          throw new KimiProtocolError('NATIVE_SESSION_NOT_FOUND', `Kimi session ${params.nativeSessionId} does not exist.`);
        }
        throw error;
      });
      if (info.busy === true) {
        throw new KimiProtocolError('SESSION_BUSY', 'The native session is busy; refusing to attach.');
      }
      const record = this.register({
        sessionId: params.sessionId,
        nativeSessionId: info.id,
        cwd: info.metadata?.cwd ?? params.cwd,
        state: 'attaching',
        activeTurn: null,
        isSidechat: false,
        parentSessionId: null,
      });
      this.setState(record, 'idle');
      await this.subscribeNative(record, { seq: info.last_seq ?? 0 });
      // History arrives via the host's own session.replay pull; no push here.
      return { snapshot: this.snapshot(record) };
    }

    // Fresh native session. The workspace must be registered first (the
    // server refuses sessions with unknown roots, error 40409).
    const workspace = await this.runtime.rest.request<{ id: string }>('POST', '/api/v1/workspaces', {
      json: { root: params.cwd },
    });
    const info = await this.runtime.rest.request<KimiSessionInfo>('POST', '/api/v1/sessions', {
      json: { metadata: { cwd: params.cwd }, workspace_id: workspace.id },
    });
    const record = this.register({
      sessionId: params.sessionId,
      nativeSessionId: info.id,
      cwd: params.cwd,
      state: 'attaching',
      activeTurn: null,
      isSidechat: false,
      parentSessionId: null,
    });
    this.setState(record, 'idle');
    await this.subscribeNative(record);
    return { snapshot: this.snapshot(record) };
  }

  private async subscribeNative(
    record: SessionRecord,
    cursor?: SessionCursor,
    options: { retainOnFailure?: boolean; resume?: boolean } = {},
  ): Promise<void> {
    try {
      // A native child/fork is persisted but cold. kap-server's WS
      // broadcaster accepts only live sessions; listing one message resumes
      // it without sending a prompt or changing the user's configuration.
      if (options.resume !== false) {
        await this.runtime.rest.request('GET', `/api/v1/sessions/${record.nativeSessionId}/messages`, {
          query: { page_size: 1 },
        });
      }
      await this.runtime.subscribe(record.nativeSessionId, cursor);
    } catch (error) {
      if (options.retainOnFailure === true) {
        this.setState(record, 'stale');
        this.emitSessionUpdated(record);
      } else {
        this.dropRecord(record);
      }
      throw error instanceof KimiProtocolError
        ? error
        : new KimiProtocolError('RUNTIME_ERROR', `Kimi event subscription failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private dropRecord(record: SessionRecord): void {
    this.records.delete(record.sessionId);
    if (this.byNative.get(record.nativeSessionId) === record.sessionId) {
      this.byNative.delete(record.nativeSessionId);
    }
    this.runtime.forgetSession(record.nativeSessionId);
  }

  private async fetchAllMessages(nativeSessionId: string): Promise<KimiMessage[]> {
    const messages: KimiMessage[] = [];
    let beforeId: string | undefined = undefined;
    for (;;) {
      const page: { items: KimiMessage[]; has_more?: boolean } = await this.runtime.rest.request<{ items: KimiMessage[]; has_more?: boolean }>(
        'GET',
        `/api/v1/sessions/${nativeSessionId}/messages`,
        { query: { page_size: MESSAGE_PAGE_SIZE, ...(beforeId !== undefined ? { before_id: beforeId } : {}) } },
      );
      messages.push(...page.items);
      if (page.has_more !== true || page.items.length === 0) break;
      beforeId = page.items.at(-1)!.id;
    }
    // Native messages are newest first; replay needs chronological order.
    return messages.reverse();
  }

  snapshot(record: SessionRecord): Record<string, unknown> {
    return {
      id: record.sessionId,
      nativeSession: { id: record.nativeSessionId },
      streamId: record.streamId,
      state: record.state === 'attaching' ? 'idle' : record.state,
      sessionConfig: {},
      availableActions: this.availableActions(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  describeSession(sessionId: string): Record<string, unknown> {
    return this.snapshot(this.requireSession(sessionId));
  }

  /** Fork and side chat share one gate. Unsupported actions belong only in
   *  Catalog, never in availableActions, even when disabled. */
  private availableActions(record: SessionRecord): Record<string, { enabled: boolean; reason?: string }> {
    const busy = record.activeTurn !== null
      || record.state === 'running'
      || record.state === 'waiting_interaction';
    const ready = !busy && record.state !== 'stale' && record.state !== 'attaching' && record.lastCompleted !== null;
    const gate = ready
      ? { enabled: true }
      : {
          enabled: false,
          reason: busy
            ? 'Wait for the active turn to finish.'
            : 'No completed turn is available to fork from.',
        };
    return {
      'sidechat.create': { ...gate },
      'session.fork': { ...gate },
    };
  }

  private emitSessionUpdated(record: SessionRecord): void {
    const state = record.state === 'attaching' ? 'idle' : record.state;
    this.emitSink({
      method: 'session.updated',
      params: {
        eventId: `evt-${sha32([record.sessionId, 'session.updated', state, record.updatedAt]).slice(0, 16)}`,
        sessionId: record.sessionId,
        streamId: record.streamId,
        sequence: this.nextSequence(record.sessionId),
        emittedAt: nowIso(),
        data: {
          state,
          availableActions: this.availableActions(record),
          updatedAt: record.updatedAt,
        },
      },
    });
  }

  async closeSession(sessionId: string, streamId: string): Promise<void> {
    const record = this.requireStream(sessionId, streamId);
    if (record.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Cannot close while a turn is active.');
    }
    this.dropRecord(record);
    // Detach only: the Kimi session and its history stay in the store.
  }

  // ---- native list / rename / delete ----

  async listNativeSessions(params: {
    cwd?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<{ sessions: Array<Record<string, unknown>>; nextCursor: string | null }> {
    await this.ensureStarted();
    const limit = params.limit ?? 100;
    let beforeId: string | undefined = undefined;
    if (params.cursor !== null && params.cursor !== undefined && params.cursor !== '') {
      try {
        const parsed = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as { before?: unknown; after?: unknown };
        const pivot = parsed.before ?? parsed.after; // Retain readability of older opaque cursors.
        if (typeof pivot === 'string') beforeId = pivot;
      } catch {
        throw new KimiProtocolError('INVALID_PARAMS', 'cursor is not a valid native list cursor.');
      }
    }
    const page = await this.runtime.rest.request<{ items: KimiSessionInfo[]; has_more?: boolean }>(
      'GET',
      '/api/v1/sessions',
      {
        query: {
          page_size: Math.min(limit, NATIVE_SESSION_PAGE_SIZE),
          busy: false,
          include_archive: false,
          ...(beforeId !== undefined ? { before_id: beforeId } : {}),
        },
      },
    );
    const items = page.items.filter((session) => {
      if (this.byNative.has(session.id)) return false;
      if (params.cwd !== undefined && session.metadata?.cwd !== params.cwd) return false;
      return true;
    });
    const nextCursor = page.has_more === true && page.items.length > 0
      ? Buffer.from(JSON.stringify({ before: page.items.at(-1)!.id }), 'utf8').toString('base64url')
      : null;
    return {
      sessions: items.map((session) => ({
        id: session.id,
        ...(session.title ? { displayName: session.title } : {}),
        ...(session.metadata?.cwd ? { cwd: session.metadata.cwd } : {}),
        ...(session.updated_at ? { updatedAt: session.updated_at } : {}),
      })),
      nextCursor,
    };
  }

  async renameSession(sessionId: string, streamId: string, name: string): Promise<void> {
    const record = this.requireStream(sessionId, streamId);
    await this.runtime.rest.request('POST', `/api/v1/sessions/${record.nativeSessionId}/profile`, {
      json: { title: name },
    });
  }

  async deleteNativeSession(nativeSessionId: string): Promise<void> {
    await this.ensureStarted();
    if (this.byNative.has(nativeSessionId)) {
      throw new KimiProtocolError('SESSION_BUSY', 'The native session is attached; close it before deleting.');
    }
    await this.runtime.rest.request('POST', `/api/v1/sessions/${nativeSessionId}:delete`, { json: {} });
  }

  // ---- turns ----

  async startTurn(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    input: OuterInputItem[];
    config: TurnConfigMap;
  }): Promise<void> {
    const record = this.requireStream(params.sessionId, params.streamId);
    // Validate the payload BEFORE the busy check: a malformed input must be
    // INVALID_PARAMS regardless of session state, and no prompt is submitted.
    const built = buildPromptInput(params.input);
    if (record.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'A turn is already active.');
    }
    // An attach-time ACK is no longer proof after a socket/server restart.
    // Resume the native session and confirm the current subscription before
    // submitting any prompt, including a cached Side Chat's first send.
    await this.ensureStarted();
    await this.subscribeNative(record, undefined, {
      retainOnFailure: true,
      resume: record.state === 'stale',
    });
    if (record.state === 'stale') this.setState(record, 'idle');
    const promptId = `gian-${sha32([record.nativeSessionId, params.turnId, built])}`;
    // Frames that beat the POST response are buffered in the projector and
    // flushed by bindTurn, so a fast native turn loses no events.
    record.projector.beginBinding();
    let response: {
      prompt_id: string;
      status: 'running' | 'queued' | 'blocked';
    };
    try {
      response = await this.runtime.rest.request<{
        prompt_id: string;
        status: 'running' | 'queued' | 'blocked';
      }>('POST', `/api/v1/sessions/${record.nativeSessionId}/prompts`, {
        json: {
          content: built.content,
          prompt_id: promptId,
          ...(built.skills.length > 0 ? { skills: built.skills } : {}),
          ...(params.config.model !== undefined ? { model: params.config.model } : {}),
          ...(params.config.thinking !== undefined ? { thinking: params.config.thinking } : {}),
          ...(params.config.approval_mode !== undefined ? { permission_mode: params.config.approval_mode } : {}),
        },
      });
    } catch (error) {
      record.projector.discardBinding();
      if (error instanceof KimiApiError && error.code === 40927) {
        throw new KimiProtocolError('CONFLICT', 'The Kimi server already accepted this turn (prompt id conflict).');
      }
      throw error;
    }
    if (response.status === 'queued') {
      // The server had an active prompt we did not start: never present a
      // queued submission as our turn, and never leave it queued to run later.
      record.projector.discardBinding();
      await this.abortNativePrompt(record, response.prompt_id);
      throw new KimiProtocolError('SESSION_BUSY', 'The Kimi session already has an active prompt.');
    }
    record.activeTurn = {
      gianTurnId: params.turnId,
      promptId: response.prompt_id,
      nativeTurnId: null,
      interruptAccepted: false,
    };
    // turn.started precedes the buffered frames that bindTurn flushes.
    this.emitSink({
      method: 'turn.started',
      params: {
        eventId: `evt-${sha32([record.nativeSessionId, response.prompt_id, 'turn.started']).slice(0, 16)}`,
        sessionId: record.sessionId,
        streamId: record.streamId,
        sequence: this.nextSequence(record.sessionId),
        turnId: params.turnId,
        sourceTurnId: response.prompt_id,
        emittedAt: nowIso(),
        data: {},
      },
    });
    record.projector.bindTurn({ gianTurnId: params.turnId, promptId: response.prompt_id });
    // The flush may have surfaced a buffered approval/question: converge on
    // waiting_interaction instead of blindly reporting running.
    this.setState(record, record.projector.pendingInteractions.size > 0 ? 'waiting_interaction' : 'running');
    this.emitSessionUpdated(record);
  }

  async steerTurn(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    input: OuterInputItem[];
  }): Promise<void> {
    const record = this.requireStream(params.sessionId, params.streamId);
    const turn = record.activeTurn;
    if (turn === null || turn.gianTurnId !== params.turnId) {
      throw new KimiProtocolError('TURN_NOT_FOUND', 'No active turn to steer; steering applies to a running turn only.');
    }
    const built = buildPromptInput(params.input);
    const promptId = `gian-${sha32(['steer', record.nativeSessionId, params.turnId, built])}`;
    const submitted = await this.runtime.rest.request<{ status: 'running' | 'queued' | 'blocked' }>(
      'POST',
      `/api/v1/sessions/${record.nativeSessionId}/prompts`,
      { json: { content: built.content, prompt_id: promptId } },
    ).catch((error: unknown) => {
      if (error instanceof KimiApiError && error.code === 40927) {
        // Identical steer replay: the queued prompt already exists.
        return { status: 'queued' as const };
      }
      throw error;
    });
    if (submitted.status !== 'queued') {
      throw new KimiProtocolError('SESSION_ERROR', 'The Kimi session has no active prompt to steer into.');
    }
    await this.runtime.rest.request<{ steered: boolean }>(
      'POST',
      `/api/v1/sessions/${record.nativeSessionId}/prompts:steer`,
      { json: { prompt_ids: [promptId] } },
    ).catch((error: unknown) => {
      if (error instanceof KimiApiError && (error.code === 40402 || error.code === 40401)) {
        throw new KimiProtocolError('TURN_NOT_FOUND', 'The Kimi session has no active turn to steer into.');
      }
      throw error;
    });
    // No terminal of our own: the running turn keeps its identity and ends
    // through its own turn.ended event.
  }

  async interruptTurn(params: { sessionId: string; streamId: string; turnId: string }): Promise<void> {
    const record = this.requireStream(params.sessionId, params.streamId);
    const turn = record.activeTurn;
    if (turn === null || turn.gianTurnId !== params.turnId) {
      throw new KimiProtocolError('TURN_NOT_FOUND', `Turn ${params.turnId} is not active.`);
    }
    const result = await this.runtime.rest.request<{ aborted: boolean }>(
      'POST',
      `/api/v1/sessions/${record.nativeSessionId}/prompts/${turn.promptId}:abort`,
      { json: {} },
    ).catch((error: unknown) => {
      if (error instanceof KimiApiError && error.code === 40402) {
        return { aborted: false };
      }
      throw error;
    });
    if (result.aborted) {
      record.projector.markInterruptAccepted();
    }
    // aborted=false means the prompt already finished and its terminal is in
    // flight; either way the watchdog fences the turn if no terminal lands.
    this.armInterruptWatchdog(record, params.turnId);
  }

  private armInterruptWatchdog(record: SessionRecord, gianTurnId: string): void {
    this.clearInterruptTimer(record.sessionId);
    const timer = setTimeout(() => {
      this.interruptTimers.delete(record.sessionId);
      if (record.activeTurn !== null && record.activeTurn.gianTurnId === gianTurnId) {
        void this.fenceActiveTurn(
          record,
          gianTurnId,
          'The interrupted turn never received a terminal event from the Kimi server; the runtime was fenced.',
        );
      }
    }, INTERRUPT_SETTLE_MS);
    timer.unref();
    this.interruptTimers.set(record.sessionId, timer);
  }

  /** Best-effort native isolation: a fenced turn must not leave its native
   *  prompt running unattributed. */
  private async abortNativePrompt(record: SessionRecord, promptId: string): Promise<void> {
    try {
      await this.runtime.rest.request(
        'POST',
        `/api/v1/sessions/${record.nativeSessionId}/prompts/${promptId}:abort`,
        { json: {}, timeoutMs: FENCE_ABORT_TIMEOUT_MS },
      );
    } catch { /* the runtime may already be gone */ }
  }

  /** Fence one specific turn. The bounded abort wait can let that turn
   *  finalize and a fresh turn bind in the meantime, so the turn identity is
   *  re-verified after the wait: a fence never fails a turn it did not set
   *  out to fence. */
  private async fenceActiveTurn(record: SessionRecord, gianTurnId: string, message: string): Promise<void> {
    if (record.activeTurn?.gianTurnId !== gianTurnId) return;
    await this.abortNativePrompt(record, record.activeTurn.promptId);
    if (record.activeTurn?.gianTurnId !== gianTurnId) return;
    if (record.projector.activeGianTurnId() !== gianTurnId) return;
    await record.projector.failTurn(message, true);
  }

  private clearInterruptTimer(sessionId: string): void {
    const timer = this.interruptTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.interruptTimers.delete(sessionId);
    }
  }

  // ---- interactions ----

  async respondInteraction(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    interactionId: string;
    actionId: string;
    values: Record<string, unknown>;
  }): Promise<void> {
    const record = this.requireStream(params.sessionId, params.streamId);
    const pending = record.projector.pendingInteractions.get(params.interactionId);
    if (pending === undefined) {
      throw new KimiProtocolError('INTERACTION_NOT_FOUND', `Interaction ${params.interactionId} is not pending.`);
    }
    if (pending.turnId !== params.turnId) {
      throw new KimiProtocolError('INTERACTION_NOT_FOUND', 'Interaction belongs to a different turn.');
    }
    if (pending.kind === 'approval') {
      if (params.actionId !== 'approved' && params.actionId !== 'rejected') {
        throw new KimiProtocolError('INTERACTION_ACTION_NOT_FOUND', `Action ${params.actionId} was not advertised.`);
      }
      const feedback = params.values.feedback;
      await this.runtime.rest.request(
        'POST',
        `/api/v1/sessions/${record.nativeSessionId}/approvals/${pending.nativeId}`,
        {
          json: {
            decision: params.actionId,
            ...(typeof feedback === 'string' && feedback !== '' ? { feedback } : {}),
          },
        },
      ).catch((error: unknown) => {
        if (error instanceof KimiApiError && (error.code === 40902 || error.code === 41001)) {
          throw new KimiProtocolError('INTERACTION_NOT_FOUND', 'The approval is no longer pending on the Kimi server.');
        }
        throw error;
      });
    } else {
      if (params.actionId !== 'accept' && params.actionId !== 'decline') {
        throw new KimiProtocolError('INTERACTION_ACTION_NOT_FOUND', `Action ${params.actionId} was not advertised.`);
      }
      if (params.actionId === 'decline') {
        await this.runtime.rest.request(
          'POST',
          `/api/v1/sessions/${record.nativeSessionId}/questions/${pending.nativeId}:dismiss`,
          { json: {} },
        ).catch((error: unknown) => {
          if (error instanceof KimiApiError && (error.code === 40909 || error.code === 40405)) {
            throw new KimiProtocolError('INTERACTION_NOT_FOUND', 'The question is no longer pending on the Kimi server.');
          }
          throw error;
        });
      } else {
        const answers = wrapQuestionAnswers(pending.inputs, params.values);
        const note = params.values.note;
        await this.runtime.rest.request(
          'POST',
          `/api/v1/sessions/${record.nativeSessionId}/questions/${pending.nativeId}`,
          {
            json: {
              answers,
              ...(typeof note === 'string' && note !== '' ? { note } : {}),
            },
          },
        ).catch((error: unknown) => {
          if (error instanceof KimiApiError && (error.code === 40909 || error.code === 40405)) {
            throw new KimiProtocolError('INTERACTION_NOT_FOUND', 'The question is no longer pending on the Kimi server.');
          }
          throw error;
        });
      }
    }
    const resolvedHere = record.projector.resolveInteraction(params.interactionId);
    this.reconcileState(record);
    // WS may report the native resolution before REST answers. Its fact is
    // already projected; accepting this response must not resolve it twice.
    if (!resolvedHere) return;
    this.emitSink({
      method: 'interaction.resolved',
      params: {
        eventId: `evt-${sha32([record.nativeSessionId, params.interactionId, 'resolved', params.actionId]).slice(0, 16)}`,
        sessionId: record.sessionId,
        streamId: record.streamId,
        sequence: this.nextSequence(record.sessionId),
        turnId: params.turnId,
        sourceTurnId: record.activeTurn?.promptId ?? pending.turnId,
        emittedAt: nowIso(),
        data: {
          interactionId: params.interactionId,
          ...(pending.kind === 'question' && params.actionId === 'decline'
            ? { outcome: 'cancelled' }
            : { outcome: 'submitted', actionId: params.actionId }),
        },
      },
    });
  }

  // ---- fork & side chat ----

  async forkSession(params: {
    sourceSessionId: string;
    sourceStreamId: string;
    sessionId: string;
    anchor: { type: 'head' } | { type: 'turn'; turnId: string; sourceTurnId: string };
  }): Promise<{ session: Record<string, unknown>; origin: Record<string, unknown> }> {
    const source = this.requireStream(params.sourceSessionId, params.sourceStreamId);
    if (params.anchor.type === 'turn') {
      throw new KimiProtocolError(
        'FORK_BOUNDARY_UNAVAILABLE',
        'The Kimi server API exposes only head forks: POST /sessions/{id}/children has no turn '
        + 'boundary (the engine forkSessionOptionsSchema has turnIndex, but it is not on the REST surface).',
      );
    }
    if (source.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Refusing to fork while a turn is active.');
    }
    if (source.lastCompleted === null) {
      throw new KimiProtocolError(
        'FORK_BOUNDARY_UNAVAILABLE',
        'The source session has no completed turn to fork from.',
      );
    }
    await this.ensureStarted();
    const child = await this.runtime.rest.request<KimiSessionInfo>(
      'POST',
      `/api/v1/sessions/${source.nativeSessionId}/children`,
      { json: {} },
    );
    const record = this.register({
      sessionId: params.sessionId,
      nativeSessionId: child.id,
      cwd: child.metadata?.cwd ?? source.cwd,
      state: 'attaching',
      activeTurn: null,
      isSidechat: false,
      parentSessionId: source.sessionId,
    });
    this.setState(record, 'idle');
    await this.subscribeNative(record, { seq: child.last_seq ?? 0 });
    return {
      session: this.snapshot(record),
      origin: {
        kind: 'fork',
        sessionId: params.sourceSessionId,
        turnId: source.lastCompleted.gianTurnId,
        sourceTurnId: source.lastCompleted.promptId,
      },
    };
  }

  async createSidechat(params: {
    parentSessionId: string;
    parentStreamId: string;
    sidechatId: string;
  }): Promise<Record<string, unknown>> {
    const parent = this.requireStream(params.parentSessionId, params.parentStreamId);
    if (parent.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Refusing to open a Side Chat while a turn is active.');
    }
    const anchor = parent.lastCompleted === null
      ? { type: 'empty' as const }
      : {
          type: 'turn' as const,
          turnId: parent.lastCompleted.gianTurnId,
          sourceTurnId: parent.lastCompleted.promptId,
        };
    await this.ensureStarted();
    const child = await this.runtime.rest.request<KimiSessionInfo>(
      'POST',
      `/api/v1/sessions/${parent.nativeSessionId}/children`,
      { json: {} },
    );
    const record = this.register({
      sessionId: params.sidechatId,
      nativeSessionId: child.id,
      cwd: child.metadata?.cwd ?? parent.cwd,
      state: 'attaching',
      activeTurn: null,
      isSidechat: true,
      parentSessionId: parent.sessionId,
    });
    this.setState(record, 'idle');
    await this.subscribeNative(record, { seq: child.last_seq ?? 0 });
    const resumeRef = this.sidechatStore.seal({
      sidechatId: params.sidechatId,
      parentSessionId: params.parentSessionId,
      nativeSessionId: child.id,
      anchor,
      sessionConfig: {},
      createdAt: nowIso(),
    });
    return this.sidechatSnapshot(record, resumeRef.id, anchor);
  }

  async resumeSidechat(params: {
    sidechatId: string;
    parentSessionId: string;
    resumeRef: { id: string };
  }): Promise<Record<string, unknown>> {
    const tombstone = this.sidechatStore.closed(params.resumeRef.id);
    if (tombstone !== null) {
      throw new KimiProtocolError('SIDECHAT_UNAVAILABLE', 'This Side Chat was closed permanently.');
    }
    const payload = this.sidechatStore.open(params.resumeRef.id);
    if (payload === null) {
      throw new KimiProtocolError('SIDECHAT_UNAVAILABLE', 'The resume reference is not readable.');
    }
    const existing = this.records.get(params.sidechatId);
    if (existing !== undefined && existing.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Cannot resume while the Side Chat turn is still settling.');
    }
    await this.ensureStarted();
    const info = await this.runtime.rest.request<KimiSessionInfo>('GET', `/api/v1/sessions/${payload.nativeSessionId}`);
    if (info.busy === true) {
      throw new KimiProtocolError('SESSION_BUSY', 'The Side Chat native session is busy.');
    }
    const record = this.register({
      sessionId: params.sidechatId,
      nativeSessionId: payload.nativeSessionId,
      cwd: info.metadata?.cwd ?? '',
      state: 'attaching',
      activeTurn: null,
      isSidechat: true,
      parentSessionId: params.parentSessionId,
    });
    this.setState(record, 'idle');
    await this.subscribeNative(record, { seq: info.last_seq ?? 0 });
    return this.sidechatSnapshot(record, params.resumeRef.id, payload.anchor);
  }

  async closeSidechat(params: { sidechatId: string; streamId?: string; resumeRef: { id: string } }): Promise<void> {
    const record = this.requireSession(params.sidechatId);
    if (record.isSidechat !== true) {
      throw new KimiProtocolError('SESSION_STALE', `${params.sidechatId} is not a Side Chat.`);
    }
    if (record.activeTurn !== null) {
      throw new KimiProtocolError('SESSION_BUSY', 'Cannot close while a turn is active.');
    }
    if (params.streamId !== undefined) this.requireStream(params.sidechatId, params.streamId);
    this.dropRecord(record);
    // Kimi's :delete permanence is not verified for child sessions; the
    // tombstone invalidates the resume ref and reports history honestly.
    this.sidechatStore.rememberClosed(params.resumeRef.id, {
      sidechatId: params.sidechatId,
      providerDataDeleted: false,
    });
  }

  private sidechatSnapshot(
    record: SessionRecord,
    resumeRefId: string,
    anchor: { type: 'empty' } | { type: 'turn' | 'activeInput'; turnId: string; sourceTurnId: string },
  ): Record<string, unknown> {
    return {
      id: record.sessionId,
      parentSessionId: record.parentSessionId ?? '',
      streamId: record.streamId,
      state: record.state === 'attaching' ? 'idle' : record.state,
      resumeRef: { id: resumeRefId },
      anchor,
      sessionConfig: {},
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  // ---- replay ----

  /** Full replay snapshot; the adapter owns cursor pagination over it. */
  async replay(params: {
    sessionId: string;
    streamId: string;
  }): Promise<{ replayStreamId: string; events: Array<Record<string, unknown>> }> {
    const record = this.requireStream(params.sessionId, params.streamId);
    const messages = await this.fetchAllMessages(record.nativeSessionId);
    const revision = sha32([messages.length, messages.at(-1)?.id ?? '']);
    const replayStreamId = `replay:kimi:${record.nativeSessionId}:${revision}:v2`;
    const events = buildReplayEvents({
      sessionId: record.sessionId,
      nativeSessionId: record.nativeSessionId,
      replayStreamId,
      messages,
    });
    return { replayStreamId, events: events as unknown as Array<Record<string, unknown>> };
  }

  // ---- catalog facts ----

  async catalogFacts(): Promise<{ models: KimiModelInfo[]; defaultModel: string | null }> {
    await this.ensureStarted();
    const models = await this.runtime.rest.request<{ items: KimiModelInfo[] }>('GET', '/api/v1/models');
    let defaultModel: string | null = null;
    try {
      const config = await this.runtime.rest.request<{ default_model?: string }>('GET', '/api/v1/config');
      defaultModel = typeof config.default_model === 'string' && config.default_model !== '' ? config.default_model : null;
    } catch {
      defaultModel = null;
    }
    return { models: models.items, defaultModel };
  }

  // ---- customization ----

  async inspectCustomizations(params: {
    kind: import('@gian/proxy-protocol').CustomizationKind;
    cwd?: string;
  }): Promise<import('@gian/proxy-protocol').CustomizationListResult> {
    try {
      return await this.customization.list(params.kind, params.cwd ?? null);
    } catch (error) {
      if (error instanceof ScanTimeoutError) {
        return {
          kind: params.kind,
          status: 'unavailable',
          completeness: 'none',
          observedAt: nowIso(),
          items: [],
          truncated: false,
          diagnostics: [{
            code: 'PROVIDER_INSPECTION_FAILED',
            message: `Kimi ${params.kind} scan exceeded its inspection bound.`,
          }],
        };
      }
      throw error;
    }
  }

  async customizationDetail(params: {
    kind: import('@gian/proxy-protocol').CustomizationKind;
    id: string;
    cwd?: string;
  }): Promise<import('@gian/proxy-protocol').CustomizationDetailResult> {
    try {
      return await this.customization.detail(params.kind, params.id, params.cwd ?? null);
    } catch (error) {
      if (error instanceof ScanTimeoutError) {
        return {
          kind: params.kind,
          id: params.id,
          status: 'unavailable',
          observedAt: nowIso(),
          text: '',
          truncated: false,
          diagnostics: [{ code: 'PROVIDER_INSPECTION_FAILED', message: 'Kimi detail scan exceeded its inspection bound.' }],
        };
      }
      throw error;
    }
  }

  // ---- shutdown ----

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const timer of this.interruptTimers.values()) clearTimeout(timer);
    this.interruptTimers.clear();
    await this.runtime.stop();
  }

  // ---- diff helper ----

  private async fetchFileDiff(nativeSessionId: string, nativeTurnId: number): Promise<{
    diff: string;
    truncated: boolean;
    files: Array<Record<string, unknown>>;
  } | null> {
    const deadline = Date.now() + DIFF_PHASE_BUDGET_MS;
    const changes = await this.runtime.rest.request<{ changes: KimiFileChange[] }>(
      'GET',
      `/api/v1/sessions/${nativeSessionId}/file-history/changes`,
      { query: { turn_id: nativeTurnId }, timeoutMs: DIFF_REQUEST_TIMEOUT_MS },
    );
    if (changes.changes.length === 0) return null;
    const files: Array<Record<string, unknown>> = [];
    const patchParts: string[] = [];
    let truncated = false;
    for (const change of changes.changes.slice(0, 20)) {
      files.push({ path: change.path, status: change.status });
      if (change.binary === true || change.oversize === true) {
        truncated = true;
        continue;
      }
      if (Date.now() >= deadline) {
        // The facet budget is spent: keep the file facts, skip the content.
        truncated = true;
        continue;
      }
      try {
        const before = await this.runtime.rest.request<{ content: { content?: string; binary?: boolean } }>(
          'GET',
          `/api/v1/sessions/${nativeSessionId}/file-history/content`,
          { query: { turn_id: nativeTurnId, path: change.path, phase: 'before' }, timeoutMs: DIFF_REQUEST_TIMEOUT_MS },
        );
        const after = await this.runtime.rest.request<{ content: { content?: string; binary?: boolean } }>(
          'GET',
          `/api/v1/sessions/${nativeSessionId}/file-history/content`,
          { query: { turn_id: nativeTurnId, path: change.path, phase: 'after' }, timeoutMs: DIFF_REQUEST_TIMEOUT_MS },
        );
        const rendered = renderUnifiedDiff(
          change.path,
          before.content.content ?? '',
          change.status === 'deleted' ? '' : after.content.content ?? '',
        );
        if (rendered.truncated) truncated = true;
        if (rendered.diff !== '') patchParts.push(rendered.diff);
      } catch {
        // The before/after phases are best-effort; the file facts stay.
        truncated = true;
      }
    }
    return { diff: patchParts.join('\n'), truncated, files };
  }
}

/** Kimi transport/API errors → gian domain errors (shared with the adapter). */
export function normalizeKimiError(error: unknown): KimiProtocolError {
  if (error instanceof KimiProtocolError) return error;
  if (error instanceof KimiApiError) {
    const mapped = mapApiError(error.code);
    return new KimiProtocolError(mapped.domain, error.message, mapped.retryable);
  }
  if (error instanceof KimiTransportError) {
    return new KimiProtocolError('RUNTIME_ERROR', error.message, true);
  }
  return new KimiProtocolError('INTERNAL', error instanceof Error ? error.message : String(error));
}

function mapApiError(code: number): { domain: import('../transport/protocol.js').DomainCode; retryable: boolean } {
  switch (code) {
    case 40001:
    case 40002:
    case 40409:
    case 41301:
      return { domain: 'INVALID_PARAMS', retryable: false };
    case 40401:
      return { domain: 'SESSION_NOT_FOUND', retryable: false };
    case 40901:
      return { domain: 'SESSION_BUSY', retryable: false };
    case 40402:
      return { domain: 'TURN_NOT_FOUND', retryable: false };
    case 40404:
    case 40405:
    case 40902:
    case 40909:
    case 41001:
    case 41002:
      return { domain: 'INTERACTION_NOT_FOUND', retryable: false };
    case 40927:
      return { domain: 'CONFLICT', retryable: false };
    case 40110:
    case 40111:
    case 40112:
    case 40113:
      return { domain: 'RUNTIME_AUTH_REQUIRED', retryable: false };
    case 40926:
      return { domain: 'RUNTIME_ERROR', retryable: true };
    default:
      return { domain: 'RUNTIME_ERROR', retryable: false };
  }
}
