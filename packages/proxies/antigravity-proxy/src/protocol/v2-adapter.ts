import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import type { InitializeResponse, ListSessionsResponse, SessionConfigOption } from '@agentclientprotocol/sdk';
import { proxyNotificationSchema } from '@gian/proxy-protocol';

import type {
  AntigravityService, ConfigValues, JsonRecord, ProjectionContext,
  ServiceEvent, ServiceSession,
} from '../contracts.js';
import { coldModeOption, resolveConfigValues, toGianConfigOptions, validateConfigValues } from '../core/catalog.js';
import { completeTurnProjection, createProjectionContext, projectSessionUpdate } from '../core/events.js';
import { normalizeInputItems } from '../core/input.js';
import { redactRuntimeData, toAcpMcpServers } from '../core/mcp.js';
import {
  AntigravityCliModels,
  AntigravityCliModelsError,
  type AntigravityCliHelperIdentity,
  type AntigravityCliModelsFailure,
  type AntigravityCliModelOption,
  type AntigravityCliModelsOptions,
} from '../runtime/cli-models.js';
import { discoverAntigravityRuntimes, probeAntigravityRuntime } from '../runtime/discover.js';
import { planRuntimeInstallation } from '../runtime/install.js';
import { ProtocolError, RpcError, standardError, type WireRequest } from '../transport/protocol.js';

const PLUGIN_ID = 'io.gian.antigravity';
const MAX_LEDGER_ENTRIES = 10_000;
const MAX_QUEUED_NOTIFICATIONS = 4096;
/** Successful non-empty CLI catalogs only. Failures are not cached. */
export const ANTIGRAVITY_COLD_CATALOG_TTL_MS = 30_000;
const CATALOG_CLOSED = 'Antigravity catalog is closed.';
const SERVICE_CLOSING = 'The Antigravity service is closing. No session or turn was admitted and the prompt was not sent.';
type Sink = (method: string, params: JsonRecord) => void;

interface AttachedSession {
  id: string;
  streamId: string;
  sequence: number;
  config: ConfigValues;
  createFingerprint: string;
  record: ServiceSession | null;
  turns: Map<string, { fingerprint: string; outcome: Promise<{ accepted: true; turnId: string }> }>;
  responses: Map<string, string>;
  projection: ProjectionContext | null;
  admission: { turnId: string; events: ServiceEvent[] } | null;
}

interface PendingNotification {
  method: string;
  params: JsonRecord;
  waitsFor: Set<symbol>;
}

export interface AntigravityProtocolV2AdapterOptions {
  cliModels?: AntigravityCliModelsOptions;
  catalogTtlMs?: number;
  now?: () => number;
  /** Test sequencing after a warm helper recheck, before the closed-catalog recheck. */
  afterHelperCheck?: () => Promise<void> | void;
}

interface ColdCatalog {
  fetchedAt: number;
  helper: AntigravityCliHelperIdentity;
  native: SessionConfigOption[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new RpcError(-32602, `${name} is required.`);
  return value;
}

function stopReason(reason: string): string {
  switch (reason) {
    case 'end_turn': return 'completed';
    case 'cancelled': return 'cancelled';
    case 'max_tokens':
    case 'max_turn_requests': return 'limit_reached';
    case 'refusal': return 'refused';
    default: return 'other';
  }
}

export class AntigravityProtocolV2Adapter {
  private initialized = false;
  private negotiated: InitializeResponse | null = null;
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly interactions = new Map<string, { sessionId: string; turnId: string; options: Set<string> }>();
  private readonly barriers = new Map<string, Set<symbol>>();
  private readonly activeBarriers = new Set<symbol>();
  private readonly outboxes = new Map<string, PendingNotification[]>();
  private readonly nativePages = new Map<string, {
    cwd: string | undefined; remaining: ListSessionsResponse['sessions']; upstream: string | undefined;
  }>();
  private readonly cliModels: AntigravityCliModels;
  private readonly catalogTtlMs: number;
  private readonly now: () => number;
  private readonly afterHelperCheck: () => Promise<void> | void;
  private cold: ColdCatalog | null = null;
  private coldInflight: Promise<SessionConfigOption[]> | null = null;
  private closePromise: Promise<void> | null = null;
  private catalogClosed = false;
  private fatalError: ProtocolError | null = null;

