/**
 * gian.proxy/2.1 adapter for com.zhipu.zcode.
 *
 * Response barriers (contract §16): every mutating request queues the
 * notifications it causes and the CLI flushes them AFTER the response.
 * `turn.started` is emitted when ZCode's typed `turn-started` event confirms
 * runtime execution, so the outer stream never claims a fact before the
 * runtime does.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import {
  capabilitiesFor,
  INNER_PROTOCOL_NAME,
  INNER_PROTOCOL_VERSION,
  PLUGIN_ID,
  PLUGIN_NAME,
  PLUGIN_VERSION,
} from './identity.js';
import {
  bootstrapCatalog,
  decodeModelValue,
  projectCatalog,
  resolveCatalog,
  ConfigValueInvalidError,
  revisionFor,
  type ProjectedCatalog,
} from './catalog.js';
import { SessionProjector, terminalEventIdFor, type OuterNotification } from './events.js';
import {
  GIAN_RUNTIME_PREFERENCES,
  InnerError,
  type InnerRuntimeFailure,
  redactSecrets,
  registerGianReverseHandlers,
  ZCodeTransport,
} from './inner/transport.js';
import type { InnerReadState, InnerSessionSummary, InnerSettings, InnerSlashCommand } from './inner/model.js';
import {
  InteractionResponseLedger,
  randomId,
  SessionRegistry,
  SessionRegistryError,
  TurnLedger,
  type SessionRecord,
} from './ownership.js';

export class ServiceError extends Error {
  readonly domainCode: string;
  readonly retryable: boolean;
  constructor(domainCode: string, message: string, retryable = false) {
    super(message);
    this.name = 'ServiceError';
    this.domainCode = domainCode;
    this.retryable = retryable;
  }
}

export interface WireRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface DispatchOutcome {
  ok: boolean;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: { domainCode: string; retryable: boolean; details?: Record<string, unknown> };
  };
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
}

type ConfigValue = string | number | boolean | null;

interface PendingInteraction {
  gianSessionId: string;
  gianTurnId: string;
  serverRequestId: string;
  responses: Map<string, Record<string, unknown>>;
  resolved: boolean;
}

const EMPTY_CATALOG: ProjectedCatalog = bootstrapCatalog('uninitialized');

export class ZcodeV2Adapter {
  private initialized = false;
  private queue: Array<{ method: string; params: Record<string, unknown> }> | null = null;
  private catalog: ProjectedCatalog = EMPTY_CATALOG;
  private readonly registry: SessionRegistry;
  private readonly turns = new TurnLedger();
  private readonly responses = new InteractionResponseLedger();
  private readonly projectors = new Map<string, SessionProjector>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly sessionSequence = new Map<string, number>();
  private optionsEmit: (notification: OuterNotification) => void = () => undefined;
  private runtimeKeyCache: string | null = null;
  private stopping = false;

  constructor(
    private readonly transport: ZCodeTransport,
    private readonly options: {
      dataDir: string | null;
      /** ReadState workspace for the side-effect-free catalog (defaults to dataDir). */
      catalogWorkspace: string;
      interactionEnabled: boolean;
      runtimeBin: string;
      isNativeSessionOwned?: (nativeSessionId: string) => boolean;
    },
  ) {
    this.registry = new SessionRegistry(options.dataDir);
    registerGianReverseHandlers(this.transport);
    this.transport.registerReverseHandler('interaction/requestPermission', (params, transportId) => (
      this.handlePermissionReverseRequest(params, transportId)
    ));
    this.transport.on('notification', (notification: { method: string; params: Record<string, unknown> }) => {
      this.routeInnerNotification(notification.method, notification.params);
    });
    this.transport.on('runtime-failure', (failure: InnerRuntimeFailure) => {
      this.handleInnerRuntimeFailure(failure);
    });
    this.transport.on('exit', (code: number | null, signal: string | null) => {
      if (!this.stopping) this.handleInnerRuntimeExit(code, signal);
    });
  }

  private handleInnerRuntimeFailure(failure: InnerRuntimeFailure): void {
    for (const record of this.registry.activeRecords()) {
      const projector = this.projectors.get(record.nativeSessionId);
      projector?.finalizeTurn('error_provider_business', { runtimeFailure: failure });
      for (const [interactionId, pending] of this.pendingInteractions) {
        if (pending.gianSessionId !== record.sessionId) continue;
        this.pendingInteractions.delete(interactionId);
        try {
          this.transport.respondToServer(pending.serverRequestId, {
            error: { code: -32603, message: 'Provider turn ended before permission was resolved.' },
          });
        } catch {
          // The native request may already have ended with the provider failure.
        }
      }
      this.registry.markIdle(record);
      this.turns.forgetStream(record.sessionId, record.streamId);
    }
  }

  private handleInnerRuntimeExit(code: number | null, signal: string | null): void {
    const failure = {
      domainCode: 'RUNTIME_ERROR',
      message: 'ZCode app-server exited unexpectedly.',
      retryable: true,
      exitCode: code,
      signal,
    };
    for (const record of this.registry.records()) {
      const projector = this.projectors.get(record.nativeSessionId);
      if (record.activeTurnId !== null) {
        projector?.finalizeTurn('error_runtime_exit', { runtimeFailure: failure });
      } else {
        this.emit({
          method: 'runtime.error',
          params: {
            eventId: `runtime-exit-${randomId()}`,
            sessionId: record.sessionId,
            streamId: record.streamId,
            sequence: this.nextSequence(record.sessionId),
            emittedAt: new Date().toISOString(),
            data: {
              domainCode: failure.domainCode,
              message: failure.message,
              retryable: failure.retryable,
              details: {
                exitCode: failure.exitCode,
                signal: failure.signal,
              },
            },
          },
        });
      }
      this.registry.quarantine(record, 'runtime-exit');
      this.turns.forgetStream(record.sessionId, record.streamId);
    }
    this.pendingInteractions.clear();
  }

  setEmitSink(sink: (notification: OuterNotification) => void): void {
    this.optionsEmit = sink;
  }

  /** Route one inner notification to the owning session's projector and run
   *  the post-terminal ownership transitions. */
  private routeInnerNotification(method: string, params: Record<string, unknown>): void {
    const nativeSessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
    if (nativeSessionId === null) return;
    const projector = this.projectors.get(nativeSessionId);
    if (projector === undefined) return;
    const consumed = projector.handleNotification(method, params);
    if (consumed === false) return;
    if (projector.hasActiveTurn() === false) return;
    const terminalMethods = method === 'session/event'
      && typeof (params.payload as Record<string, unknown> | undefined)?.resultType === 'string';
    if (terminalMethods === true) {
      const record = this.registry.byNativeSession(nativeSessionId);
      if (record !== undefined && record.activeTurnId !== null) {
        this.registry.markIdle(record);
        this.turns.forgetStream(record.sessionId, record.streamId);
      }
    }
  }

  private emit(notification: OuterNotification): void {
    if (this.queue !== null) {
      this.queue.push({ method: notification.method, params: notification.params });
      return;
    }
    this.optionsEmit(notification);
  }

  async dispatch(request: WireRequest): Promise<DispatchOutcome> {
    const queue: Array<{ method: string; params: Record<string, unknown> }> = [];
    const previous = this.queue;
    this.queue = queue;
    try {
      const result = await this.handle(request);
      return { ok: true, result, notifications: queue };
    } catch (error) {
      return { ok: false, error: normalizeError(error), notifications: queue };
    } finally {
      this.queue = previous;
    }
  }

  /** Wire-level handler. The `async handle(` + `switch (request.method)`
   *  shape is a cross-adapter convention enforced by contract-003. */
  async handle(request: WireRequest): Promise<unknown> {
    const { params } = request;
    const { method } = request;
    if (method !== 'initialize' && method !== 'shutdown' && this.initialized === false) {
      throw new ServiceError('NOT_INITIALIZED', 'initialize must be the first request.');
    }
    switch (request.method) {
      case 'initialize': return this.initialize(params);
      case 'catalog.list': return this.catalogList();
      case 'catalog.resolve': return this.catalogResolve(params);
      case 'session.create': return this.sessionCreate(params);
      case 'session.get': return this.sessionGet(params);
      case 'turn.start': return this.turnStart(params);
      case 'turn.interrupt': return this.turnInterrupt(params);
      case 'interaction.respond': return this.interactionRespond(params);
      case 'session.close': return this.sessionClose(params);
      case 'session.native.list': return this.sessionNativeList(params);
      case 'session.replay': return this.sessionReplay(params);
      case 'shutdown': return this.shutdown();
      case 'session.rename':
      case 'session.native.delete':
      case 'turn.steer':
      case 'sidechat.create':
      case 'sidechat.resume':
      case 'sidechat.close':
      case 'session.fork':
        throw new ServiceError('CAPABILITY_NOT_SUPPORTED', `${method} is not part of the ZCode v1 capability set.`);
      default:
        throw new ServiceError('METHOD_NOT_FOUND', `Unknown method ${method}.`);
    }
  }

  // ---- runtime fingerprint (WP0 G8) ----

  runtimeKey(): string {
    if (this.runtimeKeyCache !== null) return this.runtimeKeyCache;
    const entry = resolve(this.options.runtimeBin);
    const hash = createHash('sha256');
    hash.update(`${entry}\u0000${PLUGIN_VERSION}\u0000`);
    hash.update(`node:${process.versions.node}\u0000`);
    hash.update('launch:app-server --stdio --surface desktop\u0000');
    hash.update(`file:${hashFile(entry)}\u0000`);
    // Execution closure: when the entry lives inside a resource tree that also
    // contains bundled plugins, cover the whole tree (WP0 G8).
    const packagesDir = join(dirname(entry), 'packages');
    if (existsSync(packagesDir)) {
      hash.update(`closure:${hashTree(dirname(entry))}\u0000`);
    }
    this.runtimeKeyCache = hash.digest('hex');
    return this.runtimeKeyCache;
  }

  // ---- initialize ----

  private async initialize(params: Record<string, unknown>): Promise<unknown> {
    if (this.initialized) throw new ServiceError('ALREADY_INITIALIZED', 'initialize can only be sent once.');
    const protocol = (params.protocol ?? {}) as Record<string, unknown>;
    if (protocol.name !== 'gian.proxy') {
      throw new ServiceError('INCOMPATIBLE_PROTOCOL', 'Expected gian.proxy protocol name.');
    }
    const versions = Array.isArray(protocol.versions) ? protocol.versions as unknown[] : [];
    if (versions.includes('2.1') === false) {
      throw new ServiceError('INCOMPATIBLE_PROTOCOL', 'com.zhipu.zcode speaks gian.proxy/2.1 only.');
    }
    this.initialized = true;
    this.catalog = EMPTY_CATALOG;
    return {
      protocol: { name: 'gian.proxy', version: '2.1' },
      plugin: { id: PLUGIN_ID, name: PLUGIN_NAME, version: PLUGIN_VERSION },
      process: { scope: 'shared' },
      capabilities: capabilitiesFor({ interaction: this.options.interactionEnabled }),
    };
  }

  // ---- catalog ----

  private async readState(workspace: string): Promise<InnerReadState> {
    const state = await this.transport.request('workspace/readState', {
      workspace: { workspacePath: workspace, workspaceKey: workspace },
    }) as InnerReadState | null;
    if (state === null || typeof state !== 'object') {
      throw new ServiceError('RUNTIME_UNAVAILABLE', 'workspace/readState returned no state.');
    }
    return state;
  }

  private assertInnerProtocol(state: InnerReadState): void {
    if (state.protocol !== undefined && state.protocol !== null) {
      if (state.protocol.name !== INNER_PROTOCOL_NAME || state.protocol.version !== INNER_PROTOCOL_VERSION) {
        throw new ServiceError(
          'INCOMPATIBLE_PROTOCOL',
          `ZCode runtime protocol must be ${INNER_PROTOCOL_NAME}/${INNER_PROTOCOL_VERSION}.`,
        );
      }
    }
  }

  private async catalogList(): Promise<unknown> {
    const state = await this.readState(this.options.catalogWorkspace);
    this.assertInnerProtocol(state);
    this.catalog = projectCatalog(this.runtimeKey(), state);
    return this.catalog;
  }

  private catalogResolve(params: Record<string, unknown>): unknown {
    const revision = typeof params.catalogRevision === 'string' ? params.catalogRevision : '';
    if (revision === '' || revision !== this.catalog.catalogRevision) {
      if (revision === '' || this.catalog === EMPTY_CATALOG) {
        throw new ServiceError('CONFIG_VALUE_INVALID', 'catalog.resolve ran before catalog.list.');
      }
      // Stale revision: resolve against the projected catalog the revision
      // names is impossible without cache; require a re-list.
      throw new ServiceError('CONFIG_VALUE_INVALID', 'Unknown catalogRevision; call catalog.list again.');
    }
    const sessionConfig = (params.sessionConfig ?? {}) as Record<string, unknown>;
    const turnConfig = (params.turnConfig ?? {}) as Record<string, unknown>;
    try {
      return { ...this.catalog, ...resolveCatalog(this.catalog, { sessionConfig, turnConfig }) };
    } catch (error) {
      if (error instanceof ConfigValueInvalidError) {
        throw new ServiceError('CONFIG_VALUE_INVALID', error.message);
      }
      throw error;
    }
  }

  // ---- session lifecycle ----

  private async sessionCreate(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const workspace = (params.workspace ?? {}) as Record<string, unknown>;
    const cwd = stringField(workspace, 'cwd');
    const config = (params.config ?? {}) as Record<string, ConfigValue>;
    const native = (params.nativeSession ?? null) as Record<string, unknown> | null;
    const nativeHistory = native && native.history === 'replay' ? 'replay' : 'none';

    if (config && Object.keys(config).length > 0) {
      // v1 declares no session-bound options; an explicit snapshot must be {}.
      throw new ServiceError('CONFIG_BINDING_INVALID', 'ZCode v1 has no session-bound config options.');
    }

    // Idempotency (contract §10.1): same id + same request -> snapshot;
    // same id + different workspace/native -> CONFLICT.
    const fingerprint = TurnLedger.fingerprint({ cwd, native: native?.id ?? null }, config);
    const existing = this.registry.get(sessionId);
    if (existing !== undefined) {
      const knownFingerprint = this.createFingerprints.get(sessionId);
      if (knownFingerprint !== undefined && knownFingerprint !== fingerprint) {
        throw new ServiceError('CONFLICT', 'session.create was replayed with different parameters.');
      }
      if (knownFingerprint === undefined) {
        // Restored ownership has no process-local create fingerprint. Rebind
        // only to the persisted native identity inside this workspace's
        // data-dir, allocate a fresh outer stream, and re-probe native idle
        // state before accepting work.
        if (native?.id !== undefined && native.id !== existing.nativeSessionId) {
          throw new ServiceError('CONFLICT', 'Restored session id names a different native session.');
        }
        existing.runtimeKey = this.runtimeKey();
        this.registry.newStreamId(existing);
        try {
          await this.adoptNativeSession(existing, existing.nativeSessionId, nativeHistory === 'replay');
        } catch (error) {
          this.registry.quarantine(existing, 'restore-attach-failed');
          throw error;
        }
        this.createFingerprints.set(sessionId, fingerprint);
      }
      return { session: this.snapshot(existing) };
    }

    const runtimeKey = this.runtimeKey();
    let record: SessionRecord;
    if (native !== null && typeof native.id === 'string' && native.id !== '') {
      record = this.registry.beginAttach(sessionId, native.id, runtimeKey);
      try {
        await this.adoptNativeSession(record, native.id, nativeHistory === 'replay');
      } catch (error) {
        this.registry.detachForce(record);
        throw error;
      }
    } else {
      // Fresh native session. Handlers are registered before spawn; the
      // reverse preference requests are answered from the frozen Gian profile.
      const created = await this.transport.request('session/create', {
        workspace: { workspacePath: cwd, workspaceKey: cwd },
      }, 45_000) as Record<string, unknown> | null;
      const inner = (created?.session ?? null) as InnerReadState['session'] | null;
      const nativeSessionId = typeof inner?.sessionId === 'string' ? inner.sessionId : null;
      if (nativeSessionId === null) {
        throw new ServiceError('RUNTIME_ERROR', 'ZCode session/create returned no native session id.');
      }
      this.assertInnerProtocol(created as unknown as InnerReadState);
      record = this.registry.beginAttach(sessionId, nativeSessionId, runtimeKey);
      record.confirmedNativeSettings = this.confirmedSettingsFrom(created);
      await this.attachProjector(record);
      this.registry.markOwned(record);
      this.maybeCatalogChanged(created);
    }

    this.createFingerprints.set(sessionId, fingerprint);
    return { session: this.snapshot(record) };
  }

  private readonly createFingerprints = new Map<string, string>();

  private confirmedSettingsFrom(created: Record<string, unknown> | null): SessionRecord['confirmedNativeSettings'] {
    const settings = (created?.settings ?? {}) as Record<string, unknown>;
    const model = (settings.model ?? {}) as Record<string, unknown>;
    const current = model.current as Record<string, unknown> | undefined;
    const thought = (settings.thoughtLevel ?? {}) as Record<string, unknown>;
    const permission = (settings.permission ?? {}) as Record<string, unknown>;
    return {
      ...(current && typeof current.providerId === 'string' && typeof current.modelId === 'string'
        ? { model: { providerId: current.providerId, modelId: current.modelId } }
        : {}),
      ...(typeof thought.current === 'string' ? { thoughtLevel: thought.current } : {}),
      ...(typeof permission.mode === 'string' ? { mode: permission.mode } : {}),
    };
  }

  private async adoptNativeSession(record: SessionRecord, nativeId: string, wantHistory: boolean): Promise<void> {
    void wantHistory;
    // Ownership probe: read fails for sessions that are not loaded; resume
    // loads them. Both errors fail the attach WITHOUT mutating ZCode state.
    await this.transport.request('session/resume', { sessionId: nativeId }, 30_000);
    const read = await this.transport.request('session/read', { sessionId: nativeId }, 20_000) as InnerReadState | null;
    if (read === null) {
      throw new ServiceError('NATIVE_SESSION_NOT_FOUND', 'ZCode returned no state for the native session.');
    }
    const status = read.session?.status;
    if (status !== undefined && status !== 'idle') {
      throw new ServiceError('SESSION_BUSY', 'Native session is not idle; refusing to attach.');
    }
    this.assertInnerProtocol(read);
    record.confirmedNativeSettings = this.confirmedSettingsFrom(read as unknown as Record<string, unknown>);
    await this.attachProjector(record);
    this.registry.markOwned(record);
  }

  private async attachProjector(record: SessionRecord): Promise<void> {
    const projector = new SessionProjector({
      gianSessionId: record.sessionId,
      nativeSessionId: record.nativeSessionId,
      nextSequence: () => {
        const next = (this.sessionSequence.get(record.sessionId) ?? 0) + 1;
        this.sessionSequence.set(record.sessionId, next);
        return next;
      },
      emit: (notification) => this.emit(notification),
    });
    projector.setStreamId(record.streamId);
    this.projectors.set(record.nativeSessionId, projector);
    try {
      // Real ZCode 0.16.5 emits only selected computer-use events until the
      // client subscribes with the frozen desktop-continuous delivery kind.
      // Fake servers used to push unconditionally and therefore masked this
      // missing live-event boundary until WP7.
      await this.transport.request('session/subscribe', {
        sessionId: record.nativeSessionId,
        deliveryKind: 'desktop-continuous',
        includeSnapshot: true,
      }, 20_000);
    } catch (error) {
      this.projectors.delete(record.nativeSessionId);
      throw error;
    }
  }

  private maybeCatalogChanged(created: Record<string, unknown> | null): void {
    if (this.catalog === EMPTY_CATALOG) return;
    const state: InnerReadState = {};
    if (created?.settings !== undefined) state.settings = created.settings as InnerSettings;
    if (created?.slashCommands !== undefined) state.slashCommands = created.slashCommands as InnerSlashCommand[];
    const projectedRevision = revisionFor(this.runtimeKey(), state);
    if (projectedRevision !== this.catalog.catalogRevision) {
      this.emit({
        method: 'catalog.changed',
        params: {
          eventId: `catalog-changed-${randomId()}`,
          emittedAt: new Date().toISOString(),
          data: { reason: 'zcode-settings-changed' },
        },
      });
    }
  }

  private snapshot(record: SessionRecord): Record<string, unknown> {
    const stateName = record.state === 'running-owned'
      ? 'running'
      : record.state === 'waiting-interaction'
        ? 'waiting_interaction'
        : record.state === 'quarantined'
          ? 'stale'
          : 'idle';
    return {
      id: record.sessionId,
      nativeSession: { id: record.nativeSessionId },
      streamId: record.streamId,
      state: stateName,
      sessionConfig: {},
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async sessionGet(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const record = this.registry.requireSession(sessionId);
    return { session: this.snapshot(record) };
  }

  // ---- turn ----

  private async turnStart(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const turnId = stringField(params, 'turnId');
    const record = this.registry.requireStream(sessionId, streamId);
    if (record.activeTurnId !== null) {
      throw new ServiceError('SESSION_BUSY', 'A turn is already active.');
    }
    const input = Array.isArray(params.input) ? params.input as Array<Record<string, unknown>> : [];
    const config = (params.config ?? {}) as Record<string, ConfigValue>;

    const fingerprint = TurnLedger.fingerprint(input, config);
    const observed = this.turns.observe(sessionId, streamId, turnId, fingerprint);
    if (observed === 'duplicate') {
      return { accepted: true, turnId };
    }

    // 1. Apply the full turn config snapshot (§7.4): model -> thinking ->
    // approval mode, verified step by step. Any failure never reaches send.
    const nativeSessionId = record.nativeSessionId;
    const confirmed = { ...record.confirmedNativeSettings };
    try {
      const modelValue = config['model'];
      if (typeof modelValue === 'string') {
        const ref = decodeModelValue(modelValue);
        if (confirmed.model?.providerId !== ref.providerId || confirmed.model?.modelId !== ref.modelId) {
          await this.transport.request('session/setModel', {
            sessionId: nativeSessionId, model: ref,
          });
          confirmed.model = ref;
        }
      }
      const thinkingValue = config['thinking'];
      if (typeof thinkingValue === 'string' && thinkingValue !== confirmed.thoughtLevel) {
        await this.transport.request('session/setThoughtLevel', {
          sessionId: nativeSessionId, thoughtLevel: thinkingValue,
        });
        confirmed.thoughtLevel = thinkingValue;
      }
      const approvalValue = config['approval_mode'];
      if (typeof approvalValue === 'string' && approvalValue !== confirmed.mode) {
        await this.transport.request('session/setMode', {
          sessionId: nativeSessionId, mode: approvalValue,
        });
        confirmed.mode = approvalValue;
      }
    } catch (error) {
      // Restore the previously confirmed snapshot; the session MUST NOT run
      // with unknown config (§7.4).
      await this.restoreConfirmed(record, confirmed).catch(() => undefined);
      if (error instanceof ConfigValueInvalidError) {
        throw new ServiceError('CONFIG_VALUE_INVALID', error.message);
      }
      if (error instanceof InnerError) {
        throw new ServiceError('RUNTIME_ERROR', redactSecrets(error.message) as string);
      }
      throw error;
    }

    // 2. Build the send payload. Only text in v1 (G3 gate pending).
    const text = input
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
    if (text === '') {
      this.turns.forget(sessionId, streamId, turnId);
      throw new ServiceError('INVALID_PARAMS', 'ZCode v1 accepts text input only.');
    }

    // 3. Send. Notifications emitted between accept and response stay inside
    // this dispatch queue (response barrier), after the accepted result.
    let sendResult: Record<string, unknown> | null;
    try {
      sendResult = await this.transport.request('session/send', {
        sessionId: nativeSessionId, content: text,
      }, 60_000) as Record<string, unknown> | null;
    } catch (error) {
      this.turns.forget(sessionId, streamId, turnId);
      if (error instanceof InnerError && error.code === -32004) {
        throw new ServiceError('SESSION_ERROR', 'ZCode reported the session as not active.');
      }
      throw error;
    }
    if (sendResult === null || sendResult.accepted !== true) {
      this.turns.forget(sessionId, streamId, turnId);
      throw new ServiceError('RUNTIME_ERROR', 'ZCode did not accept the turn input.');
    }

    record.confirmedNativeSettings = confirmed;
    this.turns.markAccepted(sessionId, streamId, turnId);
    const projector = this.projectors.get(nativeSessionId);
    if (projector !== undefined) {
      projector.bindTurn(turnId, ''); // nativeTurnId binds on typed turn-started
    }
    this.registry.markRunning(record, turnId, null);
    return { accepted: true, turnId };
  }

  private async restoreConfirmed(record: SessionRecord, confirmed: SessionRecord['confirmedNativeSettings']): Promise<void> {
    const nativeSessionId = record.nativeSessionId;
    if (confirmed.model !== undefined) {
      await this.transport.request('session/setModel', { sessionId: nativeSessionId, model: confirmed.model });
    }
    if (confirmed.thoughtLevel !== undefined) {
      await this.transport.request('session/setThoughtLevel', {
        sessionId: nativeSessionId, thoughtLevel: confirmed.thoughtLevel,
      });
    }
    if (confirmed.mode !== undefined) {
      await this.transport.request('session/setMode', { sessionId: nativeSessionId, mode: confirmed.mode });
    }
  }

  private async turnInterrupt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const turnId = stringField(params, 'turnId');
    const record = this.registry.requireStream(sessionId, streamId);
    if (record.activeTurnId !== turnId) {
      throw new ServiceError('TURN_NOT_FOUND', `Turn ${turnId} is not active.`);
    }
    const projector = this.projectors.get(record.nativeSessionId);
    const foregroundExecutionId = projector?.activeForegroundExecutionId() ?? null;
    const stopped = await this.transport.request('v4/command', {
      commandId: `gian-stop-${randomId()}`,
      clientId: `gian:${sessionId}`,
      sessionId: record.nativeSessionId,
      type: 'stop',
      payload: {
        ...(foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {}),
      },
      issuedAt: Date.now(),
    }, 20_000) as Record<string, unknown> | null;
    const ack = stopped?.ack !== null && typeof stopped?.ack === 'object'
      ? stopped.ack as Record<string, unknown>
      : stopped;
    const status = typeof ack?.status === 'string' ? ack.status : null;
    if (status !== 'accepted' && status !== 'duplicate' && status !== 'noop') {
      const reasonCode = typeof ack?.reasonCode === 'string' ? ack.reasonCode : 'unknown';
      throw new ServiceError(
        'RUNTIME_ERROR',
        `ZCode rejected the interrupt command (${reasonCode}).`,
        status === 'stale',
      );
    }
    projector?.markInterruptAccepted();
    return { accepted: true, turnId };
  }

  // ---- interaction ----

  private handlePermissionReverseRequest(params: Record<string, unknown>, transportId: string):
    { result: unknown } | { error: { code: number; message: string; data?: unknown } } | { defer: true } {
    const nativeSessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
    const requestId = typeof params.requestId === 'string' ? params.requestId : null;
    const projector = nativeSessionId === null ? undefined : this.projectors.get(nativeSessionId);
    if (projector === undefined || requestId === null) {
      return {
        error: {
          code: -32601,
          message: 'interaction/requestPermission has no relayable Gian turn.',
        },
      };
    }
    const options = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
    const accepted = projector.handlePermissionRequest({
      requestId,
      ...(typeof params.turnId === 'string' && params.turnId !== '' ? { nativeTurnId: params.turnId } : {}),
      ...(typeof params.toolCallId === 'string' ? { toolCallId: params.toolCallId } : {}),
      ...(typeof params.toolName === 'string' ? { toolName: params.toolName } : {}),
      ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
      ...(typeof params.riskLevel === 'string' ? { riskLevel: params.riskLevel } : {}),
      input: params.input,
      options: options.map((option) => ({
        ...(typeof option.optionId === 'string' ? { optionId: option.optionId } : {}),
        ...(typeof option.kind === 'string' ? { kind: option.kind } : {}),
        ...(typeof option.name === 'string' ? { name: option.name } : {}),
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
        ...(option.response !== undefined && option.response !== null
          ? { response: option.response as Record<string, unknown> }
          : {}),
      })),
      raw: params,
    });
    if (accepted === false) {
      return {
        error: {
          code: -32601,
          message: 'No faithfully round-trippable action set for this permission request.',
        },
      };
    }
    // The server request stays open; interaction.respond completes it with the
    // user-selected EXACT native response payload (§11.1).
    const ownedRecord = this.registry.byNativeSession(nativeSessionId ?? '');
    this.pendingInteractions.set(`int:${requestId}`, {
      gianSessionId: ownedRecord?.sessionId ?? '',
      gianTurnId: projector.activeGianTurnId() ?? '',
      serverRequestId: transportId,
      responses: new Map(
        options
          .filter((option) => typeof option.optionId === 'string' && option.response !== undefined && option.response !== null)
          .map((option) => [option.optionId as string, option.response as Record<string, unknown>]),
      ),
      resolved: false,
    });
    return { defer: true };
  }

  private async interactionRespond(params: Record<string, unknown>): Promise<unknown> {
    if (this.options.interactionEnabled === false) {
      throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'interaction capability is not declared.');
    }
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const turnId = stringField(params, 'turnId');
    const responseId = stringField(params, 'responseId');
    const interactionId = stringField(params, 'interactionId');
    const actionId = stringField(params, 'actionId');
    this.registry.requireStream(sessionId, streamId);

    const fingerprint = JSON.stringify({
      interactionId, actionId, values: params.values ?? {},
    });
    const observed = this.responses.observe(responseId, fingerprint);
    if (observed === 'duplicate') {
      return { accepted: true, interactionId, responseId };
    }

    const pending = this.pendingInteractions.get(interactionId);
    if (pending === undefined || pending.resolved) {
      throw new ServiceError('INTERACTION_NOT_FOUND', `Interaction ${interactionId} is not pending.`);
    }
    if (pending.gianSessionId !== sessionId || pending.gianTurnId !== turnId) {
      throw new ServiceError('INTERACTION_NOT_FOUND', 'Interaction belongs to a different session or turn.');
    }
    const nativeResponse = pending.responses.get(actionId);
    if (nativeResponse === undefined) {
      throw new ServiceError('INTERACTION_ACTION_NOT_FOUND', `Action ${actionId} was not advertised.`);
    }

    // Answer the stored server request with the EXACT native payload (§11.1).
    this.transport.respondToServer(pending.serverRequestId, { result: nativeResponse });
    pending.resolved = true;
    this.pendingInteractions.delete(interactionId);
    const projector = this.projectors.get(this.registry.requireSession(sessionId).nativeSessionId);
    projector?.resolveInteraction(interactionId);

    const record = this.registry.requireSession(sessionId);
    this.emit({
      method: 'interaction.resolved',
      params: {
        eventId: `resolved-${responseId}`,
        sessionId,
        streamId,
        sequence: this.nextSequence(sessionId),
        turnId,
        sourceTurnId: projector?.activeNativeTurnId() ?? '',
        emittedAt: new Date().toISOString(),
        data: { interactionId, outcome: 'submitted', actionId },
      },
    });
    if (record.state === 'waiting-interaction') this.registry.markRunning(record, record.activeTurnId ?? turnId, null);
    return { accepted: true, interactionId, responseId };
  }

  private nextSequence(sessionId: string): number {
    const next = (this.sessionSequence.get(sessionId) ?? 0) + 1;
    this.sessionSequence.set(sessionId, next);
    return next;
  }

  // ---- close / native list / replay ----

  private async sessionClose(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const record = this.registry.detach(sessionId, streamId);
    this.projectors.delete(record.nativeSessionId);
    this.turns.forgetStream(sessionId, streamId);
    // Deliberately NO inner session/close: WP0 G7 proved it purges empty
    // native sessions. Detach only drops adapter state (Revision 2 §5.3).
    return { ok: true };
  }

  private async sessionNativeList(params: Record<string, unknown>): Promise<unknown> {
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.min(params.limit, 500) : 100;
    const cursor = typeof params.cursor === 'string' && params.cursor !== '' ? params.cursor : null;
    const offset = cursor === null ? 0 : decodeOffsetCursor(cursor);
    if (offset < 0) throw new ServiceError('INVALID_PARAMS', 'cursor is not a valid native list cursor.');
    const list = await this.transport.request('session/list', {}) as { sessions?: InnerSessionSummary[] } | null;
    const summaries = (list?.sessions ?? []).filter((session) => {
      if (session.status !== 'idle' || session.sessionKind !== 'interactive') return false;
      const nativeSessionId = session.sessionId ?? '';
      return this.registry.byNativeSession(nativeSessionId) === undefined
        && this.options.isNativeSessionOwned?.(nativeSessionId) !== true;
    });
    const page = summaries.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      sessions: page.map((session) => ({
        id: session.sessionId ?? '',
        ...(session.title ? { displayName: session.title } : {}),
        ...(session.workspace?.workspacePath ? { cwd: session.workspace.workspacePath } : {}),
        ...(typeof session.updatedAt === 'number' ? { updatedAt: new Date(session.updatedAt).toISOString() } : {}),
      })),
      nextCursor: nextOffset < summaries.length ? encodeOffsetCursor(nextOffset) : null,
    };
  }

  private async sessionReplay(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const record = this.registry.requireStream(sessionId, streamId);
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.min(params.limit, 500) : 200;
    const cursor = params.cursor === null || params.cursor === undefined ? null : String(params.cursor);

    const messages = await this.transport.request('session/messages', {
      sessionId: record.nativeSessionId,
    }, 30_000) as { messages?: Array<unknown> } | null;
    const all = messages?.messages ?? [];
    const revision = `${all.length}:${hashOf(JSON.stringify(all.at(-1) ?? ''))}`;
    const replayStreamId = `replay:zcode:${record.nativeSessionId}:${revision}:v1`;

    const events = buildReplayEvents({
      gianSessionId: sessionId,
      nativeSessionId: record.nativeSessionId,
      replayStreamId,
      messages: all,
    });
    const offset = cursor === null ? 0 : decodeOffsetCursor(cursor);
    if (offset < 0) throw new ServiceError('INVALID_PARAMS', 'cursor is not a valid replay cursor.');
    const page = events.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      replayStreamId,
      events: page,
      nextCursor: nextOffset < events.length ? encodeOffsetCursor(nextOffset) : null,
    };
  }

  private async shutdown(): Promise<unknown> {
    this.stopping = true;
    await this.transport.stop();
    return { ok: true };
  }

  /** Diagnostics snapshot for tests and stderr reporting. */
  diagnostics(): Record<string, unknown> {
    return {
      runtimeKey: this.runtimeKey(),
      sessions: [...this.registry['sessions'].values()].map((record) => ({
        sessionId: record.sessionId,
        nativeSessionId: record.nativeSessionId,
        state: record.state,
      })),
      pendingInteractions: this.pendingInteractions.size,
    };
  }
}

