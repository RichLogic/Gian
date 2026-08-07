import type { ServerToClientMessage } from '@gian/shared';
import type { WSContext } from 'hono/ws';

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
    try {
      client.send(JSON.stringify(message));
    } catch (err) {
      console.error('[ws] send failed', err);
    }
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
      try {
        client.send(data);
      } catch (err) {
        console.error('[ws] broadcast failed', err);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}
