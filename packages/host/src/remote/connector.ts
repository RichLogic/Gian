import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  CONTENT_WINDOW_CHUNKS,
  MAX_ATTACHMENT_BYTES,
  MAX_CONCURRENT_TRANSFERS_PER_DEVICE,
  RemoteProtocolError,
  assertInnerContentPlaintext,
  base64UrlToBytes,
  bytesToBase64Url,
  contentChunkRawByteLimit,
  generateCanonicalId,
  isRemoteErrorCode,
  parseClosed,
  parseCommandRequest,
  parseContentChunk,
  parseRelayFrame,
  assertFrameClassMatchesInner,
  utf8ByteLength,
  attachmentBeginSchema,
  attachmentCompleteSchema,
  downloadRequestSchema,
  transferAckSchema,
  type CommandRequest,
  type RelayFrame,
} from '@gian/remote-protocol';
import type { RemoteAttachmentService } from './attachment-stream.js';
import { createCiphertextPacer } from './ciphertext-pacer.js';
import { PeerCryptoSession } from './crypto-session.js';
import type { RemoteDeviceRecord } from './device-store.js';
import type { RemoteFileRefService } from './file-ref.js';
import { RemoteReplayBuffer } from './replay-buffer.js';
import { createSerialQueue } from './serial-queue.js';

