/**
 * KimiServerRuntime — one facade over the supervisor, the REST client and the
 * `/api/v1/ws` event socket.
 *
 * WS facts (upstream 2.1.1): client frames are `{type, id, payload}`; the
 * server answers `{type:"ack", id, code, msg, payload}`; server pings carry a
 * ULID nonce that must be echoed; the server closes the socket after
 * `heartbeat_ms × 2` without inbound traffic. `subscribe` accepts
 * `{session_ids, cursors?}` and replies with accepted/not_found/
 * resync_required/cursors. Unknown/wrong-epoch/overflow cursors come back as
 * `resync_required` frames — the client must rebuild from REST
 * (GET /sessions/{id}/snapshot) and re-subscribe with the fresh cursor.
 */

import { EventEmitter } from 'node:events';

import { KimiServerRestClient } from './rest-client.js';
import { KimiServerSupervisor, type KimiServerSupervisorResult } from './server-supervisor.js';
import { WsSocket } from './ws.js';

export interface SessionCursor {
  seq: number;
  epoch?: string;
}

export interface KimiServerEventFrame {
  type: string;
  seq: number;
  epoch?: string;
  volatile?: boolean;
  offset?: number;
  session_id?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ResyncNotice {
  sessionId: string;
  reason: string;
  currentSeq: number | null;
  epoch: string | null;
}

export interface RuntimeEvents {
  on(event: 'session-event', listener: (frame: KimiServerEventFrame) => void): void;
  on(event: 'resync', listener: (notice: ResyncNotice) => void): void;
  on(event: 'down', listener: () => void): void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

export class KimiServerRuntime {
  private readonly events = new EventEmitter();
  private supervisor: KimiServerSupervisorResult | null = null;
  private restClient: KimiServerRestClient | null = null;
  private socket: WsSocket | null = null;
  private connecting: Promise<void> | null = null;
  private stopped = false;
  /** Desired subscriptions; cursors track the last durable seq we delivered. */
  private readonly subscriptions = new Map<string, SessionCursor | undefined>();
  private reconnectAttempts = 0;
  private nextRequestId = 1;

  constructor(private readonly options: { kimiBin: string; endpoint?: { baseUrl: string; token: string } }) {
    this.events.setMaxListeners(0);
  }

  on: RuntimeEvents['on'] = (event, listener) => {
    this.events.on(event, listener);
    return this;
  };

  get rest(): KimiServerRestClient {
    if (this.restClient === null) {
      throw new Error('Kimi server runtime is not started.');
    }
    return this.restClient;
  }

  get serverPid(): number | null {
    return this.supervisor?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.restClient !== null) return;
    const supervisor = await new KimiServerSupervisor({
      kimiBin: this.options.kimiBin,
      ...(this.options.endpoint !== undefined ? { endpoint: this.options.endpoint } : {}),
    }).start();
    this.supervisor = supervisor;
    this.restClient = new KimiServerRestClient(supervisor.endpoint);
    supervisor.exit.then(() => {
      if (this.stopped) return;
      this.socket = null;
      this.restClient = null;
      this.events.emit('down');
    });
  }

  /** Latest cursor bookkeeping: the projector advances this per durable frame
   *  so a reconnect resumes exactly after what was delivered. */
  advanceCursor(sessionId: string, cursor: SessionCursor): void {
    const current = this.subscriptions.get(sessionId);
    if (current === undefined || cursor.seq > current.seq) {
      this.subscriptions.set(sessionId, cursor);
    }
  }

  forgetSession(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    void this.sendWhenOpen({ type: 'unsubscribe', id: this.nextId(), payload: { session_ids: [sessionId] } });
  }

  /** Subscribe (or refresh cursors for) one session. Safe before the socket
   *  is open: the subscription is applied on connect. */
  async subscribe(sessionId: string, cursor?: SessionCursor): Promise<void> {
    const existing = this.subscriptions.get(sessionId);
    if (existing === undefined || (cursor !== undefined && cursor.seq > existing.seq)) {
      this.subscriptions.set(sessionId, cursor ?? existing);
    }
    const effective = this.subscriptions.get(sessionId);
    await this.sendWhenOpen({
      type: 'subscribe',
      id: this.nextId(),
      payload: {
        session_ids: [sessionId],
        ...(effective !== undefined ? { cursors: { [sessionId]: effective } } : {}),
      },
    });
  }