  constructor(
    private readonly service: AntigravityService,
    private readonly pluginVersion: string,
    private readonly sink: Sink,
    options: AntigravityProtocolV2AdapterOptions = {},
  ) {
    this.cliModels = new AntigravityCliModels(options.cliModels ?? {});
    this.catalogTtlMs = requireCatalogTtl(options.catalogTtlMs);
    this.now = options.now ?? (() => Date.now());
    this.afterHelperCheck = options.afterHelperCheck ?? (() => undefined);
    service.setEventSink(event => this.consumeServiceEvent(event));
  }

  private consumeServiceEvent(event: ServiceEvent): void {
    if (this.fatalError) return;
    try { this.onServiceEvent(event); }
    catch {
      this.fatalError = new ProtocolError('RUNTIME_ERROR', 'Antigravity produced an invalid or oversized event; the runtime is being retired.');
      this.emit('runtime.error', undefined, undefined, {
        domainCode: 'RUNTIME_ERROR', message: this.fatalError.message, retryable: false, details: {},
      });
      void this.close().catch(() => {
        this.emit('runtime.error', undefined, undefined, {
          domainCode: 'RUNTIME_ERROR', message: 'Antigravity runtime cleanup could not be confirmed.', retryable: false, details: {},
        });
      });
    }
  }

  /** A notification waits for every in-flight response in its own scope, not
   * for unrelated sessions. Cancellation/approval can overtake a prompt. */
  async dispatch(
    request: WireRequest,
    respond: (result: unknown, error?: unknown) => void,
  ): Promise<void> {
    const scope = typeof request.params.sessionId === 'string' ? request.params.sessionId : '';
    const token = Symbol(request.id);
    const barriers = this.barriers.get(scope) ?? new Set<symbol>();
    barriers.add(token);
    this.barriers.set(scope, barriers);
    this.activeBarriers.add(token);
    try {
      const result = await this.handle(request);
      if (this.fatalError && request.method !== 'shutdown' && request.method !== 'turn.start') throw this.fatalError;
      respond(result);
    } catch (error) {
      respond(undefined, error);
    } finally {
      barriers.delete(token);
      this.activeBarriers.delete(token);
      if (barriers.size === 0) this.barriers.delete(scope);
      this.flushNotifications();
    }
  }

  async handle(request: WireRequest): Promise<unknown> {
    const p = request.params;
    if (this.fatalError && request.method !== 'shutdown') throw this.fatalError;
    if (this.catalogClosed && request.method !== 'shutdown') {
      throw new ProtocolError('RUNTIME_UNAVAILABLE', SERVICE_CLOSING);
    }
    if (!this.initialized && request.method !== 'initialize' && request.method !== 'shutdown') {
      throw new ProtocolError('NOT_INITIALIZED', 'initialize must be the first request.');
    }
    switch (request.method) {
      case 'initialize': return this.initialize(p);
      case 'catalog.list': return this.listColdCatalog();
      case 'catalog.resolve': return this.resolveCatalog(p);
      case 'session.create': return this.createSession(p);
      case 'session.get': return { session: this.snapshot(this.requireSession(text(p.sessionId, 'sessionId'))) };
      case 'turn.start': return this.startTurn(p);
      case 'turn.interrupt': {
        const session = this.requireStream(p);
        const turnId = text(p.turnId, 'turnId');
        await this.service.interruptTurn(session.id, turnId);
        return { accepted: true, turnId };
      }
      case 'interaction.respond': return this.respondInteraction(p);
      case 'session.close': {
        const session = this.requireStream(p);
        await this.service.closeSession(session.id);
        return { ok: true };
      }
      case 'session.native.list': return this.listNativeSessions(p);
      case 'runtime.discover': return discoverAntigravityRuntimes();
      case 'runtime.probe': return probeAntigravityRuntime(text(p.path, 'path'));
      case 'runtime.install.plan': return planRuntimeInstallation(p as Parameters<typeof planRuntimeInstallation>[0]);
      case 'shutdown': return this.shutdown();
      default: throw new ProtocolError('CAPABILITY_NOT_SUPPORTED', `${request.method} is not supported.`);
    }
  }

