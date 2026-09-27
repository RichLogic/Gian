/**
 * Real Cordis host adapter for the bridge.
 *
 * Compiles without the DSH packages being declared as dependencies: the bridge
 * is mounted *inside* a composed DSH profile, where `ctx` already carries the
 * services below. Every DSH surface this file touches was verified against the
 * shipped type definitions of `@deepseek-ai/dsh@0.1.5-rc.3`
 * (upstream tag `dsh-v0.1.5-rc.3`, commit `a4c74a91e06b00fe0b0937bde982170c526cc842`):
 *
 * - `ctx.agents` (AgentRegistry): `create/resume/get/list/roots/isOwnedBy`;
 *   `CreateAgentOptions.meta.parentSession/isSeeded` + `seed` +
 *   `inheritedEventCount` are the native fork path
 *   (`@deepseek-ai/dsh-agent` index.d.ts).
 * - `Agent`: `id/status/session/options/inbox`, `send/followup/steer/inject/
 *   cancel/whenIdle`; `steer` consumes at the nearest step boundary of the
 *   open turn (`@deepseek-ai/dsh-agent` runtime-types.d.ts).
 * - `session/event` (`SessionEventMap` incl. `todo/write`, `plan/mode`,
 *   `approval/asked`, `approval/decided`, `session/end-seed`), `agent/status`,
 *   `agent/error`, `agent/assistant-stream` (frames carry attemptId, revision,
 *   turn/step and a committed/abandoned end outcome),
 *   `subagent/start` + `subagent/end` (`@deepseek-ai/dsh-subagent`:
 *   SubagentRunInfo / SubagentRunEndInfo with runId, child session id,
 *   stopReason).
 * - `ctx.approval` (`approval/request` waterfall, `setPolicy`), and
 *   `ctx.userQuestions` (`user-questions/request` waterfall, AskUserQuestion*
 *   shapes incl. `plan-review` intent and multiSelect) — `@deepseek-ai/dsh-user-approval`,
 *   `@deepseek-ai/dsh-user-questions`.
 * - `ctx.attachments` (`AttachmentStore.saveImages/saveFile` producing the
 *   durable `ImageAttachmentRef` / `FileAttachmentRef` used by the native
 *   `image` / `file` content blocks — `@deepseek-ai/dsh-attachment`).
 * - `ctx.skills` (`SkillRegistry.list/get`, `isUserInvocable`,
 *   `renderSkillContent`; `SkillInvocationSource` is the native
 *   user-explicit-invocation source — `@deepseek-ai/dsh-skill`).
 * - `ctx.permissionPresets`, `ctx.agentPresets`, `ctx.llm`.
 * - `ctx.sessionPersistence.list/stat/open/read`
 *   (`SessionPersistenceSnapshot`: header + revision + eventCount; there is
 *   no delete and no title anywhere in the storage contract, which is what
 *   keeps native delete/rename unsupported).
 *
 * Messages and content blocks are built with the plain shapes documented by
 * `@deepseek-ai/dsh-llm` (`createUserMessage` equivalents) so no DSH module
 * import is required at compile time.
 */

import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { BridgeProtocolError, BridgeWriter } from './jsonrpc.js';
import { BridgeServer } from './server.js';
import { DSH_SESSION_FORMAT_VERSION, type BridgeJsonValue } from './schema.js';
import { verifyHostBinding } from './host-binding.js';
import type {
  BridgeCustomizationDetailParams,
  BridgeCustomizationListParams,
  BridgeForkAnchor,
  BridgeHost,
  BridgeHostEvent,
  BridgeSessionCreateParams,
  BridgeSessionForkParams,
  BridgeTurnInputItem,
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
  inheritedEventCount?: number;
}

interface CordisAgent {
  id: string;
  status: 'idle' | 'running';
  session: CordisSession;
  ctx: AnyContext;
  cancel(cause: { kind: 'user' | 'disposed' }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
  followup(message: Record<string, unknown>): void;
  steer(message: Record<string, unknown>): void;
  inject(message: Record<string, unknown>): void;
}

interface CordisAgentHandle {
  agent: CordisAgent;
  dispose(): Promise<void>;
}

interface CordisAgentRegistry {
  create(options: {
    sessionId: string;
    meta?: {
      cwd?: string;
      parentSession?: string;
      isSeeded?: boolean;
      origin?: 'subagent';
      delegationDepth?: number;
      agentPreset?: string;
    };
    inheritedEventCount?: number;
    seed?: readonly unknown[];
    agentOptions?: { provider?: string; model?: string };
    setup?: (ctx: AnyContext) => void | Promise<void>;
  }): Promise<CordisAgentHandle>;
  resume(options: {
    resumeSessionId: string;
    agentOptions?: { provider?: string; model?: string };
    setup?: (ctx: AnyContext) => void | Promise<void>;
  }): Promise<CordisAgentHandle>;
  isOwnedBy?(childId: string, owner: CordisAgent): boolean;
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

/** Subset of `@deepseek-ai/dsh-attachment` the bridge drives. */
interface CordisAttachmentStore {
  readonly imageLimits?: {
    readonly maxImageBytes: number;
    readonly mediaTypes: readonly string[];
  };
  saveImages(inputs: ReadonlyArray<{
    data: Uint8Array;
    mediaType: string;
    name?: string;
  }>): Promise<Array<Record<string, unknown>>>;
  saveFile(input: { data: Uint8Array; name?: string }): Promise<Record<string, unknown>>;
}

/** Subset of `@deepseek-ai/dsh-skill` the bridge drives. */
interface CordisSkillRegistry {
  list(options?: { cwd?: string }): Promise<Array<Record<string, unknown>>>;
  get(name: string, options?: { cwd?: string }): Promise<Record<string, unknown> | undefined>;
}

interface CordisPersistenceSnapshot {
  header: {
    id: string;
    createdAt?: number;
    cwd?: string;
    origin?: 'subagent';
    parentSession?: string;
    isSeeded?: boolean;
  };
  revision: unknown;
  eventCount?: number;
}

interface CordisSessionPersistence {
  list(options?: { signal?: AbortSignal }): Promise<readonly CordisPersistenceSnapshot[]>;
}

/** AskUserQuestion shapes (`@deepseek-ai/dsh-user-questions/types`). */
interface CordisUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: { kind: 'plan-review'; approve: string };
}

interface CordisUserQuestionRequest {
  questions: CordisUserQuestionItem[];
  agent?: CordisAgent;
  signal?: AbortSignal;
}

interface CordisUserQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
}

