/**
 * gian.proxy/2.1-2.3 adapter for com.zhipu.zcode, rebased onto the open-source
 * ZCode CLI 0.16.9 (upstream commit 328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f).
 *
 * Response barriers (contract §16): every mutating request queues the
 * notifications it causes and the CLI flushes them AFTER the response.
 * `turn.started` is emitted when ZCode's typed `turn-started` event confirms
 * runtime execution, so the outer stream never claims a fact before the
 * runtime does.
 *
 * 0.16.9 send path: turns are driven by the v4 `sendText` command
 * (packages/shared/src/zcode-protocol-v4/command.ts:81-134), which carries
 * attachments ({ref, fileName, mime, bytes}) and the requested delivery
 * routing. The legacy `session/event` stream keeps flowing for v4-driven
 * turns while a desktop-continuous subscription exists
 * (server-operations.ts:3040-3082 `onSessionEvent`).
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { discoverZcodeRuntimes, probeZcodeRuntime } from './runtime/discover.js';
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
import {
  buildManualSkillPrompt,
  commandIdFor,
  validateLocalAttachment,
  type InnerAttachmentRef,
} from './attachments.js';
import {
  SessionInteractionActionError,
  SessionProjector,
  terminalEventIdFor,
  type OuterNotification,
} from './events.js';
import {
  GIAN_RUNTIME_PREFERENCES,
  InnerError,
  type InnerRuntimeFailure,
  redactSecrets,
  registerGianReverseHandlers,
  ZCodeTransport,
} from './inner/transport.js';
import type {
  InnerCommandAck,
  InnerConversationRow,
  InnerModelInfo,
  InnerModelRef,
  InnerPresentation,
  InnerReadState,
  InnerSessionSummary,
  InnerSettings,
  InnerSkillEntry,
  InnerRowsRangeResult,
  InnerUserInputQuestion,
} from './inner/model.js';
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
  resolved: boolean;
  respond: (actionId: string, values: Record<string, unknown>) => Record<string, unknown>;
}

/** Adapter-visible facts about model/thoughtLevel state. In 0.16.9,
 *  session/create and session/resume snapshots carry the FULL provider model
 *  catalog (server-operations.ts snapshot() defaults modelAvailability to
 *  undefined -> app.listModels(); only read/subscribe/setModel narrow to
 *  "current"), so the store MERGES the available lists observed across
 *  snapshots and keeps the newest current/thought facts. This feeds the
 *  side-effect-free catalog without creating sessions or model requests. */
export class ModelFactStore {
  private settings: InnerSettings | null = null;
  update(settings: InnerSettings | null | undefined): void {
    if (settings === null || settings === undefined) return;
    if (typeof settings !== 'object') return;
    const previous = this.settings;
    if (previous === null) {
      this.settings = settings;
      return;
    }
    const merged = new Map<string, InnerModelInfo>();
    for (const model of [...(previous.model?.available ?? []), ...(settings.model?.available ?? [])]) {
      const key = `${model.ref?.providerId ?? ''}\u0000${model.ref?.modelId ?? ''}`;
      if (key !== '\u0000') merged.set(key, model);
    }
    this.settings = {
      ...previous,
      model: {
        ...previous.model,
        ...(settings.model?.current !== undefined ? { current: settings.model.current } : {}),
        ...(settings.model?.lastUsed !== undefined ? { lastUsed: settings.model.lastUsed } : {}),
        available: [...merged.values()],
      },
      ...(settings.thoughtLevel !== undefined ? { thoughtLevel: settings.thoughtLevel } : {}),
      ...(settings.permission !== undefined ? { permission: settings.permission } : {}),
      ...(settings.mode !== undefined ? { mode: settings.mode } : {}),
    };
  }
  current(): InnerReadState | null {
    return this.settings === null ? null : { settings: this.settings };
  }
}

function customizationUnsupportedList(kind: string, message: string) {
  return {
    kind,
    status: 'proxy_unsupported',
    completeness: 'none',
    observedAt: new Date().toISOString(),
    items: [],
    truncated: false,
    diagnostics: [{
      code: 'SOURCE_NOT_ENUMERABLE',
      message,
    }],
  };
}

function customizationUnavailableDetail(kind: string, id: string, message: string) {
  return {
    kind,
    id,
    status: 'unavailable',
    observedAt: new Date().toISOString(),
    text: '',
    truncated: false,
    diagnostics: [{ code: 'PROVIDER_INSPECTION_FAILED', message }],
  };
}

const EMPTY_CATALOG: ProjectedCatalog = bootstrapCatalog('uninitialized');

/** Upstream task types surfaced in the native session list
 *  (task-list-session-membership.ts TASK_LIST_SESSION_TYPES, minus
 *  workflow_parent whose children are internal projections). */
const ADOPTABLE_SESSION_KINDS = new Set(['interactive', 'fork']);
const LISTABLE_SESSION_STATUSES = new Set(['idle', 'completed', 'error']);

