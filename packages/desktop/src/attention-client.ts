import {
  isAttentionControlMessage,
  isAttentionMessage,
  type AttentionControlMessage,
  type AttentionInboxRef,
  type AttentionMessage,
} from '@gian/shared';

export interface AttentionSocket {
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface AttentionSocketInit {
  headers: Record<string, string>;
}

export type AttentionSocketFactory = (
  url: string,
  init: AttentionSocketInit,
) => AttentionSocket;

export interface AttentionClientOptions {
  hostUrl: string;
  token: string;
  tokenHeader: string;
  socketFactory: AttentionSocketFactory;
  onAttention: (message: AttentionMessage) => void;
  /** Read/terminal frames. They never include Inbox bodies. */
  onControl?: (message: AttentionControlMessage) => void;
  /** Stored OS refs to reconcile after each successful auth, including reconnect. */
  lookupRefs?: () => readonly AttentionInboxRef[];
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  reconnectDelaysMs?: readonly number[];
}

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/**
 * Maintains the Desktop main-process subscription used for native alerts.
 * It intentionally never subscribes to transcript events: `attention`
 * messages are global, small, and safe to receive while every window is
 * closed.
 */
export class AttentionClient {
  private readonly options: AttentionClientOptions;
  private readonly setTimer: NonNullable<AttentionClientOptions['setTimer']>;
  private readonly clearTimer: NonNullable<AttentionClientOptions['clearTimer']>;
  private readonly reconnectDelaysMs: readonly number[];
  private running = false;
  private socket: AttentionSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private generation = 0;

  constructor(options: AttentionClientOptions) {
    this.options = options;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempt = 0;
    this.connect();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'desktop_shutdown');
  }

  private connect(): void {
    if (!this.running || this.socket) return;
    const generation = ++this.generation;
    let socket: AttentionSocket;
    try {
      const origin = new URL(this.options.hostUrl).origin;
      socket = this.options.socketFactory(attentionWebSocketUrl(origin), {
        headers: {
          Origin: origin,
          [this.options.tokenHeader]: this.options.token,
        },
      });
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (!this.running || generation !== this.generation || this.socket !== socket) return;
      this.reconnectAttempt = 0;
      // The mode is part of the atomic auth boundary. Host registers this as
      // a read-only attention sink before it can receive any broadcasts.
      socket.send(JSON.stringify({
        type: 'auth',
        token: this.options.token,
        client: 'attention',
      }));
    });
    socket.addEventListener('message', event => {
      if (!this.running || generation !== this.generation || this.socket !== socket) return;
      const frame = parseJson(event.data);
      if (isAuthOk(frame)) {
        this.sendLookup(socket);
        return;
      }
      if (isAttentionControlMessage(frame)) {
        this.options.onControl?.(frame);
        return;
      }
      if (isAttentionMessage(frame)) this.options.onAttention(frame);
    });
    socket.addEventListener('close', () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect(generation);
    });
    // The close event owns reconnect scheduling. Some WebSocket
    // implementations emit both error and close; scheduling from both would
    // create duplicate connections.
    socket.addEventListener('error', () => {});
  }

  private sendLookup(socket: AttentionSocket): void {
    const refs = this.options.lookupRefs?.() ?? [];
    for (let index = 0; index < refs.length; index += 32) {
      const chunk = refs.slice(index, index + 32);
      if (chunk.length === 0) continue;
      socket.send(JSON.stringify({ type: 'attention:lookup', refs: chunk }));
    }
  }

  private scheduleReconnect(generation: number): void {
    if (!this.running || generation !== this.generation || this.reconnectTimer) return;
    const index = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1);
    const delay = this.reconnectDelaysMs[index] ?? 30_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (this.running && generation === this.generation) this.connect();
    }, delay);
  }
}

export function attentionWebSocketUrl(hostUrl: string): string {
  const url = new URL('/ws', hostUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function parseAttentionMessage(data: unknown): AttentionMessage | null {
  const value = parseJson(data);
  return isAttentionMessage(value) ? value : null;
}

export function parseAttentionControlMessage(data: unknown): AttentionControlMessage | null {
  const value = parseJson(data);
  return isAttentionControlMessage(value) ? value : null;
}

function parseJson(data: unknown): unknown {
  try {
    if (typeof data !== 'string') return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isAuthOk(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'auth_ok';
}
