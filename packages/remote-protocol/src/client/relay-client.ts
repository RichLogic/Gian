import {
  CONTENT_WINDOW_CHUNKS,
  MAX_RELAY_FRAME_BYTES,
  RELAY_PROTOCOL,
  RemoteProtocolError,
  createRemoteHello,
  validateRemoteHelloReply,
  type Hello,
  type HelloOk,
  assertFrameClassMatchesInner,
  assertInnerContentPlaintext,
  base64UrlToBytes,
  cryptoAcceptPayload,
  cryptoOfferPayload,
  exportPublicJwk,
  generateCanonicalId,
  generateP256KeyPair,
  importP256PublicKey,
  parseRelayFrame,
  parseRelayHandshake,
  signBytes,
  utf8ByteLength,
  verifyBytes,
  type CryptoAccept,
  type RelayFrame,
  type RelayNotice,
} from './protocol.js';
import { createCiphertextPacer } from '../ciphertext-pacer.js';
import { DeviceCryptoSession } from './crypto-session.js';
import { acceptMatchesOffer, type FrozenCryptoOffer } from './handshake.js';
export interface DeviceSigningIdentity {
  hostId: string;
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  privateKey?: CryptoKey;
  sign?: (bytes: Uint8Array) => Promise<string>;
}
import { createSerialQueue } from './serial-queue.js';

export interface HostFrameIo {
  crypto: {
    connectionId: string;
    open(input: {
      ciphertext: string;
      sequence: number;
      direction: 'host_to_device';
      routeId: string;
      connectionId: string;
    }): Promise<Uint8Array>;
  };
  noteAck: (transportAck: number) => void;
  onControl: (message: { type?: string }) => Promise<void> | void;
  sendError: (message: { type: 'error'; code: string; message: string }) => Promise<void> | void;
  close: (reason: string) => void;
  log?: (error: unknown) => void;
}

export type FrameOutcome = 'handled' | 'dropped' | 'closed';

/** Classify a failure on one inbound host frame. Only an AEAD open failure is
 *  an integrity boundary that justifies killing the connection; a malformed
 *  inner message is answered with an error frame and dropped so one bad
 *  frame cannot cascade into disconnect, backoff, and a full resync. */
