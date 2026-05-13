import type { ServerToClientMessage } from '@gian/shared';
import type { WSContext } from 'hono/ws';

/**
 * Tracks authenticated WebSocket clients and broadcasts messages to them.
 * Single-user app — no per-user filtering needed.
 */
export class WsBroadcaster {
  private clients = new Set<WSContext>();

  add(client: WSContext): void {
    this.clients.add(client);
  }

  remove(client: WSContext): void {
    this.clients.delete(client);
  }

  send(client: WSContext, message: ServerToClientMessage): void {
    try {
      client.send(JSON.stringify(message));
    } catch (err) {
      console.error('[ws] send failed', err);
    }
  }

  broadcast(message: ServerToClientMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
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