  private async initialize(params: JsonRecord) {
    if (this.initialized) throw new ProtocolError('ALREADY_INITIALIZED', 'Proxy is already initialized.');
    const offered = record(params.protocol);
    const versions = Array.isArray(offered.versions) ? offered.versions : [];
    const version = versions.includes('2.3') ? '2.3' : versions.includes('2.2') ? '2.2' : null;
    if (offered.name !== 'gian.proxy' || !version) {
      throw new ProtocolError('INCOMPATIBLE_PROTOCOL', 'Antigravity requires gian.proxy 2.2 or 2.3.');
    }
    this.negotiated = await this.service.initialize();
    this.initialized = true;
    return {
      protocol: { name: 'gian.proxy', version },
      plugin: { id: PLUGIN_ID, name: 'Antigravity', version: this.pluginVersion },
      process: { scope: 'shared' },
      capabilities: {
        'catalog.resolve': 1, 'catalog.modeSemantics': 1,
        interaction: 1, 'event.reasoning': 1, 'event.plan': 1, 'event.usage': 1,
        'runtime.discover': 1, 'runtime.probe': 1, 'runtime.install.plan': 1,
        ...(this.negotiated.agentCapabilities?.mcpCapabilities?.http ? { 'integration.mcp.streamableHttp': 1 } : {}),
        ...(this.negotiated.agentCapabilities?.sessionCapabilities?.list ? { 'session.native.list': 1 } : {}),
      },
    };
  }

  private catalog(native: SessionConfigOption[], values: ConfigValues = {}) {
    const internalOptions = toGianConfigOptions(native, values);
    const specialCatalogs: Record<string, string> = {};
    for (const option of internalOptions) {
      if (option.role === 'model') specialCatalogs.model = option.id;
      else if (option.role === 'effort' || option.role === 'thinking') specialCatalogs.thinking = option.id;
      else if (option.role === 'approval_mode') specialCatalogs.approvalMode = option.id;
    }
    // Gian 2.2/2.3 uses specialCatalogs, never the legacy wire role field.
    const configOptions = internalOptions.map(({ role: _role, ...option }) => option);
    return {
      // Resolution changes dependent choices, not the underlying advertisement.
      // Native updates (including currentValue) still invalidate the fence.
      catalogRevision: fingerprint({ native, projection: 'family-thinking-v1' }),
      input: [{ type: 'text' }], configOptions, specialCatalogs, slashCommands: [],
    };
  }

  private listColdCatalog() {
    return this.coldCatalog().then((native) => this.catalog(native));
  }

  private coldCatalog(): Promise<SessionConfigOption[]> {
    if (this.catalogClosed) return Promise.reject(new ProtocolError('CANCELLED', CATALOG_CLOSED));
    if (this.coldInflight) return this.coldInflight;
    const run = this.loadColdCatalog();
    const wrapped = run.finally(() => {
      if (this.coldInflight === wrapped) this.coldInflight = null;
    });
    this.coldInflight = wrapped;
    return wrapped;
  }

  private async loadColdCatalog(): Promise<SessionConfigOption[]> {
    if (this.catalogClosed) throw new ProtocolError('CANCELLED', CATALOG_CLOSED);
    const cached = this.cold;
    if (cached !== null && this.now() - cached.fetchedAt < this.catalogTtlMs) {
      let matches = false;
      try {
        matches = await this.helperStillCurrent(cached.helper);
      } catch (error) {
        this.cold = null;
        if (this.catalogClosed) throw new ProtocolError('CANCELLED', CATALOG_CLOSED);
        throw this.catalogFailure(error);
      }
      await this.afterHelperCheck();
      if (this.catalogClosed) {
        this.cold = null;
        throw new ProtocolError('CANCELLED', CATALOG_CLOSED);
      }
      if (matches) return cached.native;
      this.cold = null;
    } else if (cached !== null) {
      this.cold = null;
    }
    if (this.catalogClosed) throw new ProtocolError('CANCELLED', CATALOG_CLOSED);
    try {
      const result = await this.cliModels.list();
      if (this.catalogClosed) {
        this.cold = null;
        throw new ProtocolError('CANCELLED', CATALOG_CLOSED);
      }
      if (result.models.length === 0) throw new AntigravityCliModelsError('models_unavailable');
      const native = coldModelOptions(result.models);
      this.cold = { fetchedAt: this.now(), helper: result.helper, native };
      return native;
    } catch (error) {
      this.cold = null;
      if (this.catalogClosed && !(error instanceof ProtocolError)) {
        throw new ProtocolError('CANCELLED', CATALOG_CLOSED);
      }
      throw this.catalogFailure(error);
    }
  }

