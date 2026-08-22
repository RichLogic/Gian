/**
 * Real Cordis host adapter for the bridge.
 *
 * Compiles without the DSH packages being declared as dependencies: the bridge
 * is mounted *inside* a composed DSH profile, where `ctx` already carries the
 * services below. Every DSH surface this file touches was frozen by the WP0
 * probe against `@deepseek-ai/dsh@0.1.0-rc.7`.
 *
 * - `ctx.agents` (AgentRegistry): `create/resume/get/roots/list`
 * - `Agent`: `id/status/session`, `send/followup/steer/inject/cancel/whenIdle`
 * - `session/event`, `agent/status`, `agent/error`, `agent/inbox/*`
 * - `ctx.userQuestions.registerProvider/ask`
 * - `ctx.sessionPersistence.list/inspect/prepare/readFrom`
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { BridgeWriter } from './jsonrpc.js';
import { BridgeServer } from './server.js';
import { DSH_SESSION_FORMAT_VERSION, type BridgeJsonValue } from './schema.js';
import type {
  BridgeHost,
  BridgeHostEvent,
  BridgeSessionCreateParams,
  BridgeTurnStartParams,
} from './host.js';

interface CordisSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

interface CordisSession {
  id: string;
  header?: { createdAt?: number };
  events?: readonly CordisSessionEvent[];
}

interface CordisAgent {
  id: string;
  status: 'idle' | 'running';
  session: CordisSession;
  cancel(cause: { kind: 'user' | 'disposed' }): void;
  whenIdle(): Promise<void>;
  followup(message: Record<string, unknown>): void;
  steer(message: Record<string, unknown>): void;
}

interface CordisAgentHandle {
  agent: CordisAgent;
  dispose(): Promise<void>;
}

interface CordisAgentRegistry {
  create(options: {
    sessionId: string;
    meta: { cwd: string };
    agentOptions?: { provider?: string; model?: string };
  }): Promise<CordisAgentHandle>;
}

interface CordisLlmRuntime {
  listProviders(): Array<{ id: string; name?: string }>;
  listModels(provider: string): Promise<Array<{ id: string; provider?: string; name?: string; description?: string }>>;
}

type AnyContext = {
  [key: string]: unknown;
  get?: (name: string) => unknown;
  on?: (name: string, listener: (session: unknown, event: unknown) => void) => () => boolean;
  agents?: CordisAgentRegistry;
  llm?: CordisLlmRuntime;
  appExit?: (code: number) => void;
  effect?: (
    callback: () => (() => Promise<void>),
    label?: string,
  ) => unknown;
};

interface CordisHostOptions {
  ctx: AnyContext;
  bridgeVersion?: string;
  stdin?: typeof process.stdin;
  stdout?: typeof process.stdout;
}

/**
 * Bind the bridge server onto a live DSH Cordis context. Returns a disposer.
 * When the `stdio` config row is falsy, wiring is a no-op (used in tests).
 */
export function mountBridge(options: CordisHostOptions): () => Promise<void> {
  const writer = new BridgeWriter(options.stdout ?? process.stdout);
  const host = new CordisDshHost(options.ctx, options.bridgeVersion ?? '0.1.0');
  const server = new BridgeServer({ host, writer });
  const input = options.stdin ?? process.stdin;

  let disposed = false;
  const run = async () => {
    const { runBridgeInput } = await import('./jsonrpc.js');
    return runBridgeInput(
      input,
      async (request) => server.handle(request),
      writer,
    );
  };
  void run();

  return async () => {
    if (disposed) return;
    disposed = true;
    input.destroy();
    await host.dispose();
  };
}

/** Cordis `apply` shape expected by the inserted bundle row. */
export function apply(ctx: AnyContext, config?: Record<string, unknown>): void {
  if ((config?.stdio ?? false) !== true) return;
  if (typeof ctx.effect !== 'function') {
    throw new Error('gian-dsh-bridge: Cordis ctx.effect is unavailable');
  }
  ctx.effect(() => mountBridge({ ctx }), 'gian-dsh-bridge.stdio');
}

