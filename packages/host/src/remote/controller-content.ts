import {
  CONTENT_WINDOW_CHUNKS, RemoteProtocolError, TransferAckGate,
  applyDownloadChunk, applyDownloadMetadata, completeDownload, generateCanonicalId,
  parseClosed, transferAckSchema, attachmentResultSchema, uploadRemoteAttachment,
  type DownloadTransfer, type AttachmentUploadResult,
} from '@gian/remote-protocol';
import type { RemoteControllerClient } from './controller-client.js';

export class RemoteControllerContent {
  constructor(private readonly client: RemoteControllerClient) {}

  async download(handleId: string): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
    const transferId = generateCanonicalId();
    let current: DownloadTransfer | undefined;
    let done = false;
    let resolve!: (value: { bytes: Uint8Array; name: string; mime: string }) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<{ bytes: Uint8Array; name: string; mime: string }>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => reject(new RemoteProtocolError('HOST_OFFLINE', 'file download timed out')), 120_000);
    timer.unref();
    const unsubscribe = this.client.onControl(async message => {
      if (message.transfer_id !== transferId || done) return;
      try {
        if (message.type === 'download.metadata') {
          current = applyDownloadMetadata(current, message, this.client.environment.host_id);
        } else if (message.type === 'attachment.chunk') {
          if (!current) throw new RemoteProtocolError('INVALID_FRAME', 'file metadata missing');
          current = applyDownloadChunk(current, message, transferId);
          await this.client.sendControl({ type: 'transfer.ack', transfer_id: transferId,
            contiguous_offset: current.nextOffset, window_chunks: CONTENT_WINDOW_CHUNKS });
        } else if (message.type === 'download.complete') {
          if (!current) throw new RemoteProtocolError('INVALID_FRAME', 'file metadata missing');
          const bytes = await completeDownload(current, message);
          done = true;
          resolve({ bytes, name: current.name, mime: current.mime });
        } else if (message.type === 'transfer.error' || message.type === 'transfer.cancel') {
          throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file transfer failed');
        }
      } catch (error) { reject(error instanceof Error ? error : new Error('file transfer failed')); }
    });
    try {
      const sending = this.client.sendControl({ type: 'download.request', transfer_id: transferId,
        kind: 'file', handle_id: handleId }).catch(error => { reject(error); });
      const [read] = await Promise.all([result, sending]);
      return read;
    } finally {
      done = true; clearTimeout(timer); unsubscribe();
    }
  }

  upload(sessionId: string, name: string, mime: string, bytes: Uint8Array) {
    return uploadRemoteAttachment({ sessionId, name, mime, bytes,
      sendControl: message => this.client.sendControl(message), sendContent: message => this.client.sendContent(message),
      registerWaiters: transferId => {
        const acks = new TransferAckGate();
        let resolve!: (value: AttachmentUploadResult) => void;
        let reject!: (error: Error) => void;
        const result = new Promise<AttachmentUploadResult>((yes, no) => { resolve = yes; reject = no; });
        const fail = (error: Error) => { acks.abort(error); reject(error); };
        const timer = setTimeout(() => fail(new RemoteProtocolError('HOST_OFFLINE', 'attachment upload timed out')), 120_000);
        timer.unref();
        const unsubscribe = this.client.onControl(message => {
          if (message.transfer_id !== transferId) return;
          try {
            if (message.type === 'transfer.ack') acks.push(parseClosed(transferAckSchema, message));
            else if (message.type === 'attachment.result') resolve(parseClosed(attachmentResultSchema, message));
            else if (message.type === 'transfer.error' || message.type === 'transfer.cancel') fail(new RemoteProtocolError('TRANSFER_CONFLICT', 'attachment upload failed'));
          } catch { fail(new RemoteProtocolError('INVALID_FRAME', 'invalid attachment receipt')); }
        });
        return { result, acks, cleanup: () => { clearTimeout(timer); unsubscribe(); } };
      },
    });
  }
}
