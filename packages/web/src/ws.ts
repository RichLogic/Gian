import type {
  ClientToServerMessage,
  ServerToClientMessage,
  TermCloseMessage,
} from '@gian/shared';
import { parseStateSyncMessage } from '@gian/shared';

export type WsState = 'connecting' | 'open' | 'closed';
export type WsListener = (msg: ServerToClientMessage) => void;
export type WsStateListener = (state: WsState, attempt: number) => void;

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];
/** A close tombstone is tiny, but an offline/never-recovering app could create
 * an unbounded number over its lifetime. Keep a generous bounded set; repeated
 * closes for one terminal coalesce to the newest request. */
const MAX_PENDING_TERMINAL_CLOSES = 256;

function backoffFor(attempt: number): number {
  return BACKOFF_STEPS[Math.min(attempt, BACKOFF_STEPS.length - 1)]!;
}

/** Only queries/subscriptions plus idempotent terminal teardown are safe to
 * replay after an authoritative state_sync. Other mutations and terminal
 * input may already have reached the old socket, so replaying them would risk
 * duplicate side effects. */
function isReplaySafe(message: ClientToServerMessage): boolean {
  return message.type === 'events:subscribe'
    || message.type === 'term:replay-request'
    // Closing an already-closed/missing PTY is idempotent. Unlike ordinary
    // mutations it is a compensating teardown: retaining it across a socket
    // gap prevents an unmounted terminal tab from leaking a Host process.
    || message.type === 'term:close';
}

export class GianWs {
  private ws: WebSocket | null = null;
  private listeners = new Set<WsListener>();
  private stateListeners = new Set<WsStateListener>();
  private queue: ClientToServerMessage[] = [];
  /** Correlated terminal closes are compensating tombstones. A close sent on
   * an apparently-open socket can still be lost before its ack; retain it by
   * request id and replay after every subsequent authoritative sync until the
   * Host confirms success. No other mutation is eligible for this treatment. */
  private pendingTerminalCloses = new Map<string, TermCloseMessage>();
  private authed = false;
  private awaitingStateSync = true;
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
    this.awaitingStateSync = true;
    this.setState('connecting');

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', async () => {
      if (this.ws !== ws) return;
      let token: string;
      try {
        token = await Promise.resolve(this.getToken());
      } catch {
        token = '';
      }
      // Token lookup can outlive this socket (for example a StrictMode
      // cleanup/remount). Never authenticate a superseded generation.
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      // Server closes the socket on empty-token, so an empty value here is a
      // soft auth failure rather than a hard JS error.
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.addEventListener('message', evt => {
      // A closing socket can still deliver buffered events after a newer
      // generation has been installed. Those frames must never mutate the
      // current connection or reach product reducers.
      if (this.ws !== ws) return;
      let raw: unknown;
      try {
        raw = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
        || typeof (raw as { type?: unknown }).type !== 'string') return;

      let parsed: ServerToClientMessage;
      if ((raw as { type: string }).type === 'state_sync') {
        try {
          parsed = parseStateSyncMessage(raw);
        } catch {
          // The Host sends exactly one snapshot per authentication. Waiting
          // on this socket would strand the client in `connecting` forever,
          // so fail this generation and recover through the normal backoff.
          this.authed = false;
          ws.close(4002, 'invalid_state_sync');
          return;
        }
      } else {
        parsed = raw as ServerToClientMessage;
      }

      if (parsed.type === 'operation:result'
        && parsed.request_type === 'term:close'
        && parsed.ok) {
        // The same request id is reused for a compensating replay. Clearing
        // only after a positive correlated result covers both cases: the
        // original close reached the Host, or a reconnect replay completed
        // the teardown after the original frame/ack was lost.
        this.pendingTerminalCloses.delete(parsed.request_id);
      }

      if (parsed.type === 'auth_ok') {
        this.authed = true;
      }

      if (parsed.type === 'state_sync') {
        if (!this.authed) return;

        // Capture only replay-safe queries, then clear the old-socket queue.
        // Listeners receive the authoritative snapshot while sends are still
        // gated, so mutations triggered during reduction are classified by
        // the same rule rather than racing ahead of state application.
        const replayable = this.queue.filter(isReplaySafe);
        this.queue = [];
        for (const listener of this.listeners) listener(parsed);
        replayable.push(...this.queue.filter(isReplaySafe));
        this.queue = [];
        const compensatingCloses = [...this.pendingTerminalCloses.values()];

        if (this.ws === ws && ws.readyState === WebSocket.OPEN && this.authed) {
          for (const queued of replayable) ws.send(JSON.stringify(queued));
          for (const close of compensatingCloses) ws.send(JSON.stringify(close));
          this.awaitingStateSync = false;
          this.attempt = 0;
          this.setState('open');
        }
        return;
      }

      for (const listener of this.listeners) listener(parsed);
    });

    ws.addEventListener('close', () => {
      // Ignore a delayed close from a superseded generation. In particular,
      // it must not null out a newer socket or schedule a duplicate reconnect.
      if (this.ws !== ws) return;
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

  send(msg: ClientToServerMessage): 'sent' | 'queued' | 'dropped' {
    const terminalCloseRequestId = msg.type === 'term:close'
      && typeof msg.request_id === 'string'
      && msg.request_id.length > 0
      ? msg.request_id
      : null;
    if (terminalCloseRequestId) {
      // Remember before attempting the write. WebSocket.send can race a
      // network failure: even if it returns, only operation:result proves the
      // Host performed this idempotent teardown.
      const terminalClose = msg as TermCloseMessage;
      // A second lifecycle close for the same terminal supersedes the older
      // uncertain request. Replaying either is safe, but retaining both wastes
      // memory and emits duplicate compensation after every reconnect.
      for (const [requestId, pending] of this.pendingTerminalCloses) {
        if (requestId !== terminalCloseRequestId && pending.term_id === terminalClose.term_id) {
          this.pendingTerminalCloses.delete(requestId);
        }
      }
      if (!this.pendingTerminalCloses.has(terminalCloseRequestId)
        && this.pendingTerminalCloses.size >= MAX_PENDING_TERMINAL_CLOSES) {
        const oldest = this.pendingTerminalCloses.keys().next().value as string | undefined;
        if (oldest !== undefined) this.pendingTerminalCloses.delete(oldest);
      }
      this.pendingTerminalCloses.set(terminalCloseRequestId, terminalClose);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authed || this.awaitingStateSync) {
      if (terminalCloseRequestId) return 'queued';
      if (isReplaySafe(msg)) {
        this.queue.push(msg);
        return 'queued';
      }
      // Mutations and terminal input may already have reached an older
      // socket, so retaining them would risk duplicate side effects. The
      // operation dispatcher turns this explicit disposition into a failed
      // run/rollback; raw terminal bytes are intentionally discarded.
      return 'dropped';
    }
    this.ws.send(JSON.stringify(msg));
    return 'sent';
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
