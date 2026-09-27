/**
 * Deterministic fake DSH runtime implementing the `BridgeHost` seam.
 *
 * It replays the exact event vocabulary the real `gian` profile emits from
 * `ctx.agents` / `session/event` (turn/step boundaries, assistant chunks and
 * assembled messages with usage, tool calls/results with fs-diff meta, request
 * headers/context, approval asks and structured user questions, todo/plan
 * snapshots, subagent run lifecycle) with zero model calls and zero persisted
 * state.
 *
 * Two root sessions and one in-process child are the canonical WP1 shape:
 * every event carries a sessionId and a native turn/step so the proxy can
 * derive sourceTurnId / stepId without any cordis runtime.
 */

import { DSH_SESSION_FORMAT_VERSION, type BridgeJsonValue } from './schema.js';
import { verifyHostBinding } from './host-binding.js';
import type {
  BridgeCustomizationDetailParams,
  BridgeCustomizationListParams,
  BridgeHost,
  BridgeHostEvent,
  BridgeInteractionRespondParams,
  BridgeInteractionRequest,
  BridgeSessionCreateParams,
  BridgeSessionForkParams,
  BridgeTurnStartParams,
} from './host.js';

export interface FakeSession {
  id: string;
  nativeId: string;
  cwd: string;
  roots: string[];
  config: Record<string, BridgeJsonValue>;
  createdAt: string;
  events: Array<{ type: string; seq: number; time: number; data: Record<string, unknown> }>;
  closed: boolean;
  /** Native turn ordinal currently open, mirroring cordis-host tracking. */
  openTurn: number | null;
  /** Fork lineage for `session.fork` projections. */
  parentNativeId?: string;
}

export interface FakeHostOptions {
  bridgeVersion?: string;
  dshVersion?: string;
  /** When set, turn.start produces a scripted event sequence. */
  script?: 'success' | 'approval' | 'question' | 'interrupt' | 'error' | 'multi-step'
    | 'plan' | 'diff' | 'subagent' | 'attachments';
  /** When set, every turn is interrupted by the pending native question. */
  autoQuestion?: boolean;
  /** When set, the host has no reliable ownership API (default). */
  reliableOwnership?: boolean;
  hostBindingKey?: string;
  /** Absolute attachment admission refusals for paths containing `/refused/`. */
  refuseAttachments?: boolean;
  /** Native image byte limit used by fake admission (default 8 MiB). */
  maxImageBytes?: number;
}

let sessionCounter = 0;
let interactionCounter = 0;

export function mintId(prefix: string): string {
  sessionCounter += 1;
  return `${prefix}-${sessionCounter}-${Date.now().toString(36)}`;
}

function event(
  type: string,
  sessionId: string,
  seq: number,
  data: Record<string, unknown>,
): BridgeHostEvent {
  return {
    method: 'session.event',
    params: { sessionId, nativeSeq: seq, type, data },
  };
}

export class FakeDshRuntime implements BridgeHost {
  readonly kind = 'fake' as const;
  readonly bridgeVersion: string;
  readonly dshVersion: string;
  readonly sessionFormatVersion = DSH_SESSION_FORMAT_VERSION;
  readonly sessions = new Map<string, FakeSession>();
  readonly pendingInteractions = new Map<string, BridgeInteractionRequest>();
  /** Structured user-question payloads pending behind interaction ids. */
  readonly pendingQuestions = new Map<string, { questions: Array<Record<string, unknown>>; resolve: (answer: unknown) => void; reject: (error: Error) => void }>();
  private sink: ((event: BridgeHostEvent) => void) | null = null;
  private initialized = false;
  private early: BridgeHostEvent[] = [];

  constructor(private readonly options: FakeHostOptions = {}) {
    this.bridgeVersion = options.bridgeVersion ?? '0.1.5';
    this.dshVersion = options.dshVersion ?? '0.1.5-rc.3';
  }

