import {
  CONTENT_WINDOW_CHUNKS,
  RemoteProtocolError,
  TransportSequenceGuard,
  isContentFrame,
  isControlFrame,
  parseRelayFrame,
  utf8ByteLength,
  type RelayFrame,
  type RelayHandshake,
  type RelayNotice,
  type TransportDirection,
} from '@gian/remote-protocol';

import { type RemoteServerConfig } from '../config.js';
import { type PresenceService } from '../presence/leases.js';
import { ContentFlowWindow } from './content-window.js';
import { ControlOutbox } from './outbox.js';

export interface RelayPeer {
  role: 'host' | 'device';
  hostId: string;
  deviceId?: string;
  routeId: string;
  connectionId: string;
  send(frame: RelayFrame | RelayNotice | RelayHandshake): void;
  close(reason: string): void;
}

interface ConnectionState {
  peer: RelayPeer;
  inbound: TransportSequenceGuard;
  inboundByRoute: Map<string, TransportSequenceGuard>;
  frames: number[];
  byteStamps: { at: number; bytes: number }[];
  cryptoBound: boolean;
}

export class RelayRouter {
  readonly outbox: ControlOutbox;
  readonly content = new ContentFlowWindow();
  readonly #connections = new Map<string, ConnectionState>();
  readonly #heldCrypto = new Set<string>();

  constructor(
    private readonly config: RemoteServerConfig,
    private readonly presence: PresenceService,
  ) {
    this.outbox = new ControlOutbox(config.controlOutboxMaxFrames, config.controlOutboxMaxBytes);
  }

