import type {
  ClientToServerMessage,
  ServerToClientMessage,
} from '@gian/shared';

export type WsState = 'connecting' | 'open' | 'closed';
export type WsListener = (msg: ServerToClientMessage) => void;
export type WsStateListener = (state: WsState, attempt: number) => void;

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

function backoffFor(attempt: number): number {
  return BACKOFF_STEPS[Math.min(attempt, BACKOFF_STEPS.length - 1)]!;
}

export class GianWs {
  private ws: WebSocket | null = null;
  private listeners = new Set<WsListener>();
  private stateListeners = new Set<WsStateListener>();
  private queue: ClientToServerMessage[] = [];
  private authed = false;
  private state: WsState = 'closed';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(
    private url: string,
    /**
     * Async token getter. Resolved once per connection, right after the
     * socket opens, so Login → token-fetch → reconnect can refresh the value
     * without rebuilding GianWs.
     */
    private getToken: () => Promise<string> | string,
  ) {}

  connect(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.intentionalClose = false;
    this.openSocket();
  }

  private openSocket(): void {
    this.cancelTimer();
    this.setState('connecting');

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', async () => {
      let token: string;
      try {
        token = await Promise.resolve(this.getToken());
      } catch {
        token = '';
      }
      // Server closes the socket on empty-token, so an empty value here is a
      // soft auth failure rather than a hard JS error.
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.addEventListener('message', evt => {
      let parsed: ServerToClientMessage;
      try {
        parsed = JSON.parse(evt.data) as ServerToClientMessage;
      } catch {
        return;
      }

      if (parsed.type === 'auth_ok') {
        this.authed = true;
        this.attempt = 0;
        this.setState('open');
        for (const queued of this.queue) ws.send(JSON.stringify(queued));
        this.queue = [];
      }

      if (parsed.type === 'state_sync') {
        // state_sync clears any locally queued messages — the server just sent
        // the authoritative state, so replaying stale queued messages would
        // double-send. Queue is intentionally drained by auth_ok above; this
        // guard is a safety net for a tight race where state_sync arrives
        // before auth_ok's queue flush completes.
        this.queue = [];
      }

      for (const listener of this.listeners) listener(parsed);
    });

    ws.addEventListener('close', evt => {
      this.authed = false;
      this.ws = null;
      if (this.intentionalClose) {
        this.setState('closed');
        return;
      }
      // Non-clean close → schedule reconnect with exponential backoff.
      this.setState('closed');
      const delay = backoffFor(this.attempt);
      this.attempt += 1;
      this.reconnectTimer = setTimeout(() => {
        this.openSocket();
      }, delay);
    });
  }

  private cancelTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(next: WsState): void {
    if (this.state === next) return;
    this.state = next;
    for (const fn of this.stateListeners) fn(next, this.attempt);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cancelTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.authed = false;
    this.setState('closed');
  }

  send(msg: ClientToServerMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authed) {
      this.queue.push(msg);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  onMessage(listener: WsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to WS connection state changes. Fires immediately with current state. */
  onState(listener: WsStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state, this.attempt);
    return () => this.stateListeners.delete(listener);
  }

  getState(): WsState {
    return this.state;
  }

  getAttempt(): number {
    return this.attempt;
  }
}