  private async helperStillCurrent(previous: AntigravityCliHelperIdentity): Promise<boolean> {
    await this.cliModels.assertDefaultHome();
    const current = await this.cliModels.resolveSelectedHelper();
    if (current === null) return false;
    return current.path === previous.path
      && current.source === previous.source
      && current.dev === previous.dev
      && current.ino === previous.ino
      && current.size === previous.size
      && current.mtimeMs === previous.mtimeMs;
  }

  private catalogFailure(error: unknown): Error {
    if (error instanceof ProtocolError) return error;
    if (error instanceof AntigravityCliModelsError) {
      return new ProtocolError(error.domainCode, error.message, false, {
        reason: catalogQueryReason(error.failure),
      });
    }
    return error instanceof Error
      ? error
      : new ProtocolError('RUNTIME_ERROR', 'Antigravity CLI model query failed.');
  }

  private async resolveCatalog(params: JsonRecord) {
    const session = params.sessionId ? this.requireStream(params) : null;
    const native = session ? this.sessionOptions(session) : await this.coldCatalog();
    const nativeRevision = this.catalog(native).catalogRevision;
    // Generic session clients may resolve with their process catalog fence.
    // Accept only the latest issued cold fence or this session's exact fence;
    // either way, validate/project against the live native advertisement.
    const coldRevision = session && this.cold ? this.catalog(this.cold.native).catalogRevision : null;
    if (params.catalogRevision !== nativeRevision && (coldRevision === null || params.catalogRevision !== coldRevision)) {
      throw new ProtocolError('CONFLICT', 'Catalog changed; refresh its options before resolving.');
    }
    const sessionConfig = omitClearedModel(native, record(params.sessionConfig) as ConfigValues);
    const turnConfig = omitClearedModel(native, record(params.turnConfig) as ConfigValues);
    this.validateBinding(native, sessionConfig, 'session', true);
    this.validateBinding(native, turnConfig, 'turn', true);
    const resolvedSession = resolveConfigValues(native, sessionConfig);
    const resolvedTurn = resolveConfigValues(native, turnConfig);
    const catalog = this.catalog(native, { ...sessionConfig, ...turnConfig });
    const sessionDefaults: ConfigValues = {};
    const turnDefaults: ConfigValues = {};
    for (const option of catalog.configOptions) {
      if (option.defaultValue === null) continue;
      (option.binding === 'session' ? sessionDefaults : turnDefaults)[option.id] = option.defaultValue;
    }
    return { ...catalog, resolvedDefaults: {
      sessionConfig: { ...sessionDefaults, ...resolvedSession }, turnConfig: { ...turnDefaults, ...resolvedTurn },
    } };
  }

  private sessionOptions(session: AttachedSession): SessionConfigOption[] {
    if (!session.record) throw new ProtocolError('SESSION_NOT_FOUND', 'Session is not attached.');
    return session.record.configOptions;
  }

  private validateBinding(native: SessionConfigOption[], values: ConfigValues, binding: 'session' | 'turn', resolving = false): void {
    if (resolving) resolveConfigValues(native, values);
    else validateConfigValues(native, values);
    const options = toGianConfigOptions(native, values);
    for (const id of Object.keys(values)) {
      if (options.find(option => option.id === id)?.binding !== binding) {
        throw new ProtocolError('CONFIG_BINDING_INVALID', `Config option ${id} does not bind to ${binding}.`);
      }
    }
  }