interface CordisSessionRecord {
  id: string;
  nativeId: string;
  cwd: string;
  roots: string[];
  config: Record<string, BridgeJsonValue>;
  createdAt: string;
  handle: CordisAgentHandle;
  lastTurn: number | null;
  lastStep: number | null;
}

export class CordisDshHost implements BridgeHost {
  readonly kind = 'cordis' as const;
  readonly bridgeVersion: string;
  readonly dshVersion: string;
  readonly sessionFormatVersion = DSH_SESSION_FORMAT_VERSION;

  private readonly ctx: AnyContext;
  private sink: ((event: BridgeHostEvent) => void) | null = null;
  private readonly early: BridgeHostEvent[] = [];
  private readonly sessions = new Map<string, CordisSessionRecord>();
  private readonly byNativeId = new Map<string, CordisSessionRecord>();
  private readonly offSessionEvent: (() => boolean) | null;
  private disposed = false;

  constructor(ctx: AnyContext, bridgeVersion: string) {
    this.ctx = ctx;
    this.bridgeVersion = bridgeVersion;
    this.dshVersion = this.readDshVersion();
    this.offSessionEvent = typeof ctx.on === 'function'
      ? ctx.on('session/event', (session, event) => {
          this.handleSessionEvent(session, event);
        })
      : null;
  }

  private readDshVersion(): string {
    try {
      const manifest = createRequire(import.meta.url)('@deepseek-ai/dsh/package.json') as {
        version?: unknown;
      };
      return typeof manifest.version === 'string' ? manifest.version : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private agentRegistry(): CordisAgentRegistry {
    const registry = this.ctx.get?.('agents') ?? this.ctx.agents;
    if (registry === null || typeof registry !== 'object'
      || typeof (registry as CordisAgentRegistry).create !== 'function') {
      throw new Error('RUNTIME_UNAVAILABLE: DSH AgentRegistry is not mounted');
    }
    return registry as CordisAgentRegistry;
  }

  private session(sessionId: string): CordisSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`DSH bridge session ${sessionId} not found`);
    return record;
  }

  private sessionResult(record: CordisSessionRecord): Record<string, unknown> {
    return {
      session: {
        id: record.id,
        nativeId: record.nativeId,
        cwd: record.cwd,
        roots: record.roots,
        state: record.handle.agent.status,
        config: record.config,
        createdAt: record.createdAt,
      },
    };
  }

  attachSink(sink: (event: BridgeHostEvent) => void): void {
    this.sink = sink;
    const pending = this.early.splice(0);
    for (const item of pending) this.sink(item);
  }

  private emit(event: BridgeHostEvent): void {
    if (this.sink) this.sink(event);
    else this.early.push(event);
  }

  async initialize(): Promise<Record<string, unknown>> {
    return {
      protocol: { name: 'gian.dsh.bridge', version: '1.0' },
      plugin: { id: 'ai.deepseek.harness', bundle: '@gian/dsh-bridge', version: this.bridgeVersion },
      runtime: {
        id: 'deepseek-harness',
        package: '@deepseek-ai/dsh',
        version: this.dshVersion,
        sessionFormatVersion: this.sessionFormatVersion,
      },
      capabilities: {
        'session.resume': 1,
        'session.events.read': 1,
        'turn.interrupt': 1,
        'catalog.changed': 1,
        interaction: 1,
        'event.step': 1,
        'event.request': 1,
        'event.usage': 1,
      },
    };
  }

