/**
 * Deterministic fake DSH runtime implementing the `BridgeHost` seam.
 *
 * It replays the exact event vocabulary the real `gian` profile emits from
 * `ctx.agents` / `session/event` (turn/step boundaries, assistant chunks and
 * assembled messages with usage, tool calls/results, request headers/context,
 * approval and user questions) with zero model calls and zero persisted state.
 *
 * Two root sessions and one in-process child are the canonical WP1 shape:
 * every event carries a sessionId and a native turn/step so the proxy can
 * derive sourceTurnId / stepId without any cordis runtime.
 */

import { DSH_SESSION_FORMAT_VERSION, type BridgeJsonValue } from './schema.js';
import type {
  BridgeHost,
  BridgeHostEvent,
  BridgeInteractionRespondParams,
  BridgeInteractionRequest,
  BridgeSessionCreateParams,
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
}

export interface FakeHostOptions {
  bridgeVersion?: string;
  dshVersion?: string;
  /** When set, turn.start produces a scripted event sequence. */
  script?: 'success' | 'approval' | 'question' | 'interrupt' | 'error' | 'multi-step';
  /** When set, every turn is interrupted by the pending native question. */
  autoQuestion?: boolean;
  /** When set, the host has no reliable ownership API (default). */
  reliableOwnership?: boolean;
}

let sessionCounter = 0;

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
  private sink: ((event: BridgeHostEvent) => void) | null = null;
  private initialized = false;
  private early: BridgeHostEvent[] = [];

  constructor(private readonly options: FakeHostOptions = {}) {
    this.bridgeVersion = options.bridgeVersion ?? '0.1.1';
    this.dshVersion = options.dshVersion ?? '0.1.1-rc.2';
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
    return {
      catalogRevision: `fake-catalog-${this.dshVersion}`,
      providers: [{ id: 'deepseek', label: 'DeepSeek' }],
      models: [
        { id: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', provider: 'deepseek', label: 'DeepSeek Reasoner' },
      ],
      effortLevels: ['low', 'medium', 'high'],
      approvalPolicies: ['ask', 'never'],
      agentPresets: ['standard', 'code', 'minimal'],
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
    this.emit({ method: 'agent.status', params: { sessionId: s.id, nativeId: s.nativeId, status: 'idle' } });
    return { ok: true };
  }

  async sessionNativeList(): Promise<Record<string, unknown>> {
    // No reliable cross-process ownership API in latest DSH → fail closed.
    throw new Error('RUNTIME_UNAVAILABLE: native session list requires a reliable ownership API');
  }

  async sessionRename(params: { sessionId: string; name: string }): Promise<Record<string, unknown>> {
    const s = this.session(params.sessionId);
    s.config.titles = params.name;
    return { ok: true };
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

  async turnStart(params: BridgeTurnStartParams): Promise<Record<string, unknown>> {
    const s = this.session(params.sessionId);
    const turn = s.events.length;
    this.append(params.sessionId, 'turn/start', { turn });

    const text = params.input
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
    if (text) {
      this.append(params.sessionId, 'user/message', {
        turn,
        step: 0,
        message: {
          role: 'user',
          content: [{ type: 'text', text }],
        },
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

    const script = this.options.script ?? 'success';
    if (script === 'error') {
      this.append(params.sessionId, 'step/start', { turn, step: 0 });
      this.emit({ method: 'agent.error', params: { sessionId: params.sessionId, turn, step: 0, error: 'boom', details: { k: 'v' } } });
      this.append(params.sessionId, 'step/end', { turn, step: 0 });
      this.append(params.sessionId, 'turn/end', { turn, reason: { kind: 'error', error: { message: 'boom', code: 'FAKE' } } });
      return { accepted: true };
    }

    if (script === 'interrupt') {
      this.append(params.sessionId, 'step/start', { turn, step: 0 });
      this.emit({ method: 'agent.status', params: { sessionId: params.sessionId, status: 'running', turn } });
      return { accepted: true };
    }

    if (script === 'multi-step') {
      this.runMultiStep(params.sessionId, turn, text);
      return { accepted: true };
    }

    this.runSuccessTurn(params.sessionId, turn, script);
    return { accepted: true };
  }

  private runSuccessTurn(sessionId: string, turn: number, script: string): void {
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
      this.emit({
        method: 'interaction.requested',
        params: this.interaction(sessionId, turn, 0, script) as unknown as Record<string, unknown>,
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
    this.append(sessionId, 'assistant/chunk', { turn, step: 0, chunk: { type: 'text-delta', text: 'hello' } });
    this.append(sessionId, 'assistant/message', {
      turn,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    this.append(sessionId, 'step/end', { turn, step: 0 });
    this.append(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
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
    return { accepted: true };
  }

  async turnInterrupt(params: { sessionId: string; turnId?: string }): Promise<Record<string, unknown>> {
    const s = this.session(params.sessionId);
    const ended = s.events.filter((e) => e.type === 'turn/start').length;
    for (const item of s.events) {
      if (item.type === 'step/start' && (item.data as Record<string, unknown>).turn === ended - 1) {
        // leave running for the test driver to close explicitly
      }
    }
    this.emit({ method: 'agent.status', params: { sessionId: params.sessionId, status: 'running', cancelled: true } });
    return { accepted: true };
  }

  async interactionRespond(params: BridgeInteractionRespondParams): Promise<Record<string, unknown>> {
    const pending = this.pendingInteractions.get(params.interactionId);
    if (!pending) throw new Error(`interaction ${params.interactionId} not pending`);
    this.pendingInteractions.delete(params.interactionId);
    this.emit({
      method: 'interaction.resolved',
      params: {
        sessionId: pending.sessionId,
        interactionId: pending.interactionId,
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