interface CordisSubagentRunInfo {
  runId: string;
  provider: string;
  id: string;
  local: boolean;
}

interface CordisSubagentRunEndInfo extends CordisSubagentRunInfo {
  stopReason: string;
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
    options.bridgeVersion ?? '0.1.5',
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
  /** Native turn ordinal currently open, or null between turns. */
  openTurn: number | null;
}

interface PendingInteraction {
  sessionId: string;
  interactionId: string;
  settle: (outcome: CordisApprovalOutcome | 'answered', actionId?: string) => void;
  /** Completes a user-questions pending entry with a structured answer. */
  answer?: (answer: CordisUserQuestionAnswer) => void;
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

interface ChildAgentFacts {
  parentSessionId: string;
  runId: string;
  childNativeId: string;
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
/** Bridge-transport memory guard for verbatim file admission (native storage
 * itself carries no file limit; this only bounds the bridge's in-process read). */
const MAX_FILE_ADMISSION_BYTES = 512 * 1024 * 1024;

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

/** Stable skill/mcp customization id (`ci1_` + sha256 prefix), matching the
 * protocol's stableCustomizationId recipe over non-sensitive provenance. */
function customizationStableId(kind: string, scopeKey: string, locator: string, nativeIdentity: string): string {
  const payload = ['ai.deepseek.harness', kind, scopeKey, locator, nativeIdentity].join('\u0000');
  return `ci1_${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`;
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
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  /** Live child agents attributed to a Gian session via subagent/start. */
  private readonly children = new Map<string, ChildAgentFacts>();
  private readonly offSessionEvent: (() => boolean) | null;
  private readonly offAssistantStream: (() => boolean) | null;
  private readonly offSubagentStart: (() => boolean) | null;
  private readonly offSubagentEnd: (() => boolean) | null;
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
    this.offSubagentStart = typeof ctx.on === 'function'
      ? ctx.on('subagent/start', payload => { this.handleSubagentStart(payload); }, { global: true })
      : null;
    this.offSubagentEnd = typeof ctx.on === 'function'
      ? ctx.on('subagent/end', payload => { this.handleSubagentEnd(payload); }, { global: true })
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

  private attachmentsRuntime(): CordisAttachmentStore | null {
    const service = this.optionalContextValue('attachments');
    return service !== null && typeof service === 'object'
      && typeof (service as CordisAttachmentStore).saveImages === 'function'
      && typeof (service as CordisAttachmentStore).saveFile === 'function'
      ? service as CordisAttachmentStore
      : null;
  }

  private skillsRuntime(): CordisSkillRegistry | null {
    const service = this.optionalContextValue('skills');
    return service !== null && typeof service === 'object'
      && typeof (service as CordisSkillRegistry).list === 'function'
      && typeof (service as CordisSkillRegistry).get === 'function'
      ? service as CordisSkillRegistry
      : null;
  }

  private sessionPersistenceRuntime(): CordisSessionPersistence | null {
    const service = this.optionalContextValue('sessionPersistence');
    return service !== null && typeof service === 'object'
      && typeof (service as CordisSessionPersistence).list === 'function'
      ? service as CordisSessionPersistence
      : null;
  }

  private supportsApprovalInteraction(): boolean {
    return this.approvalRuntime() !== null && typeof this.ctx.on === 'function';
  }

  private supportsUserQuestions(): boolean {
    const service = this.optionalContextValue('userQuestions');
    return service !== null && typeof service === 'object'
      && typeof (service as { ask?: unknown }).ask === 'function'
      && typeof this.ctx.on === 'function';
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

  private installUserQuestions(agentCtx: AnyContext, sessionId: string): void {
    if (!this.supportsUserQuestions()) return;
    if (typeof agentCtx.on !== 'function') {
      throw new Error('RUNTIME_UNAVAILABLE: DSH Agent context cannot install user-question interaction');
    }
    agentCtx.on('user-questions/request', async (...args: unknown[]) => {
      const request = args[0] as CordisUserQuestionRequest | undefined;
      const next = args[1];
      if (!request || !Array.isArray(request.questions) || request.questions.length === 0) {
        return typeof next === 'function'
          ? (next as () => Promise<CordisUserQuestionAnswer>)()
          : { answers: [] };
      }
      return this.requestUserAnswers(sessionId, request);
    });
  }

  private requestApproval(
    sessionId: string,
    request: CordisApprovalRequest,
  ): Promise<CordisApprovalOutcome> {
    const record = this.session(sessionId);
    const interactionId = `dsh-approval-${randomUUID()}`;
    // The approval service appends the durable `approval/asked` audit event
    // immediately before dispatching the answerer waterfall; the log tail is
    // therefore the ask's native seq and anchors the interaction identity for
    // both live projection and replay.
    const askedSeq = (Array.isArray(record.handle.agent.session.events)
      ? record.handle.agent.session.events.length
      : 1) - 1;
    return new Promise<CordisApprovalOutcome>((resolveApproval) => {
      let settled = false;
      const onAbort = () => settle('cancelled');
      const settle = (outcome: CordisApprovalOutcome | 'answered', actionId?: string) => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener('abort', onAbort);
        this.pendingInteractions.delete(interactionId);
        if (outcome !== 'answered') {
          this.emit({
            method: 'interaction.resolved',
            params: {
              sessionId,
              interactionId,
              outcome: 'cancelled',
              nativeSeq: askedSeq,
            },
          });
        }
        resolveApproval(outcome === 'answered' ? 'allowed-once' : outcome);
      };
      this.pendingInteractions.set(interactionId, {
        sessionId,
        interactionId,
        settle: (outcome, actionId) => {
          if (outcome === 'answered') {
            settle(actionId === 'allow-once' ? 'allowed-once' : 'rejected', actionId);
            this.emit({
              method: 'interaction.resolved',
              params: {
                sessionId,
                interactionId,
                outcome: 'submitted',
                ...(actionId === undefined ? {} : { actionId }),
                nativeSeq: askedSeq,
              },
            });
            return;
          }
          settle(outcome, actionId);
        },
      });
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
          nativeSeq: askedSeq,
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

  private requestUserAnswers(
    sessionId: string,
    request: CordisUserQuestionRequest,
  ): Promise<CordisUserQuestionAnswer> {
    const record = this.session(sessionId);
    const interactionId = `dsh-question-${randomUUID()}`;
    const planReview = request.questions.find(q => q.intent?.kind === 'plan-review');
    const hasMulti = request.questions.some(q => q.multiSelect === true);
    return new Promise<CordisUserQuestionAnswer>((resolveAnswer, rejectAnswer) => {
      let settled = false;
      const askedSeq = (Array.isArray(record.handle.agent.session.events)
        ? record.handle.agent.session.events.length
        : 1) - 1;
      const onAbort = () => settleCancelled();
      const settleCancelled = () => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener('abort', onAbort);
        this.pendingInteractions.delete(interactionId);
        this.pendingQuestionRequests.delete(interactionId);
        this.emit({
          method: 'interaction.resolved',
          params: { sessionId, interactionId, outcome: 'cancelled', nativeSeq: askedSeq },
        });
        // Fail the native ask: the human dismissed the structured question and
        // no fabricated answer may reach the model.
        rejectAnswer(new Error('ASK_ABORTED: the user dismissed the question without answering'));
      };
      const settleAnswer = (answer: CordisUserQuestionAnswer) => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener('abort', onAbort);
        this.pendingInteractions.delete(interactionId);
        this.pendingQuestionRequests.delete(interactionId);
        const summary = answer.answers
          .map(entry => (entry.custom ?? entry.selected.join(', ')))
          .filter(text => text.length > 0)
          .join(' | ') || 'answered';
        this.emit({
          method: 'interaction.resolved',
          params: {
            sessionId,
            interactionId,
            outcome: 'submitted',
            actionId: 'submit',
            displaySummary: summary,
            nativeSeq: askedSeq,
          },
        });
        resolveAnswer(answer);
      };
      this.pendingInteractions.set(interactionId, {
        sessionId,
        interactionId,
        settle: (outcome) => {
          if (outcome !== 'answered') settleCancelled();
        },
        answer: (answer) => settleAnswer(answer),
      });
      this.pendingQuestionRequests.set(interactionId, request.questions);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      this.emit({
        method: 'interaction.requested',
        params: {
          sessionId,
          interactionId,
          kind: planReview !== undefined ? 'plan_review' : hasMulti ? 'choice' : 'question',
          title: planReview !== undefined
            ? 'Review plan'
            : request.questions[0]?.header ?? 'Question',
          ...(request.questions.length === 1 && request.questions[0]?.detail
            ? { description: request.questions[0]!.detail }
            : {}),
          ...(record.lastTurn === null ? {} : { turn: record.lastTurn }),
          ...(record.lastStep === null ? {} : { step: record.lastStep }),
          nativeSeq: askedSeq,
          inputs: request.questions.map((question) => {
            const select = Array.isArray(question.options) && question.options.length > 0;
            return {
              id: question.id,
              type: select
                ? (question.multiSelect === true ? 'multi_select' : 'single_select')
                : 'text',
              label: question.question,
              required: true,
              ...(question.detail ? { description: question.detail } : {}),
              ...(select
                ? {
                    choices: (question.options ?? []).map(option => ({
                      value: option.label,
                      displayName: option.label,
                      ...(option.description ? { description: option.description } : {}),
                    })),
                  }
                : {}),
            };
          }),
          actions: [
            { id: 'submit', label: planReview !== undefined ? 'Review verdict' : 'Submit', style: 'primary' },
            { id: 'cancel', label: 'Dismiss', style: 'secondary' },
          ],
          context: planReview !== undefined
            ? { approveOption: planReview.intent!.approve }
            : undefined,
        },
      });
      if (request.signal?.aborted) settleCancelled();
    });
  }

  /* ------------------------------------------------------------------ *
   * Structured turn input admission (attachments + skills)
   * ------------------------------------------------------------------ */

  private validateLocalPath(path: string): void {
    if (path.length === 0 || !path.startsWith('/')
      || path.split('/').some(part => part === '..')) {
      throw new BridgeProtocolError(
        -32000,
        `Attachment path must be an absolute Host path without traversal: ${path}`,
        'CONFIG_VALUE_INVALID',
      );
    }
  }

  /**
   * Convert structured input items into native message content blocks. Every
   * admission (existence, size, media type, storage) happens here, BEFORE the
   * caller admits the turn, so a failed attachment never consumes a native
   * turn ordinal.
   */
  private async admitInputItems(
    record: CordisSessionRecord,
    input: readonly BridgeTurnInputItem[],
  ): Promise<Array<Record<string, unknown>>> {
    const attachments = this.attachmentsRuntime();
    const blocks: Array<Record<string, unknown>> = [];
    const textParts: string[] = [];
    const pendingImages: Array<{ index: number; data: Uint8Array; mediaType: string; name?: string }> = [];

    for (const item of input) {
      if (item.type === 'text') {
        if (typeof item.text === 'string' && item.text.length > 0) textParts.push(item.text);
        continue;
      }
      if (item.type === 'skill') {
        if (typeof item.skill !== 'string' || item.skill.length === 0) {
          throw new BridgeProtocolError(-32000, 'Skill input requires a skill name.', 'CONFIG_VALUE_INVALID');
        }
        blocks.push(...await this.admitSkill(record, item.skill));
        continue;
      }
      if (attachments === null) {
        throw new BridgeProtocolError(
          -32000,
          'RUNTIME_UNAVAILABLE: DSH AttachmentStore is not mounted; file and image input are unavailable',
          'CONFIG_VALUE_INVALID',
        );
      }
      const path = typeof item.path === 'string' ? item.path : '';
      this.validateLocalPath(path);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        throw new BridgeProtocolError(-32000, `Attachment file does not exist: ${path}`, 'CONFIG_VALUE_INVALID');
      }
      if (stats.isFile() === false) {
        throw new BridgeProtocolError(-32000, `Attachment path is not a regular file: ${path}`, 'CONFIG_VALUE_INVALID');
      }
      const name = typeof item.name === 'string' && item.name.length > 0
        ? item.name
        : path.split('/').pop() ?? 'attachment';
      if (item.type === 'localImage') {
        const mediaType = this.imageMediaType(item.mime, path);
        if (typeof attachments.imageLimits === 'object' && attachments.imageLimits !== null
          && typeof attachments.imageLimits.maxImageBytes === 'number'
          && stats.size > attachments.imageLimits.maxImageBytes) {
          throw new BridgeProtocolError(
            -32000,
            `Image ${name} is ${stats.size} bytes; the runtime admits at most ${attachments.imageLimits.maxImageBytes}.`,
            'CONFIG_VALUE_INVALID',
          );
        }
        pendingImages.push({
          index: blocks.length,
          data: readFileSync(path),
          mediaType,
          name,
        });
        blocks.push({ __imagePlaceholder: true });
        continue;
      }
      if (stats.size > MAX_FILE_ADMISSION_BYTES) {
        throw new BridgeProtocolError(
          -32000,
          `File ${name} is ${stats.size} bytes; the bridge admits at most ${MAX_FILE_ADMISSION_BYTES} per file.`,
          'CONFIG_VALUE_INVALID',
        );
      }
      const ref = await attachments.saveFile({ data: readFileSync(path), name }).catch((error: unknown) => {
        throw new BridgeProtocolError(
          -32000,
          `File attachment was refused by the runtime: ${error instanceof Error ? error.message : String(error)}`,
          'CONFIG_VALUE_INVALID',
        );
      });
      blocks.push({ type: 'file', attachment: ref });
    }

    if (pendingImages.length > 0) {
      const store = this.attachmentsRuntime();
      if (store === null) {
        throw new BridgeProtocolError(
          -32000,
          'RUNTIME_UNAVAILABLE: DSH AttachmentStore is not mounted; image input is unavailable',
          'CONFIG_VALUE_INVALID',
        );
      }
      const refs = await store.saveImages(pendingImages.map(image => ({
        data: image.data,
        mediaType: image.mediaType,
        ...(image.name === undefined ? {} : { name: image.name }),
      }))).catch((error: unknown) => {
        throw new BridgeProtocolError(
          -32000,
          `Image attachment was refused by the runtime: ${error instanceof Error ? error.message : String(error)}`,
          'CONFIG_VALUE_INVALID',
        );
      });
      pendingImages.forEach((image, order) => {
        blocks[image.index] = { type: 'image', attachment: refs[order] };
      });
    }

    const text = textParts.join('\n');
    const withoutPlaceholders = blocks.filter(
      block => (block as { __imagePlaceholder?: boolean }).__imagePlaceholder !== true,
    );
    if (text.length > 0) {
      return [{ type: 'text', text }, ...withoutPlaceholders];
    }
    return withoutPlaceholders;
  }

  private imageMediaType(mime: unknown, path: string): string {
    if (typeof mime === 'string' && IMAGE_MEDIA_TYPES.has(mime)) return mime;
    const dot = path.lastIndexOf('.');
    const extension = dot >= 0 ? path.slice(dot).toLowerCase() : '';
    const inferred = IMAGE_EXTENSION_MEDIA_TYPES[extension];
    if (inferred !== undefined) return inferred;
    throw new BridgeProtocolError(
      -32000,
      `Image ${path} needs a supported media type (png, jpeg, webp, gif); got ${String(mime ?? 'none')}.`,
      'CONFIG_VALUE_INVALID',
    );
  }

  /**
   * Resolve a user-explicit skill invocation through `ctx.skills` and return
   * the injected instruction block. The rendered body uses the runtime's own
   * `renderSkillContent` when the DSH skill package is resolvable so the model
   * sees the canonical `<skill_content>` shape shared with the skill tool.
   */
  private async admitSkill(record: CordisSessionRecord, name: string): Promise<Array<Record<string, unknown>>> {
    const skills = this.skillsRuntime();
    if (skills === null) {
      throw new BridgeProtocolError(
        -32000,
        'RUNTIME_UNAVAILABLE: DSH SkillRegistry is not mounted; skill input is unavailable',
        'CONFIG_VALUE_INVALID',
      );
    }
    const definition = await skills.get(name, { cwd: record.cwd }).catch(() => undefined);
    if (definition === undefined || typeof definition.content !== 'string') {
      throw new BridgeProtocolError(-32000, `Skill ${name} was not found in the runtime catalog.`, 'CONFIG_VALUE_INVALID');
    }
    const invocation = definition.invocation as { userInvocable?: boolean } | undefined;
    if (invocation?.userInvocable === false) {
      throw new BridgeProtocolError(-32000, `Skill ${name} is not user-invocable.`, 'CONFIG_VALUE_INVALID');
    }
    let rendered = definition.content;
    try {
      const specifier = '@deepseek-ai/dsh-skill';
      const skillPackage = await import(specifier) as {
        renderSkillContent?: (skill: Record<string, unknown>) => string;
      };
      if (typeof skillPackage.renderSkillContent === 'function') {
        rendered = skillPackage.renderSkillContent({
          name: definition.name ?? name,
          provider: definition.provider,
          ...(definition.resourceBase === undefined ? {} : { resourceBase: definition.resourceBase }),
          content: definition.content,
        });
      }
    } catch {
      // Outside a composed DSH profile the canonical renderer is unavailable;
      // the real skill body is still delivered verbatim.
    }
    return [{
      type: 'text',
      text: rendered,
      source: { kind: 'skill-invocation', name, form: 'instructions' },
    }];
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
    // An effort that the selected model does not advertise is dropped (and a
    // stale inherited effort is cleared) rather than guessed onto the request.
    let effort = typeof config.effort === 'string' ? config.effort : undefined;
    if (effort !== undefined) {
      const advertised = match.reasoning?.efforts?.some(candidate => candidate.id === effort);
      if (advertised !== true) effort = undefined;
    }
    const requested = {
      provider: match.provider,
      model: match.id,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
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
    const skills = this.skillsRuntime() !== null;
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
        'session.fork': 1,
        ...(this.sessionPersistenceRuntime() !== null ? { 'session.native.list': 1 } : {}),
        'turn.interrupt': 1,
        'turn.steer': 1,
        'catalog.changed': 1,
        ...(this.supportsApprovalInteraction() || this.supportsUserQuestions()
          ? { interaction: 1 }
          : {}),
        ...(this.attachmentsRuntime() !== null ? { 'input.attachments': 1 } : {}),
        ...(skills ? { 'input.skill': 1, 'customization.skill': 1 } : {}),
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
    const attachments = this.attachmentsRuntime();
    const modelInputModalities = new Set(
      models.flatMap(model => Array.isArray(model.inputModalities) ? model.inputModalities : []),
    );
    const input: Array<Record<string, unknown>> = [{ type: 'text' }];
    if (attachments !== null) {
      input.push({ type: 'localFile' });
      if (modelInputModalities.has('image')) input.push({ type: 'localImage' });
    }
    if (this.skillsRuntime() !== null) input.push({ type: 'skill' });
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
      input,
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
      this.installUserQuestions(agentCtx, params.sessionId);
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
      openTurn: null,
    };
    this.sessions.set(record.id, record);
    this.byNativeId.set(record.nativeId, record);
    this.emit({
      method: 'agent.status',
      params: { sessionId: record.id, nativeId, status: handle.agent.status },
    });
    return this.sessionResult(record);
  }

  /**
   * Re-attach an existing native DSH session under a new bridge session id
   * (Side Chat resume). This is a proxy-internal surface: unlike
   * `session.create`'s native branch there is no Host ownership proof,
   * because the bridge process itself is the trust boundary and the caller
   * authenticated through the sealed resumeRef. Selection falls back to the
   * catalog defaults; the next `turn.start.config` re-pins the real one.
   */
  async sessionResume(params: { sessionId: string; nativeSessionId: string }): Promise<Record<string, unknown>> {
    if (this.sessions.has(params.sessionId)) {
      throw new BridgeProtocolError(
        -32000,
        `CONFLICT: DSH bridge session ${params.sessionId} already exists`,
        'CONFLICT',
      );
    }
    if (this.byNativeId.has(params.nativeSessionId)) {
      throw new BridgeProtocolError(
        -32000,
        `CONFLICT: DSH native session ${params.nativeSessionId} is already attached`,
        'CONFLICT',
      );
    }
    const models = await this.catalogModels();
    const defaults = this.defaultSelection(models);
    const selection: DshModelSelectionRef = {
      current: { provider: defaults.provider, model: defaults.model },
    };
    const presets = this.agentPresetsRuntime();
    const setup = async (agentCtx: AnyContext) => {
      if (presets !== null) {
        const scopedAgent = agentCtx.agent;
        if (!scopedAgent) {
          throw new Error('RUNTIME_UNAVAILABLE: resumed DSH Agent is unavailable during setup');
        }
        const persistedPreset = await presets.resolve(sessionAgentPreset(scopedAgent.session));
        if (persistedPreset.broken) {
          throw new Error(`RUNTIME_UNAVAILABLE: DSH Agent preset ${persistedPreset.id} is broken: ${persistedPreset.broken}`);
        }
        await presets.mount(agentCtx, persistedPreset.id);
      }
      installModelSelection(agentCtx, selection);
      this.installApprovalInteraction(agentCtx, params.sessionId);
      this.installUserQuestions(agentCtx, params.sessionId);
    };
    let handle: CordisAgentHandle;
    try {
      handle = await this.agentRegistry().resume({
        resumeSessionId: params.nativeSessionId,
        agentOptions: { provider: selection.current.provider, model: selection.current.model },
        setup,
      });
    } catch (error) {
      if (error instanceof Error && /^session ".+" not found$/.test(error.message)) {
        throw new BridgeProtocolError(
          -32000,
          `DSH native session ${params.nativeSessionId} was not found.`,
          'NATIVE_SESSION_NOT_FOUND',
        );
      }
      throw error;
    }
    const header = handle.agent.session.header ?? null;
    const createdAtMs = header !== null && typeof header.createdAt === 'number' ? header.createdAt : undefined;
    const record: CordisSessionRecord = {
      id: params.sessionId,
      nativeId: params.nativeSessionId,
      // The live Cordis session header carries no cwd; the Side Chat record
      // re-derives cwd/roots from its parent on the proxy side.
      cwd: '',
      // Roots are a bridge-level sandbox concept with no native header
      // counterpart; the Side Chat record re-derives them from its parent.
      roots: [],
      config: {},
      createdAt: new Date(createdAtMs ?? Date.now()).toISOString(),
      handle,
      selection,
      lastTurn: null,
      lastStep: null,
      openTurn: null,
    };
    this.sessions.set(record.id, record);
    this.byNativeId.set(record.nativeId, record);
    this.emit({
      method: 'agent.status',
      params: { sessionId: record.id, nativeId: record.nativeId, status: handle.agent.status },
    });
    return this.sessionResult(record);
  }

  async sessionGet(params: { sessionId: string }): Promise<Record<string, unknown>> {
    return this.sessionResult(this.session(params.sessionId));
  }

  async sessionClose(params: { sessionId: string }): Promise<Record<string, unknown>> {
    const record = this.session(params.sessionId);
    this.settleSessionInteractions(record.id);
    record.handle.agent.cancel({ kind: 'user' });
    await record.handle.agent.whenIdle();
    await record.handle.dispose();
    this.sessions.delete(record.id);
    this.assistantStreams.delete(record.id);
    this.byNativeId.delete(record.nativeId);
    for (const [childNativeId, facts] of [...this.children.entries()]) {
      if (facts.parentSessionId === record.id) this.children.delete(childNativeId);
    }
    this.emit({
      method: 'agent.status',
      params: { sessionId: record.id, nativeId: record.nativeId, status: 'idle' },
    });
    return { ok: true };
  }

  async sessionNativeList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const persistence = this.sessionPersistenceRuntime();
    if (persistence === null) {
      throw new BridgeProtocolError(
        -32000,
        'RUNTIME_UNAVAILABLE: DSH SessionPersistence is not mounted',
        'RUNTIME_UNAVAILABLE',
      );
    }
    const snapshots = await persistence.list();
    const limit = typeof params.limit === 'number' && params.limit > 0
      ? Math.floor(params.limit)
      : 100;
    const offset = typeof params.cursor === 'string' && params.cursor.length > 0
      ? Number(params.cursor)
      : 0;
    // Subagent-origin sessions are presentation children, not continuable
    // user sessions, and fork-lineage children (persistent forks and Side
    // Chats) are owned by their Gian parent — listing them would invite
    // double adoption of an already-managed context, so both stay out.
    const summaries = snapshots
      .filter(snapshot => snapshot.header.origin !== 'subagent'
        && snapshot.header.parentSession === undefined)
      .map(snapshot => ({
        id: String(snapshot.header.id),
        cwd: snapshot.header.cwd,
        updatedAt: new Date(
          typeof snapshot.header.createdAt === 'number' ? snapshot.header.createdAt : 0,
        ).toISOString(),
      }));
    const page = summaries.slice(offset, offset + limit);
    return {
      sessions: page,
      nextCursor: offset + page.length < summaries.length ? String(offset + page.length) : null,
    };
  }