  attach(peer: RelayPeer): void {
    const replaced = this.#replaceMatching(peer);
    const held = peer.role === 'device' && peer.deviceId
      ? this.#heldCrypto.has(this.#cryptoKey(peer.hostId, peer.deviceId))
      : false;
    this.#connections.set(peer.connectionId, {
      peer,
      inbound: new TransportSequenceGuard(),
      inboundByRoute: new Map(),
      frames: [],
      byteStamps: [],
      cryptoBound: peer.role !== 'device' || (!replaced && !held),
    });
  }

  detach(connectionId: string): void {
    const state = this.#connections.get(connectionId);
    if (state?.peer.role === 'device' && state.peer.deviceId) {
      this.#holdCrypto(state.peer.hostId, state.peer.deviceId);
      this.outbox.dropDevice(state.peer.deviceId);
    }
    this.content.drop(connectionId);
    this.#connections.delete(connectionId);
  }

  restart(): void {
    this.outbox.clear();
  }

  hasHost(hostId: string): boolean {
    for (const entry of this.#connections.values()) {
      if (entry.peer.role === 'host' && entry.peer.hostId === hostId) return true;
    }
    return false;
  }

  closeDevice(hostId: string, deviceId: string): void {
    this.#holdCrypto(hostId, deviceId);
    for (const [id, state] of [...this.#connections]) {
      if (
        state.peer.role === 'device'
        && state.peer.hostId === hostId
        && state.peer.deviceId === deviceId
      ) {
        state.peer.close('device_revoked');
        this.content.drop(id);
        this.#connections.delete(id);
      }
    }
    this.outbox.dropDevice(deviceId);
  }

  notifyHost(hostId: string, notice: RelayNotice): void {
    for (const entry of this.#connections.values()) {
      if (entry.peer.role === 'host' && entry.peer.hostId === hostId) {
        entry.peer.send(notice);
      }
    }
  }

  handleHandshake(connectionId: string, message: RelayHandshake): void {
    const state = this.#connections.get(connectionId);
    // Replacement closes the old WebSocket asynchronously. Ignore any final
    // message already queued on that authenticated socket; its server-issued
    // connection id can no longer address a live route.
    if (!state) return;
    if (message.host_id !== state.peer.hostId) {
      throw new RemoteProtocolError('INVALID_FRAME', 'handshake crossed its host binding.');
    }
    if (state.peer.role === 'device') {
      if (message.type !== 'crypto.offer' || message.device_id !== state.peer.deviceId) {
        throw new RemoteProtocolError('INVALID_FRAME', 'device may only offer its own handshake.');
      }
    } else if (message.type !== 'crypto.accept') {
      throw new RemoteProtocolError('INVALID_FRAME', 'host may only accept a handshake.');
    }
    if (state.peer.role === 'device' && !this.presence.isOnline(message.host_id)) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'host is offline; handshake is not queued.');
    }
    this.outbox.dropDevice(message.device_id);
    if (message.type === 'crypto.accept') {
      this.#resetCryptoRoute(message.host_id, message.device_id);
      this.#bindCrypto(message.host_id, message.device_id);
    }
    const targetRole = state.peer.role === 'host' ? 'device' : 'host';
    for (const entry of this.#connections.values()) {
      if (entry.peer.role !== targetRole || entry.peer.hostId !== message.host_id) continue;
      if (targetRole === 'device' && entry.peer.deviceId !== message.device_id) continue;
      entry.peer.send(message);
    }
  }

  handleFrame(connectionId: string, raw: unknown): void {
    const state = this.#connections.get(connectionId);
    if (!state) return;
    const frame = parseRelayFrame(raw);
    const direction: TransportDirection = state.peer.role === 'host' ? 'host_to_device' : 'device_to_host';
    this.#assertInboundRoute(state.peer, frame);
    if (state.peer.role === 'host' && !this.#deviceCryptoBound(frame.host_id, frame.device_id)) {
      return;
    }
    this.#enforceRate(state, frame);
    if (state.peer.role === 'device' && !this.presence.isOnline(frame.host_id)) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'host is offline; business frames are not queued.');
    }
    if (isContentFrame(frame) && this.content.inFlight(connectionId) >= CONTENT_WINDOW_CHUNKS) {
      throw new RemoteProtocolError('RATE_LIMITED', 'content window is full.');
    }
    this.#acceptSequence(state, frame);
    this.#releaseContentWindow(state, frame);
    if (isContentFrame(frame)) {
      this.content.accept(connectionId, frame);
    } else if (isControlFrame(frame)) {
      try {
        this.outbox.enqueue(frame, direction);
      } catch (error) {
        state.peer.close('outbox_overflow');
        throw error;
      }
      const opposite: TransportDirection = direction === 'host_to_device' ? 'device_to_host' : 'host_to_device';
      this.outbox.ack(frame.route_id, opposite, frame.transport_ack);
    }
    this.#forward(state, frame);
  }

  #replaceMatching(peer: RelayPeer): boolean {
    let replaced = false;
    for (const [id, state] of [...this.#connections]) {
      const sameRoleAndHost = state.peer.role === peer.role && state.peer.hostId === peer.hostId;
      const sameDevice = peer.role === 'host' || state.peer.deviceId === peer.deviceId;
      if (!sameRoleAndHost || !sameDevice) continue;
      if (peer.role === 'device' && peer.deviceId) {
        this.#holdCrypto(peer.hostId, peer.deviceId);
        this.outbox.dropDevice(peer.deviceId);
      }
      state.peer.close('replaced');
      this.content.drop(id);
      this.#connections.delete(id);
      replaced = true;
    }
    return replaced;
  }

  #cryptoKey(hostId: string, deviceId: string): string {
    return `${hostId}:${deviceId}`;
  }

  #holdCrypto(hostId: string, deviceId: string): void {
    this.#heldCrypto.add(this.#cryptoKey(hostId, deviceId));
  }

  #bindCrypto(hostId: string, deviceId: string): void {
    this.#heldCrypto.delete(this.#cryptoKey(hostId, deviceId));
    for (const state of this.#connections.values()) {
      if (
        state.peer.role === 'device'
        && state.peer.hostId === hostId
        && state.peer.deviceId === deviceId
      ) {
        state.cryptoBound = true;
      }
    }
  }

  #deviceCryptoBound(hostId: string, deviceId: string): boolean {
    for (const state of this.#connections.values()) {
      if (
        state.peer.role === 'device'
        && state.peer.hostId === hostId
        && state.peer.deviceId === deviceId
      ) {
        return state.cryptoBound;
      }
    }
    return false;
  }

  #resetCryptoRoute(hostId: string, deviceId: string): void {
    const routeIds = new Set<string>([deviceId]);
    for (const state of this.#connections.values()) {
      if (
        state.peer.role === 'device'
        && state.peer.hostId === hostId
        && state.peer.deviceId === deviceId
      ) {
        routeIds.add(state.peer.routeId);
      }
    }
    for (const [id, state] of this.#connections) {
      if (state.peer.hostId !== hostId) continue;
      if (state.peer.role === 'host') {
        for (const routeId of routeIds) state.inboundByRoute.delete(routeId);
      }
      if (state.peer.role === 'device' && state.peer.deviceId === deviceId) {
        state.inbound = new TransportSequenceGuard();
        state.inboundByRoute.clear();
        this.content.drop(id);
      }
    }
  }

  #assertInboundRoute(peer: RelayPeer, frame: RelayFrame): void {
    if (frame.host_id !== peer.hostId || frame.connection_id !== peer.connectionId) {
      throw new RemoteProtocolError('INVALID_FRAME', 'relay frame crossed its route binding.');
    }
    if (peer.role === 'device' && (
      frame.device_id !== peer.deviceId
      || frame.route_id !== peer.routeId
    )) {
      throw new RemoteProtocolError('INVALID_FRAME', 'relay frame crossed its route binding.');
    }
  }

  #acceptSequence(state: ConnectionState, frame: RelayFrame): void {
    if (state.peer.role === 'host') {
      const guard = state.inboundByRoute.get(frame.route_id) ?? new TransportSequenceGuard();
      guard.accept(frame.transport_sequence);
      state.inboundByRoute.set(frame.route_id, guard);
      return;
    }
    state.inbound.accept(frame.transport_sequence);
  }

  #releaseContentWindow(state: ConnectionState, frame: RelayFrame): void {
    const targetRole = state.peer.role === 'host' ? 'device' : 'host';
    for (const entry of this.#connections.values()) {
      if (entry.peer.role !== targetRole || entry.peer.hostId !== frame.host_id) continue;
      if (targetRole === 'device' && entry.peer.deviceId !== frame.device_id) continue;
      this.content.releaseThrough(entry.peer.connectionId, frame.route_id, frame.transport_ack);
    }
  }

  #forward(state: ConnectionState, frame: RelayFrame): void {
    const targetRole = state.peer.role === 'host' ? 'device' : 'host';
    for (const entry of this.#connections.values()) {
      if (entry.peer.role !== targetRole || entry.peer.hostId !== frame.host_id) continue;
      if (targetRole === 'device' && entry.peer.deviceId !== frame.device_id) continue;
      entry.peer.send(frame);
    }
  }

  #enforceRate(state: ConnectionState, frame: RelayFrame): void {
    const now = this.config.now();
    state.frames = state.frames.filter((stamp) => stamp > now - 1000);
    state.frames.push(now);
    if (state.frames.length > this.config.maxControlFramesPerSecond) {
      throw new RemoteProtocolError('RATE_LIMITED', 'frame rate exceeded.');
    }
    const size = utf8ByteLength(frame.ciphertext);
    state.byteStamps = state.byteStamps.filter((entry) => entry.at > now - 1000);
    state.byteStamps.push({ at: now, bytes: size });
    const bytes = state.byteStamps.reduce((sum, entry) => sum + entry.bytes, 0);
    if (bytes > this.config.maxCiphertextBytesPerSecond) {
      throw new RemoteProtocolError('RATE_LIMITED', 'ciphertext byte rate exceeded.');
    }
  }
}