export class ZcodeV2Adapter {
  private initialized = false;
  private protocolVersion: '2.1' | '2.2' | '2.3' = '2.1';
  private queue: Array<{ method: string; params: Record<string, unknown> }> | null = null;
  private catalog: ProjectedCatalog = EMPTY_CATALOG;
  private catalogPresentation: InnerPresentation | null = null;
  private catalogModelState: InnerReadState | null = null;
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
      /** Shared model facts observed from live session snapshots. */
      modelFacts?: ModelFactStore;
    },
  ) {
    this.registry = new SessionRegistry(options.dataDir);
    registerGianReverseHandlers(this.transport);
    this.transport.registerReverseHandler('interaction/requestPermission', (params, transportId) => (
      this.handlePermissionReverseRequest(params, transportId)
    ));
    this.transport.registerReverseHandler('interaction/requestUserInput', (params, transportId) => (
      this.handleUserInputReverseRequest(params, transportId)
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
      projector?.finalizeTurn('error_during_execution', { runtimeFailure: failure });
      this.abortPendingInteractionsFor(record.sessionId, 'Provider turn ended before the interaction was resolved.');
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
        projector?.finalizeTurn('error_during_execution', { runtimeFailure: failure });
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
    this.abortPendingInteractionsFor(null, 'ZCode app-server exited before the interaction was resolved.');
  }

  /** Terminate every hanging interaction (optionally scoped to one session):
   *  answer the open server requests so the runtime never waits. The outer
   *  interaction.resolved fact (turn_ended / runtime_ended) is emitted by the
   *  projector's terminal finalizer, so this must not emit a second one. */
  private abortPendingInteractionsFor(sessionId: string | null, message: string): void {
    for (const [interactionId, pending] of this.pendingInteractions) {
      if (sessionId !== null && pending.gianSessionId !== sessionId) continue;
      this.pendingInteractions.delete(interactionId);
      try {
        this.transport.respondToServer(pending.serverRequestId, {
          error: { code: -32603, message },
        });
      } catch {
        // The native request may already have ended with the failure.
      }
    }
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
      case 'turn.steer': return this.turnSteer(params);
      case 'interaction.respond': return this.interactionRespond(params);
      case 'session.close': return this.sessionClose(params);
      case 'session.rename': return this.sessionRename(params);
      case 'session.fork': return this.sessionFork(params);
      case 'session.native.list': return this.sessionNativeList(params);
      case 'session.replay': return this.sessionReplay(params);
      case 'runtime.discover':
        if (this.protocolVersion === '2.1') {
          throw new ServiceError('METHOD_NOT_FOUND', 'runtime.discover requires gian.proxy/2.2.');
        }
        return discoverZcodeRuntimes();
      case 'runtime.probe':
        if (this.protocolVersion === '2.1') {
          throw new ServiceError('METHOD_NOT_FOUND', 'runtime.probe requires gian.proxy/2.2.');
        }
        return probeZcodeRuntime(String(params.path ?? ''));
      case 'customization.list':
      case 'customization.detail':
        if (this.protocolVersion !== '2.3') {
          throw new ServiceError('CAPABILITY_NOT_SUPPORTED', `${method} requires gian.proxy/2.3.`);
        }
        return method === 'customization.list'
          ? this.customizationList(params)
          : this.customizationDetail(params);
      case 'shutdown': return this.shutdown();
      case 'sidechat.create':
      case 'sidechat.resume':
      case 'sidechat.close':
        throw new ServiceError(
          'SIDECHAT_UNAVAILABLE',
          'ZCode selection side chats inherit hidden parent context and restrict fork/retry; '
          + 'they are not a semantic Gian Side Chat (session-fork.ts:677-693, commands/executor.ts:10-16).',
        );
      case 'session.native.delete':
        throw new ServiceError(
          'CAPABILITY_NOT_SUPPORTED',
          'ZCode v4 deleteSession is documented as closeSession: it unloads the runtime but never '
          + 'purges persisted history (session-mgmt.ts:154-158). ZCode Proxy exposes session.close '
          + '(detach) and keeps history visible.',
        );
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
    const managedRoot = resolve(dirname(entry), '..');
    if (existsSync(join(managedRoot, 'gian-source.json'))) {
      hash.update(`closure:${hashTree(managedRoot)}\u0000`);
    } else if (existsSync(packagesDir)) {
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
    const selected = versions.includes('2.3')
      ? '2.3'
      : versions.includes('2.2')
        ? '2.2'
        : versions.includes('2.1')
          ? '2.1'
          : null;
    if (selected === null) {
      throw new ServiceError('INCOMPATIBLE_PROTOCOL', 'gian.proxy/2.1, 2.2, or 2.3 is required.');
    }
    this.initialized = true;
    this.protocolVersion = selected;
    this.catalog = EMPTY_CATALOG;
    this.catalogPresentation = null;
    this.catalogModelState = null;
    const capabilities = capabilitiesFor({ interaction: this.options.interactionEnabled });
    if (selected !== '2.1') {
      capabilities['runtime.discover'] = 1;
      capabilities['runtime.probe'] = 1;
    }
    if (selected === '2.3') capabilities['customization.list'] = 1;
    return {
      protocol: { name: 'gian.proxy', version: selected },
      plugin: { id: PLUGIN_ID, name: PLUGIN_NAME, version: PLUGIN_VERSION },
      process: { scope: 'shared' },
      capabilities,
    };
  }

  // ---- catalog ----

  /** Side-effect-free workspace read. 0.16.9 replaced `workspace/readState`
   *  with `workspace/readPresentation` (mode + slashCommands only). */
  private async readPresentation(cwd: string): Promise<InnerPresentation> {
    const presentation = await this.transport.request('workspace/readPresentation', {
      workspace: { workspacePath: cwd, workspaceKey: cwd },
    }) as InnerPresentation | null;
    if (presentation === null || typeof presentation !== 'object') {
      throw new ServiceError('RUNTIME_UNAVAILABLE', 'workspace/readPresentation returned no presentation.');
    }
    return presentation;
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

  /** The pinned CLI exposes the configured Registry without creating a
   * session or returning Provider credentials. */
  private async readModelCatalog(): Promise<InnerReadState> {
    const catalog = await this.transport.request('gian/modelCatalog', {}) as Record<string, unknown> | null;
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.models)) {
      throw new ServiceError('RUNTIME_UNAVAILABLE', 'ZCode Runtime does not expose the pinned model catalog contract.');
    }
    for (const model of catalog.models) {
      if (!model || typeof model !== 'object'
        || typeof model.ref?.providerId !== 'string' || !model.ref.providerId
        || typeof model.ref?.modelId !== 'string' || !model.ref.modelId) {
        throw new ServiceError('RUNTIME_UNAVAILABLE', 'ZCode model catalog contains an invalid model reference.');
      }
    }
    const current = catalog.selection as InnerModelRef | undefined;
    if (current && (typeof current.providerId !== 'string' || typeof current.modelId !== 'string')) {
      throw new ServiceError('RUNTIME_UNAVAILABLE', 'ZCode model catalog contains an invalid selection.');
    }
    return { settings: { model: {
      available: catalog.models as InnerModelInfo[],
      ...(current ? { current } : {}),
    } } };
  }

  private effectiveCatalogModelState(): InnerReadState | null {
    const full = this.catalogModelState;
    if (!full) return null;
    const observed = this.options.modelFacts?.current()?.settings;
    const current = observed?.model?.current;
    const advertised = full.settings?.model?.available ?? [];
    if (!current || !advertised.some(model => model.ref?.providerId === current.providerId
      && model.ref.modelId === current.modelId)) return full;
    return { settings: {
      ...full.settings,
      model: { ...full.settings?.model, current },
      ...(observed?.thoughtLevel ? { thoughtLevel: observed.thoughtLevel } : {}),
    } };
  }

  private async catalogList(): Promise<unknown> {
    const [presentation, modelState] = await Promise.all([
      this.readPresentation(this.options.catalogWorkspace),
      this.readModelCatalog(),
    ]);
    this.catalogPresentation = presentation;
    this.catalogModelState = modelState;
    this.catalog = projectCatalog(this.runtimeKey(), presentation, this.effectiveCatalogModelState());
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
    if (this.catalogPresentation === null) {
      throw new ServiceError('CONFIG_VALUE_INVALID', 'catalog.resolve ran before catalog.list.');
    }
    const sessionConfig = (params.sessionConfig ?? {}) as Record<string, unknown>;
    const turnConfig = (params.turnConfig ?? {}) as Record<string, unknown>;
    try {
      return resolveCatalog(
        this.runtimeKey(),
        this.catalogPresentation,
        this.effectiveCatalogModelState(),
        { sessionConfig, turnConfig },
      );
    } catch (error) {
      if (error instanceof ConfigValueInvalidError) {
        throw new ServiceError('CONFIG_VALUE_INVALID', error.message);
      }
      throw error;
    }
  }

  // ---- session lifecycle ----

  /** Map outer hostServices (streamable-http MCP descriptors) to ZCode
   *  session-scoped remote MCP entries. 0.16.9 accepts `mcpServers` on
   *  session/create AND session/resume (shared/zp/index.ts:1559-1599); the
   *  entry is a full session-runtime override (protocol-mcp-config.ts:4-42),
   *  so no user global config is ever touched. */
  private hostServicesToMcpServers(hostServices: unknown): Array<Record<string, unknown>> | undefined {
    if (Array.isArray(hostServices) === false || hostServices.length === 0) return undefined;
    const servers: Array<Record<string, unknown>> = [];
    for (const raw of hostServices) {
      const service = raw as Record<string, unknown>;
      const id = typeof service.id === 'string' ? service.id : '';
      const transport = (service.transport ?? {}) as Record<string, unknown>;
      const url = typeof transport.url === 'string' ? transport.url : '';
      if (id === '' || url === '') {
        throw new ServiceError('INVALID_PARAMS', 'hostServices entries need id and transport.url.');
      }
      if (service.protocol !== undefined && service.protocol !== 'mcp') {
        throw new ServiceError('INVALID_PARAMS', `Unsupported hostService protocol: ${String(service.protocol)}.`);
      }
      const headers = transport.headers;
      servers.push({
        name: id,
        type: 'http',
        url,
        ...(headers !== undefined && typeof headers === 'object' && Array.isArray(headers) === false
          ? {
              headers: Object.entries(headers as Record<string, string>)
                .filter(([name]) => typeof name === 'string' && name !== '')
                .map(([name, value]) => ({ name, value: String(value) })),
            }
          : {}),
        isolation: 'session',
      });
    }
    return servers;
  }

  private async sessionCreate(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const workspace = (params.workspace ?? {}) as Record<string, unknown>;
    const cwd = stringField(workspace, 'cwd');
    const config = (params.config ?? {}) as Record<string, ConfigValue>;
    const native = (params.nativeSession ?? null) as Record<string, unknown> | null;
    const nativeHistory = native && native.history === 'replay' ? 'replay' : 'none';
    const mcpServers = this.hostServicesToMcpServers(params.hostServices);

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
      if (mcpServers !== undefined) record.hostMcpServers = mcpServers;
      try {
        await this.adoptNativeSession(record, native.id, nativeHistory === 'replay');
      } catch (error) {
        this.registry.detachForce(record);
        throw error;
      }
    } else {
      // Fresh native session. Handlers are registered before spawn; the
      // reverse preference requests are answered from the frozen Gian profile.
      // 0.16.9 turns are v4 turns, so the session MUST be created through the
      // v4 `createSession` command: its deferred draft is the row the v4
      // CommandInbox's session_input foreign key resolves against when the
      // first sendText promotes persistence. A legacy `session/create`
      // produces a session the v4 store does not know, and every v4 turn dies
      // on the FK constraint (live-verified 0.16.9).
      const ack = await this.v4Command({
        commandId: commandIdFor(['createSession', sessionId]),
        clientId: `gian:${sessionId}`,
        sessionId: null,
        type: 'createSession',
        payload: {
          workspaceId: cwd,
          ...(mcpServers !== undefined ? { mcpServers } : {}),
        },
      }, 45_000);
      const nativeSessionId = typeof ack.result?.sessionId === 'string' ? ack.result.sessionId : '';
      if (nativeSessionId === '') {
        throw new ServiceError('RUNTIME_ERROR', 'ZCode v4 createSession returned no native session id.');
      }
      record = this.registry.beginAttach(sessionId, nativeSessionId, runtimeKey);
      if (mcpServers !== undefined) record.hostMcpServers = mcpServers;
      try {
        // Adopt the fresh draft through the same resume+read path as an
        // explicit attach: resume's snapshot carries the FULL provider model
        // catalog (read alone narrows to the current model), which feeds the
        // side-effect-free catalog and the selection vocabulary checks.
        await this.adoptNativeSession(record, nativeSessionId, false);
      } catch (error) {
        this.registry.detachForce(record);
        throw error;
      }
    }

    this.createFingerprints.set(sessionId, fingerprint);
    return { session: this.snapshot(record) };
  }

  private readonly createFingerprints = new Map<string, string>();

  private confirmedSettingsFrom(created: Record<string, unknown> | null): SessionRecord['confirmedNativeSettings'] {
    const settings = (created?.settings ?? {}) as Record<string, unknown>;
    const model = (settings.model ?? {}) as Record<string, unknown>;
    const current = model.current as InnerModelRef | undefined;
    const modelOptions = current?.options;
    const thought = (settings.thoughtLevel ?? {}) as Record<string, unknown>;
    const permission = (settings.permission ?? {}) as Record<string, unknown>;
    return {
      ...(current && typeof current.providerId === 'string' && typeof current.modelId === 'string'
        ? { model: { providerId: current.providerId, modelId: current.modelId,
          ...(typeof modelOptions?.reasoningLevel === 'string' ? { options: { reasoningLevel: modelOptions.reasoningLevel } } : {}),
        } }
        : {}),
      ...(typeof modelOptions?.reasoningLevel === 'string' ? { thoughtLevel: modelOptions.reasoningLevel }
        : typeof thought.current === 'string' ? { thoughtLevel: thought.current } : {}),
      ...(typeof permission.mode === 'string' ? { mode: permission.mode } : {}),
    };
  }

  private async adoptNativeSession(record: SessionRecord, nativeId: string, wantHistory: boolean): Promise<void> {
    // Ownership probe: read fails for sessions that are not loaded; resume
    // loads them. Both errors fail the attach WITHOUT mutating ZCode state.
    // resume returns the FULL model catalog (snapshot() default); the
    // follow-up read narrows to the current model, so facts merge from both.
    const resumed = await this.transport.request('session/resume', {
      sessionId: nativeId,
      ...(record.hostMcpServers !== undefined ? { mcpServers: record.hostMcpServers } : {}),
    }, 30_000) as Record<string, unknown> | null;
    this.options.modelFacts?.update((resumed?.settings ?? undefined) as InnerReadState['settings']);
    const read = await this.transport.request('session/read', {
      sessionId: nativeId,
    }, 20_000) as InnerReadState | null;
    if (read === null) {
      throw new ServiceError('NATIVE_SESSION_NOT_FOUND', 'ZCode returned no state for the native session.');
    }
    const status = read.session?.status;
    if (status !== undefined && status !== 'idle') {
      throw new ServiceError('SESSION_BUSY', 'Native session is not idle; refusing to attach.');
    }
    this.assertInnerProtocol(read);
    record.confirmedNativeSettings = this.confirmedSettingsFrom(read as unknown as Record<string, unknown>);
    this.options.modelFacts?.update(read.settings);
    await this.attachProjector(record);
    this.registry.markOwned(record);
    if (wantHistory) {
      // Full history recovery: session/read's snapshot only carries messages
      // with the subscribe snapshot; fetch the durable transcript and project
      // it as replay-identity events on the fresh stream.
      await this.replayHistoryOnAttach(record);
    }
  }

  /** Project persisted history onto the freshly attached stream: complete
   *  messages, tool calls and terminal states with stable eventIds, then a
   *  plan snapshot when the session carries todos. Live events after the
   *  subscribe baseline carry native eventIds, so no duplicate or reordered
   *  facts reach the Host. */
  private async replayHistoryOnAttach(record: SessionRecord): Promise<void> {
    const projector = this.projectors.get(record.nativeSessionId);
    if (projector === undefined) return;
    const messages = await this.transport.request('session/messages', {
      sessionId: record.nativeSessionId,
    }, 30_000) as { messages?: Array<unknown> } | null;
    const all = messages?.messages ?? [];
    if (all.length > 0) {
      const events = buildReplayEvents({
        gianSessionId: record.sessionId,
        streamId: record.streamId,
        nativeSessionId: record.nativeSessionId,
        messages: all,
      });
      for (const event of events) {
        // buildReplayEvents returns the flat replay-event shape; the outer
        // notification wraps everything except the method name.
        const { method, ...params } = event as { method?: string } & Record<string, unknown>;
        this.emit({
          method: method as string,
          params: {
            ...params,
            streamId: record.streamId,
            sequence: this.nextSequence(record.sessionId),
          },
        });
      }
    }
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
      // Real ZCode emits live session/event notifications only while a
      // deliveryKind subscription exists (server-operations.ts:3053).
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

  private maybeCatalogChanged(_created: Record<string, unknown> | null): void {
    if (this.catalog === EMPTY_CATALOG || this.catalogPresentation === null) return;
    const observed = this.effectiveCatalogModelState();
    const projectedRevision = revisionFor(this.runtimeKey(), this.catalogPresentation, observed);
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

  /** Issue one v4 command envelope and normalize its ack. */
  private async v4Command(
    envelope: {
      commandId: string;
      clientId: string;
      sessionId: string | null;
      type: string;
      payload: Record<string, unknown>;
    },
    timeoutMs?: number,
  ): Promise<InnerCommandAck> {
    const ackEnvelope = await this.transport.request('v4/command', {
      ...envelope,
      issuedAt: Date.now(),
    }, timeoutMs) as Record<string, unknown> | null;
    return (ackEnvelope?.ack ?? ackEnvelope ?? {}) as InnerCommandAck;
  }

  /** Effective 0.16.9 model vocabulary for a ref, from the full Registry
   * catalog when available; session snapshots may expose only the current. */
  private modelVocabulary(ref: InnerModelRef): {
    levels: string[] | null;
    defaultLevel: string | null;
  } {
    const settings = this.catalogModelState?.settings ?? this.options.modelFacts?.current()?.settings;
    for (const model of settings?.model?.available ?? []) {
      if (model.ref?.providerId === ref.providerId && model.ref?.modelId === ref.modelId) {
        return {
          levels: model.reasoning?.levels?.map((level) => level.value) ?? null,
          defaultLevel: model.reasoning?.defaultLevel ?? null,
        };
      }
    }
    return { levels: null, defaultLevel: null };
  }

  private async applyTurnConfig(record: SessionRecord, config: Record<string, ConfigValue>): Promise<SessionRecord['confirmedNativeSettings']> {
    // Apply the full turn config snapshot (§7.4). 0.16.9 resolves model and
    // reasoning level as ONE ModelSelection (`session/setModel` params carry
    // `{providerId, modelId, options:{reasoningLevel?}}`, and the registry
    // rejects a model whose reasoning level is missing), so model and
    // thinking are committed ATOMICALLY here — the previous two-step
    // setModel -> setThoughtLevel path died on the real registry validation.
    const nativeSessionId = record.nativeSessionId;
    const previousConfirmed = {
      ...record.confirmedNativeSettings,
      ...(record.confirmedNativeSettings.model
        ? { model: { ...record.confirmedNativeSettings.model } }
        : {}),
    };
    const confirmed = {
      ...previousConfirmed,
      ...(previousConfirmed.model ? { model: { ...previousConfirmed.model } } : {}),
    };
    try {
      const modelValue = config['model'];
      const thinkingValue = config['thinking'];
      if (modelValue !== undefined || thinkingValue !== undefined) {
        if (modelValue !== undefined && typeof modelValue !== 'string') {
          throw new ConfigValueInvalidError('model config must be a string.');
        }
        if (thinkingValue !== undefined && (typeof thinkingValue !== 'string' || thinkingValue === '')) {
          throw new ConfigValueInvalidError('thinking config must be a non-empty string.');
        }
        if (typeof modelValue === 'string') {
          const ref = decodeModelValue(modelValue);
          const providerValue = config['provider'];
          if (typeof providerValue === 'string' && providerValue !== ref.providerId) {
            throw new ConfigValueInvalidError('Provider and model config values do not match.');
          }
          // turn.start may arrive before catalog.list. Read the same
          // side-effect-free Registry contract on demand, then fail cleanly
          // instead of leaking a raw runtime rejection after admission.
          this.catalogModelState ??= await this.readModelCatalog();
          const available = this.catalogModelState.settings?.model?.available ?? [];
          const known = available.some((model) =>
            model.ref?.providerId === ref.providerId && model.ref?.modelId === ref.modelId);
          if (!known) {
            throw new ConfigValueInvalidError(`Unknown model ${ref.providerId}/${ref.modelId}.`);
          }
          confirmed.model = { providerId: ref.providerId, modelId: ref.modelId };
        }
        if (!confirmed.model) {
          throw new ConfigValueInvalidError(
            'thinking was requested but the runtime has no current model; send model and thinking together.',
          );
        }
        const explicitLevel = typeof thinkingValue === 'string' ? thinkingValue : undefined;
        const { levels, defaultLevel } = this.modelVocabulary(confirmed.model);
        let effectiveLevel: string | undefined = explicitLevel ?? confirmed.thoughtLevel ?? undefined;
        if (explicitLevel !== undefined && levels !== null && !levels.includes(explicitLevel)) {
          // An explicitly requested level outside the TARGET model's own
          // vocabulary is a clean request failure (§7.4), never a silent map.
          throw new ConfigValueInvalidError(
            `Reasoning level "${explicitLevel}" is not supported by ${confirmed.model.providerId}/${confirmed.model.modelId}.`,
          );
        }
        if (explicitLevel === undefined && typeof modelValue === 'string'
          && effectiveLevel !== undefined && levels !== null && !levels.includes(effectiveLevel)) {
          // A model switch must not carry the previous model's vocabulary:
          // fall back to the TARGET model's own default when the inherited
          // level is not one of its reasoning choices.
          effectiveLevel = defaultLevel ?? undefined;
        }
        if (effectiveLevel === undefined && levels !== null && levels.length > 0
          && defaultLevel !== null) {
          effectiveLevel = defaultLevel;
        }
        if (effectiveLevel !== undefined && levels !== null && !levels.includes(effectiveLevel)) {
          throw new ConfigValueInvalidError(
            `Reasoning level "${effectiveLevel}" is not supported by ${confirmed.model.providerId}/${confirmed.model.modelId}.`,
          );
        }
        const selection: InnerModelRef & { options?: { reasoningLevel: string } } = {
          providerId: confirmed.model.providerId,
          modelId: confirmed.model.modelId,
          ...(effectiveLevel !== undefined ? { options: { reasoningLevel: effectiveLevel } } : {}),
        };
        const unchanged = previousConfirmed.model?.providerId === selection.providerId
          && previousConfirmed.model?.modelId === selection.modelId
          && (previousConfirmed.thoughtLevel ?? undefined) === selection.options?.reasoningLevel;
        if (!unchanged) {
          const set = await this.transport.request('session/setModel', {
            sessionId: nativeSessionId, model: selection,
          }) as Record<string, unknown> | null;
          if (selection.options?.reasoningLevel !== undefined) {
            confirmed.thoughtLevel = selection.options.reasoningLevel;
          }
          this.options.modelFacts?.update((set?.settings ?? undefined) as InnerReadState['settings']);
        }
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
      await this.restoreConfirmed(record, previousConfirmed).catch(() => undefined);
      if (error instanceof ConfigValueInvalidError) {
        throw new ServiceError('CONFIG_VALUE_INVALID', error.message);
      }
      if (error instanceof InnerError) {
        throw new ServiceError('RUNTIME_ERROR', redactSecrets(error.message) as string);
      }
      throw error;
    }
    return confirmed;
  }

  /** Build the sendText text and attachment list from outer input items.
   *  Every validation failure happens BEFORE the turn is sent. */
  private buildSendPayload(input: Array<Record<string, unknown>>): {
    text: string;
    attachments: InnerAttachmentRef[];
  } {
    const attachments: InnerAttachmentRef[] = [];
    const textParts: string[] = [];
    let trailingTask = '';
    const pendingSkills: string[] = [];
    for (const item of input) {
      const type = typeof item.type === 'string' ? item.type : '';
      if (type === 'text' && typeof item.text === 'string') {
        trailingTask = trailingTask === '' ? item.text : `${trailingTask}\n${item.text}`;
        continue;
      }
      if (type === 'skill') {
        const name = typeof item.name === 'string' ? item.name : '';
        if (name === '') {
          throw new ServiceError('INVALID_PARAMS', 'skill input requires a name.');
        }
        pendingSkills.push(name);
        continue;
      }
      if (type === 'localImage' || type === 'localFile') {
        const validated = validateLocalAttachment(item as {
          type: string; path: string; name?: string; mime?: string; size?: number;
        });
        attachments.push(validated.ref);
        continue;
      }
      throw new ServiceError('INVALID_PARAMS', `Unsupported input type for ZCode: ${type || 'unknown'}.`);
    }
    // Skills activate through the upstream canonical manual-skill prompt
    // (slash-commands.ts buildManualSkillPrompt); the user's text is the task.
    for (const skillName of pendingSkills) {
      textParts.push(buildManualSkillPrompt(skillName, trailingTask));
      trailingTask = '';
    }
    if (trailingTask !== '') textParts.push(trailingTask);
    const text = textParts.join('\n\n');
    if (text === '' && attachments.length === 0) {
      throw new ServiceError('INVALID_PARAMS', 'Turn input resolved to neither text nor attachments.');
    }
    return { text, attachments };
  }

  private async sendTextCommand(args: {
    nativeSessionId: string;
    text: string;
    attachments: InnerAttachmentRef[];
    delivery: 'startNow' | 'guide';
    commandId: string;
    clientId: string;
    /** Full model selection carried with the input so admission pins the
     *  exact selection the turn was validated against (0.16.9 sendText
     *  payload accepts `modelSelection`). */
    modelSelection?: { providerId: string; modelId: string; options?: { reasoningLevel: string } };
  }): Promise<InnerCommandAck> {
    const ackEnvelope = await this.transport.request('v4/command', {
      commandId: args.commandId,
      clientId: args.clientId,
      sessionId: args.nativeSessionId,
      type: 'sendText',
      payload: {
        text: args.text,
        ...(args.attachments.length > 0 ? { attachments: args.attachments } : {}),
        ...(args.modelSelection !== undefined ? { modelSelection: args.modelSelection } : {}),
        requestedDelivery: args.delivery,
      },
      issuedAt: Date.now(),
    }, 60_000) as Record<string, unknown> | null;
    const ack = (ackEnvelope?.ack ?? ackEnvelope ?? {}) as InnerCommandAck;
    if (ack.status !== 'accepted' && ack.status !== 'duplicate' && ack.status !== 'noop') {
      const reasonCode = typeof ack.reasonCode === 'string' ? ack.reasonCode : 'unknown';
      if (args.delivery === 'guide' && reasonCode.includes('guide.attachmentsUnsupported')) {
        throw new ServiceError('INVALID_PARAMS', 'ZCode guide routing cannot carry attachments.');
      }
      throw new ServiceError(
        'RUNTIME_ERROR',
        `ZCode rejected the sendText command (${ack.status}: ${reasonCode}).`,
        ack.status === 'stale',
      );
    }
    return ack;
  }

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

    const nativeSessionId = record.nativeSessionId;
    let confirmed: SessionRecord['confirmedNativeSettings'];
    try {
      confirmed = await this.applyTurnConfig(record, config);
    } catch (error) {
      // The idempotency entry must not block a corrected retry.
      this.turns.forget(sessionId, streamId, turnId);
      throw error;
    }

    // Build the send payload. Attachment/skill validation happens before the
    // send so a rejected input never starts a native turn.
    let payload: { text: string; attachments: InnerAttachmentRef[] };
    try {
      payload = this.buildSendPayload(input);
    } catch (error) {
      this.turns.forget(sessionId, streamId, turnId);
      throw error;
    }

    // Bind the projector turn BEFORE the send: the 0.16.9 runtime emits the
    // typed turn-started operation event as soon as it admits the input,
    // which can precede the sendText ack. Binding after the ack swallowed or
    // mis-attributed every subsequent turn's turn.started (live E2E).
    const projector = this.projectors.get(nativeSessionId);
    projector?.bindTurn(turnId, ''); // nativeTurnId binds on typed turn-started

    // Send. Notifications emitted between accept and response stay inside
    // this dispatch queue (response barrier), after the accepted result.
    try {
      await this.sendTextCommand({
        nativeSessionId,
        text: payload.text,
        attachments: payload.attachments,
        delivery: 'startNow',
        commandId: commandIdFor(['sendText', sessionId, turnId]),
        clientId: `gian:${sessionId}`,
        // Carry the exact selection this turn was validated against so
        // admission cannot resolve a different model/reasoning pair.
        ...(confirmed.model !== undefined
          ? {
              modelSelection: {
                providerId: confirmed.model.providerId,
                modelId: confirmed.model.modelId,
                ...(confirmed.thoughtLevel !== undefined
                  ? { options: { reasoningLevel: confirmed.thoughtLevel } }
                  : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      // No native turn exists; release the binding so a stale turn-started
      // can never be attributed to this gian turn.
      projector?.clearTurn();
      this.turns.forget(sessionId, streamId, turnId);
      if (error instanceof InnerError && error.code === -32004) {
        throw new ServiceError('SESSION_ERROR', 'ZCode reported the session as not active.');
      }
      throw error;
    }

    record.confirmedNativeSettings = confirmed;
    this.turns.markAccepted(sessionId, streamId, turnId);
    this.registry.markRunning(record, turnId, null);
    return { accepted: true, turnId };
  }

  private async restoreConfirmed(record: SessionRecord, confirmed: SessionRecord['confirmedNativeSettings']): Promise<void> {
    const nativeSessionId = record.nativeSessionId;
    // Rollback restores the COMPLETE selection atomically: model and reasoning
    // level travel in one `session/setModel` call — the split setModel +
    // setThoughtLevel path no longer exists in the 0.16.9 flow.
    if (confirmed.model !== undefined) {
      await this.transport.request('session/setModel', {
        sessionId: nativeSessionId,
        model: {
          providerId: confirmed.model.providerId,
          modelId: confirmed.model.modelId,
          ...(confirmed.thoughtLevel !== undefined
            ? { options: { reasoningLevel: confirmed.thoughtLevel } }
            : {}),
        },
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
    await this.transport.request('v4/command', {
      commandId: commandIdFor(['stop', sessionId, turnId]),
      clientId: `gian:${sessionId}`,
      sessionId: record.nativeSessionId,
      type: 'stop',
      payload: {
        ...(foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {}),
      },
      issuedAt: Date.now(),
    }, 20_000) as Record<string, unknown> | null;
    // The stop command's ack is advisory: the authoritative fact is the
    // native turn terminal event, which the projector maps (§9.3).
    projector?.markInterruptAccepted();
    return { accepted: true, turnId };
  }

  // ---- steer ----

  /** `turn.steer` maps to v4 `sendText` with `requestedDelivery: "guide"`:
   *  supplementary guidance inlined into the CURRENT turn at the next model
   *  step boundary — the same turn continues (session.port.ts:272-278,
   *  turn-guide-drain.ts:13-66). Queueing to the next turn is a different
   *  delivery and is never presented as steer. */
  private async turnSteer(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const turnId = stringField(params, 'turnId');
    const record = this.registry.requireStream(sessionId, streamId);
    if (record.activeTurnId !== turnId) {
      throw new ServiceError(
        'TURN_NOT_FOUND',
        `No active turn ${turnId} to steer; ZCode guide routing only applies to a running turn.`,
      );
    }
    const input = Array.isArray(params.input) ? params.input as Array<Record<string, unknown>> : [];
    for (const item of input) {
      if (item.type !== 'text') {
        throw new ServiceError(
          'INVALID_PARAMS',
          'ZCode guide routing is text-only (guide.attachmentsUnsupported); attachments cannot steer a running turn.',
        );
      }
    }
    const payload = this.buildSendPayload(input);
    if (payload.text === '') {
      throw new ServiceError('INVALID_PARAMS', 'Steer input resolved to empty text.');
    }
    const ack = await this.sendTextCommand({
      nativeSessionId: record.nativeSessionId,
      text: payload.text,
      attachments: [],
      delivery: 'guide',
      // Deterministic commandId: an identical retry is deduped by the CLI
      // command inbox (status "duplicate"); different text yields a new id,
      // so multiple distinct steers per turn are allowed.
      commandId: commandIdFor(['steer', sessionId, turnId, payload.text]),
      clientId: `gian:${sessionId}`,
    });
    void ack;
    return { accepted: true, turnId };
  }

  // ---- interaction ----

  private handlePermissionReverseRequest(params: Record<string, unknown>, transportId: string):
    { result: unknown } | { error: { code: number; message: string; data?: unknown } } | { defer: true } {
    const nativeSessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
    const requestId = typeof params.requestId === 'string' ? params.requestId : null;
    const projector = nativeSessionId === null ? undefined : this.projectors.get(nativeSessionId);
    if (nativeSessionId === null || projector === undefined || requestId === null) {
      return {
        error: {
          code: -32601,
          message: 'interaction/requestPermission has no relayable Gian turn.',
        },
      };
    }
    const options = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
    const request = {
      requestId,
      // The 0.16.9 permission request carries the native turnId; it can
      // arrive BEFORE the typed turn-started event, so the projector binds
      // the turn identity from this field (WP0 G2). The live E2E proved the
      // real runtime relies on exactly this ordering.
      ...(typeof params.turnId === 'string' && params.turnId !== ''
        ? { turnId: params.turnId, nativeTurnId: params.turnId }
        : {}),
      ...(typeof params.toolCallId === 'string' ? { toolCallId: params.toolCallId } : {}),
      ...(typeof params.toolName === 'string' ? { toolName: params.toolName } : {}),
      ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
      ...(typeof params.riskLevel === 'string' ? { riskLevel: params.riskLevel } : {}),
      input: params.input,
      ...(params.origin !== undefined && params.origin !== null ? { origin: params.origin as Record<string, unknown> } : {}),
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
    };
    const entry = projector.handlePermissionRequest(request);
    if (entry === null) {
      return {
        error: {
          code: -32601,
          message: 'No faithfully round-trippable action set for this permission request.',
        },
      };
    }
    return this.deferInteraction(entry, nativeSessionId, projector, transportId);
  }

  private handleUserInputReverseRequest(params: Record<string, unknown>, transportId: string):
    { result: unknown } | { error: { code: number; message: string; data?: unknown } } | { defer: true } {
    const nativeSessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
    const requestId = typeof params.requestId === 'string' ? params.requestId : null;
    const projector = nativeSessionId === null ? undefined : this.projectors.get(nativeSessionId);
    if (nativeSessionId === null || projector === undefined || requestId === null) {
      return {
        error: {
          code: -32601,
          message: 'interaction/requestUserInput has no relayable Gian turn.',
        },
      };
    }
    const questions: InnerUserInputQuestion[] = Array.isArray(params.questions)
      ? params.questions as InnerUserInputQuestion[]
      : [];
    const request = {
      requestId,
      ...(typeof params.turnId === 'string' && params.turnId !== ''
        ? { turnId: params.turnId, nativeTurnId: params.turnId }
        : {}),
      ...(typeof params.toolCallId === 'string' ? { toolCallId: params.toolCallId } : {}),
      ...(typeof params.toolName === 'string' ? { toolName: params.toolName } : {}),
      ...(typeof params.prompt === 'string' ? { prompt: params.prompt } : {}),
      questions,
      input: params.input,
      ...(params.origin !== undefined && params.origin !== null ? { origin: params.origin as Record<string, unknown> } : {}),
      ...(params.schema !== undefined && params.schema !== null ? { schema: params.schema as Record<string, unknown> } : {}),
      raw: params,
    };
    const entry = projector.handleUserInputRequest(request);
    if (entry === null) {
      return {
        error: {
          code: -32601,
          message: 'No faithfully relayable question set for this user input request.',
        },
      };
    }
    return this.deferInteraction(entry, nativeSessionId, projector, transportId);
  }

  private deferInteraction(
    entry: { interactionId: string; respond: (actionId: string, values: Record<string, unknown>) => Record<string, unknown> },
    nativeSessionId: string,
    projector: SessionProjector,
    transportId: string,
  ): { defer: true } {
    // The server request stays open; interaction.respond completes it with
    // the EXACT native response payload (§11.1).
    const ownedRecord = this.registry.byNativeSession(nativeSessionId);
    this.pendingInteractions.set(entry.interactionId, {
      gianSessionId: ownedRecord?.sessionId ?? '',
      gianTurnId: projector.activeGianTurnId() ?? '',
      serverRequestId: transportId,
      resolved: false,
      respond: entry.respond,
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
    const values = (params.values ?? {}) as Record<string, unknown>;
    this.registry.requireStream(sessionId, streamId);

    const fingerprint = JSON.stringify({
      interactionId, actionId, values,
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
    let nativeResponse: Record<string, unknown>;
    try {
      nativeResponse = pending.respond(actionId, values);
    } catch (error) {
      if (error instanceof SessionInteractionActionError) {
        this.responses.forget(responseId);
        throw new ServiceError('INTERACTION_ACTION_NOT_FOUND', error.message);
      }
      throw error;
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

  // ---- rename ----

  /** `session.rename` maps to the v4 `renameSession` command
   *  (commands/handlers/session-mgmt.ts:140-152); the runtime then enforces
   *  titleSource=custom stickiness and emits session.titleUpdated. */
  private async sessionRename(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const name = params.name;
    if (typeof name !== 'string' || [...name].length === 0 || [...name].length > 200) {
      throw new ServiceError('INVALID_PARAMS', 'params.name must be 1-200 Unicode code points.');
    }
    const record = this.registry.requireStream(sessionId, streamId);
    const ackEnvelope = await this.transport.request('v4/command', {
      commandId: commandIdFor(['renameSession', sessionId, name]),
      clientId: `gian:${sessionId}`,
      sessionId: record.nativeSessionId,
      type: 'renameSession',
      payload: { title: name },
      issuedAt: Date.now(),
    }, 20_000) as Record<string, unknown> | null;
    const ack = (ackEnvelope?.ack ?? ackEnvelope ?? {}) as InnerCommandAck;
    if (ack.status !== 'accepted' && ack.status !== 'duplicate' && ack.status !== 'noop') {
      const reasonCode = typeof ack.reasonCode === 'string' ? ack.reasonCode : 'unknown';
      throw new ServiceError('RUNTIME_ERROR', `ZCode rejected the rename command (${ack.status}: ${reasonCode}).`);
    }
    return { ok: true };
  }

  // ---- fork ----

  /** Fetch conversation rows (tail-first) until `matcher` finds a target or
   *  the walk budget is exhausted. rowsRange rows arrive in rowId ascending
   *  order; atRevision/atLogEpoch name the consistent watermark the fork CAS
   *  needs (transport.ts:478-502). */
  private async findForkRow(nativeSessionId: string, anchor: { type: 'head' } | { type: 'turn'; sourceTurnId: string }): Promise<{
    row: InnerConversationRow;
    atRevision: number;
    atLogEpoch: string;
    nativeTurnId: string;
  }> {
    const MAX_PAGES = 6;
    let beforeRowId: number | undefined = undefined;
    let scanned: InnerConversationRow[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.transport.request('v4/conversation/rowsRange', {
        sessionId: nativeSessionId,
        limit: 200,
        ...(beforeRowId !== undefined ? { beforeRowId } : {}),
      }, 20_000) as InnerRowsRangeResult | null;
      const rows = result?.rows ?? [];
      if (rows.length === 0) break;
      scanned = page === 0 ? rows : [...rows, ...scanned];
      const match = matchForkAnchor(scanned, anchor);
      if (match !== null) {
        if (typeof result?.atRevision !== 'number' || typeof result?.atLogEpoch !== 'string') {
          throw new ServiceError('RUNTIME_ERROR', 'ZCode rowsRange returned no fork CAS watermark.');
        }
        return {
          row: match.row,
          atRevision: result.atRevision,
          atLogEpoch: result.atLogEpoch,
          nativeTurnId: match.nativeTurnId,
        };
      }
      if (result?.hasMore === true && typeof rows[0]?.rowId === 'number') {
        beforeRowId = rows[0].rowId;
        continue;
      }
      break;
    }
    throw new ServiceError(
      'FORK_BOUNDARY_UNAVAILABLE',
      anchor.type === 'head'
        ? 'No completed, forkable assistant turn was found in the conversation projection.'
        : `No completed, forkable assistant turn matches sourceTurnId ${anchor.sourceTurnId}.`,
    );
  }

  /** `session.fork` maps to the v4 `forkAssistant` command — the stable
   *  CONVERSATION-ONLY fork (fork-edit-retry.ts:6 "conversation-only copy;
   *  running parent 与 workspace 不动"). The legacy checkpoint fork
   *  (`session/fork`, which restores workspace files) is never used. */
  private async sessionFork(params: Record<string, unknown>): Promise<unknown> {
    const sourceSessionId = stringField(params, 'sourceSessionId');
    const sourceStreamId = stringField(params, 'sourceStreamId');
    const newSessionId = stringField(params, 'sessionId');
    const anchorRaw = (params.anchor ?? {}) as Record<string, unknown>;
    const anchorType = anchorRaw.type;
    if (anchorType !== 'head' && anchorType !== 'turn') {
      throw new ServiceError('INVALID_PARAMS', 'params.anchor.type must be "head" or "turn".');
    }
    if (this.registry.get(newSessionId) !== undefined) {
      throw new ServiceError('CONFLICT', `Session ${newSessionId} already exists.`);
    }
    const source = this.registry.requireStream(sourceSessionId, sourceStreamId);
    if (source.activeTurnId !== null) {
      // The conversation-only fork does not require an idle parent
      // (fork-edit-retry.ts:275-279), but Gian forks a snapshot identity:
      // refuse mid-turn to keep the origin fact unambiguous.
      throw new ServiceError('SESSION_BUSY', 'Refusing to fork while a turn is active.');
    }
    const anchor = anchorType === 'head'
      ? { type: 'head' } as const
      : { type: 'turn' as const, sourceTurnId: stringField(anchorRaw, 'sourceTurnId') };

    let attempt = 0;
    for (;;) {
      const target = await this.findForkRow(source.nativeSessionId, anchor);
      const ackEnvelope = await this.transport.request('v4/command', {
        commandId: commandIdFor(['forkAssistant', sourceSessionId, anchorType === 'head' ? 'head' : anchor.sourceTurnId]),
        clientId: `gian:${sourceSessionId}`,
        sessionId: source.nativeSessionId,
        baseRevision: target.atRevision,
        baseLogEpoch: target.atLogEpoch,
        type: 'forkAssistant',
        payload: {
          target: {
            rowId: target.row.rowId,
            entityId: target.row.entityId,
          },
        },
        issuedAt: Date.now(),
      }, 30_000) as Record<string, unknown> | null;
      const ack = (ackEnvelope?.ack ?? ackEnvelope ?? {}) as InnerCommandAck;
      if (ack.status === 'stale' && attempt === 0) {
        // The projection moved between rowsRange and the command; refresh the
        // watermark once and retry with the same deterministic commandId.
        attempt += 1;
        continue;
      }
      if (ack.status !== 'accepted' && ack.status !== 'duplicate') {
        const reasonCode = typeof ack.reasonCode === 'string' ? ack.reasonCode : 'unknown';
        throw new ServiceError(
          'FORK_BOUNDARY_UNAVAILABLE',
          `ZCode rejected the fork command (${ack.status}: ${reasonCode}).`,
        );
      }
      const childNativeId = typeof ack.result?.sessionId === 'string' ? ack.result.sessionId : '';
      if (childNativeId === '') {
        throw new ServiceError('RUNTIME_ERROR', 'ZCode fork command returned no child session id.');
      }
      const record = this.registry.beginAttach(newSessionId, childNativeId, this.runtimeKey());
      try {
        await this.adoptNativeSession(record, childNativeId, false);
      } catch (error) {
        this.registry.detachForce(record);
        throw error;
      }
      return {
        session: this.snapshot(record),
        origin: {
          kind: 'fork',
          sessionId: sourceSessionId,
          turnId: target.nativeTurnId,
          sourceTurnId: target.nativeTurnId,
        },
      };
    }
  }

  // ---- close / native list / replay ----

  private async sessionClose(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = stringField(params, 'sessionId');
    const streamId = stringField(params, 'streamId');
    const record = this.registry.detach(sessionId, streamId);
    this.projectors.delete(record.nativeSessionId);
    this.turns.forgetStream(sessionId, streamId);
    // Deliberately NO inner session/close: the 0.16.9 close tears the runtime
    // down (and v4 publishers emit session.removed); the 0.16.9 deleteSession
    // command is the same close. Detach only drops adapter state, so the
    // provider history stays visible and re-attachable (session/list +
    // session/resume adopt it later).
    return { ok: true };
  }

  private async sessionNativeList(params: Record<string, unknown>): Promise<unknown> {
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.min(params.limit, 500) : 100;
    const cursor = typeof params.cursor === 'string' && params.cursor !== '' ? params.cursor : null;
    const offset = cursor === null ? 0 : decodeOffsetCursor(cursor);
    if (offset < 0) throw new ServiceError('INVALID_PARAMS', 'cursor is not a valid native list cursor.');
    const cwd = typeof params.cwd === 'string' && params.cwd !== '' ? params.cwd : null;
    const list = await this.transport.request('session/list', {
      limit: 500,
      includeArchived: false,
      ...(cwd !== null ? { workspace: { workspacePath: cwd, workspaceKey: cwd } } : {}),
    }, 20_000) as { sessions?: InnerSessionSummary[] } | null;
    const summaries = (list?.sessions ?? []).filter((session) => {
      if (session.status !== undefined && LISTABLE_SESSION_STATUSES.has(session.status) === false) return false;
      if (session.sessionKind !== undefined && ADOPTABLE_SESSION_KINDS.has(session.sessionKind) === false) return false;
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
      streamId: '',
      nativeSessionId: record.nativeSessionId,
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

  // ---- customization (read-only inventory, gian.proxy/2.3) ----

  private workspaceRefFor(cwd: string | null): Record<string, string> {
    const workspace = cwd ?? this.options.catalogWorkspace;
    return { workspacePath: workspace, workspaceKey: workspace };
  }

  private customizationItemId(kind: string, name: string, extra: string): string {
    return `ci1_${createHash('sha256').update(`${kind}\u0000${name}\u0000${extra}`).digest('hex').slice(0, 32)}`;
  }

  private async customizationList(params: Record<string, unknown>): Promise<unknown> {
    const kind = typeof params.kind === 'string' ? params.kind : '';
    const cwd = typeof params.cwd === 'string' && params.cwd !== '' ? params.cwd : null;
    if (kind === 'skill') return this.customizationSkills(cwd);
    if (kind === 'mcp') return this.customizationMcp(cwd);
    if (kind === 'hook') {
      return customizationUnsupportedList(
        'hook',
        'ZCode 0.16.9 exposes no hook enumeration method on the app-server '
        + '(grep listHooks|hooks/list over apps/zcode-cli + packages: 0 hits); '
        + 'hook runs surface as transcript activities only.',
      );
    }
    return customizationUnsupportedList(kind || 'rule', `ZCode has no ${kind || 'rule'} customization concept.`);
  }

  private async customizationSkills(cwd: string | null): Promise<unknown> {
    // skills/referenceCatalog without sessionId performs a fresh workspace
    // scan and never executes anything (skill-reference-catalog.ts:16-36).
    const catalog = await this.transport.request('skills/referenceCatalog', {
      workspace: this.workspaceRefFor(cwd),
    }, 20_000) as { skills?: InnerSkillEntry[] } | null;
    const skills = catalog?.skills ?? [];
    const items = skills.slice(0, 500).map((skill) => {
      const name = typeof skill.name === 'string' ? skill.name : '';
      const path = typeof skill.path === 'string' ? skill.path : '';
      const scope = skill.scope === 'workspace' ? 'workspace' : skill.scope === 'user' ? 'user' : 'unknown';
      const originKind = skill.scope === 'plugin' ? 'plugin' : skill.scope === 'workspace' ? 'project_file' : 'user_file';
      return {
        id: this.customizationItemId('skill', name, path),
        kind: 'skill',
        name,
        ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
        nativeType: 'skill',
        ...(skill.enabled === false ? { nativeStatus: 'disabled' } : {}),
        activation: 'enabled', // upstream catalog entries are enabled: literal true
        scope: { level: scope, ...(path !== '' ? { root: path } : {}) },
        origin: {
          kind: originKind,
          ...(path !== '' ? { path } : {}),
          ...(typeof skill.pluginName === 'string' ? { label: skill.pluginName } : {}),
        },
        discovery: { method: 'provider_api' },
        skill: {
          format: 'agent-skill',
          ...(path !== '' ? { entryPath: path } : {}),
          ...(name !== '' ? { invocation: name } : {}),
          userInvocable: true,
          modelInvocable: true,
        },
      };
    });
    return {
      kind: 'skill',
      status: 'ok',
      completeness: 'effective',
      observedAt: new Date().toISOString(),
      items,
      truncated: skills.length > items.length,
      diagnostics: [],
    };
  }

  private async customizationMcp(cwd: string | null): Promise<unknown> {
    // mode:"status" is the read-only surface: it never connects
    // (mcp.ts:78-87 listMcpServerStatuses synthesizes without connecting).
    const result = await this.transport.request('mcp/list', {
      workspace: this.workspaceRefFor(cwd),
      mode: 'status',
    }, 20_000) as { statuses?: Record<string, Record<string, unknown>> } | null;
    const statuses = result?.statuses ?? {};
    const activationFor: Record<string, string> = {
      connected: 'enabled',
      disabled: 'disabled',
      untrusted: 'pending_trust',
      failed: 'invalid',
      connecting: 'unknown',
      disconnected: 'unknown',
    };
    const items = Object.entries(statuses).slice(0, 500).map(([name, status]) => {
      const transport = typeof status.transport === 'string' ? status.transport : 'stdio';
      const activation = activationFor[typeof status.status === 'string' ? status.status : ''] ?? 'unknown';
      return {
        id: this.customizationItemId('mcp', name, transport),
        kind: 'mcp',
        name,
        description: `${status.toolCount ?? 0} tools`,
        nativeType: transport,
        ...(typeof status.status === 'string' ? { nativeStatus: status.status } : {}),
        activation,
        scope: { level: 'user' },
        origin: { kind: 'unknown', label: name },
        discovery: { method: 'provider_api' },
        mcp: {
          transport: transport === 'sse' ? 'http' : transport,
          ...(activation !== 'enabled' ? {} : { targetSummary: name }),
          ...(typeof status.toolCount === 'number' ? { toolCount: status.toolCount } : {}),
        },
      };
    });
    return {
      kind: 'mcp',
      status: 'ok',
      completeness: 'configured',
      observedAt: new Date().toISOString(),
      items,
      truncated: Object.keys(statuses).length > items.length,
      diagnostics: [],
    };
  }

  private async customizationDetail(params: Record<string, unknown>): Promise<unknown> {
    const kind = typeof params.kind === 'string' ? params.kind : '';
    const id = typeof params.id === 'string' ? params.id : '';
    const cwd = typeof params.cwd === 'string' && params.cwd !== '' ? params.cwd : null;
    if (kind === 'skill' || kind === 'mcp') {
      const list = kind === 'skill' ? await this.customizationSkills(cwd) : await this.customizationMcp(cwd);
      const item = (list as { items?: Array<{ id: string; [key: string]: unknown }> }).items
        ?.find((entry) => entry.id === id);
      if (item === undefined) {
        return customizationUnavailableDetail(kind, id, `No ${kind} customization matches ${id}.`);
      }
      // Detail text is the provider-reported metadata only. For skills this
      // is the catalog entry (upstream never exposes skill bodies over the
      // protocol); for MCP it is the status snapshot, which carries no
      // credentials (statuses only: status/transport/toolCount/updatedAt).
      const text = JSON.stringify(item);
      return {
        kind,
        id,
        status: 'ok',
        observedAt: new Date().toISOString(),
        text: text.length > 16_000 ? text.slice(0, 16_000) : text,
        truncated: text.length > 16_000,
        diagnostics: [],
      };
    }
    return customizationUnavailableDetail(
      kind || 'rule',
      id,
      `ZCode 0.16.9 exposes no ${kind || 'rule'} detail surface.`,
    );
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

/** Fork-anchor resolution over projection rows. A valid target is the LAST
 *  assistant segment of a successfully completed turn whose canFork action
 *  is advertised (product-projection.ts:895-932
 *  resolveStableForkCandidate). */
function matchForkAnchor(
  rows: InnerConversationRow[],
  anchor: { type: 'head' } | { type: 'turn'; sourceTurnId: string },
): { row: InnerConversationRow; nativeTurnId: string } | null {
  const turnState = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === 'turnHeader') {
      const key = row.productTurnId ?? row.turnId ?? '';
      if (key !== '') turnState.set(key, row.state ?? '');
    }
  }
  const turnOf = (row: InnerConversationRow): string => row.productTurnId ?? row.turnId ?? '';
  let match: InnerConversationRow | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind !== 'assistantText') continue;
    if (row.state !== 'complete') continue;
    if (row.actions?.canFork !== true) continue;
    const turnId = turnOf(row);
    if (turnId === '') continue;
    if (anchor.type === 'turn' && turnId !== anchor.sourceTurnId) continue;
    if (turnState.get(turnId) !== 'completedSuccess') continue;
    match = row;
    break;
  }
  if (match === null) return null;
  return { row: match, nativeTurnId: turnOf(match) };
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
    if (error.domainCode === 'INVALID_PARAMS') {
      return {
        code: -32602,
        message: error.message,
        data: { domainCode: 'INVALID_PARAMS', retryable: false, details: {} },
      };
    }
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

/** 0.16.9 `session/messages` shapes (packages/shared/src/
 *  zcode-protocol-legacy-types.ts:212-252, 360-443). */
interface ReplayMessage {
  info?: {
    role?: string;
    messageId?: string;
    id?: string;
    finish?: string;
    parentMessageId?: string;
    tokens?: Record<string, unknown>;
    time?: { created?: number };
  };
  parts?: Array<Record<string, unknown>>;
}

export function buildReplayEvents(context: {
  gianSessionId: string;
  /** '' for session.replay (Host fills the stream), set for attach replay. */
  streamId: string;
  nativeSessionId: string;
  messages: unknown[];
}): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  let sequence = 0;
  const nextSequence = (): number => ++sequence;
  const emittedAt = (time: unknown): string => {
    const ms = typeof time === 'number' ? time : Date.now();
    return new Date(ms).toISOString();
  };

  // Group messages into turns: a user message starts a turn; assistant
  // messages whose parentMessageId points at that user message belong to it.
  // The native turn id comes from a timeline part anchorTurnId when present
  // (parts carry anchorTurnId/anchorMessageId, legacy-types.ts:311-358),
  // falling back to the assistant message id so identity stays stable.
  interface ReplayTurn {
    nativeTurnId: string;
    user: ReplayMessage | null;
    assistants: ReplayMessage[];
    anchorTime: unknown;
  }
  const turns: ReplayTurn[] = [];
  const userToTurn = new Map<string, ReplayTurn>();
  for (const raw of context.messages) {
    const message = raw as ReplayMessage;
    const role = message.info?.role;
    const messageId = message.info?.messageId ?? message.info?.id ?? '';
    if (role === 'user') {
      const turn: ReplayTurn = {
        nativeTurnId: messageId || `turn-${turns.length}`,
        user: message,
        assistants: [],
        anchorTime: message.info?.time?.created,
      };
      turns.push(turn);
      if (messageId !== '') userToTurn.set(messageId, turn);
      continue;
    }
    if (role === 'assistant') {
      const parent = typeof message.info?.parentMessageId === 'string' ? message.info.parentMessageId : '';
      const host = parent !== '' ? userToTurn.get(parent) : undefined;
      if (host !== undefined) {
        host.assistants.push(message);
      } else {
        // Assistant without a known parent: its own synthetic turn.
        const anchorTurnId = readAnchorTurnId(message);
        turns.push({
          nativeTurnId: anchorTurnId ?? (messageId || `turn-${turns.length}`),
          user: null,
          assistants: [message],
          anchorTime: message.info?.time?.created,
        });
      }
    }
  }

  for (const turn of turns) {
    // Native turn identity: a timeline part anchorTurnId wins (stable across
    // live and replay), else the first assistant message id.
    const anchorTurnId = turn.assistants.map(readAnchorTurnId).find((id) => id !== null) ?? null;
    if (anchorTurnId !== null) turn.nativeTurnId = anchorTurnId;
    const sourceTurnId = turn.nativeTurnId;
    const allMessages = [...(turn.user !== null ? [turn.user] : []), ...turn.assistants];
    const lastTime = allMessages.at(-1)?.info?.time?.created;
    const base = (): Record<string, unknown> => ({
      eventId: '',
      sessionId: context.gianSessionId,
      streamId: context.streamId,
      sequence: 0,
      sourceTurnId,
      emittedAt: emittedAt(turn.anchorTime),
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
      event.emittedAt = emittedAt(time ?? turn.anchorTime);
      event.data = data;
      events.push(event);
    };

    push('turn.started', [sourceTurnId, 'started'], {}, turn.anchorTime);

    for (const message of allMessages) {
      const messageId = message.info?.messageId ?? message.info?.id ?? '';
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
          }, message.info?.time?.created);
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
            status: state.status === 'failed' || state.status === 'error' ? 'failed' : state.status === 'cancelled' ? 'cancelled' : 'succeeded',
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
          continue;
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

    push(
      'turn.completed',
      [sourceTurnId, 'terminal'],
      { stopReason: 'completed' },
      lastTime,
      terminalEventIdFor(context.nativeSessionId, sourceTurnId, 'turn.completed'),
    );
  }

  return events;
}

function readAnchorTurnId(message: ReplayMessage): string | null {
  for (const part of message.parts ?? []) {
    if (part.type === 'timeline' && typeof part.anchorTurnId === 'string' && part.anchorTurnId !== '') {
      return part.anchorTurnId;
    }
  }
  return null;
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