  async catalogList(): Promise<Record<string, unknown>> {
    const llm = this.ctx.get?.('llm') ?? this.ctx.llm;
    if (llm === null || typeof llm !== 'object'
      || typeof (llm as CordisLlmRuntime).listProviders !== 'function'
      || typeof (llm as CordisLlmRuntime).listModels !== 'function') {
      throw new Error('RUNTIME_UNAVAILABLE: DSH LlmRuntime is not mounted');
    }
    const runtime = llm as CordisLlmRuntime;
    const providers = runtime.listProviders();
    const modelGroups = await Promise.all(providers.map(async (provider) => (
      (await runtime.listModels(provider.id)).map((model) => ({
        id: model.id,
        provider: provider.id,
        label: model.name ?? model.id,
        ...(model.description ? { description: model.description } : {}),
      }))
    )));
    return {
      catalogRevision: `cordis-${this.dshVersion}`,
      providers: providers.map((provider) => ({ id: provider.id, label: provider.name ?? provider.id })),
      models: modelGroups.flat(),
      effortLevels: [],
      approvalPolicies: [],
      agentPresets: [],
      slashCommands: [],
    };
  }

  async catalogResolve(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.catalogList();
    return { ...list, resolvedDefaults: { sessionConfig: {}, turnConfig: (params.turnConfig ?? {}) as Record<string, unknown> } };
  }

  async sessionCreate(params: BridgeSessionCreateParams): Promise<Record<string, unknown>> {
    if (params.nativeSessionId !== undefined) {
      throw new Error('RUNTIME_UNAVAILABLE: native attach requires a reliable ownership API');
    }
    if (this.sessions.has(params.sessionId)) {
      throw new Error(`SESSION_BUSY: DSH bridge session ${params.sessionId} already exists`);
    }

    const nativeId = `session-${randomUUID()}`;
    const provider = typeof params.config.provider === 'string'
      ? params.config.provider
      : 'deepseek-official';
    const model = typeof params.config.model === 'string'
      ? params.config.model
      : 'deepseek-chat';
    const handle = await this.agentRegistry().create({
      sessionId: nativeId,
      meta: { cwd: params.cwd },
      agentOptions: { provider, model },
    });
    const createdAtMs = handle.agent.session.header?.createdAt;
    const record: CordisSessionRecord = {
      id: params.sessionId,
      nativeId,
      cwd: params.cwd,
      roots: [...params.roots],
      config: { ...params.config },
      createdAt: new Date(
        typeof createdAtMs === 'number' ? createdAtMs : Date.now(),
      ).toISOString(),
      handle,
      lastTurn: null,
      lastStep: null,
    };
    this.sessions.set(record.id, record);
    this.byNativeId.set(record.nativeId, record);
    this.emit({
      method: 'agent.status',
      params: { sessionId: record.id, nativeId, status: handle.agent.status },
    });
    return this.sessionResult(record);
  }

  async sessionResume(): Promise<Record<string, unknown>> {
    throw new Error('cordis host session.resume is exercised only inside a live DSH profile');
  }

  async sessionGet(params: { sessionId: string }): Promise<Record<string, unknown>> {
    return this.sessionResult(this.session(params.sessionId));
  }

  async sessionClose(params: { sessionId: string }): Promise<Record<string, unknown>> {
    const record = this.session(params.sessionId);
    record.handle.agent.cancel({ kind: 'user' });
    await record.handle.agent.whenIdle();
    await record.handle.dispose();
    this.sessions.delete(record.id);
    this.byNativeId.delete(record.nativeId);
    this.emit({
      method: 'agent.status',
      params: { sessionId: record.id, nativeId: record.nativeId, status: 'idle' },
    });
    return { ok: true };
  }

  async sessionNativeList(): Promise<Record<string, unknown>> {
    throw new Error('RUNTIME_UNAVAILABLE: native session list requires a reliable ownership API');
  }

  async sessionRename(): Promise<Record<string, unknown>> {
    throw new Error('cordis host session.rename is exercised only inside a live DSH profile');
  }

