import { EventEmitter } from 'node:events';
import {
  RELAY_PROTOCOL,
  createRelayFramePacer,
  generateCanonicalId,
  parseRelayHandshake,
  type CryptoOffer,
  type RelayFrame,
  type RelayHandshake,
  type RelayNotice,
} from '@gian/remote-protocol';
import type { RemotePeerTransport } from './connector.js';
import { createSerialQueue } from './serial-queue.js';

export class DeviceRouteTransport implements RemotePeerTransport {
  readonly events = new EventEmitter();
  closed = false;

  constructor(
    private readonly sendFrame: (frame: unknown) => void,
    private readonly onDispose: () => void,
  ) {}

  send(frame: unknown): void {
    if (this.closed) return;
    this.sendFrame(frame);
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.events.emit('close', reason);
    this.onDispose();
  }

  onMessage(handler: (frame: unknown) => void): () => void {
    this.events.on('message', handler);
    return () => this.events.off('message', handler);
  }

  onClose(handler: () => void): () => void {
    this.events.on('close', handler);
    return () => this.events.off('close', handler);
  }
}

export class HostRelaySocket {
  connectionId = generateCanonicalId();
  private readonly routes = new Map<string, DeviceRouteTransport>();
  private readonly noticeHandlers = new Set<(notice: RelayNotice) => void>();
  private readonly handshakeHandlers = new Set<(offer: CryptoOffer) => void>();
  private readonly queuedNotices: RelayNotice[] = [];
  private readonly boundHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private readonly enqueueOutbound = createSerialQueue();
  private readonly framePacer = createRelayFramePacer();
  private closed = false;
  bound = false;

  private constructor(private readonly socket: WebSocket) {}

  static connect(input: { url: string; ticket: string }): Promise<HostRelaySocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(input.url);
      const relay = new HostRelaySocket(socket);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener('error', onError);
        if (error) reject(error);
        else resolve(relay);
      };
      const timer = setTimeout(() => finish(new Error('host relay auth timed out')), 5_000);
      const onError = (error: Event) => finish(new Error(String(error)));
      socket.addEventListener('error', onError);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          protocol: RELAY_PROTOCOL,
          type: 'ws.auth',
          ticket: input.ticket,
        }));
      }, { once: true });
      socket.addEventListener('message', (event) => {
        relay.#onMessage(typeof event.data === 'string' ? event.data : String(event.data));
        if (relay.bound) finish();
      });
      socket.addEventListener('close', () => {
        if (!relay.bound) finish(new Error('host relay closed before bind'));
        relay.close('socket_closed');
      });
    });
  }

  attachDevice(deviceId: string): DeviceRouteTransport {
    const existing = this.routes.get(deviceId);
    if (existing && !existing.closed) return existing;
    let transport: DeviceRouteTransport;
    transport = new DeviceRouteTransport(
      (frame) => this.sendWhen(frame, () => !transport.closed),
      () => this.routes.delete(deviceId),
    );
    this.routes.set(deviceId, transport);
    return transport;
  }

  send(frame: unknown): void {
    this.sendWhen(frame, () => true);
  }

  private sendWhen(frame: unknown, stillCurrent: () => boolean): void {
    if (this.closed) return;
    if (frame && typeof frame === 'object' && 'ciphertext' in frame) {
      void this.enqueueOutbound(async () => {
        await this.framePacer.wait();
        if (stillCurrent()) this.sendNow(frame);
      }).catch(() => undefined);
      return;
    }
    if (stillCurrent()) this.sendNow(frame);
  }

  private sendNow(frame: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    if (frame && typeof frame === 'object' && 'connection_id' in frame) {
      this.socket.send(JSON.stringify({ ...frame, connection_id: this.connectionId }));
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  sendHandshake(message: RelayHandshake): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  onHandshake(handler: (offer: CryptoOffer) => void): () => void {
    this.handshakeHandlers.add(handler);
    return () => this.handshakeHandlers.delete(handler);
  }

  ackRevoked(notice: RelayNotice): void {
    if (!notice.device_id) return;
    this.send({
      protocol: RELAY_PROTOCOL,
      type: 'device.revoked.ack',
      host_id: notice.host_id,
      device_id: notice.device_id,
      sent_at: Date.now(),
    });
  }

  onNotice(handler: (notice: RelayNotice) => void): () => void {
    this.noticeHandlers.add(handler);
    if (this.queuedNotices.length) {
      const queued = this.queuedNotices.splice(0);
      for (const notice of queued) handler(notice);
    }
    return () => this.noticeHandlers.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(reason = 'host_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.bound = false;
    for (const transport of this.routes.values()) transport.close(reason);
    this.routes.clear();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    for (const handler of this.closeHandlers) handler(reason);
  }

  #onMessage(raw: string): void {
    let parsed: { type?: string; device_id?: string };
    try {
      parsed = JSON.parse(raw) as { type?: string; device_id?: string };
    } catch {
      return;
    }
    if (parsed.type === 'ws.bound') {
      const bound = parsed as { connection_id?: string };
      if (bound.connection_id) this.connectionId = bound.connection_id;
      this.bound = true;
      for (const handler of this.boundHandlers) handler();
      return;
    }
    if (parsed.type === 'crypto.offer') {
      try {
        const offer = parseRelayHandshake(parsed);
        if (offer.type === 'crypto.offer') {
          for (const handler of this.handshakeHandlers) handler(offer);
        }
      } catch {
        return;
      }
      return;
    }
    if (
      parsed.type === 'device.revoked'
      || parsed.type === 'host.offline'
      || parsed.type === 'host.online'
      || parsed.type === 'pairing.claimed'
    ) {
      const notice = parsed as RelayNotice;
      if (this.noticeHandlers.size === 0) {
        this.queuedNotices.push(notice);
        return;
      }
      for (const handler of this.noticeHandlers) handler(notice);
      return;
    }
    const frame = parsed as RelayFrame;
    const route = frame.device_id ? this.routes.get(frame.device_id) : undefined;
    route?.events.emit('message', frame);
  }
}