  private async createSession(params: JsonRecord) {
    const id = text(params.sessionId, 'sessionId');
    const workspace = record(params.workspace);
    const cwd = text(workspace.cwd, 'workspace.cwd');
    if (!isAbsolute(cwd) || cwd.includes('\0') || !Array.isArray(workspace.roots) || workspace.roots.length === 0
      || workspace.roots.some(root => typeof root !== 'string' || !isAbsolute(root) || root.includes('\0'))) {
      throw new RpcError(-32602, 'workspace.cwd and workspace.roots must be absolute paths without NUL bytes; roots must be non-empty.');
    }
    // Roots describe context, not permissions. ACP receives cwd only; extra
    // roots (including Gian attachments) do not change native mode or grants.
    const native = record(params.nativeSession);
    if (native.history === 'replay') {
      throw new ProtocolError('CAPABILITY_NOT_SUPPORTED', 'Native history import is not advertised by this Proxy.');
    }
    const signature = fingerprint(params);
    const existing = this.sessions.get(id);
    if (existing) {
      const canReattach = existing.record
        && (existing.record.state === 'stale' || existing.record.state === 'closed')
        && native.id === existing.record.nativeSessionId
        && resolve(cwd) === resolve(existing.record.cwd);
      if (!canReattach) {
        if (existing.record?.state === 'stale') throw new ProtocolError('SESSION_STALE', 'Reattach with the exact native session id before continuing.');
        if (existing.createFingerprint !== signature) throw new ProtocolError('CONFLICT', 'Session id was reused with different creation parameters.');
        return { session: this.snapshot(existing) };
      }
      this.outboxes.delete(id);
      for (const [interactionId, interaction] of this.interactions) {
        if (interaction.sessionId === id) this.interactions.delete(interactionId);
      }
      this.negotiated = await this.service.initialize();
    }
    const mcpServers = toAcpMcpServers(params.hostServices ?? []);
    if (mcpServers.length && !this.negotiated?.agentCapabilities?.mcpCapabilities?.http) {
      throw new ProtocolError('CAPABILITY_NOT_SUPPORTED', 'Runtime did not advertise HTTP MCP.');
    }
    const session: AttachedSession = {
      id, streamId: randomUUID(), sequence: 0, config: omitNullKey(record(params.config) as ConfigValues, 'model'),
      createFingerprint: signature, record: null, turns: new Map(), responses: new Map(), projection: null, admission: null,
    };
    this.sessions.set(id, session);
    try {
      session.record = await this.service.createSession({
        sessionId: id, cwd, config: session.config, mcpServers,
        ...(typeof native.id === 'string' ? { nativeSessionId: native.id, resumeMode: 'resume' as const } : {}),
      });
      return { session: this.snapshot(session) };
    } catch (error) {
      this.sessions.delete(id);
      this.outboxes.delete(id);
      throw error;
    }
  }

  private async startTurn(params: JsonRecord) {
    const session = this.requireStream(params);
    const turnId = text(params.turnId, 'turnId');
    const signature = fingerprint({ input: params.input, config: params.config });
    const previous = session.turns.get(turnId);
    if (previous !== undefined) {
      if (previous.fingerprint !== signature) throw new ProtocolError('CONFLICT', 'Turn id was reused with different input.');
      return previous.outcome;
    }
    if (session.turns.size >= MAX_LEDGER_ENTRIES) throw new ProtocolError('RUNTIME_ERROR', 'Session turn ledger is full; reattach before continuing.');
    if (session.projection) throw new ProtocolError('SESSION_BUSY', 'A turn is already active in this session.');
    const prompt = normalizeInputItems(params.input);
    const config = this.turnConfig(session.record?.configOptions ?? [], record(params.config) as ConfigValues);
    session.projection = createProjectionContext(session.id, turnId);
    session.admission = { turnId, events: [] };
    const outcome = Promise.resolve().then(async () => {
      await this.service.startTurn({ sessionId: session.id, turnId, prompt, config });
      const early = session.admission?.events ?? [];
      session.admission = null;
      this.emit('turn.started', session, turnId, {});
      for (const event of early) this.consumeServiceEvent(event);
      return { accepted: true as const, turnId };
    }).catch(error => {
      session.admission = null;
      if (session.projection?.turnId === turnId) session.projection = null;
      if (session.record) this.consumeServiceEvent({ kind: 'session.changed', session: session.record });
      // Retain the rejected outcome as well as the fingerprint. A duplicate
      // must neither execute again nor falsely report successful acceptance.
      throw error;
    });
    session.turns.set(turnId, { fingerprint: signature, outcome });
    return outcome;
  }

  private turnConfig(native: SessionConfigOption[], config: ConfigValues): ConfigValues {
    const supplied = omitClearedModel(native, config);
    this.validateBinding(native, supplied, 'turn');
    const model = toGianConfigOptions(native).find((option) => option.role === 'model');
    if (!model) {
      throw new ProtocolError('CONFIG_REQUIRED', 'Choose an advertised Gemini model before sending a prompt.');
    }
    if (!Object.hasOwn(supplied, model.id)) {
      if (typeof model.defaultValue !== 'string' || !model.defaultValue.startsWith('gemini')) {
        throw new ProtocolError('CONFIG_REQUIRED', 'Choose an advertised Gemini model before sending a prompt.');
      }
      return supplied;
    }
    const explicit = supplied[model.id];
    if (typeof explicit !== 'string' || !explicit.startsWith('gemini')) {
      throw new ProtocolError('CONFIG_REQUIRED', 'Choose an advertised Gemini model before sending a prompt.');
    }
    return supplied;
  }