  async sessionRename(): Promise<Record<string, unknown>> {
    // Verified absence in @deepseek-ai/dsh@0.1.5-rc.3: SessionHeader carries no
    // title, SessionPersistenceSnapshot has no displayName, and neither the
    // storage contract nor the session surface exposes a rename operation.
    throw new BridgeProtocolError(
      -32000,
      'RUNTIME_UNAVAILABLE: DSH exposes no native session title/rename API',
      'CAPABILITY_NOT_SUPPORTED',
    );
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
    if (record.openTurn !== null) {
      throw new BridgeProtocolError(
        -32000,
        `SESSION_BUSY: native turn ${record.openTurn} is still open`,
        'SESSION_BUSY',
      );
    }
    const selection = await this.resolveTurnSelection(record, params.config);
    record.selection.current = selection;
    const permissionPreset = params.config.permission_preset;
    if (typeof permissionPreset === 'string') {
      const permissions = this.permissionPresetsRuntime();
      if (permissions === null) {
        throw new Error('RUNTIME_UNAVAILABLE: DSH PermissionPresetService is not mounted');
      }
      permissions.set(record.handle.agent.session, permissionPreset);
    }
    // Structured admission runs before any inbox delivery: a failed image,
    // file, or skill must reject the turn before a native ordinal is consumed.
    const blocks = await this.admitInputItems(record, params.input);
    if (blocks.length === 0) {
      throw new BridgeProtocolError(-32000, 'Turn input resolved to no native content.', 'CONFIG_VALUE_INVALID');
    }
    const instructionBlocks = blocks.filter(
      block => typeof (block as { source?: { kind?: string } }).source?.kind === 'string'
        && (block as { source: { kind: string } }).source.kind === 'skill-invocation',
    );
    const messageBlocks = blocks.filter(block => block !== null && !instructionBlocks.includes(block));
    // Skill bodies ride the native injected-context channel (instructions-form
    // `agent.inject`), the same path the runtime uses for user-explicit
    // invocations; the user's own words remain the turn's user message.
    for (const block of instructionBlocks) {
      record.handle.agent.inject({
        id: randomUUID(),
        role: 'user',
        content: [block],
        source: (block as { source: Record<string, unknown> }).source,
      });
    }
    record.handle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: messageBlocks,
      source: { kind: 'user' },
    });
    return { accepted: true };
  }

  async turnSteer(params: { sessionId: string; turnId?: string; input: unknown[] }): Promise<Record<string, unknown>> {
    const record = this.session(params.sessionId);
    if (record.openTurn === null) {
      throw new BridgeProtocolError(
        -32000,
        'TURN_NOT_FOUND: steering requires an open native turn; queue the input as a new turn instead.',
        'TURN_NOT_FOUND',
      );
    }
    // The runtime consumes steering at the nearest step boundary of the open
    // turn and logs the durable claim; retries and new steering are decided
    // proxy-side, the bridge refuses only when no open turn exists.
    const blocks = await this.admitInputItems(record, params.input as BridgeTurnInputItem[]);
    if (blocks.length === 0) {
      throw new BridgeProtocolError(-32000, 'Steer input resolved to no native content.', 'CONFIG_VALUE_INVALID');
    }
    record.handle.agent.steer({
      id: randomUUID(),
      role: 'user',
      content: blocks,
      source: { kind: 'user' },
    });
    return { accepted: true, openTurn: record.openTurn };
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
    const pending = this.pendingInteractions.get(params.interactionId);
    if (!pending || pending.sessionId !== params.sessionId) {
      throw new BridgeProtocolError(
        -32000,
        `interaction ${params.interactionId} is not pending`,
        'INTERACTION_NOT_FOUND',
      );
    }
    if (pending.answer !== undefined) {
      if (params.actionId === 'cancel') {
        pending.settle('cancelled');
        return { accepted: true };
      }
      const request = this.pendingQuestionRequests.get(params.interactionId);
      const questions = request ?? [];
      pending.answer({
        answers: questions.map((question) => {
          const raw = params.values[question.id];
          const select = Array.isArray(question.options) && question.options.length > 0;
          if (select) {
            const selected = Array.isArray(raw)
              ? raw.map(String)
              : typeof raw === 'string' ? [raw] : [];
            return { id: question.id, selected };
          }
          return {
            id: question.id,
            selected: [],
            ...(typeof raw === 'string' && raw.length > 0 ? { custom: raw } : {}),
          };
        }),
      });
      return { accepted: true };
    }
    if (params.actionId === 'allow-once') {
      pending.settle('answered', 'allow-once');
    } else if (params.actionId === 'reject') {
      pending.settle('answered', 'reject');
    } else if (params.actionId === 'cancel') {
      pending.settle('cancelled');
    } else {
      throw new BridgeProtocolError(
        -32000,
        `unsupported approval action ${String(params.actionId)}`,
        'INTERACTION_ACTION_NOT_FOUND',
      );
    }
    return { accepted: true };
  }

  /** Remember structured question payloads so respond can rebuild answers. */
  private readonly pendingQuestionRequests = new Map<string, CordisUserQuestionItem[]>();

  async sessionFork(params: BridgeSessionForkParams): Promise<Record<string, unknown>> {
    return this.forkSession(params);
  }

  private async forkSession(params: BridgeSessionForkParams): Promise<Record<string, unknown>> {
    if (this.sessions.has(params.newSessionId)) {
      throw new BridgeProtocolError(
        -32000,
        `CONFLICT: DSH bridge session ${params.newSessionId} already exists`,
        'CONFLICT',
      );
    }
    const record = this.session(params.sessionId);
    const source = record.handle.agent.session;
    const events = Array.isArray(source.events) ? [...source.events] : [];

    let boundary: number;
    if (params.anchor.kind === 'head') {
      boundary = events.length - 1;
      // A head boundary inside an open native turn has no verifiable sequence
      // cut; refuse rather than guessing the nearest closed turn.
      const openTurn = this.openTurnAt(events, boundary);
      if (openTurn !== null) {
        throw new BridgeProtocolError(
          -32000,
          `FORK_BOUNDARY_UNAVAILABLE: native head boundary is inside open turn ${openTurn}`,
          'FORK_BOUNDARY_UNAVAILABLE',
        );
      }
    } else {
      const turnEnd = this.turnEndSeq(events, params.anchor.nativeTurn);
      if (turnEnd === null) {
        throw new BridgeProtocolError(
          -32000,
          `FORK_BOUNDARY_UNAVAILABLE: native turn ${params.anchor.nativeTurn} has no verifiable turn/end boundary in the source log`,
          'FORK_BOUNDARY_UNAVAILABLE',
        );
      }
      boundary = turnEnd;
    }

    const seed = boundary >= 0 ? events.slice(0, boundary + 1) : [];
    const childNativeId = `session-${randomUUID()}`;
    const models = await this.catalogModels();
    const selection: DshModelSelectionRef = { current: { ...record.selection.current } };
    const presets = this.agentPresetsRuntime();
    const inheritedPreset = sessionAgentPreset(source);
    const setup = async (agentCtx: AnyContext) => {
      if (presets !== null) await presets.mount(agentCtx, inheritedPreset);
      installModelSelection(agentCtx, selection);
      this.installApprovalInteraction(agentCtx, params.newSessionId);
      this.installUserQuestions(agentCtx, params.newSessionId);
    };
    let handle: CordisAgentHandle;
    try {
      handle = await this.agentRegistry().create({
        sessionId: childNativeId,
        meta: {
          cwd: record.cwd,
          parentSession: record.nativeId,
          // An empty source forks an empty child: no inherited prefix exists,
          // so the durable isSeeded marker stays false (replay history alone
          // never makes a session inherited).
          ...(seed.length > 0 ? { isSeeded: true } : {}),
          ...(inheritedPreset === undefined ? {} : { agentPreset: inheritedPreset }),
        },
        ...(seed.length > 0
          ? { inheritedEventCount: seed.length, seed }
          : {}),
        agentOptions: {
          provider: selection.current.provider,
          model: selection.current.model,
        },
        setup,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) {
        throw new BridgeProtocolError(-32000, `CONFLICT: ${message}`, 'CONFLICT');
      }
      if (/open turn|inside an open turn/i.test(message)) {
        throw new BridgeProtocolError(-32000, `FORK_BOUNDARY_UNAVAILABLE: ${message}`, 'FORK_BOUNDARY_UNAVAILABLE');
      }
      throw error;
    }
    const childRecord: CordisSessionRecord = {
      id: params.newSessionId,
      nativeId: childNativeId,
      cwd: record.cwd,
      roots: [...record.roots],
      config: { ...record.config },
      createdAt: new Date(
        typeof handle.agent.session.header?.createdAt === 'number'
          ? handle.agent.session.header.createdAt
          : Date.now(),
      ).toISOString(),
      handle,
      selection,
      lastTurn: null,
      lastStep: null,
      openTurn: null,
    };
    this.sessions.set(childRecord.id, childRecord);
    this.byNativeId.set(childNativeId, childRecord);
    this.emit({
      method: 'agent.status',
      params: { sessionId: childRecord.id, nativeId: childNativeId, status: handle.agent.status },
    });
    return {
      ...this.sessionResult(childRecord),
      parentNativeId: record.nativeId,
      atSeq: boundary,
      seedEventCount: seed.length,
      inheritedEventCount: handle.agent.session.inheritedEventCount ?? seed.length,
    };
  }

  /** Seq of the `turn/end` closing `nativeTurn`, or null when unbounded. */
  private turnEndSeq(events: readonly CordisSessionEvent[], nativeTurn: number): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event === undefined) continue;
      if (event.type === 'turn/end' && event.data.turn === nativeTurn) return index;
    }
    return null;
  }

  /** Native turn ordinal open at `boundary` (inclusive), or null. */
  private openTurnAt(events: readonly CordisSessionEvent[], boundary: number): number | null {
    let open: number | null = null;
    for (let index = 0; index <= boundary && index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined) continue;
      if (event.type === 'turn/start' && typeof event.data.turn === 'number') open = event.data.turn;
      if (event.type === 'turn/end' && event.data.turn === open) open = null;
    }
    return open;
  }

  async customizationList(params: BridgeCustomizationListParams): Promise<Record<string, unknown>> {
    if (params.kind !== 'skill') {
      // Verified absence in 0.1.5-rc.3: MCP servers are static profile plugin
      // instances (`@deepseek-ai/dsh-mcp-client` config), and the hooks
      // packages expose no enumeration registry — there is no runtime API to
      // inventory them read-only.
      return {
        kind: params.kind,
        status: 'provider_unsupported',
        completeness: 'none',
        observedAt: new Date().toISOString(),
        items: [],
        truncated: false,
        diagnostics: [{
          code: 'SOURCE_NOT_ENUMERABLE',
          message: 'This DSH build exposes no runtime enumeration API for this customization kind.',
        }],
      };
    }
    const skills = this.skillsRuntime();
    if (skills === null) {
      return {
        kind: 'skill',
        status: 'unavailable',
        completeness: 'none',
        observedAt: new Date().toISOString(),
        items: [],
        truncated: false,
        diagnostics: [{
          code: 'PROVIDER_INSPECTION_FAILED',
          message: 'DSH SkillRegistry is not mounted on this profile.',
        }],
      };
    }
    const summaries = await skills.list({ ...(params.cwd === undefined ? {} : { cwd: params.cwd }) });
    const items = summaries.slice(0, 500).map((summary) => {
      const record = summary as {
        name?: string;
        description?: string;
        source?: string;
        path?: string;
        invocation?: { userInvocable?: boolean; modelInvocable?: boolean };
      };
      const name = String(record.name ?? '');
      const source = String(record.source ?? 'unknown');
      const userInvocable = record.invocation?.userInvocable ?? null;
      const modelInvocable = record.invocation?.modelInvocable ?? null;
      return {
        id: customizationStableId('skill', `runtime:${source}`, String(record.path ?? `skill:${name}`), name),
        kind: 'skill',
        name,
        ...(typeof record.description === 'string' ? { description: record.description } : {}),
        activation: userInvocable === false && modelInvocable === false ? 'disabled' : 'enabled',
        scope: { level: 'user', native: source },
        origin: {
          kind: 'builtin',
          ...(typeof record.path === 'string' ? { path: record.path } : {}),
        },
        discovery: { method: 'provider_api' },
        skill: {
          format: 'agent-skill',
          ...(typeof record.path === 'string' ? { entryPath: record.path } : {}),
          invocation: source,
          userInvocable,
          modelInvocable,
        },
      };
    });
    return {
      kind: 'skill',
      status: 'ok',
      completeness: 'effective',
      observedAt: new Date().toISOString(),
      items,
      truncated: summaries.length > 500,
      diagnostics: [],
    };
  }

  async customizationDetail(params: BridgeCustomizationDetailParams): Promise<Record<string, unknown>> {
    if (params.kind !== 'skill') {
      return {
        kind: params.kind,
        id: params.id,
        status: 'unavailable',
        observedAt: new Date().toISOString(),
        text: '',
        truncated: false,
        diagnostics: [{
          code: 'SOURCE_NOT_ENUMERABLE',
          message: 'This DSH build exposes no runtime enumeration API for this customization kind.',
        }],
      };
    }
    const list = await this.customizationList({ kind: 'skill', ...(params.cwd === undefined ? {} : { cwd: params.cwd }) });
    const items = Array.isArray(list.items) ? list.items as Array<Record<string, unknown>> : [];
    const match = items.find(item => item.id === params.id);
    if (match === undefined) {
      return {
        kind: params.kind,
        id: params.id,
        status: 'unavailable',
        observedAt: new Date().toISOString(),
        text: '',
        truncated: false,
        diagnostics: [{ code: 'SOURCE_UNREADABLE', message: 'No skill matches this id in the runtime catalog.' }],
      };
    }
    const skills = this.skillsRuntime();
    const name = String(match.name ?? '');
    const definition = skills === null
      ? undefined
      : await skills.get(name, { ...(params.cwd === undefined ? {} : { cwd: params.cwd }) }).catch(() => undefined);
    const text = definition !== undefined && typeof definition.content === 'string'
      ? definition.content
      : String(match.description ?? '');
    return {
      kind: 'skill',
      id: params.id,
      status: 'ok',
      observedAt: new Date().toISOString(),
      text,
      truncated: false,
    };
  }

  private settleSessionInteractions(sessionId: string): void {
    for (const pending of [...this.pendingInteractions.values()]) {
      if (pending.sessionId === sessionId) pending.settle('cancelled');
    }
  }

  private handleSubagentStart(payload: unknown): void {
    if (this.disposed || !payload || typeof payload !== 'object') return;
    const info = payload as CordisSubagentRunInfo;
    if (typeof info.runId !== 'string' || typeof info.id !== 'string') return;
    const parent = this.attributedParent(info.id);
    if (parent === null) return;
    this.children.set(info.id, {
      parentSessionId: parent.id,
      runId: info.runId,
      childNativeId: info.id,
    });
    this.emit({
      method: 'subagent.started',
      params: {
        sessionId: parent.id,
        agentId: info.runId,
        childNativeId: info.id,
        provider: info.provider,
        state: 'running',
      },
    });
  }

  private handleSubagentEnd(payload: unknown): void {
    if (this.disposed || !payload || typeof payload !== 'object') return;
    const info = payload as CordisSubagentRunEndInfo;
    if (typeof info.runId !== 'string' || typeof info.id !== 'string') return;
    const facts = this.children.get(info.id);
    const parent = (facts !== undefined ? this.sessions.get(facts.parentSessionId) : this.attributedParent(info.id)) ?? null;
    this.children.delete(info.id);
    if (parent === null) return;
    const state = info.stopReason === 'completed' || info.stopReason === 'max-tokens'
      ? 'completed'
      : info.stopReason === 'aborted'
        ? 'cancelled'
        : 'failed';
    this.emit({
      method: 'subagent.finished',
      params: {
        sessionId: parent.id,
        agentId: info.runId,
        childNativeId: info.id,
        state,
        stopReason: info.stopReason,
      },
    });
  }

  /** Find the Gian record whose agent owns this child, when attribution is provable. */
  private attributedParent(childNativeId: string): CordisSessionRecord | null {
    const registry = this.ctx.get?.('agents') ?? this.ctx.agents;
    if (registry !== null && typeof registry === 'object'
      && typeof (registry as CordisAgentRegistry).isOwnedBy === 'function') {
      for (const record of this.sessions.values()) {
        try {
          if ((registry as CordisAgentRegistry).isOwnedBy!(childNativeId, record.handle.agent)) {
            return record;
          }
        } catch {
          // Ownership probing must never break event delivery.
        }
      }
    }
    return null;
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
      // cannot revive the completed attempt. The committed settlement seq
      // travels with the durable event, so nothing else is needed here.
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
    if (!record) {
      this.handleChildSessionEvent(sessionId, event);
      return;
    }

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

  /** Project attributed child-agent tool activity into the parent session. */
  private handleChildSessionEvent(nativeId: string, event: unknown): void {
    const facts = this.children.get(nativeId);
    if (facts === undefined) return;
    const typed = event as { type?: unknown; seq?: unknown; data?: unknown } | null;
    if (typed === null || typeof typed !== 'object') return;
    if (typeof typed.type !== 'string' || typeof typed.seq !== 'number') return;
    if (typed.type !== 'tool/call' && typed.type !== 'tool/result') return;
    const data = (typed.data ?? {}) as Record<string, unknown>;
    const record = this.sessions.get(facts.parentSessionId);
    if (record === undefined) return;
    this.emit({
      method: 'subagent.activity',
      params: {
        sessionId: record.id,
        agentId: facts.runId,
        childNativeId: nativeId,
        childSeq: typed.seq,
        kind: typed.type,
        callId: typeof data.callId === 'string' ? data.callId : '',
        name: typeof data.name === 'string' ? data.name : '',
        ...(typed.type === 'tool/result' ? { error: data.error !== undefined } : {}),
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
      record.openTurn = data.turn;
    }
    if (type === 'turn/end' && typeof data.turn === 'number' && data.turn === record.openTurn) {
      record.openTurn = null;
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
    this.offSubagentStart?.();
    this.offSubagentEnd?.();
    this.children.clear();
    this.offCatalogChanged?.();
    this.byNativeId.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(records.map(async (record) => {
      this.settleSessionInteractions(record.id);
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

export default CordisDshHost;
