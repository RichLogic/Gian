import {
  CONTENT_WINDOW_CHUNKS,
  RemoteProtocolError,
  assertInnerContentPlaintext,
  bytesToBase64Url,
  contentChunkRawByteLimit,
  generateCanonicalId,
  sha256Hex,
} from '@gian/remote-protocol';
import type { DraftAttachment } from './types.js';

export interface AttachmentUploadResult {
  transfer_id: string;
  upload_id: string;
  attachment_id: string;
  name: string;
  mime: string;
  size: number;
}

export interface TransferAckState {
  contiguous_offset: number;
  window_chunks: number;
}

export class TransferAckGate {
  private current: TransferAckState = {
    contiguous_offset: 0,
    window_chunks: CONTENT_WINDOW_CHUNKS,
  };
  private seen = false;
  private aborted: Error | null = null;
  private readonly waiters = new Set<() => void>();

  get pendingWaiterCount(): number {
    return this.waiters.size;
  }

  push(ack: TransferAckState): void {
    this.current = {
      contiguous_offset: ack.contiguous_offset,
      window_chunks: Math.max(1, Math.min(CONTENT_WINDOW_CHUNKS, ack.window_chunks)),
    };
    this.seen = true;
    for (const waiter of this.waiters) waiter();
  }

  snapshot(): TransferAckState {
    return this.current;
  }

  abort(error: Error): void {
    if (this.aborted) return;
    this.aborted = error;
    for (const waiter of [...this.waiters]) waiter();
  }

  async waitFirst(timeoutMs = 8_000): Promise<TransferAckState> {
    if (this.seen) return this.current;
    await this.waitUntil(() => this.seen, timeoutMs, 'transfer.ack timed out');
    return this.current;
  }

  async waitUntil(
    predicate: (ack: TransferAckState) => boolean,
    timeoutMs = 8_000,
    message = 'transfer window timed out',
  ): Promise<TransferAckState> {
    const started = Date.now();
    while (!predicate(this.current)) {
      if (this.aborted) throw this.aborted;
      if (Date.now() - started > timeoutMs) {
        throw new RemoteProtocolError('RATE_LIMITED', message);
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.waiters.delete(finish);
          resolve();
        };
        timer = setTimeout(finish, 10);
        this.waiters.add(finish);
      });
    }
    if (this.aborted) throw this.aborted;
    return this.current;
  }
}

export async function uploadRemoteAttachment(input: {
  sessionId: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  sendControl: (message: Record<string, unknown>) => Promise<void>;
  sendContent: (message: Record<string, unknown>) => Promise<void>;
  registerWaiters: (transferId: string) => {
    result: Promise<AttachmentUploadResult>;
    acks: TransferAckGate;
    cleanup: () => void;
  };
}): Promise<DraftAttachment> {
  const transferId = generateCanonicalId();
  const uploadId = generateCanonicalId();
  const mime = input.mime.trim() || 'application/octet-stream';
  const name = input.name.trim().slice(0, 128) || 'attachment.bin';
  const waiters = input.registerWaiters(transferId);
  try {
    const rawChunk = contentChunkRawByteLimit();
    const digest = await sha256Hex(input.bytes);
    const sendAll = async (): Promise<AttachmentUploadResult> => {
      await input.sendControl({
        type: 'attachment.begin',
        transfer_id: transferId,
        upload_id: uploadId,
        session_id: input.sessionId,
        name,
        mime,
        size: input.bytes.byteLength,
        sha256: digest,
      });
      const firstAck = await waiters.acks.waitFirst();
      let offset = Math.min(firstAck.contiguous_offset, input.bytes.byteLength);
      let sequence = 0;
      while (offset < input.bytes.byteLength) {
        await waiters.acks.waitUntil((ack) => {
          const unacked = offset - ack.contiguous_offset;
          const unackedChunks = unacked <= 0 ? 0 : Math.ceil(unacked / rawChunk);
          return unackedChunks < ack.window_chunks;
        });
        const end = Math.min(offset + rawChunk, input.bytes.byteLength);
        const chunk = {
          type: 'attachment.chunk',
          transfer_id: transferId,
          transfer_sequence: sequence,
          offset,
          bytes: bytesToBase64Url(input.bytes.subarray(offset, end)),
        };
        assertInnerContentPlaintext(chunk);
        await input.sendContent(chunk);
        offset = end;
        sequence += 1;
      }
      await input.sendControl({
        type: 'attachment.complete',
        transfer_id: transferId,
        upload_id: uploadId,
      });
      return waiters.result;
    };
    const result = await Promise.race([rejectOnly(waiters.result), sendAll()]);
    return {
      id: result.attachment_id,
      name: result.name,
      mime: result.mime,
      size: result.size,
    };
  } finally {
    waiters.cleanup();
  }
}

function rejectOnly<T>(promise: Promise<T>): Promise<never> {
  return new Promise((_, reject) => {
    void promise.then(() => undefined, reject);
  });
}