  private nextId(): string {
    return `gian-${this.nextRequestId++}`;
  }

  private async sendWhenOpen(frame: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.ensureConnected();
        this.socket!.sendText(JSON.stringify(frame));
        return;
      } catch {
        this.socket = null;
        if (attempt === 2) throw new Error('Kimi event socket is unavailable.');
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200 * (attempt + 1)));
      }
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket !== null && this.socket.status === 'open') return;
    if (this.connecting !== null) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    if (this.restClient === null) throw new Error('Kimi server runtime is not started.');
    const endpoint = this.supervisor?.endpoint;
    if (endpoint === undefined) throw new Error('Kimi server endpoint is unknown.');
    const socket = await WsSocket.connect({
      url: `${endpoint.baseUrl.replace(/^http/, 'ws')}/api/v1/ws`,
      headers: { Authorization: `Bearer ${endpoint.token}` },
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
    });
    socket.on('message', (raw: string) => this.handleMessage(raw));
    socket.on('close', () => {
      this.socket = null;
      if (this.stopped) return;
      this.events.emit('down');
      this.scheduleReconnect();
    });
    this.socket = socket;
    this.reconnectAttempts = 0;
    // Resubscribe everything we owe, with cursors where we have them.
    if (this.subscriptions.size > 0) {
      socket.sendText(JSON.stringify({
        type: 'subscribe',
        id: this.nextId(),
        payload: {
          session_ids: [...this.subscriptions.keys()],
          ...(SubscriptionCursors(this.subscriptions).size > 0
            ? { cursors: Object.fromEntries(SubscriptionCursors(this.subscriptions)) }
            : {}),
        },
      }));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.restClient === null) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    setTimeout(() => {
      if (this.stopped || this.socket !== null) return;
      this.ensureConnected().catch(() => this.scheduleReconnect());
    }, delay).unref();
  }

  private handleMessage(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof frame.type === 'string' ? frame.type : '';
    if (type === 'ack') {
      // Subscription acks are informational: resync_required arrives both in
      // the ack payload and as its own frame, which we handle below.
      return;
    }
    if (type === 'ping') {
      const payload = (frame.payload ?? {}) as Record<string, unknown>;
      if (typeof payload.nonce === 'string') {
        try {
          this.socket?.sendText(JSON.stringify({ type: 'pong', payload: { nonce: payload.nonce } }));
        } catch { /* reconnect handles it */ }
      }
      return;
    }
    if (type === 'resync_required') {
      const payload = (frame.payload ?? {}) as Record<string, unknown>;
      const sessionId = typeof frame.session_id === 'string'
        ? frame.session_id
        : typeof payload.session_id === 'string' ? payload.session_id : '';
      if (sessionId !== '') {
        this.subscriptions.set(sessionId, undefined);
        this.events.emit('resync', {
          sessionId,
          reason: typeof payload.reason === 'string' ? payload.reason : 'unknown',
          currentSeq: typeof payload.current_seq === 'number' ? payload.current_seq : null,
          epoch: typeof payload.epoch === 'string' ? payload.epoch : null,
        } satisfies ResyncNotice);
      }
      return;
    }
    if (typeof frame.session_id !== 'string' || typeof frame.seq !== 'number') return;
    this.events.emit('session-event', frame as unknown as KimiServerEventFrame);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try { this.socket?.close(); } catch { /* already gone */ }
    this.socket = null;
    await this.supervisor?.stop();
    this.supervisor = null;
    this.restClient = null;
  }
}

function SubscriptionCursors(
  subscriptions: Map<string, SessionCursor | undefined>,
): Map<string, SessionCursor> {
  const cursors = new Map<string, SessionCursor>();
  for (const [sessionId, cursor] of subscriptions) {
    if (cursor !== undefined) cursors.set(sessionId, cursor);
  }
  return cursors;
}