  attachSink(sink: (event: BridgeHostEvent) => void): void {
    this.sink = sink;
    if (this.sink) {
      const pending = this.early.splice(0);
      for (const item of pending) this.sink(item);
    }
  }

  /** Test-only escape hatch to push an arbitrary bridge host event. */
  emitForTest(ev: BridgeHostEvent): void {
    this.emit(ev);
  }

  /**
   * Test-only native structured question: resolves when the proxy answers or
   * rejects on cancel, mirroring `ctx.userQuestions.ask`.
   */
  askFakeQuestion(
    sessionId: string,
    questions: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    interactionCounter += 1;
    const interactionId = `question-${interactionCounter}`;
    this.emit({
      method: 'interaction.requested',
      params: {
        sessionId,
        interactionId,
        kind: questions.some(q => q.intent !== undefined) ? 'plan_review' : 'question',
        title: 'Question',
        inputs: questions.map((question) => ({
          id: question.id,
          type: question.multiSelect === true
            ? 'multi_select'
            : Array.isArray(question.options) ? 'single_select' : 'text',
          label: question.question,
          required: true,
          ...(Array.isArray(question.options)
            ? {
                choices: (question.options as Array<Record<string, unknown>>).map(option => ({
                  value: String(option.label),
                  displayName: String(option.label),
                })),
              }
            : {}),
        })),
        actions: [
          { id: 'submit', label: 'Submit', style: 'primary' },
          { id: 'cancel', label: 'Dismiss', style: 'secondary' },
        ],
      },
    });
    return new Promise((resolve, reject) => {
      this.pendingQuestions.set(interactionId, { questions, resolve, reject });
    });
  }

  private emit(ev: BridgeHostEvent): void {
    if (this.sink) this.sink(ev);
    else this.early.push(ev);
  }

  private session(id: string): FakeSession {
    const found = this.sessions.get(id);
    if (!found) throw new Error(`fake session ${id} not found`);
    return found;
  }

  private append(sessionId: string, type: string, data: Record<string, unknown>): number {
    const s = this.session(sessionId);
    const seq = s.events.length;
    const record = { type, seq, time: Date.now(), data };
    s.events.push(record);
    this.emit(event(type, sessionId, seq, data));
    return seq;
  }