  /**
   * Idempotent retirement. Blocks new requests, aborts the CLI helper,
   * then runs the service close. RPC shutdown and process exit share this promise.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.catalogClosed = true;
    this.cold = null;
    this.closePromise = this.shutdownOwned();
    return this.closePromise;
  }

  private async shutdownOwned(): Promise<void> {
    this.catalogClosed = true;
    this.cold = null;
    let helperError: unknown;
    try {
      await this.cliModels.stop();
    } catch (error) {
      helperError = error;
    }
    await this.service.close();
    if (helperError !== undefined) throw this.catalogFailure(helperError);
  }

  private async shutdown(): Promise<{ ok: true }> {
    await this.close();
    return { ok: true };
  }

  private respondInteraction(params: JsonRecord) {
    const session = this.requireStream(params);
    const interactionId = text(params.interactionId, 'interactionId');
    const responseId = text(params.responseId, 'responseId');
    const signature = fingerprint(params);
    const previous = session.responses.get(responseId);
    if (previous !== undefined) {
      if (previous !== signature) throw new ProtocolError('CONFLICT', 'Response id was reused with different input.');
      return { accepted: true, interactionId, responseId };
    }
    const interaction = this.interactions.get(interactionId);
    if (!interaction || interaction.sessionId !== session.id || interaction.turnId !== params.turnId) {
      throw new ProtocolError('INTERACTION_NOT_FOUND', 'Interaction is not active in this session and turn.');
    }
    const optionId = text(params.actionId, 'actionId');
    if (!interaction.options.has(optionId) || Object.keys(record(params.values)).length) {
      throw new ProtocolError('INTERACTION_ACTION_NOT_FOUND', 'Only an advertised permission option can be selected.');
    }
    if (session.responses.size >= MAX_LEDGER_ENTRIES) throw new ProtocolError('RUNTIME_ERROR', 'Interaction response ledger is full.');
    this.service.respondPermission({ sessionId: session.id, interactionId, optionId });
    session.responses.set(responseId, signature);
    return { accepted: true, interactionId, responseId };
  }

  private async listNativeSessions(params: JsonRecord) {
    if (!this.negotiated?.agentCapabilities?.sessionCapabilities?.list) {
      throw new ProtocolError('CAPABILITY_NOT_SUPPORTED', 'Runtime does not advertise native session listing.');
    }
    const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
    const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
    const page = cursor ? this.nativePages.get(cursor) : undefined;
    if (cursor && (!page || page.cwd !== cwd)) {
      throw new ProtocolError('CONFLICT', 'Native session cursor expired or belongs to a different workspace; restart listing.');
    }
    const limit = typeof params.limit === 'number' ? params.limit : 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RpcError(-32602, 'limit must be between 1 and 500.');
    const result: ListSessionsResponse = page?.remaining.length ? {
      sessions: page.remaining,
      ...(page.upstream ? { nextCursor: page.upstream } : {}),
    } : await this.service.listNativeSessions({
      ...(cwd ? { cwd } : {}),
      ...(page?.upstream ? { cursor: page.upstream } : {}),
    });
    const remaining = result.sessions.slice(limit);
    let nextCursor: string | null = null;
    if (remaining.length || result.nextCursor) {
      nextCursor = randomUUID();
      // ACP controls native page size. Preserve overflow behind an opaque,
      // bounded Proxy cursor rather than dropping rows to honor Host's limit.
      if (this.nativePages.size >= 128) this.nativePages.delete(this.nativePages.keys().next().value!);
      this.nativePages.set(nextCursor, { cwd, remaining, upstream: result.nextCursor ?? undefined });
    }
    return {
      sessions: result.sessions.slice(0, limit).map(item => ({
        id: item.sessionId,
        ...(item.title ? { displayName: item.title } : {}),
        ...(item.cwd ? { cwd: item.cwd } : {}),
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
      })),
      nextCursor,
    };
  }

  private requireSession(id: string): AttachedSession {
    const session = this.sessions.get(id);
    if (!session) throw new ProtocolError('SESSION_NOT_FOUND', 'Session is not attached.');
    return session;
  }

  private requireStream(params: JsonRecord): AttachedSession {
    const session = this.requireSession(text(params.sessionId, 'sessionId'));
    if (session.streamId !== params.streamId) throw new ProtocolError('SESSION_STALE', 'Session stream has changed.');
    return session;
  }

  private snapshot(session: AttachedSession) {
    const current = session.record ?? this.service.getSession(session.id);
    const catalog = this.catalog(current.configOptions);
    return {
      id: session.id, nativeSession: { id: current.nativeSessionId }, streamId: session.streamId,
      state: current.state, sessionConfig: session.config,
      lastError: current.lastError === null ? null : String(redactRuntimeData(current.lastError)),
      turnConfigOptions: catalog.configOptions, turnConfigRevision: catalog.catalogRevision,
      createdAt: current.createdAt, updatedAt: current.updatedAt,
    };
  }

  private onServiceEvent(event: ServiceEvent): void {
    if (event.kind === 'runtime.stopped') {
      if (!event.event.expected || event.event.error) this.emit('runtime.error', undefined, undefined, {
        domainCode: 'RUNTIME_UNAVAILABLE',
        message: event.event.error && event.event.expected
          ? 'Antigravity runtime cleanup failed; resource ownership is uncertain.'
          : 'Antigravity ACP disconnected; active prompt outcomes may be uncertain.',
        retryable: !event.event.expected,
        details: {},
      });
      return;
    }
    const sessionId = event.kind === 'session.changed' ? event.session.id : event.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // An ACP reverse request can precede the dispatch acknowledgment. Hold
    // its events until admission, then publish turn.started first. This also
    // avoids emitting a lifecycle for a rejected turn.start request.
    if (session.admission) {
      if (event.kind === 'session.changed') session.record = event.session;
      if (event.kind !== 'turn.started') {
        if (session.admission.events.length >= MAX_QUEUED_NOTIFICATIONS) {
          throw new ProtocolError('RUNTIME_ERROR', 'Turn admission event buffer overflow.');
        }
        session.admission.events.push(event);
      }
      return;
    }
    if (event.kind === 'session.changed') {
      session.record = event.session;
      const catalog = this.catalog(event.session.configOptions);
      this.emit('session.updated', session, undefined, {
        nativeSession: { id: event.session.nativeSessionId }, state: event.session.state,
        lastError: event.session.lastError, updatedAt: event.session.updatedAt,
        turnConfigOptions: catalog.configOptions, turnConfigRevision: catalog.catalogRevision,
      });
      return;
    }
    if (event.kind === 'native.update') {
      if (event.replay || !event.turnId || session.projection?.turnId !== event.turnId) return;
      for (const draft of projectSessionUpdate(event.notification.update, session.projection)) {
        this.emit(draft.method, session, event.turnId, draft.data);
      }
      return;
    }
    if (event.kind === 'permission.requested') {
      this.interactions.set(event.interactionId, {
        sessionId, turnId: event.turnId, options: new Set(event.request.options.map(option => option.optionId)),
      });
      // Host InteractionKindRegistry keys this map by session + interaction.
      // The resolved event carries only the opaque actionId, so a missing kind
      // cannot be recovered later. Pass the native ACP kind through unchanged.
      const permissionOptionKinds: Record<string, string> = {};
      for (const option of event.request.options) {
        if (option.optionId && option.kind) permissionOptionKinds[option.optionId] = option.kind;
      }
      this.emit('interaction.requested', session, event.turnId, {
        interactionId: event.interactionId, title: event.request.toolCall.title,
        presentation: { kind: 'permission', tone: 'warning' }, inputs: [],
        actions: event.request.options.map(option => ({
          id: option.optionId, label: option.name,
          style: option.kind.startsWith('reject') ? 'danger' : 'primary',
        })),
        context: {
          toolCall: redactRuntimeData(event.request.toolCall),
          ...(Object.keys(permissionOptionKinds).length > 0 ? { permissionOptionKinds } : {}),
        },
      });
      return;
    }
    if (event.kind === 'permission.resolved') {
      this.interactions.delete(event.interactionId);
      this.emit('interaction.resolved', session, event.turnId, {
        interactionId: event.interactionId, outcome: event.outcome,
        ...(event.outcome === 'submitted' && event.optionId ? { actionId: event.optionId } : {}),
      });
      return;
    }
    if (event.kind === 'turn.started') {
      return;
    }
    if (session.projection?.turnId === event.turnId) {
      const outcome = event.kind === 'turn.failed' ? 'failed'
        : event.response.stopReason === 'cancelled' ? 'cancelled' : 'completed';
      for (const draft of completeTurnProjection(session.projection, outcome)) this.emit(draft.method, session, event.turnId, draft.data);
      session.projection = null;
    }
    if (event.kind === 'turn.completed') {
      this.emit('turn.completed', session, event.turnId, { stopReason: stopReason(event.response.stopReason) });
    } else if (event.kind === 'turn.failed') {
      const error = standardError(event.error);
      const details = record(error.data);
      this.emit('turn.failed', session, event.turnId, {
        error: {
          domainCode: details.domainCode, message: error.message, retryable: details.retryable === true,
          details: record(details.details),
        },
      });
    }
  }

  private emit(method: string, session: AttachedSession | undefined, turnId: string | undefined, data: JsonRecord) {
    const params: JsonRecord = {
      eventId: randomUUID(), emittedAt: new Date().toISOString(), data: redactRuntimeData(data),
      ...(session ? { sessionId: session.id, streamId: session.streamId, sequence: session.sequence + 1 } : {}),
      ...(turnId ? { turnId, sourceTurnId: turnId } : {}),
    };
    const parsed = proxyNotificationSchema.safeParse({ jsonrpc: '2.0', method, params });
    if (!parsed.success) throw new ProtocolError('RUNTIME_ERROR', `Invalid projected ${method} notification.`);
    if (session) session.sequence += 1;
    const scope = session?.id ?? '';
    const waitsFor = new Set([...(this.barriers.get(scope) ?? []), ...(this.barriers.get('') ?? [])]);
    const queue = this.outboxes.get(scope) ?? [];
    if (queue.length >= MAX_QUEUED_NOTIFICATIONS) throw new ProtocolError('RUNTIME_ERROR', 'Notification barrier overflow.');
    queue.push({ method, params, waitsFor });
    this.outboxes.set(scope, queue);
    this.flushNotifications();
  }

  private flushNotifications(): void {
    for (const [scope, queue] of this.outboxes) {
      while (queue.length) {
        const next = queue[0]!;
        if ([...next.waitsFor].some(token => this.activeBarriers.has(token))) break;
        queue.shift();
        this.sink(next.method, next.params);
      }
      if (!queue.length) this.outboxes.delete(scope);
    }
  }
}

function omitClearedModel(native: SessionConfigOption[], config: ConfigValues): ConfigValues {
  const modelId = toGianConfigOptions(native).find((option) => option.role === 'model')?.id ?? null;
  return omitNullKey(config, modelId);
}

/** Drop only an explicit clear of the known model id. Other nulls stay invalid. */
function omitNullKey(config: ConfigValues, key: string | null): ConfigValues {
  if (key === null || !Object.hasOwn(config, key) || config[key] !== null) return config;
  const next: ConfigValues = { ...config };
  delete next[key];
  return next;
}

function coldModelOptions(models: readonly AntigravityCliModelOption[]): SessionConfigOption[] {
  const option = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select' as const,
    options: models.map((model) => ({ value: model.id, name: model.label })),
  };
  return [option as SessionConfigOption, coldModeOption()];
}

/** Fixed operational token for JSON-RPC `data.details.reason`. Not display copy. */
function catalogQueryReason(failure: AntigravityCliModelsFailure): string {
  switch (failure) {
    case 'home_not_default':
      return 'home_unsupported';
    case 'helper_missing':
    case 'models_unavailable':
    case 'invalid_response':
    case 'query_failed':
    case 'timeout':
    case 'output_limit':
    case 'cancelled':
    case 'cleanup_failed':
    case 'busy':
      return failure;
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function requireCatalogTtl(value: number | undefined): number {
  const ttl = value ?? ANTIGRAVITY_COLD_CATALOG_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1) {
    throw new ProtocolError('RUNTIME_ERROR', 'Antigravity catalog options are invalid.');
  }
  return ttl;
}