export async function openHostFrame(raw: unknown, io: HostFrameIo): Promise<FrameOutcome> {
  let frame: RelayFrame;
  try {
    frame = parseRelayFrame(raw);
  } catch {
    return 'dropped';
  }
  io.noteAck(frame.transport_ack);
  let plaintext: Uint8Array;
  try {
    plaintext = await io.crypto.open({
      ciphertext: frame.ciphertext,
      sequence: frame.transport_sequence,
      direction: 'host_to_device',
      routeId: frame.route_id,
      connectionId: io.crypto.connectionId,
    });
  } catch (error) {
    io.close(error instanceof RemoteProtocolError ? error.code : 'INVALID_FRAME');
    return 'closed';
  }
  let message: { type?: string };
  try {
    message = JSON.parse(new TextDecoder().decode(plaintext)) as { type?: string };
    assertFrameClassMatchesInner(frame.frame_class, message.type);
  } catch (error) {
    await io.sendError({
      type: 'error',
      code: 'INVALID_FRAME',
      message: `bad inner message: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
    });
    return 'dropped';
  }
  try {
    await io.onControl(message);
  } catch (error) {
    io.log?.(error);
  }
  return 'handled';
}

export interface DeviceRelayHandlers {
  onControl(message: { type?: string; [key: string]: unknown }): void | Promise<void>;
  onNotice?(notice: RelayNotice): void;
  onClose?(reason: string): void;
}
export interface DeviceRelayLike {
  readonly isOpen: boolean;
  connect(): Promise<void>;
  sendControl(message: object): Promise<void>;
  sendContent(message: object): Promise<void>;
  close(reason?: string): void;
}

export type DeviceRelayFactory = (input: DeviceRelayClientOptions) => DeviceRelayLike;

export interface DeviceRelayClientOptions {
  wsUrl: string;
  ticket: string;
  identity: DeviceSigningIdentity;
  application?: string;
  requireNegotiated?: boolean;
  requireExecution?: boolean;
  hostPublicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  hostId: string;
  deviceId: string;
  cryptoConnectionId: string;
  handlers: DeviceRelayHandlers;
}

export class DeviceRelayClient implements DeviceRelayLike {
  private socket: WebSocket | null = null;
  private crypto: DeviceCryptoSession | null = null;
  private socketConnectionId: string | null = null;
  private closed = false;
  private peerTransportAck = -1;
  private readonly pending: unknown[] = [];
  private readonly enqueueInbound = createSerialQueue();
  private readonly enqueueOutbound = createSerialQueue();
  private readonly ciphertextPacer = createCiphertextPacer();
  private acceptWaiter: ((accept: CryptoAccept) => void) | null = null;
  private acceptReject: ((error: Error) => void) | null = null;
  private frozenOffer: FrozenCryptoOffer | null = null;
  private helloOffer: Hello | null = null;
  private helloGeneration = '';
  private helloResolve: ((reply: HelloOk | null) => void) | null = null;
  private helloReject: ((error: Error) => void) | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private protocolReady = false;
  private readonly deferredControl: Array<{ type?: string; [key: string]: unknown }> = [];
  protocolMode: 'pending' | 'legacy' | 'negotiated' = 'pending';

  constructor(private readonly input: DeviceRelayClientOptions) {}

  get isOpen(): boolean {
    return !this.closed && this.protocolReady && this.crypto !== null && this.socket?.readyState === WebSocket.OPEN;
  }

  get hostGeneration(): string { return this.helloGeneration; }

  private async sign(bytes: Uint8Array): Promise<string> {
    if (this.input.identity.sign) return this.input.identity.sign(bytes);
    if (!this.input.identity.privateKey) throw new RemoteProtocolError('AUTH_REQUIRED', 'device signer unavailable');
    return signBytes(this.input.identity.privateKey, bytes);
  }

  async connect(): Promise<void> {
    const bound = await this.authenticate();
    this.socketConnectionId = bound.connection_id;
    const ephemeral = await generateP256KeyPair();
    const deviceEphemeral = await exportPublicJwk(ephemeral.publicKey);
    const sentAt = Date.now();
    const offerFields = {
      host_id: this.input.hostId,
      device_id: this.input.deviceId,
      crypto_connection_id: this.input.cryptoConnectionId,
      handshake_nonce: generateCanonicalId(),
      sent_at: sentAt,
      device_identity: this.input.identity.publicJwk,
      device_ephemeral: deviceEphemeral,
    };
    this.frozenOffer = {
      handshake_nonce: offerFields.handshake_nonce,
      device_ephemeral: deviceEphemeral,
      sent_at: sentAt,
    };
    const acceptPromise = new Promise<CryptoAccept>((resolve, reject) => {
      this.acceptWaiter = resolve;
      this.acceptReject = reject;
    });
    this.sendRaw({
      protocol: RELAY_PROTOCOL,
      type: 'crypto.offer',
      ...offerFields,
      signature: await this.sign(new TextEncoder().encode(cryptoOfferPayload(offerFields))),
    });
    const accept = await Promise.race([
      acceptPromise,
      sleepReject(8_000, 'crypto.accept timed out'),
    ]);
    if (!this.frozenOffer || !acceptMatchesOffer(accept, this.frozenOffer)) {
      throw new RemoteProtocolError('INVALID_FRAME', 'crypto.accept does not match the current offer');
    }
    const hostKey = await importP256PublicKey(this.input.hostPublicKey, 'verify');
    const acceptOk = await verifyBytes(
      hostKey,
      new TextEncoder().encode(cryptoAcceptPayload({
        host_id: this.input.hostId,
        device_id: this.input.deviceId,
        crypto_connection_id: this.input.cryptoConnectionId,
        handshake_nonce: accept.handshake_nonce,
        sent_at: accept.sent_at,
        host_generation: accept.host_generation,
        host_identity: accept.host_identity,
        device_identity: this.input.identity.publicJwk,
        host_ephemeral: accept.host_ephemeral,
        device_ephemeral: accept.device_ephemeral,
      })),
      base64UrlToBytes(accept.signature),
    );
    if (!acceptOk) {
      throw new RemoteProtocolError('INVALID_FRAME', 'crypto.accept signature is invalid');
    }
    this.crypto = await DeviceCryptoSession.fromHandshake({
      localPrivate: ephemeral.privateKey,
      remotePublic: await importP256PublicKey(accept.host_ephemeral, 'deriveBits'),
      transcript: {
        host_identity: accept.host_identity,
        device_identity: this.input.identity.publicJwk,
        host_ephemeral: accept.host_ephemeral,
        device_ephemeral: deviceEphemeral,
        connection_id: this.input.cryptoConnectionId,
      },
      sendDirection: 'device_to_host',
      binding: {
        hostGeneration: accept.host_generation,
        hostId: this.input.hostId,
        deviceId: this.input.deviceId,
        routeId: this.input.deviceId,
        connectionId: this.input.cryptoConnectionId,
      },
    });
    this.helloOffer = createRemoteHello(this.input.deviceId, this.input.application ?? 'remote-web');
    this.helloGeneration = accept.host_generation;
    const negotiated = new Promise<HelloOk | null>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
      // Existing Hosts ignore hello. This bounded transition preserves those
      // deployments; an explicit rejection or socket close NEVER falls back.
      this.helloTimer = setTimeout(() => resolve(null), 1500);
    });
    // Install the rejection handler before sending or draining queued frames.
    const outcome = negotiated.then(reply => ({ reply }), error => ({ error }));
    try {
      await this.enqueueSealed('control', this.helloOffer);
      await this.enqueueInbound(async () => {
        while (this.pending.length) {
          await this.openFrame(this.pending.shift());
        }
      });
      const result = await outcome;
      if ('error' in result) throw result.error;
      if (this.closed) throw new RemoteProtocolError('HOST_OFFLINE', 'Connection closed during Remote negotiation');
      if (!result.reply && this.input.requireNegotiated) throw new RemoteProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'Remote execution requires negotiation');
      if (this.input.requireExecution && !result.reply?.negotiated_capabilities.includes('wire.execution_v1')) {
        throw new RemoteProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'Host does not support native remote execution');
      }
      this.protocolMode = result.reply ? 'negotiated' : 'legacy';
      this.protocolReady = true;
      for (const message of this.deferredControl.splice(0)) await this.input.handlers.onControl(message);
    } catch (error) {
      this.close('remote_negotiation_failed');
      throw error;
    } finally {
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      this.helloResolve = null;
      this.helloReject = null;
    }
  }

  async sendControl(message: object): Promise<void> {
    await this.enqueueSealed('control', message);
  }

  async sendContent(message: object): Promise<void> {
    assertInnerContentPlaintext(message);
    await this.enqueueSealed('content', message);
  }

  private async enqueueSealed(frameClass: 'control' | 'content', message: object): Promise<void> {
    await this.enqueueOutbound(async () => {
      if (this.closed || !this.crypto || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new RemoteProtocolError('HOST_OFFLINE', 'device relay is not open');
      }
      assertFrameClassMatchesInner(frameClass, (message as { type?: string }).type);
      if (frameClass === 'content') {
        await this.waitForContentWindow();
      }
      const sealed = await this.crypto.seal(new TextEncoder().encode(JSON.stringify(message)));
      const ciphertextBytes = utf8ByteLength(sealed.ciphertext);
      await this.ciphertextPacer.wait(ciphertextBytes);
      const socket = this.socket;
      const crypto = this.crypto;
      if (this.closed || !crypto || !socket || socket.readyState !== WebSocket.OPEN) {
        this.ciphertextPacer.note(ciphertextBytes);
        throw new RemoteProtocolError('HOST_OFFLINE', 'device relay is not open');
      }
      // Wire connection_id is the Server socket id; AEAD AAD keeps crypto_connection_id.
      socket.send(JSON.stringify({
        protocol: RELAY_PROTOCOL,
        frame_id: generateCanonicalId(),
        frame_class: frameClass,
        route_id: crypto.routeId,
        host_id: crypto.hostId,
        device_id: crypto.deviceId,
        connection_id: this.socketConnectionId ?? crypto.connectionId,
        transport_ack: crypto.inboundAck,
        transport_sequence: sealed.sequence,
        sent_at: Date.now(),
        ciphertext: sealed.ciphertext,
      }));
      this.ciphertextPacer.note(ciphertextBytes);
    });
  }

  private async waitForContentWindow(): Promise<void> {
    const started = Date.now();
    while (
      this.crypto
      && (this.crypto.outboundSequence - (this.peerTransportAck + 1)) >= CONTENT_WINDOW_CHUNKS
    ) {
      if (Date.now() - started > 5_000) {
        throw new RemoteProtocolError('RATE_LIMITED', 'content window is full');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  close(reason = 'device_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.protocolReady = false;
    this.helloReject?.(new RemoteProtocolError('HOST_OFFLINE', reason));
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.deferredControl.length = 0;
    this.crypto?.close();
    this.crypto = null;
    this.acceptReject?.(new Error(reason));
    this.acceptWaiter = null;
    this.acceptReject = null;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      this.socket.close();
    }
    this.socket = null;
    this.input.handlers.onClose?.(reason);
  }

  private authenticate(): Promise<{ connection_id: string }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.input.wsUrl);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('device relay auth timed out')), 5_000);
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('device relay socket error'));
      });
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          protocol: RELAY_PROTOCOL,
          type: 'ws.auth',
          ticket: this.input.ticket,
        }));
      });
      socket.addEventListener('close', (event) => {
        const reason = event.reason || 'socket_closed';
        if (!this.crypto && !this.closed) {
          clearTimeout(timer);
          reject(new Error(reason));
        }
        this.close(reason);
      });
      socket.addEventListener('message', (event) => {
        let parsed: {
          type?: string;
          connection_id?: string;
        };
        try {
          const text = String(event.data);
          if (utf8ByteLength(text) > MAX_RELAY_FRAME_BYTES) throw new Error('oversized frame');
          parsed = JSON.parse(text) as typeof parsed;
          if (!parsed || typeof parsed !== 'object') throw new Error('invalid frame');
        } catch { this.close('invalid_frame'); return; }
        if (parsed.type === 'ws.bound') {
          clearTimeout(timer);
          resolve({ connection_id: String(parsed.connection_id) });
          return;
        }
        void this.enqueueInbound(() => this.receive(parsed)).catch(() => this.close('invalid_frame'));
      });
    });
  }

  private async receive(parsed: { type?: string }): Promise<void> {
    if (parsed.type === 'crypto.accept') {
      try {
        const handshake = parseRelayHandshake(parsed);
        if (handshake.type === 'crypto.accept') {
          if (!this.frozenOffer || !acceptMatchesOffer(handshake, this.frozenOffer)) {
            this.acceptReject?.(new RemoteProtocolError(
              'INVALID_FRAME',
              'crypto.accept does not match the current offer',
            ));
            this.acceptWaiter = null;
            this.acceptReject = null;
            return;
          }
          this.acceptWaiter?.(handshake);
          this.acceptWaiter = null;
          this.acceptReject = null;
        }
      } catch (error) {
        this.acceptReject?.(error instanceof Error ? error : new Error('invalid crypto.accept'));
      }
      return;
    }
    if (
      parsed.type === 'host.offline'
      || parsed.type === 'host.online'
      || parsed.type === 'device.revoked'
    ) {
      this.input.handlers.onNotice?.(parsed as RelayNotice);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || !('ciphertext' in parsed)) return;
    if (!this.crypto) {
      if (this.pending.length >= 64) { this.close('handshake_overflow'); return; }
      this.pending.push(parsed);
      return;
    }
    await this.openFrame(parsed);
  }

  private async openFrame(raw: unknown): Promise<void> {
    if (!this.crypto) return;
    await openHostFrame(raw, {
      crypto: this.crypto,
      noteAck: (ack) => {
        this.peerTransportAck = Math.max(this.peerTransportAck, ack);
      },
      onControl: async message => {
        if (message.type === 'hello.ok') {
          try {
            if (!this.helloOffer) throw new RemoteProtocolError('INVALID_FRAME', 'Unsolicited hello reply');
            const reply = validateRemoteHelloReply(message, this.helloOffer, this.input.cryptoConnectionId, this.helloGeneration);
            if (this.protocolMode === 'legacy') this.protocolMode = 'negotiated';
            this.helloResolve?.(reply);
          } catch (error) {
            this.helloReject?.(error instanceof Error ? error : new Error('Invalid hello reply'));
            this.close('remote_negotiation_failed');
          }
          return;
        }
        const control = message as { type?: string; [key: string]: unknown };
        if (message.type === 'error' && control.code === 'PROTOCOL_VERSION_UNSUPPORTED') {
          this.helloReject?.(new RemoteProtocolError('PROTOCOL_VERSION_UNSUPPORTED', String(control.message ?? 'Remote protocol mismatch')));
          this.close('remote_protocol_unsupported');
          return;
        }
        if (!this.protocolReady) {
          if (this.deferredControl.length >= 64) { this.close('remote_negotiation_overflow'); return; }
          this.deferredControl.push(control);
          return;
        }
        await this.input.handlers.onControl(control);
      },
      sendError: async message => {
        try {
          await this.sendControl(message);
        } catch {
          // The socket is gone; close handling owns recovery.
        }
      },
      close: reason => this.close(reason),
      log: error => console.error('[remote] control handler failed; frame dropped', error),
    });
  }

  private sendRaw(value: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'device relay is not open');
    }
    this.socket.send(JSON.stringify(value));
  }
}

function sleepReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
