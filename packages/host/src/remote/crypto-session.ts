import {
  RemoteProtocolError,
  base64UrlToBytes,
  buildRelayAad,
  decryptRemotePayload,
  deriveDirectionKeys,
  encryptRemotePayload,
  generateCanonicalId,
  handshakeTranscriptHash,
  type RelayAadInput,
  type TransportDirection,
} from '@gian/remote-protocol';
import type { CryptoKey } from './crypto-types.js';
import { createSerialQueue } from './serial-queue.js';

export interface PeerCryptoBinding {
  hostGeneration: string;
  hostId: string;
  deviceId: string;
  routeId: string;
  connectionId: string;
}

export class PeerCryptoSession {
  private outbound = 0;
  private inboundExpected = 0;
  private closed = false;
  private readonly enqueueSeal = createSerialQueue();
  private readonly enqueueOpen = createSerialQueue();

  constructor(
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
    private readonly sendDirection: TransportDirection,
    private readonly recvDirection: TransportDirection,
    private readonly binding: PeerCryptoBinding,
  ) {}

  static async fromHandshake(input: {
    localPrivate: CryptoKey;
    remotePublic: CryptoKey;
    transcript: Parameters<typeof handshakeTranscriptHash>[0];
    sendDirection: TransportDirection;
    binding: PeerCryptoBinding;
  }): Promise<PeerCryptoSession> {
    const hash = await handshakeTranscriptHash(input.transcript);
    const keys = await deriveDirectionKeys(input.localPrivate, input.remotePublic, hash);
    const recvDirection = input.sendDirection === 'host_to_device' ? 'device_to_host' : 'host_to_device';
    return new PeerCryptoSession(
      keys[input.sendDirection],
      keys[recvDirection],
      input.sendDirection,
      recvDirection,
      input.binding,
    );
  }

  get connectionId(): string {
    return this.binding.connectionId;
  }

  get inboundAck(): number {
    return this.inboundExpected === 0 ? 0 : this.inboundExpected - 1;
  }

  get outboundSequence(): number {
    return this.outbound;
  }

  get routeId(): string {
    return this.binding.routeId;
  }

  get hostId(): string {
    return this.binding.hostId;
  }

  get deviceId(): string {
    return this.binding.deviceId;
  }

  async seal(plaintext: Uint8Array): Promise<{ ciphertext: string; sequence: number; aad: RelayAadInput }> {
    return this.enqueueSeal(async () => {
      this.assertOpen();
      const sequence = this.outbound;
      const aad = this.aad(this.sendDirection, sequence);
      const sealed = await encryptRemotePayload(this.sendKey, aad, plaintext);
      this.outbound += 1;
      return { ciphertext: sealed.ciphertext, sequence, aad };
    });
  }

  async open(input: {
    ciphertext: string;
    sequence: number;
    direction: TransportDirection;
    routeId: string;
    connectionId: string;
  }): Promise<Uint8Array> {
    return this.enqueueOpen(async () => {
      this.assertOpen();
      if (input.direction !== this.recvDirection) {
        this.close();
        throw new RemoteProtocolError('INVALID_FRAME', 'wrong transport direction');
      }
      if (input.routeId !== this.binding.routeId) {
        this.close();
        throw new RemoteProtocolError('INVALID_FRAME', 'cross-route frame');
      }
      if (input.sequence < this.inboundExpected) {
        this.close();
        throw new RemoteProtocolError('INVALID_FRAME', 'replay or rollback');
      }
      if (input.sequence !== this.inboundExpected) {
        this.close();
        throw new RemoteProtocolError('INVALID_FRAME', 'transport sequence gap');
      }
      try {
        const plaintext = await decryptRemotePayload(
          this.recvKey,
          this.aad(input.direction, input.sequence),
          base64UrlToBytes(input.ciphertext),
        );
        this.inboundExpected += 1;
        return plaintext;
      } catch (error) {
        this.close();
        throw error;
      }
    });
  }

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  bindAad(direction: TransportDirection, sequence: number): Uint8Array {
    return buildRelayAad(this.aad(direction, sequence));
  }

  private aad(direction: TransportDirection, sequence: number): RelayAadInput {
    return {
      host_generation: this.binding.hostGeneration,
      host_id: this.binding.hostId,
      device_id: this.binding.deviceId,
      route_id: this.binding.routeId,
      connection_id: this.binding.connectionId,
      direction,
      transport_sequence: sequence,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new RemoteProtocolError('INVALID_FRAME', 'crypto session is closed');
  }
}

export function newConnectionId(): string {
  return generateCanonicalId();
}
