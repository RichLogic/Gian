/**
 * Real Cordis host adapter for the bridge.
 *
 * Compiles without the DSH packages being declared as dependencies: the bridge
 * is mounted *inside* a composed DSH profile, where `ctx` already carries the
 * services below. Every DSH surface this file touches was frozen by the WP0
 * probe against `@deepseek-ai/dsh@0.1.1-rc.2`.
 *
 * - `ctx.agents` (AgentRegistry): `create/resume/get/roots/list`
 * - `Agent`: `id/status/session`, `send/followup/steer/inject/cancel/whenIdle`
 * - `session/event`, `agent/status`, `agent/error`, `agent/inbox/*`
 * - `ctx.approval`, `ctx.permissionPresets`, and `ctx.agentPresets`
 * - `ctx.userQuestions.registerProvider/ask`
 * - `ctx.sessionPersistence.list/inspect/prepare/readFrom`
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { BridgeProtocolError, BridgeWriter } from './jsonrpc.js';
import { BridgeServer } from './server.js';
import { DSH_SESSION_FORMAT_VERSION, type BridgeJsonValue } from './schema.js';
import { verifyHostBinding } from './host-binding.js';
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

export function dshVersionFromEntrypoint(entrypoint: string | undefined): string | null {
  if (!entrypoint) return null;
  let directory: string;
  try {
    directory = dirname(realpathSync(entrypoint));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') {
        return manifest.version;
      }
    } catch {
      // The DSH entry can sit several directories below its package manifest.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

interface CordisSession {
  id: string;
  header?: { createdAt?: number; agentPreset?: string };
  events?: readonly CordisSessionEvent[];
}

interface CordisAgent {
  id: string;
  status: 'idle' | 'running';
  session: CordisSession;
  ctx: AnyContext;
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
    meta: { cwd: string; agentPreset?: string };
    agentOptions?: { provider?: string; model?: string };
    setup?: (ctx: AnyContext) => void | Promise<void>;
  }): Promise<CordisAgentHandle>;
  resume(options: {
    resumeSessionId: string;
    agentOptions?: { provider?: string; model?: string };
    setup?: (ctx: AnyContext) => void | Promise<void>;
  }): Promise<CordisAgentHandle>;
}

type CordisApprovalPolicy = 'ask' | 'never';
type CordisApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

interface CordisApprovalRequest {
  agent: CordisAgent;
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

interface CordisApprovalService {
  config?: { policy?: CordisApprovalPolicy };
  setPolicy(agent: CordisAgent, policy: CordisApprovalPolicy): void;
}

interface CordisPermissionPresetSpec {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  approval: CordisApprovalPolicy;
  name?: string;
  description?: string;
}

interface CordisPermissionPresetOption {
  value: string;
  name: string;
  description?: string;
}

interface CordisPermissionPresets {
  readonly names: readonly string[];
  readonly defaultPreset: string;
  resolve(name: string): CordisPermissionPresetSpec;
  optionOf(name: string): CordisPermissionPresetOption;
  set(session: CordisSession, name: string): void;
}

interface CordisAgentPreset {
  id: string;
  name?: string;
  description?: string;
  trust?: 'system' | 'user';
  broken?: string;
}

interface CordisAgentPresets {
  readonly defaultId: string;
  list(): Promise<CordisAgentPreset[]>;
  resolve(id?: string): Promise<CordisAgentPreset>;
  mount(agentCtx: AnyContext, id?: string): Promise<CordisAgentPreset>;
}

interface CordisReasoningInfo {
  efforts: Array<{ id: string; name: string; description?: string }>;
  defaultEffort?: string;
}

interface CordisModelInfo {
  id: string;
  provider?: string;
  name?: string;
  description?: string;
  inputModalities?: string[];
  reasoning?: CordisReasoningInfo;
}

interface CordisLlmRuntime {
  listProviders(): Array<{ id: string; name?: string }>;
  listModels(provider: string): Promise<CordisModelInfo[]>;
  resolveModelInfo?(provider: string, model: string): Promise<CordisModelInfo>;
  resolveCallConfig?(config: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  }): Promise<{ provider: string; model: string; reasoningEffort?: string }>;
}

interface CordisDefaultModel {
  currentSelection(): DshModelSelection;
}

type AnyContext = {
  [key: string]: unknown;
  get?: (name: string) => unknown;
  on?: (name: string, listener: (...args: unknown[]) => unknown, options?: { global?: boolean }) => () => boolean;
  agents?: CordisAgentRegistry;
  llm?: CordisLlmRuntime;
  appExit?: (code: number) => void;
  effect?: (
    callback: () => (() => Promise<void>),
    label?: string,
  ) => unknown;
  agent?: CordisAgent;
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
  const host = new CordisDshHost(
    options.ctx,
    options.bridgeVersion ?? '0.1.3',
    process.env.GIAN_HOST_BINDING_KEY,
  );
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
  selection: DshModelSelectionRef;
  lastTurn: number | null;
  lastStep: number | null;
}

interface PendingApproval {
  sessionId: string;
  settle: (outcome: CordisApprovalOutcome, actionId?: string) => void;
}

interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

interface DshModelSelectionRef {
  current: DshModelSelection;
  assembled?: DshModelSelection;
}

function titleCaseKebab(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return value;
  return value
    .split('-')
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function sessionAgentPreset(session: CordisSession): string | undefined {
  const events = Array.isArray(session.events) ? session.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'agent-preset/selected'
      && typeof event.data.agentPreset === 'string') {
      return event.data.agentPreset;
    }
  }
  return session.header?.agentPreset;
}

function installModelSelection(ctx: AnyContext, selection: DshModelSelectionRef): void {
  if (typeof ctx.on !== 'function') {
    throw new Error('RUNTIME_UNAVAILABLE: DSH Agent context cannot install model selection');
  }
  ctx.on('system-prompt/assemble', async (...args: unknown[]) => {
    const next = args[2];
    if (typeof next !== 'function') {
      throw new Error('RUNTIME_UNAVAILABLE: DSH prompt assembly waterfall is unavailable');
    }
    const selected = selection.current;
    const assembled = await (next as () => Promise<Record<string, unknown>>)();
    selection.assembled = selected;
    const variables = assembled.variables !== null && typeof assembled.variables === 'object'
      ? assembled.variables as Record<string, unknown>
      : {};
    return {
      ...assembled,
      variables: { ...variables, provider: selected.provider, model: selected.model },
    };
  });
  ctx.on('agent/request', async (...args: unknown[]) => {
    const next = args[1];
    if (typeof next !== 'function') {
      throw new Error('RUNTIME_UNAVAILABLE: DSH request waterfall is unavailable');
    }
    const resolved = await (next as () => Promise<Record<string, unknown>>)();
    const selected = selection.assembled ?? selection.current;
    const { reasoningEffort: _ignored, ...rest } = resolved;
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selected.reasoningEffort }),
    };
  });
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
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly offSessionEvent: (() => boolean) | null;
  private readonly offAssistantStream: (() => boolean) | null;
  private readonly assistantStreams = new Map<string, {
    attemptId: string; revision: number; turn: number; step: number; index: number;
  }>();
  private readonly offCatalogChanged: (() => boolean) | null;
  private catalogChangedAt = Date.now();
  private catalogGeneration = 0;
  private firstCatalog = true;
  private disposed = false;

  constructor(
    ctx: AnyContext,
    bridgeVersion: string,
    private readonly hostBindingKey: string | undefined = undefined,
  ) {
    this.ctx = ctx;
    this.bridgeVersion = bridgeVersion;
    this.dshVersion = this.readDshVersion();
    this.offSessionEvent = typeof ctx.on === 'function'
      ? ctx.on('session/event', (session, event) => {
          this.handleSessionEvent(session, event);
        })
      : null;
    this.offAssistantStream = typeof ctx.on === 'function'
      ? ctx.on('agent/assistant-stream', payload => { this.handleAssistantStream(payload); }, { global: true })
      : null;
    this.offCatalogChanged = typeof ctx.on === 'function'
      ? ctx.on('llm/adapters-updated', () => {
          this.catalogGeneration += 1;
          this.catalogChangedAt = Date.now();
          this.emit({
            method: 'catalog.changed',
            params: { catalogRevision: `cordis-${this.dshVersion}-${this.catalogGeneration}` },
          });
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
      // Profile bundles are symlinked into `$DSH_HOME/profiles/gian`. Node
      // resolves this module from the bridge's real package path, so ordinary
      // package lookup cannot see the DSH launcher beside the profile. Recover
      // its version from the actual CLI entry instead.
      return dshVersionFromEntrypoint(process.argv[1]) ?? 'unknown';
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

  private optionalContextValue(name: string): unknown {
    try {
      const value = this.ctx.get?.(name);
      if (value !== null && value !== undefined) return value;
    } catch {
      // Cordis throws when an optional service was not injected into this
      // plugin. Treat that as absence and try the property compatibility path.
    }
    try {
      return this.ctx[name];
    } catch {
      return undefined;
    }
  }

  private approvalRuntime(): CordisApprovalService | null {
    const service = this.optionalContextValue('approval');
    return service !== null && typeof service === 'object'
      && typeof (service as CordisApprovalService).setPolicy === 'function'
      ? service as CordisApprovalService
      : null;
  }

  private permissionPresetsRuntime(): CordisPermissionPresets | null {
    const service = this.optionalContextValue('permissionPresets');
    return service !== null && typeof service === 'object'
      && Array.isArray((service as CordisPermissionPresets).names)
      && typeof (service as CordisPermissionPresets).defaultPreset === 'string'
      && typeof (service as CordisPermissionPresets).resolve === 'function'
      && typeof (service as CordisPermissionPresets).optionOf === 'function'
      && typeof (service as CordisPermissionPresets).set === 'function'
      ? service as CordisPermissionPresets
      : null;
  }

  private agentPresetsRuntime(): CordisAgentPresets | null {
    const service = this.optionalContextValue('agentPresets');
    return service !== null && typeof service === 'object'
      && typeof (service as CordisAgentPresets).list === 'function'
      && typeof (service as CordisAgentPresets).resolve === 'function'
      && typeof (service as CordisAgentPresets).mount === 'function'
      && typeof (service as CordisAgentPresets).defaultId === 'string'
      ? service as CordisAgentPresets
      : null;
  }

  private supportsApprovalInteraction(): boolean {
    return this.approvalRuntime() !== null && typeof this.ctx.on === 'function';
  }

  private installApprovalInteraction(agentCtx: AnyContext, sessionId: string): void {
    if (!this.supportsApprovalInteraction()) return;
    if (typeof agentCtx.on !== 'function') {
      throw new Error('RUNTIME_UNAVAILABLE: DSH Agent context cannot install approval interaction');
    }
    agentCtx.on('approval/request', async (...args: unknown[]) => {
      const request = args[0] as CordisApprovalRequest | undefined;
      const next = args[1];
      if (!request || typeof request.toolName !== 'string') {
        return typeof next === 'function'
          ? (next as () => Promise<CordisApprovalOutcome>)()
          : 'unavailable';
      }
      return this.requestApproval(sessionId, request);
    });
  }

  private requestApproval(
    sessionId: string,
    request: CordisApprovalRequest,
  ): Promise<CordisApprovalOutcome> {
    const record = this.session(sessionId);
    const interactionId = `dsh-approval-${randomUUID()}`;
    return new Promise<CordisApprovalOutcome>((resolveApproval) => {
      let settled = false;
      const onAbort = () => settle('cancelled');
      const settle = (outcome: CordisApprovalOutcome, actionId?: string) => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener('abort', onAbort);
        this.pendingApprovals.delete(interactionId);
        this.emit({
          method: 'interaction.resolved',
          params: {
            sessionId,
            interactionId,
            outcome: actionId === undefined ? 'cancelled' : 'submitted',
            ...(actionId === undefined ? {} : { actionId }),
          },
        });
        resolveApproval(outcome);
      };
      this.pendingApprovals.set(interactionId, { sessionId, settle });
      request.signal?.addEventListener('abort', onAbort, { once: true });
      this.emit({
        method: 'interaction.requested',
        params: {
          sessionId,
          interactionId,
          kind: 'approval',
          title: `Approve ${request.toolName}`,
          ...(request.reason ? { description: request.reason } : {}),
          ...(record.lastTurn === null ? {} : { turn: record.lastTurn }),
          ...(record.lastStep === null ? {} : { step: record.lastStep }),
          inputs: [],
          actions: [
            { id: 'allow-once', label: 'Allow once', style: 'primary' },
            { id: 'reject', label: 'Reject', style: 'danger' },
          ],
        },
      });
      if (request.signal?.aborted) settle('cancelled');
    });
  }

  private llmRuntime(): CordisLlmRuntime {
    const runtime = this.ctx.get?.('llm') ?? this.ctx.llm;
    if (runtime === null || typeof runtime !== 'object'
      || typeof (runtime as CordisLlmRuntime).listProviders !== 'function'
      || typeof (runtime as CordisLlmRuntime).listModels !== 'function') {
      throw new Error('RUNTIME_UNAVAILABLE: DSH LlmRuntime is not mounted');
    }
    return runtime as CordisLlmRuntime;
  }

  private async catalogModels(): Promise<Array<CordisModelInfo & { provider: string }>> {
    const runtime = this.llmRuntime();
    const groups = await Promise.all(runtime.listProviders().map(async (provider) => (
      (await runtime.listModels(provider.id)).map(async (model) => {
        const resolved = typeof runtime.resolveModelInfo === 'function'
          ? await runtime.resolveModelInfo(provider.id, model.id).catch(() => model)
          : model;
        return { ...model, ...resolved, provider: provider.id };
      })
    )));
    return (await Promise.all(groups.flat())).map(model => ({ ...model, provider: model.provider }));
  }

  private async resolveTurnSelection(
    record: CordisSessionRecord,
    config: Record<string, BridgeJsonValue>,
  ): Promise<DshModelSelection> {
    const provider = typeof config.provider === 'string'
      ? config.provider
      : record.selection.current.provider;
    const model = typeof config.model === 'string' ? config.model : record.selection.current.model;
    const models = await this.catalogModels();
    const match = models.find(candidate => candidate.id === model && candidate.provider === provider);
    if (!match) {
      throw new Error(`CONFIG_VALUE_INVALID: DSH model ${provider}/${model} is not available`);
    }
    const requested = {
      provider: match.provider,
      model: match.id,
      ...(typeof config.effort === 'string' ? { reasoningEffort: config.effort } : {}),
    };
    const runtime = this.llmRuntime();
    const resolved = typeof runtime.resolveCallConfig === 'function'
      ? await runtime.resolveCallConfig(requested)
      : requested;
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: resolved.reasoningEffort }),
    };
  }

  private defaultSelection(models: Array<CordisModelInfo & { provider: string }>): DshModelSelection {
    const service = this.optionalContextValue('agentDefaultModel');
    if (service !== null && typeof service === 'object'
      && typeof (service as CordisDefaultModel).currentSelection === 'function') {
      const selected = (service as CordisDefaultModel).currentSelection();
      if (models.some(model => model.provider === selected.provider && model.id === selected.model)) {
        return selected;
      }
    }
    const first = models[0];
    if (!first) throw new Error('RUNTIME_UNAVAILABLE: DSH exposes no models');
    return { provider: first.provider, model: first.id };
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
        'session.events.read': 1,
        'turn.interrupt': 1,
        'catalog.changed': 1,
        ...(this.supportsApprovalInteraction() ? { interaction: 1 } : {}),
        'event.step': 1,
        'event.request': 1,
        'event.usage': 1,
      },
    };
  }

  async catalogList(): Promise<Record<string, unknown>> {
    if (this.firstCatalog) {
      this.firstCatalog = false;
      const deadline = Date.now() + 3_000;
      // DSH profile bundles mount concurrently. Do not freeze Gian's process
      // catalog while late Provider registrations are still arriving.
      while (Date.now() < deadline) {
        const quietFor = Date.now() - this.catalogChangedAt;
        if (quietFor >= 500) break;
        await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(100, 500 - quietFor)));
      }
    }
    const runtime = this.llmRuntime();
    const providers = runtime.listProviders();
    const models = await this.catalogModels();
    const defaultSelection = this.defaultSelection(models);
    const approval = this.approvalRuntime();
    const permissions = this.permissionPresetsRuntime();
    const presets = this.agentPresetsRuntime();
    const agentPresets = presets === null ? [] : await presets.list();
    const permissionPresets = permissions === null
      ? []
      : permissions.names.flatMap((id) => {
          const spec = permissions.resolve(id);
          if (spec.approval === 'ask' && !this.supportsApprovalInteraction()) return [];
          const option = permissions.optionOf(id);
          return [{
            id,
            label: id === 'danger-full-access'
              ? 'Full access'
              : titleCaseKebab(option.name),
            ...(option.description ? { description: option.description } : {}),
            approvalPolicy: spec.approval,
          }];
        });
    const defaultPermissionPreset = permissions === null
      ? undefined
      : (permissionPresets.some(preset => preset.id === permissions.defaultPreset)
          ? permissions.defaultPreset
          : undefined);
    return {
      catalogRevision: `cordis-${this.dshVersion}`,
      providers: providers.map((provider) => ({ id: provider.id, label: provider.name ?? provider.id })),
      defaultSelection,
      models: models.map(model => ({
        id: model.id,
        provider: model.provider,
        label: model.name ?? model.id,
        ...(model.description ? { description: model.description } : {}),
        ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
        ...(model.reasoning ? {
          reasoning: {
            efforts: model.reasoning.efforts.map(effort => ({
              id: effort.id,
              label: effort.name,
              ...(effort.description ? { description: effort.description } : {}),
            })),
            ...(model.reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: model.reasoning.defaultEffort }),
          },
        } : {}),
      })),
      approvalPolicies: approval === null
        ? []
        : [
            ...(this.supportsApprovalInteraction() ? [{ id: 'ask', label: 'Ask' }] : []),
            { id: 'never', label: 'Never' },
          ],
      ...(approval === null
        ? {}
        : {
            defaultApprovalPolicy: approval.config?.policy === 'ask'
              && this.supportsApprovalInteraction()
              ? 'ask'
              : 'never',
          }),
      permissionPresets,
      ...(defaultPermissionPreset === undefined ? {} : { defaultPermissionPreset }),
      agentPresets: agentPresets.map(preset => ({
        id: preset.id,
        label: preset.name ?? preset.id,
        ...(preset.description ? { description: preset.description } : {}),
        ...(preset.trust ? { trust: preset.trust } : {}),
        ...(preset.broken ? { broken: preset.broken } : {}),
      })),
      ...(presets === null ? {} : { defaultAgentPreset: presets.defaultId }),
      slashCommands: [],
    };
  }

  async catalogResolve(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.catalogList();
    return { ...list, resolvedDefaults: { sessionConfig: {}, turnConfig: (params.turnConfig ?? {}) as Record<string, unknown> } };
  }

  async sessionCreate(params: BridgeSessionCreateParams): Promise<Record<string, unknown>> {
    if (params.nativeSessionId !== undefined) {
      if (params.restartNewStream === true) {
        throw new Error('RUNTIME_UNAVAILABLE: native session adoption is not supported');
      }
      const proof = params.hostBindingProof;
      if (this.hostBindingKey === undefined
        || proof === undefined
        || !verifyHostBinding(this.hostBindingKey, {
          pluginId: 'ai.deepseek.harness',
          sessionId: params.sessionId,
          nativeSessionId: params.nativeSessionId,
          cwd: params.cwd,
        }, proof)) {
        throw new Error('RUNTIME_UNAVAILABLE: native attach requires a valid Host ownership proof');
      }
    }
    if (this.sessions.has(params.sessionId)) {
      throw new Error(`SESSION_BUSY: DSH bridge session ${params.sessionId} already exists`);
    }

    const nativeId = params.nativeSessionId ?? `session-${randomUUID()}`;
    const models = await this.catalogModels();
    const defaults = this.defaultSelection(models);
    const model = typeof params.config.model === 'string' ? params.config.model : defaults.model;
    const provider = typeof params.config.provider === 'string'
      ? params.config.provider
      : defaults.provider;
    const requestedPreset = typeof params.config.agent_preset === 'string'
      ? params.config.agent_preset
      : undefined;
    const presets = this.agentPresetsRuntime();
    if (presets === null && requestedPreset !== undefined) {
      throw new Error('RUNTIME_UNAVAILABLE: DSH AgentPresets is not mounted');
    }
    const requestedResolvedPreset = presets === null || requestedPreset === undefined
      ? null
      : await presets.resolve(requestedPreset);
    const freshResolvedPreset = presets === null || params.nativeSessionId !== undefined
      ? null
      : (requestedResolvedPreset ?? await presets.resolve());
    if (freshResolvedPreset?.broken) {
      throw new Error(`RUNTIME_UNAVAILABLE: DSH Agent preset ${freshResolvedPreset.id} is broken: ${freshResolvedPreset.broken}`);
    }
    const presetId = freshResolvedPreset?.id;
    const selection: DshModelSelectionRef = { current: { provider, model } };
    const setup = async (agentCtx: AnyContext) => {
      let setupPresetId = presetId;
      if (presets !== null && params.nativeSessionId !== undefined) {
        const scopedAgent = agentCtx.agent;
        if (!scopedAgent) {
          throw new Error('RUNTIME_UNAVAILABLE: resumed DSH Agent is unavailable during setup');
        }
        const storedPreset = sessionAgentPreset(scopedAgent.session);
        if (requestedResolvedPreset !== null && requestedResolvedPreset.id !== storedPreset) {
          throw new Error(
            `CONFIG_VALUE_INVALID: DSH Agent preset ${requestedResolvedPreset.id} conflicts with persisted preset ${String(storedPreset)}`,
          );
        }
        const persistedPreset = await presets.resolve(storedPreset);
        if (persistedPreset.broken) {
          throw new Error(`RUNTIME_UNAVAILABLE: DSH Agent preset ${persistedPreset.id} is broken: ${persistedPreset.broken}`);
        }
        setupPresetId = persistedPreset.id;
      }
      if (presets !== null) await presets.mount(agentCtx, setupPresetId);
      installModelSelection(agentCtx, selection);
      this.installApprovalInteraction(agentCtx, params.sessionId);
    };
    let handle: CordisAgentHandle;
    try {
      handle = params.nativeSessionId === undefined
        ? await this.agentRegistry().create({
          sessionId: nativeId,
          meta: {
            cwd: params.cwd,
            ...(presetId === undefined ? {} : { agentPreset: presetId }),
          },
          agentOptions: { provider, model },
          setup,
        })
        : await this.agentRegistry().resume({
          resumeSessionId: nativeId,
          agentOptions: { provider, model },
          setup,
        });
    } catch (error) {
      if (params.nativeSessionId !== undefined
        && error instanceof Error
        && /^session ".+" not found$/.test(error.message)) {
        throw new BridgeProtocolError(
          -32000,
          `DSH native session ${params.nativeSessionId} was not found.`,
          'NATIVE_SESSION_NOT_FOUND',
        );
      }
      throw error;
    }
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
      selection,
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
    this.cancelPendingApprovals(record.id);
    record.handle.agent.cancel({ kind: 'user' });
    await record.handle.agent.whenIdle();
    await record.handle.dispose();
    this.sessions.delete(record.id);
    this.assistantStreams.delete(record.id);
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
    record.selection.current = await this.resolveTurnSelection(record, params.config);
    const permissionPreset = params.config.permission_preset;
    if (typeof permissionPreset === 'string') {
      const permissions = this.permissionPresetsRuntime();
      if (permissions === null) {
        throw new Error('RUNTIME_UNAVAILABLE: DSH PermissionPresetService is not mounted');
      }
      permissions.set(record.handle.agent.session, permissionPreset);
    }
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

  async interactionRespond(params: {
    sessionId: string;
    interactionId: string;
    actionId?: string;
    values: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const pending = this.pendingApprovals.get(params.interactionId);
    if (!pending || pending.sessionId !== params.sessionId) {
      throw new Error(`interaction ${params.interactionId} is not pending`);
    }
    if (params.actionId === 'allow-once') {
      pending.settle('allowed-once', params.actionId);
    } else if (params.actionId === 'reject') {
      pending.settle('rejected', params.actionId);
    } else {
      throw new Error(`unsupported approval action ${String(params.actionId)}`);
    }
    return { accepted: true };
  }

  private cancelPendingApprovals(sessionId: string): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      if (pending.sessionId === sessionId) pending.settle('cancelled');
    }
  }

  private handleAssistantStream(value: unknown): void {
    if (this.disposed || !value || typeof value !== 'object') return;
    const payload = value as { agent?: CordisAgent; frame?: Record<string, unknown> };
    const nativeId = payload.agent?.session?.id;
    const record = nativeId ? this.byNativeId.get(nativeId) : undefined;
    const frame = payload.frame;
    // Ignore child Agents, foreign Sessions and late frames from replaced handles.
    if (!record || record.handle.agent !== payload.agent || !frame
      || typeof frame.attemptId !== 'string' || !Number.isSafeInteger(frame.revision)) return;
    if (frame.type === 'start') {
      if (!Number.isSafeInteger(frame.turn) || !Number.isSafeInteger(frame.step)) return;
      const previous = this.assistantStreams.get(record.id);
      if (previous && (frame.revision as number) <= previous.revision) return;
      this.assistantStreams.set(record.id, {
        attemptId: frame.attemptId, revision: frame.revision as number,
        turn: frame.turn as number, step: frame.step as number, index: -1,
      });
      return;
    }
    const stream = this.assistantStreams.get(record.id);
    if (!stream || stream.attemptId !== frame.attemptId || (frame.revision as number) <= stream.revision) return;
    if (frame.type === 'end') {
      // Retain the revision fence until Session close so a replayed old start
      // cannot revive the completed attempt.
      stream.index = Number.MAX_SAFE_INTEGER;
      stream.revision = frame.revision as number;
      return;
    }
    if (frame.type !== 'chunk' || !Number.isSafeInteger(frame.index)
      || (frame.index as number) <= stream.index || !frame.chunk || typeof frame.chunk !== 'object') return;
    stream.index = frame.index as number;
    stream.revision = frame.revision as number;
    const chunk = frame.chunk as Record<string, unknown>;
    if ((chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') || typeof chunk.text !== 'string') return;
    // DSH 0.1.5 moved chunks off the durable session/event bus. Preserve their
    // attempt/index identity rather than inventing a durable native sequence.
    this.emit({ method: 'session.event', params: {
      sessionId: record.id, type: 'assistant/chunk',
      data: {
        turn: stream.turn, step: stream.step,
        liveAttemptId: stream.attemptId, liveChunkIndex: stream.index,
        chunk: {
          type: chunk.type, text: chunk.text,
          ...(Number.isSafeInteger(chunk.index) ? { index: chunk.index as number } : {}),
        },
      },
    } });
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
    this.offAssistantStream?.();
    this.assistantStreams.clear();
    this.offCatalogChanged?.();
    this.byNativeId.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(records.map(async (record) => {
      this.cancelPendingApprovals(record.id);
      record.handle.agent.cancel({ kind: 'disposed' });
      await record.handle.agent.whenIdle().catch(() => undefined);
      await record.handle.dispose().catch(() => undefined);
    }));
  }

  async shutdown(): Promise<Record<string, unknown>> {
    await this.dispose();
    const exit = this.optionalContextValue('appExit');
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