  async initialize(): Promise<Record<string, unknown>> {
    this.initialized = true;
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
        'session.native.list': 1,
        'turn.interrupt': 1,
        'turn.steer': 1,
        'catalog.changed': 1,
        interaction: 1,
        'input.attachments': 1,
        'input.skill': 1,
        'customization.skill': 1,
        'event.step': 1,
        'event.request': 1,
        'event.usage': 1,
      },
    };
  }

  async catalogList(): Promise<Record<string, unknown>> {
    return {
      catalogRevision: `fake-catalog-${this.dshVersion}`,
      providers: [{ id: 'deepseek', label: 'DeepSeek' }],
      models: [
        {
          id: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek Chat',
          inputModalities: ['text', 'image'],
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
        },
        { id: 'deepseek-reasoner', provider: 'deepseek', label: 'DeepSeek Reasoner' },
      ],
      input: [{ type: 'text' }, { type: 'localFile' }, { type: 'localImage' }, { type: 'skill' }],
      approvalPolicies: ['ask', 'never'],
      defaultApprovalPolicy: 'ask',
      permissionPresets: [
        { id: 'workspace-write', label: 'Workspace Write', approvalPolicy: 'ask' },
        { id: 'danger-full-access', label: 'Full access', approvalPolicy: 'never' },
      ],
      defaultPermissionPreset: 'workspace-write',
      agentPresets: ['standard', 'code', 'minimal'],
      defaultAgentPreset: 'standard',
      slashCommands: [
        { name: '/compact', description: 'Compact the session', source: 'builtin' },
      ],
    };
  }

  async catalogResolve(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.catalogList();
    return {
      ...list,
      resolvedDefaults: {
        sessionConfig: {},
        turnConfig: (params.turnConfig ?? {}) as Record<string, unknown>,
      },
    };
  }

  async sessionCreate(params: BridgeSessionCreateParams): Promise<Record<string, unknown>> {
    if (params.nativeSessionId !== undefined) {
      if (params.restartNewStream === true) {
        throw new Error('RUNTIME_UNAVAILABLE: native session adoption is not supported');
      }
      const key = this.options.hostBindingKey;
      const proof = params.hostBindingProof;
      if (key === undefined || proof === undefined || !verifyHostBinding(key, {
        pluginId: 'ai.deepseek.harness',
        sessionId: params.sessionId,
        nativeSessionId: params.nativeSessionId,
        cwd: params.cwd,
      }, proof)) {
        throw new Error('RUNTIME_UNAVAILABLE: native attach requires a valid Host ownership proof');
      }
    }
    const nativeId = params.nativeSessionId ?? mintId('dsn');
    const record: FakeSession = {
      id: params.sessionId,
      nativeId,
      cwd: params.cwd,
      roots: params.roots,
      config: params.config,
      createdAt: new Date().toISOString(),
      events: [],
      closed: false,
      openTurn: null,
    };
    this.sessions.set(params.sessionId, record);
    this.emit({
      method: 'agent.status',
      params: { sessionId: params.sessionId, nativeId, status: 'idle' },
    });
    return {
      session: {
        id: params.sessionId,
        nativeId,
        cwd: params.cwd,
        roots: params.roots,
        state: 'idle',
        config: params.config,
        createdAt: record.createdAt,
      },
    };
  }

  async sessionResume(params: { sessionId: string; nativeSessionId: string }): Promise<Record<string, unknown>> {
    const record: FakeSession = {
      id: params.sessionId,
      nativeId: params.nativeSessionId,
      cwd: '/tmp/resumed',
      roots: ['/tmp/resumed'],
      config: {},
      createdAt: new Date().toISOString(),
      events: [],
      closed: false,
      openTurn: null,
    };
    this.sessions.set(params.sessionId, record);
    return {
      session: {
        id: params.sessionId,
        nativeId: params.nativeSessionId,
        cwd: record.cwd,
        roots: record.roots,
        state: 'idle',
        config: {},
        createdAt: record.createdAt,
      },
    };
  }

  async sessionGet(params: { sessionId: string }): Promise<Record<string, unknown>> {
    const s = this.session(params.sessionId);
    return {
      session: {
        id: s.id,
        nativeId: s.nativeId,
        cwd: s.cwd,
        roots: s.roots,
        state: s.closed ? 'closed' : 'idle',
        config: s.config,
        createdAt: s.createdAt,
      },
    };
  }

  async sessionClose(params: { sessionId: string }): Promise<Record<string, unknown>> {
    const s = this.session(params.sessionId);
    s.closed = true;
    s.openTurn = null;
    for (const [interactionId, pending] of [...this.pendingInteractions.entries()]) {
      if (pending.sessionId === s.id) {
        this.pendingInteractions.delete(interactionId);
        this.emit({
          method: 'interaction.resolved',
          params: { sessionId: s.id, interactionId, outcome: 'cancelled' },
        });
      }
    }
    this.emit({ method: 'agent.status', params: { sessionId: s.id, nativeId: s.nativeId, status: 'idle' } });
    return { ok: true };
  }

  async sessionNativeList(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const summaries = [...this.sessions.values()]
      .filter(s => s.parentNativeId === undefined)
      .map(s => ({
        id: s.nativeId,
        cwd: s.cwd,
        updatedAt: s.createdAt,
      }));
    const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 100;
    const offset = typeof params.cursor === 'string' && params.cursor.length > 0 ? Number(params.cursor) : 0;
    const page = summaries.slice(offset, offset + limit);
    return {
      sessions: page,
      nextCursor: offset + page.length < summaries.length ? String(offset + page.length) : null,
    };
  }

  async sessionRename(): Promise<Record<string, unknown>> {
    throw new Error('CAPABILITY_NOT_SUPPORTED: DSH exposes no native session title/rename API');
  }

  async sessionFork(params: BridgeSessionForkParams): Promise<Record<string, unknown>> {
    if (this.sessions.has(params.newSessionId)) {
      throw new Error(`CONFLICT: fake session ${params.newSessionId} already exists`);
    }
    const source = this.session(params.sessionId);
    const events = source.events;
    let boundary: number;
    if (params.anchor.kind === 'head') {
      boundary = events.length - 1;
      const openTurn = this.openTurnAt(events, boundary);
      if (openTurn !== null) {
        throw new Error(`FORK_BOUNDARY_UNAVAILABLE: native head boundary is inside open turn ${openTurn}`);
      }
    } else {
      const found = this.turnEndSeq(events, params.anchor.nativeTurn);
      if (found === null) {
        throw new Error(`FORK_BOUNDARY_UNAVAILABLE: native turn ${params.anchor.nativeTurn} has no verifiable turn/end boundary`);
      }
      boundary = found;
    }
    const childNativeId = mintId('dsn');
    const child: FakeSession = {
      id: params.newSessionId,
      nativeId: childNativeId,
      cwd: source.cwd,
      roots: [...source.roots],
      config: { ...source.config },
      createdAt: new Date().toISOString(),
      events: boundary >= 0 ? events.slice(0, boundary + 1).map(clone => ({ ...clone })) : [],
      closed: false,
      openTurn: null,
      parentNativeId: source.nativeId,
    };
    this.sessions.set(params.newSessionId, child);
    this.emit({
      method: 'agent.status',
      params: { sessionId: child.id, nativeId: childNativeId, status: 'idle' },
    });
    return {
      session: {
        id: child.id,
        nativeId: childNativeId,
        cwd: child.cwd,
        roots: child.roots,
        state: 'idle',
        config: child.config,
        createdAt: child.createdAt,
      },
      parentNativeId: source.nativeId,
      atSeq: boundary,
      seedEventCount: child.events.length,
      inheritedEventCount: child.events.length,
    };
  }

  private turnEndSeq(events: FakeSession['events'], nativeTurn: number): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index];
      if (candidate === undefined) continue;
      if (candidate.type === 'turn/end' && candidate.data.turn === nativeTurn) return index;
    }
    return null;
  }

  private openTurnAt(events: FakeSession['events'], boundary: number): number | null {
    let open: number | null = null;
    for (let index = 0; index <= boundary && index < events.length; index += 1) {
      const candidate = events[index];
      if (candidate === undefined) continue;
      if (candidate.type === 'turn/start' && typeof candidate.data.turn === 'number') open = candidate.data.turn;
      if (candidate.type === 'turn/end' && candidate.data.turn === open) open = null;
    }
    return open;
  }

  async sessionEventsRead(params: { sessionId: string; cursor?: string | null; limit?: number }): Promise<Record<string, unknown>> {
    const s = this.session(params.sessionId);
    const cursor = params.cursor === null || params.cursor === undefined ? 0 : Number(params.cursor);
    const limit = params.limit ?? 500;
    const events = s.events.slice(cursor, cursor + limit);
    return {
      sessionId: s.id,
      formatVersion: this.sessionFormatVersion,
      events,
      cursor: cursor + events.length < s.events.length ? String(cursor + events.length) : null,
    };
  }

  async customizationList(params: BridgeCustomizationListParams): Promise<Record<string, unknown>> {
    if (params.kind !== 'skill') {
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
    return {
      kind: 'skill',
      status: 'ok',
      completeness: 'effective',
      observedAt: new Date().toISOString(),
      items: [
        {
          id: `ci1_${'a'.repeat(32)}`,
          kind: 'skill',
          name: 'fake-skill',
          description: 'A deterministic fake skill',
          activation: 'enabled',
          scope: { level: 'user', native: 'bundled' },
          origin: { kind: 'builtin', path: '/tmp/fake-skill/SKILL.md' },
          discovery: { method: 'provider_api' },
          skill: {
            format: 'agent-skill',
            entryPath: '/tmp/fake-skill/SKILL.md',
            invocation: 'bundled',
            userInvocable: true,
            modelInvocable: true,
          },
        },
      ],
      truncated: false,
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
    const list = await this.customizationList({ kind: 'skill' });
    const items = list.items as Array<Record<string, unknown>>;
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
    return {
      kind: 'skill',
      id: params.id,
      status: 'ok',
      observedAt: new Date().toISOString(),
      text: 'Fake skill body: do the deterministic thing.',
      truncated: false,
    };
  }

  /**
   * Fake attachment admission: mirrors the native AttachmentStore boundary —
   * absolute paths, existing regular files, image byte limits, and structured
   * content blocks. Files under a `/refused/` segment are rejected to exercise
   * the failure path.
   */
  admitFakeAttachments(sessionId: string, input: Array<{ type: string; path?: string; name?: string; mime?: string; skill?: string; text?: string }>): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    const textParts: string[] = [];
    const limits = this.options.maxImageBytes ?? 8 * 1024 * 1024;
    for (const item of input) {
      if (item.type === 'text') {
        if (typeof item.text === 'string' && item.text.length > 0) textParts.push(item.text);
        continue;
      }
      if (item.type === 'skill') {
        if (item.skill === 'fake-skill') {
          blocks.push({
            type: 'text',
            text: '<skill_content name="fake-skill">Deterministic fake body.</skill_content>',
            source: { kind: 'skill-invocation', name: 'fake-skill', form: 'instructions' },
          });
          continue;
        }
        throw new Error(`CONFIG_VALUE_INVALID: Skill ${String(item.skill)} was not found in the runtime catalog.`);
      }
      const path = typeof item.path === 'string' ? item.path : '';
      if (path.length === 0 || !path.startsWith('/') || path.split('/').some(part => part === '..')) {
        throw new Error(`CONFIG_VALUE_INVALID: Attachment path must be an absolute Host path without traversal: ${path}`);
      }
      if (path.includes('/refused/') || path.includes('/missing/')) {
        throw new Error(`CONFIG_VALUE_INVALID: Attachment file does not exist: ${path}`);
      }
      const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : path.split('/').pop() ?? 'attachment';
      if (item.type === 'localImage') {
        const size = Number(item.mime?.startsWith('oversize:') ? item.mime.slice('oversize:'.length) : 1200);
        if (size > limits) {
          throw new Error(`CONFIG_VALUE_INVALID: Image ${name} is ${size} bytes; the runtime admits at most ${limits}.`);
        }
        blocks.push({
          type: 'image',
          attachment: {
            attachmentId: `att-${sessionCounter}-${blocks.length}`,
            mediaType: 'image/png',
            bytes: size,
            width: 64,
            height: 64,
            name,
          },
        });
        continue;
      }
      blocks.push({
        type: 'file',
        attachment: {
          attachmentId: `att-file-${sessionCounter}-${blocks.length}`,
          name,
          bytes: 4096,
        },
      });
    }
    const text = textParts.join('\n');
    const instructions = blocks.filter(block => typeof (block as { source?: unknown }).source === 'object');
    const messageBlocks = blocks.filter(block => !instructions.includes(block));
    const out: Array<Record<string, unknown>> = [];
    if (text.length > 0) out.push({ type: 'text', text });
    out.push(...messageBlocks, ...instructions);
    return out;
  }

  async turnStart(params: BridgeTurnStartParams): Promise<Record<string, unknown>> {
    const s = this.session(params.sessionId);
    if (s.openTurn !== null) {
      throw new Error(`SESSION_BUSY: native turn ${s.openTurn} is still open`);
    }
    const turn = s.events.filter(entry => entry.type === 'turn/start').length;
    const script = this.options.script ?? 'success';

    let blocks: Array<Record<string, unknown>> = [];
    if (script === 'attachments') {
      blocks = this.admitFakeAttachments(params.sessionId, params.input as never);
    } else {
      const text = params.input
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n');
      if (text) blocks = [{ type: 'text', text }];
    }
    if (blocks.length === 0) {
      throw new Error('CONFIG_VALUE_INVALID: Turn input resolved to no native content.');
    }
    const instructions = blocks.filter(block => typeof (block as { source?: unknown }).source === 'object');
    const messageBlocks = blocks.filter(block => !instructions.includes(block));

    this.append(params.sessionId, 'turn/start', { turn });
    s.openTurn = turn;
    for (const block of instructions) {
      this.append(params.sessionId, 'user/message', {
        turn,
        step: 0,
        source: (block as { source: Record<string, unknown> }).source,
        message: { role: 'user', content: [block] },
      });
    }
    if (messageBlocks.length > 0) {
      this.append(params.sessionId, 'user/message', {
        turn,
        step: 0,
        message: { role: 'user', content: messageBlocks },
        source: 'gian',
      });
    }

    // Emit the native inbox-claimed fact the proxy uses for correlation.
    this.emit({
      method: 'agent.status',
      params: { sessionId: params.sessionId, nativeId: s.nativeId, status: 'running', turn },
    });
    this.emit({
      method: 'session.event',
      params: {
        sessionId: params.sessionId,
        nativeSeq: s.events.length - 1,
        type: 'agent/inbox/claimed',
        data: { turn, messageId: mintId('msg') },
      },
    });

    if (script === 'error') {
      this.append(params.sessionId, 'step/start', { turn, step: 0 });
      this.emit({ method: 'agent.error', params: { sessionId: params.sessionId, turn, step: 0, error: 'boom', details: { k: 'v' } } });
      this.append(params.sessionId, 'step/end', { turn, step: 0 });
      this.append(params.sessionId, 'turn/end', { turn, reason: { kind: 'error', error: { message: 'boom', code: 'FAKE' } } });
      s.openTurn = null;
      return { accepted: true };
    }

    if (script === 'interrupt') {
      this.append(params.sessionId, 'step/start', { turn, step: 0 });
      this.emit({ method: 'agent.status', params: { sessionId: params.sessionId, status: 'running', turn } });
      return { accepted: true };
    }

    if (script === 'multi-step') {
      this.runMultiStep(params.sessionId, turn, script);
      return { accepted: true };
    }

    this.runSuccessTurn(params.sessionId, turn, script);
    return { accepted: true };
  }

  private runSuccessTurn(sessionId: string, turn: number, script: string): void {
    const s = this.session(sessionId);
    if (script === 'approval' || script === 'question') {
      this.append(sessionId, 'step/start', { turn, step: 0 });
      this.append(sessionId, 'request/header', {
        turn,
        step: 0,
        reason: 'initial',
        header: {
          config: { provider: 'deepseek', model: 'deepseek-chat' },
          system: 'system prompt',
          tools: [{ name: 'read_file', description: 'Read a file' }],
        },
      });
      const interactionParams = this.interaction(sessionId, turn, 0, script) as unknown as Record<string, unknown>;
      // Mirror the real host: the durable ask/audit seq anchors the
      // interaction identity for live projection and replay alike.
      interactionParams.nativeSeq = s.events.length - 1;
      this.emit({
        method: 'interaction.requested',
        params: interactionParams,
      });
      return;
    }
    this.append(sessionId, 'step/start', { turn, step: 0 });
    this.append(sessionId, 'request/header', {
      turn,
      step: 0,
      reason: 'initial',
      header: {
        config: { provider: 'deepseek', model: 'deepseek-chat' },
        system: 'system prompt',
        tools: [{ name: 'read_file' }],
      },
    });
    this.append(sessionId, 'request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 128000 });
    if (script === 'plan') {
      this.append(sessionId, 'todo/write', {
        todos: [
          { content: 'Read the spec', status: 'completed' },
          { content: 'Write the code', status: 'in_progress' },
          { content: 'Run the tests', status: 'pending' },
        ],
      });
      this.append(sessionId, 'plan/mode', { active: true });
    }
    if (script === 'diff') {
      this.append(sessionId, 'tool/call', { turn, step: 0, callId: 'call-edit-1', name: 'edit', arguments: '{"file_path":"/w/a.txt"}' });
      this.append(sessionId, 'tool/result', {
        turn,
        step: 0,
        message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
        meta: {
          diffs: [
            { path: 'a.txt', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' },
            { path: 'b.txt', oldText: null, newText: 'new file\n' },
          ],
        },
      });
    }
    if (script === 'subagent') {
      this.append(sessionId, 'tool/call', { turn, step: 0, callId: 'call-sub-1', name: 'subagent', arguments: '{}' });
      const runId = mintId('run');
      const childNativeId = mintId('child');
      this.emit({
        method: 'subagent.started',
        params: { sessionId, agentId: runId, childNativeId, provider: 'spawn', state: 'running' },
      });
      this.emit({
        method: 'subagent.activity',
        params: { sessionId, agentId: runId, childNativeId, childSeq: 0, kind: 'tool/call', callId: 'child-call-1', name: 'read_file' },
      });
      this.emit({
        method: 'subagent.finished',
        params: { sessionId, agentId: runId, childNativeId, state: 'completed', stopReason: 'completed' },
      });
      this.append(sessionId, 'tool/result', {
        turn,
        step: 0,
        message: { role: 'tool', content: [{ type: 'text', text: 'subagent done' }] },
      });
    }
    this.append(sessionId, 'assistant/chunk', { turn, step: 0, chunk: { type: 'text-delta', text: 'hello' } });
    this.append(sessionId, 'assistant/message', {
      turn,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    this.append(sessionId, 'step/end', { turn, step: 0 });
    this.append(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    s.openTurn = null;
  }

  private runMultiStep(sessionId: string, turn: number, _text: string): void {
    this.append(sessionId, 'step/start', { turn, step: 0 });
    this.append(sessionId, 'request/header', { turn, step: 0, reason: 'initial', header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } });
    this.append(sessionId, 'tool/call', { turn, step: 0, callId: 'call-1', name: 'todo_write', arguments: '{}' });
    this.append(sessionId, 'tool/result', {
      turn,
      step: 0,
      message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
    });
    this.append(sessionId, 'step/end', { turn, step: 0 });
    this.append(sessionId, 'step/start', { turn, step: 1 });
    this.append(sessionId, 'assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', text: 'done' } });
    this.append(sessionId, 'assistant/message', {
      turn,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      usage: { inputTokens: 20, outputTokens: 4 },
    });
    this.append(sessionId, 'step/end', { turn, step: 1 });
    this.append(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    this.session(sessionId).openTurn = null;
  }

  private interaction(sessionId: string, turn: number, step: number, kind: string): BridgeInteractionRequest {
    const request: BridgeInteractionRequest = kind === 'question'
      ? {
          interactionId: mintId('q'),
          kind: 'question',
          title: 'Which file',
          description: 'Pick one',
          sessionId,
          turn,
          step,
          inputs: [
            {
              id: 'file',
              type: 'single_select',
              label: 'File',
              required: true,
              choices: [{ value: 'a', displayName: 'A' }, { value: 'b', displayName: 'B' }],
            },
          ],
          actions: [{ id: 'submit', label: 'Submit', style: 'primary' }],
        }
      : {
          interactionId: mintId('ap'),
          kind: 'approval',
          title: 'Approve command',
          description: 'Run pnpm test',
          sessionId,
          turn,
          step,
          inputs: [],
          actions: [
            { id: 'allow-once', label: 'Allow once', style: 'primary' },
            { id: 'reject', label: 'Reject', style: 'danger' },
          ],
        };
    this.pendingInteractions.set(request.interactionId, request);
    return request;
  }

  async turnSteer(params: { sessionId: string; turnId?: string; input: unknown[] }): Promise<Record<string, unknown>> {
    const s = this.session(params.sessionId);
    if (s.openTurn === null) {
      throw new Error('TURN_NOT_FOUND: steering requires an open native turn; queue the input as a new turn instead.');
    }
    const text = params.input
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .filter(item => item.type === 'text')
      .map(item => typeof item.text === 'string' ? item.text : '')
      .join('\n');
    if (text.length > 0) {
      this.append(params.sessionId, 'user/message', {
        turn: s.openTurn,
        step: 1,
        message: { role: 'user', content: [{ type: 'text', text }] },
        source: 'gian',
      });
    }
    return { accepted: true, openTurn: s.openTurn };
  }

  async turnInterrupt(params: { sessionId: string; turnId?: string }): Promise<Record<string, unknown>> {
    const s = this.session(params.sessionId);
    this.emit({ method: 'agent.status', params: { sessionId: params.sessionId, status: 'running', cancelled: true } });
    return { accepted: true };
  }

  async interactionRespond(params: BridgeInteractionRespondParams): Promise<Record<string, unknown>> {
    const pendingQuestion = this.pendingQuestions.get(params.interactionId);
    if (pendingQuestion !== undefined) {
      this.pendingQuestions.delete(params.interactionId);
      if (params.actionId === 'cancel') {
        pendingQuestion.reject(new Error('ASK_ABORTED: the user dismissed the question without answering'));
      } else {
        pendingQuestion.resolve({
          answers: pendingQuestion.questions.map((question) => {
            const id = String(question.id);
            const raw = params.values[id];
            if (question.multiSelect === true) {
              return { id, selected: Array.isArray(raw) ? raw.map(String) : [] };
            }
            if (Array.isArray(question.options) && question.options.length > 0) {
              return { id, selected: typeof raw === 'string' ? [raw] : [] };
            }
            return { id, selected: [], ...(typeof raw === 'string' ? { custom: raw } : {}) };
          }),
        });
      }
      this.emit({
        method: 'interaction.resolved',
        params: {
          sessionId: params.sessionId,
          interactionId: params.interactionId,
          nativeSeq: this.session(params.sessionId).events.length - 1,
          ...(params.actionId === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'submitted', actionId: 'submit' }),
        },
      });
      return { accepted: true };
    }
    const pending = this.pendingInteractions.get(params.interactionId);
    if (!pending) throw new Error(`interaction ${params.interactionId} not pending`);
    this.pendingInteractions.delete(params.interactionId);
    this.emit({
      method: 'interaction.resolved',
      params: {
        sessionId: pending.sessionId,
        interactionId: pending.interactionId,
        nativeSeq: this.session(pending.sessionId).events.length - 1,
        outcome: 'submitted',
        actionId: params.actionId ?? 'allow-once',
        displaySummary: 'ok',
      },
    });
    // Finish the pending approval turn now that it has an answer.
    const turn = pending.turn ?? 0;
    const step = pending.step ?? 0;
    this.append(pending.sessionId, 'step/end', { turn, step });
    this.append(pending.sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    this.session(pending.sessionId).openTurn = null;
    return { accepted: true };
  }

  async shutdown(): Promise<Record<string, unknown>> {
    for (const s of this.sessions.values()) {
      if (s.closed === false) this.emit({ method: 'agent.status', params: { sessionId: s.id, nativeId: s.nativeId, status: 'idle' } });
    }
    this.sessions.clear();
    return { ok: true };
  }
}