  async sessionEventsRead(params: {
    sessionId: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const record = this.session(params.sessionId);
    const events = Array.isArray(record.handle.agent.session.events)
      ? record.handle.agent.session.events
      : [];
    const cursor = params.cursor === null || params.cursor === undefined
      ? 0
      : Number(params.cursor);
    const limit = params.limit ?? 500;
    const page = events.slice(cursor, cursor + limit);
    return {
      sessionId: record.id,
      formatVersion: this.sessionFormatVersion,
      events: page.map((event) => ({
        type: event.type,
        seq: event.seq,
        time: event.time,
        data: event.data,
      })),
      cursor: cursor + page.length < events.length ? String(cursor + page.length) : null,
    };
  }

  async turnStart(params: BridgeTurnStartParams): Promise<Record<string, unknown>> {
    const record = this.session(params.sessionId);
    const text = turnText(params.input);
    if (text.length > 0) {
      record.handle.agent.followup(userMessage(text));
    }
    return { accepted: true };
  }

  async turnSteer(params: { sessionId: string; turnId?: string; input: unknown[] }): Promise<Record<string, unknown>> {
    const record = this.session(params.sessionId);
    const text = turnText(params.input);
    if (text.length > 0) {
      record.handle.agent.steer(userMessage(text));
    }
    return { accepted: true };
  }

  async turnInterrupt(params: { sessionId: string; turnId?: string }): Promise<Record<string, unknown>> {
    const record = this.session(params.sessionId);
    record.handle.agent.cancel({ kind: 'user' });
    return { accepted: true };
  }

  async interactionRespond(): Promise<Record<string, unknown>> {
    throw new Error('cordis host interaction.respond is exercised only inside a live DSH profile');
  }

  private handleSessionEvent(session: unknown, event: unknown): void {
    if (this.disposed) return;
    const sessionId = typeof session === 'object' && session !== null
      ? String((session as { id?: unknown }).id ?? '')
      : '';
    const record = this.byNativeId.get(sessionId);
    if (!record) return;

    const typed = event as { type?: unknown; seq?: unknown; data?: unknown } | null;
    if (typed === null || typeof typed !== 'object') return;
    if (typeof typed.type !== 'string' || typeof typed.seq !== 'number') return;
    const rawData = typed.data !== null && typeof typed.data === 'object'
      ? typed.data as Record<string, unknown>
      : {};
    const data = this.enrichSessionEventData(record, typed.type, rawData);
    this.emit({
      method: 'session.event',
      params: {
        sessionId: record.id,
        nativeSeq: typed.seq,
        type: typed.type,
        data,
      },
    });
  }

  private enrichSessionEventData(
    record: CordisSessionRecord,
    type: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (type === 'turn/start' && typeof data.turn === 'number') {
      record.lastTurn = data.turn;
      record.lastStep = null;
    }
    if (type === 'step/start' && typeof data.step === 'number') {
      record.lastStep = data.step;
    }
    if (type === 'request/header') {
      return {
        ...data,
        ...(typeof data.turn === 'number' ? {} : { turn: record.lastTurn ?? 0 }),
        ...(typeof data.step === 'number' ? {} : { step: record.lastStep ?? 0 }),
      };
    }
    return data;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.offSessionEvent?.();
    this.byNativeId.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(records.map(async (record) => {
      record.handle.agent.cancel({ kind: 'disposed' });
      await record.handle.agent.whenIdle().catch(() => undefined);
      await record.handle.dispose().catch(() => undefined);
    }));
  }

  async shutdown(): Promise<Record<string, unknown>> {
    await this.dispose();
    const exit = this.ctx.get?.('appExit') ?? this.ctx.appExit;
    if (typeof exit !== 'function') {
      throw new Error('RUNTIME_UNAVAILABLE: DSH launcher did not provide appExit');
    }
    setImmediate(() => exit(0));
    return { ok: true };
  }
}

function turnText(input: unknown[]): string {
  return input
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .filter((item) => item.type === 'text')
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .join('\n');
}

function userMessage(text: string): Record<string, unknown> {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

export default CordisDshHost;