// ---- helpers ----

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function hashFile(file: string): string {
  const stats = statSync(file);
  if (stats.isFile() === false) throw new ServiceError('RUNTIME_UNAVAILABLE', `Runtime entry ${file} is not a regular file.`);
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function hashTree(root: string): string {
  const hash = createHash('sha256');
  const files: Array<{ rel: string; digest: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push({ rel: relative(root, path), digest: createHash('sha256').update(readFileSync(path)).digest('hex') });
    }
  };
  walk(root);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  for (const file of files) hash.update(`${file.rel}\u0000${file.digest}\u0000`);
  return hash.digest('hex');
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeOffsetCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
    return typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0
      ? parsed.offset
      : -1;
  } catch {
    return -1;
  }
}

function stringField(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ServiceError('INVALID_PARAMS', `params.${key} must be a non-empty string.`);
  }
  return value;
}

function normalizeError(error: unknown): {
  code: number;
  message: string;
  data?: { domainCode: string; retryable: boolean; details?: Record<string, unknown> };
} {
  if (error instanceof ServiceError || error instanceof SessionRegistryError) {
    if (error.domainCode === 'METHOD_NOT_FOUND') return { code: -32601, message: error.message };
    if (error.domainCode === 'INVALID_PARAMS') return { code: -32602, message: error.message };
    return {
      code: -32000,
      message: error.message,
      data: { domainCode: error.domainCode, retryable: error.retryable, details: {} },
    };
  }
  if (error instanceof ConfigValueInvalidError) {
    return {
      code: -32000,
      message: error.message,
      data: { domainCode: 'CONFIG_VALUE_INVALID', retryable: false, details: {} },
    };
  }
  if (error instanceof InnerError) {
    return {
      code: -32000,
      message: error.message,
      data: { domainCode: 'RUNTIME_ERROR', retryable: false, details: { innerCode: error.code } },
    };
  }
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}

