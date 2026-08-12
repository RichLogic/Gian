import type { ServerToClientMessage } from '@gian/shared';
import type { WSContext } from 'hono/ws';

export const WS_MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Tracks authenticated WebSocket clients and broadcasts messages to them.
 * Single-user app — no per-user filtering needed.
 */
export class WsBroadcaster {
  private clients = new Set<WSContext>();
  private eventSubscriptions = new Map<WSContext, string | null>();

  add(client: WSContext): void {
    this.clients.add(client);
  }

  remove(client: WSContext): void {
    this.clients.delete(client);
    this.eventSubscriptions.delete(client);
  }

  subscribeToEvents(client: WSContext, sessionId: string | null): void {
    this.eventSubscriptions.set(client, sessionId);
  }

  send(client: WSContext, message: ServerToClientMessage): void {
    this.deliver(client, JSON.stringify(message));
  }

  broadcast(message: ServerToClientMessage): void {
    const clients = message.type === 'event'
      ? Array.from(this.clients).filter(client => {
          const subscription = this.eventSubscriptions.get(client);
          // Undefined preserves compatibility with clients that predate the
          // subscription message. New clients use null for "no transcript".
          return subscription === undefined || subscription === message.session_id;
        })
      : this.clients;
    if (message.type === 'event' && Array.isArray(clients) && clients.length === 0) return;
    const data = JSON.stringify(message);
    for (const client of clients) {
      this.deliver(client, data);
    }
  }

  private deliver(client: WSContext, data: string): void {
    const raw = client.raw as { bufferedAmount?: unknown } | undefined;
    const bufferedAmount = raw?.bufferedAmount;
    if (typeof bufferedAmount === 'number'
      && Number.isFinite(bufferedAmount)
      && bufferedAmount > WS_MAX_BUFFERED_BYTES) {
      this.evict(client, 1013, 'client is not keeping up');
      return;
    }
    try {
      client.send(data);
    } catch (err) {
      console.error('[ws] send failed', err);
      this.evict(client, 1011, 'send failed');
    }
  }

  private evict(client: WSContext, code: number, reason: string): void {
    this.remove(client);
    try {
      client.close(code, reason);
    } catch {
      // The transport may already be gone; removing it is the important part.
    }
  }

  get size(): number {
    return this.clients.size;
  }
}