export interface RemotePeerTransport {
  send(frame: unknown): void;
  close(reason?: string): void;
  onMessage(handler: (frame: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
}

export interface RemoteServerAuthClient {
  challenge(hostId: string): Promise<{
    challenge_id: string;
    challenge: string;
    expires_at: number;
    server_identity_fingerprint: string;
    server_identity: {
      algorithm: 'P-256';
      public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      fingerprint: string;
    };
    server_identity_signature: string;
  }>;
  login(input: {
    hostId: string;
    challengeId: string;
    signature: string;
    refreshSecret: string;
  }): Promise<{ connector_access_token: string; refresh_secret: string }>;
  heartbeat(hostId: string): Promise<void>;
  createPairing(): Promise<{
    grant_id: string;
    code: string;
    grant_nonce: string;
    expires_at: number;
  }>;
  confirmPairing(pairingId: string, decision: 'confirm' | 'reject'): Promise<{
    pairing_id: string;
    status: 'confirmed' | 'rejected';
    device_id?: string;
    crypto_connection_id?: string;
  }>;
  revokeDevice(deviceId: string): Promise<void>;
}

export class MemoryDuplexTransport implements RemotePeerTransport {
  readonly events = new EventEmitter();
  peer: MemoryDuplexTransport | null = null;
  closed = false;

  static pair(): { host: MemoryDuplexTransport; device: MemoryDuplexTransport } {
    const host = new MemoryDuplexTransport();
    const device = new MemoryDuplexTransport();
    host.peer = device;
    device.peer = host;
    return { host, device };
  }

  send(frame: unknown): void {
    if (this.closed) return;
    queueMicrotask(() => this.peer?.events.emit('message', frame));
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.events.emit('close', reason);
    this.peer?.events.emit('close', reason);
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

export class RemoteConnector {
  generation = generateCanonicalId();
  private attempts = 0;
  private closed = false;
  private peerTransportAck = -1;
  private readonly transferAckOffset = new Map<string, number>();
  private readonly activeDownloadTransfers = new Set<string>();
  private readonly enqueueInbound = createSerialQueue();
  private readonly enqueueOutbound = createSerialQueue();
  private readonly ciphertextPacer = createCiphertextPacer();

  constructor(
    private readonly transport: RemotePeerTransport,
    private readonly crypto: PeerCryptoSession,
    private readonly replay: RemoteReplayBuffer,
    private readonly onCommand: (
      device: RemoteDeviceRecord,
      command: CommandRequest,
      hooks?: { onAccepted?: () => Promise<void> },
    ) => Promise<unknown>,
    private readonly device: RemoteDeviceRecord,
    _auth?: RemoteServerAuthClient,
    _hostId?: string,
    private readonly services?: {
      attachments?: RemoteAttachmentService;
      fileRefs?: RemoteFileRefService;
    },
  ) {
    this.transport.onMessage(frame => {
      void this.enqueueInbound(() => this.receive(frame));
    });
    this.transport.onClose(() => {
      this.closed = true;
      this.crypto.close();
    });
  }

  get connected(): boolean { return !this.closed; }

  nextBackoffMs(): number {
    const exp = Math.min(30_000, 500 * (2 ** this.attempts));
    this.attempts += 1;
    const jitter = Math.floor(Math.random() * 200);
    return exp + jitter;
  }

  resetBackoff(): void {
    this.attempts = 0;
  }

  restartGeneration(): string {
    this.generation = generateCanonicalId();
    return this.generation;
  }

  async sendControl(message: object): Promise<void> {
    await this.enqueueOutbound(async () => {
      if (this.closed) return;
      assertFrameClassMatchesInner('control', (message as { type?: string }).type);
      const sealed = await this.crypto.seal(new TextEncoder().encode(JSON.stringify(message)));
      const ciphertextBytes = utf8ByteLength(sealed.ciphertext);
      await this.ciphertextPacer.wait(ciphertextBytes);
      const frame: RelayFrame = {
        protocol: 'gian.relay/1',
        frame_id: generateCanonicalId(),
        frame_class: 'control',
        route_id: this.crypto.routeId,
        host_id: this.crypto.hostId,
        device_id: this.crypto.deviceId,
        connection_id: this.crypto.connectionId,
        transport_sequence: sealed.sequence,
        transport_ack: this.crypto.inboundAck,
        sent_at: Date.now(),
        ciphertext: sealed.ciphertext,
      };
      this.transport.send(frame);
      this.ciphertextPacer.note(ciphertextBytes);
    });
  }

  close(): void {
    this.closed = true;
    this.crypto.close();
    this.transport.close('host_closed');
  }

  private async receive(raw: unknown): Promise<void> {
    if (this.closed) return;
    let messageType: string | undefined;
    let transferId: string | undefined;
    try {
      const frame = parseRelayFrame(raw);
      this.peerTransportAck = Math.max(this.peerTransportAck, frame.transport_ack);
      const plaintext = await this.crypto.open({
        ciphertext: frame.ciphertext,
        sequence: frame.transport_sequence,
        direction: 'device_to_host',
        routeId: frame.route_id,
        connectionId: this.crypto.connectionId,
      });
      const message = JSON.parse(new TextDecoder().decode(plaintext)) as {
        type?: string;
        transfer_id?: string;
      };
      messageType = message.type;
      transferId = typeof message.transfer_id === 'string' ? message.transfer_id : undefined;
      assertFrameClassMatchesInner(frame.frame_class, message.type);
      if (message.type === 'command.request') {
        const command = parseCommandRequest(message, Date.now());
        const result = await this.onCommand(this.device, command, {
          onAccepted: async () => {
            await this.sendControl({
              type: 'command.accepted',
              command_id: command.command_id,
              attempt_id: command.attempt_id,
            });
          },
        });
        await this.sendControl({
          type: 'command.result',
          command_id: command.command_id,
          attempt_id: command.attempt_id,
          ...(result as object),
        });
        return;
      }
      if (message.type === 'transfer.ack') {
        const ack = parseClosed(transferAckSchema, message);
        if (this.activeDownloadTransfers.has(ack.transfer_id)) {
          this.transferAckOffset.set(ack.transfer_id, ack.contiguous_offset);
        }
        return;
      }
      if (message.type === 'attachment.begin' || message.type === 'attachment.chunk' || message.type === 'attachment.complete') {
        await this.receiveUpload(message);
        return;
      }
      if (message.type === 'download.request') {
        void this.receiveDownload(message).catch(async (error) => {
          await this.sendTransferFailure(transferId, error);
        });
        return;
      }
      if (message.type === 'resume.request') {
        const subscribedSessionId = String(
          (message as { subscribed_session_id?: string }).subscribed_session_id ?? '',
        );
        const replayed = this.replay.replayAfter(
          Number((message as { after_event_sequence?: number }).after_event_sequence ?? -1),
          String((message as { current_revision?: string }).current_revision ?? ''),
        );
        if (replayed === 'snapshot') {
          await this.sendControl({ type: 'snapshot.required', reason: 'gap_evicted' });
          return;
        }
        await this.sendControl({
          type: 'resume.ok',
          host_generation: this.generation,
          replay_from: replayed[0]?.eventSequence ?? this.replay.eventSequence,
          replay_through: this.replay.eventSequence,
          revision: this.replay.currentRevision,
        });
        for (const envelope of replayed) {
          if (subscribedSessionId && isOtherSessionTranscript(envelope.message, subscribedSessionId)) {
            continue;
          }
          await this.sendControl(envelope.message);
        }
      }
    } catch (error) {
      const code = error instanceof RemoteProtocolError ? error.code : 'INVALID_FRAME';
      if (isFrameClassViolation(error) || !isTransferType(messageType)) {
        this.crypto.close();
        this.transport.close(code);
        return;
      }
      await this.sendTransferFailure(transferId, error);
    }
  }

  private async sendTransferFailure(transferId: string | undefined, error: unknown): Promise<void> {
    const code = error instanceof RemoteProtocolError ? error.code : 'INVALID_FRAME';
    const message = error instanceof Error ? error.message.slice(0, 256) : 'transfer failed';
    const payload = transferId
      ? {
        type: 'transfer.error' as const,
        transfer_id: transferId,
        code: isRemoteErrorCode(code) ? code : 'INVALID_FRAME',
        message,
      }
      : {
        type: 'error' as const,
        code: isRemoteErrorCode(code) ? code : 'INVALID_FRAME',
        message,
      };
    await this.sendControl(payload).catch(() => undefined);
  }

  private async receiveUpload(message: { type?: string }): Promise<void> {
    const attachments = this.services?.attachments;
    if (!attachments) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'attachment uploads are not available');
    }
    if (message.type === 'attachment.begin') {
      const begin = parseClosed(attachmentBeginSchema, message);
      const intent = await attachments.begin({
        deviceId: this.device.id,
        sessionId: begin.session_id,
        name: begin.name,
        mime: begin.mime,
        size: begin.size,
        sha256: begin.sha256,
        uploadId: begin.upload_id,
        transferId: begin.transfer_id,
      });
      await this.sendControl({
        type: 'transfer.ack',
        transfer_id: begin.transfer_id,
        contiguous_offset: intent.received,
        window_chunks: CONTENT_WINDOW_CHUNKS,
      });
      return;
    }
    if (message.type === 'attachment.chunk') {
      const chunk = parseContentChunk(message);
      const intent = attachments.getByTransferId(this.device.id, chunk.transfer_id);
      const updated = await attachments.writeChunk({
        deviceId: this.device.id,
        uploadId: intent?.id ?? chunk.transfer_id,
        offset: chunk.offset,
        bytes: Buffer.from(base64UrlToBytes(chunk.bytes)),
      });
      await this.sendControl({
        type: 'transfer.ack',
        transfer_id: chunk.transfer_id,
        contiguous_offset: updated.received,
        window_chunks: CONTENT_WINDOW_CHUNKS,
      });
      return;
    }
    const complete = parseClosed(attachmentCompleteSchema, message);
    const intentByTransfer = attachments.getByTransferId(this.device.id, complete.transfer_id);
    const item = await attachments.complete({
      deviceId: this.device.id,
      uploadId: intentByTransfer?.id ?? complete.upload_id,
    });
    const intent = attachments.get(intentByTransfer?.id ?? complete.upload_id);
    await this.sendControl({
      type: 'attachment.result',
      transfer_id: complete.transfer_id,
      upload_id: complete.upload_id,
      attachment_id: complete.upload_id,
      name: intent?.name ?? ('name' in item ? item.name : 'attachment'),
      mime: intent?.mime ?? ('mime' in item ? item.mime : 'application/octet-stream'),
      size: intent?.size ?? ('size' in item ? item.size : 0),
      sha256: intent?.sha256 ?? '',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  }

  private async receiveDownload(message: unknown): Promise<void> {
    const request = parseClosed(downloadRequestSchema, message);
    if (this.activeDownloadTransfers.has(request.transfer_id)) {
      throw new RemoteProtocolError('TRANSFER_CONFLICT', 'download transfer is already active');
    }
    if (this.activeDownloadTransfers.size >= MAX_CONCURRENT_TRANSFERS_PER_DEVICE) {
      throw new RemoteProtocolError('RATE_LIMITED', 'too many active downloads for this device');
    }
    this.activeDownloadTransfers.add(request.transfer_id);
    try {
      const payload = request.kind === 'attachment'
        ? await this.services?.attachments?.readBytes(this.device.id, request.handle_id)
        : await this.services?.fileRefs?.readBytes({
          deviceId: this.device.id,
          handleId: request.handle_id,
          maxBytes: MAX_ATTACHMENT_BYTES,
        });
      if (!payload) {
        throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'file download is not available');
      }
      const offset = request.offset ?? 0;
      const bytes = payload.bytes.subarray(offset);
      const digest = createHash('sha256').update(payload.bytes).digest('hex');
      await this.sendControl({
        type: 'download.metadata',
        transfer_id: request.transfer_id,
        name: payload.name,
        mime: payload.mime,
        size: payload.bytes.length,
        sha256: digest,
        disposition: request.kind === 'file' ? 'inline' : 'attachment',
        preview: payload.bytes.length <= 1024 * 1024,
      });
      const rawChunk = contentChunkRawByteLimit();
      const windowBytes = rawChunk * CONTENT_WINDOW_CHUNKS;
      let cursor = 0;
      let transferSequence = 0;
      while (cursor < bytes.length) {
        await this.waitForTransferWindow(request.transfer_id, cursor, windowBytes);
        const slice = bytes.subarray(cursor, cursor + rawChunk);
        await this.sendContentMessage({
          type: 'attachment.chunk',
          transfer_id: request.transfer_id,
          transfer_sequence: transferSequence,
          offset: offset + cursor,
          bytes: bytesToBase64Url(slice),
        });
        cursor += slice.length;
        transferSequence += 1;
      }
      await this.sendControl({
        type: 'download.complete',
        transfer_id: request.transfer_id,
        size: payload.bytes.length,
        sha256: digest,
      });
    } finally {
      this.activeDownloadTransfers.delete(request.transfer_id);
      this.transferAckOffset.delete(request.transfer_id);
    }
  }

  private async sendContentMessage(message: object): Promise<void> {
    assertFrameClassMatchesInner('content', (message as { type?: string }).type);
    assertInnerContentPlaintext(message);
    await this.waitForContentWindow();
    await this.enqueueOutbound(async () => {
      const sealed = await this.crypto.seal(new TextEncoder().encode(JSON.stringify(message)));
      const ciphertextBytes = utf8ByteLength(sealed.ciphertext);
      await this.ciphertextPacer.wait(ciphertextBytes);
      const frame: RelayFrame = {
        protocol: 'gian.relay/1',
        frame_id: generateCanonicalId(),
        frame_class: 'content',
        route_id: this.crypto.routeId,
        host_id: this.crypto.hostId,
        device_id: this.crypto.deviceId,
        connection_id: this.crypto.connectionId,
        transport_sequence: sealed.sequence,
        transport_ack: this.crypto.inboundAck,
        sent_at: Date.now(),
        ciphertext: sealed.ciphertext,
      };
      this.transport.send(frame);
      this.ciphertextPacer.note(ciphertextBytes);
    });
  }

  private async waitForTransferWindow(transferId: string, sentOffset: number, windowBytes: number): Promise<void> {
    const started = Date.now();
    while (sentOffset - (this.transferAckOffset.get(transferId) ?? 0) >= windowBytes) {
      if (Date.now() - started > 5_000) {
        throw new RemoteProtocolError('RATE_LIMITED', 'download window is full');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async waitForContentWindow(): Promise<void> {
    const started = Date.now();
    while ((this.crypto.outboundSequence - (this.peerTransportAck + 1)) >= CONTENT_WINDOW_CHUNKS) {
      if (Date.now() - started > 5_000) {
        throw new RemoteProtocolError('RATE_LIMITED', 'content window is full');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function isTransferType(type: string | undefined): boolean {
  return type === 'attachment.begin'
    || type === 'attachment.chunk'
    || type === 'attachment.complete'
    || type === 'download.request';
}

function isFrameClassViolation(error: unknown): boolean {
  return error instanceof RemoteProtocolError
    && (error.details?.reason === 'frame_class_mismatch' || error.details?.reason === 'unknown_inner_type');
}

function isOtherSessionTranscript(message: object, subscribedSessionId: string): boolean {
  const payload = message as { type?: string; event?: { kind?: string; session_id?: string } };
  return payload.type === 'event'
    && payload.event?.kind === 'transcript.item'
    && payload.event.session_id !== subscribedSessionId;
}