// ---- replay projection ----

interface ReplayMessage {
  info?: {
    role?: string;
    id?: string;
    finish?: string;
    anchor?: { turnId?: string };
    tokens?: Record<string, unknown>;
    modelID?: string;
    time?: { created?: number };
  };
  parts?: Array<Record<string, unknown>>;
}

export function buildReplayEvents(context: {
  gianSessionId: string;
  nativeSessionId: string;
  replayStreamId: string;
  messages: unknown[];
}): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  let sequence = 0;
  const nextSequence = (): number => ++sequence;
  const emittedAt = (time: unknown): string => {
    const ms = typeof time === 'number' ? time : Date.now();
    return new Date(ms).toISOString();
  };

  // Group messages by native turn (anchor.turnId), preserving order; messages
  // without an anchor form a synthetic turn from their own id.
  const turns = new Map<string, ReplayMessage[]>();
  for (const raw of context.messages) {
    const message = raw as ReplayMessage;
    const turnId = message.info?.anchor?.turnId ?? message.info?.id ?? 'unknown-turn';
    const bucket = turns.get(turnId);
    if (bucket === undefined) turns.set(turnId, [message]);
    else bucket.push(message);
  }

  for (const [nativeTurnId, messages] of turns) {
    const sourceTurnId = nativeTurnId;
    const base = (): Record<string, unknown> => ({
      eventId: '',
      sessionId: context.gianSessionId,
      replayStreamId: context.replayStreamId,
      sequence: 0,
      sourceTurnId,
      emittedAt: emittedAt(messages[0]?.info?.time?.created),
    });
    const push = (
      method: string,
      eventIdParts: unknown,
      data: Record<string, unknown>,
      time?: unknown,
      stableEventId?: string,
    ): void => {
      const event = base();
      event.method = method;
      event.eventId = stableEventId
        ?? `replay-${hashOf(JSON.stringify([context.nativeSessionId, eventIdParts]))}`;
      event.sequence = nextSequence();
      event.emittedAt = emittedAt(time ?? messages[0]?.info?.time?.created);
      event.data = data;
      events.push(event);
    };

    push('turn.started', [nativeTurnId, 'started'], {}, messages[0]?.info?.time?.created);

    for (const message of messages) {
      const messageId = message.info?.id ?? '';
      if (message.info?.role === 'user') {
        const text = (message.parts ?? [])
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n');
        push('input.recorded', [messageId, 'input'], { input: [{ type: 'text', text }] }, message.info?.time?.created);
        continue;
      }
      let openText: { contentId: string; text: string } | null = null;
      for (const part of message.parts ?? []) {
        const partId = typeof part.id === 'string' ? part.id : `${messageId}:${String(part.type)}`;
        if (part.type === 'text') {
          openText = {
            contentId: partId,
            text: openText === null ? String(part.text ?? '') : `${openText.text}${String(part.text ?? '')}`,
          };
          continue;
        }
        if (openText !== null) {
          push('content.completed', [openText.contentId, 'content'], {
            contentId: openText.contentId, kind: 'text', format: 'markdown', content: openText.text,
          }, message.info?.time?.created);
          openText = null;
        }
        if (part.type === 'reasoning') {
          push('content.completed', [partId, 'reasoning'], {
            contentId: partId, kind: 'reasoning', content: String(part.text ?? ''),
          }, (part.time as { end?: unknown } | undefined)?.end ?? message.info?.time?.created);
          continue;
        }
        if (part.type === 'tool') {
          const state = (part.state ?? {}) as {
            status?: unknown;
            input?: unknown;
            output?: unknown;
            time?: { end?: unknown };
          };
          const toolName = typeof part.tool === 'string' ? part.tool : 'tool';
          const output = boundedValue(state.output);
          push('activity.updated', [partId, 'activity'], {
            activityId: typeof part.callID === 'string' ? part.callID : partId,
            kind: `tool:${toolName}`,
            title: toolName,
            status: state.status === 'failed' ? 'failed' : state.status === 'cancelled' ? 'cancelled' : 'succeeded',
            presentation: {
              type: 'tool',
              data: {
                name: toolName,
                ...(state.input !== undefined ? { input: boundedValue(state.input).value } : {}),
                output: output.value,
              },
            },
            ...(output.truncated ? { details: { truncated: true } } : {}),
          }, state.time?.end ?? message.info?.time?.created);
        }
      }
      if (openText !== null) {
        push('content.completed', [openText.contentId, 'content'], {
          contentId: openText.contentId, kind: 'text', format: 'markdown', content: openText.text,
        }, message.info?.time?.created);
      }
      const tokens = message.info?.tokens ?? {};
      if (Object.keys(tokens).length > 0) {
        push('usage.updated', [messageId, 'usage'], {
          conversation: {
            mode: 'absolute',
            ...(typeof tokens.input === 'number' ? { inputTokens: tokens.input } : {}),
            ...(typeof tokens.output === 'number' ? { outputTokens: tokens.output } : {}),
            ...(numberField(tokens.cache, 'read') !== null ? { cachedInputTokens: numberField(tokens.cache, 'read') } : {}),
            ...(typeof tokens.total === 'number' ? { totalTokens: tokens.total } : {}),
          },
        }, message.info?.time?.created);
      }
    }

    const finish = messages.at(-1)?.info?.finish;
    push(
      'turn.completed',
      [nativeTurnId, 'terminal'],
      { stopReason: 'completed' },
      messages.at(-1)?.info?.time?.created,
      terminalEventIdFor(context.nativeSessionId, nativeTurnId, 'turn.completed'),
    );
    void finish;
  }

  return events;
}

function numberField(value: unknown, key: string): number | null {
  if (value === null || typeof value !== 'object') return null;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'number' ? entry : null;
}

function boundedValue(value: unknown): { value: unknown; truncated: boolean } {
  const json = JSON.stringify(value ?? null);
  if (json.length <= 64 * 1024) return { value, truncated: false };
  return {
    value: { truncated: true, originalBytes: json.length, preview: json.slice(0, 2_000) },
    truncated: true,
  };
}
