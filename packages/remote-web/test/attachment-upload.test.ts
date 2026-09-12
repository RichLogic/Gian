import { describe, expect, it } from 'vitest';
import {
  CONTENT_WINDOW_CHUNKS,
  MAX_CONTENT_CHUNK_PLAINTEXT_BYTES,
  contentChunkRawByteLimit,
  generateCanonicalId,
} from '@gian/remote-protocol';
import {
  TransferAckGate,
  uploadRemoteAttachment,
} from '../src/controller/attachment-upload.js';

describe('uploadRemoteAttachment content protocol', () => {
  it('registers waiters before begin and sends chunks as content under the 256 KiB inner budget', async () => {
    const bytes = new Uint8Array(200 * 1024).fill(7);
    const order: string[] = [];
    const control: Array<{ type?: string }> = [];
    const content: Array<{ type?: string; bytes?: string; offset?: number }> = [];
    const acks = new TransferAckGate();
    const result = Promise.resolve({
      transfer_id: 'later',
      upload_id: generateCanonicalId(),
      attachment_id: generateCanonicalId(),
      name: 'shot.bin',
      mime: 'application/octet-stream',
      size: bytes.byteLength,
    });
    const done = uploadRemoteAttachment({
      sessionId: generateCanonicalId(),
      name: 'shot.bin',
      mime: 'application/octet-stream',
      bytes,
      sendControl: async (message) => {
        order.push(`control:${String(message.type)}`);
        control.push(message);
        if (message.type === 'attachment.begin') acks.push({
          contiguous_offset: 0,
          window_chunks: CONTENT_WINDOW_CHUNKS,
        });
      },
      sendContent: async (message) => {
        order.push('content:attachment.chunk');
        content.push(message);
      },
      registerWaiters: () => {
        order.push('register');
        return { result, acks, cleanup: () => order.push('cleanup') };
      },
    });
    await done;
    expect(order[0]).toBe('register');
    expect(order[1]).toBe('control:attachment.begin');
    expect(order.at(-1)).toBe('cleanup');
    expect(control.map((item) => item.type)).toEqual(['attachment.begin', 'attachment.complete']);
    expect(content.length).toBeGreaterThan(0);
    for (const chunk of content) {
      expect(chunk.type).toBe('attachment.chunk');
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(MAX_CONTENT_CHUNK_PLAINTEXT_BYTES);
    }
    const rawLimit = contentChunkRawByteLimit();
    expect(rawLimit).toBeLessThan(MAX_CONTENT_CHUNK_PLAINTEXT_BYTES);
    expect(bytes.byteLength).toBeGreaterThan(rawLimit * 0.9);
  });

  it('resumes from contiguous_offset and waits for the transfer window', async () => {
    const rawLimit = contentChunkRawByteLimit();
    const bytes = new Uint8Array(rawLimit * 3).fill(3);
    const contentOffsets: number[] = [];
    const acks = new TransferAckGate();
    let sent = 0;
    const result = Promise.resolve({
      transfer_id: 't',
      upload_id: generateCanonicalId(),
      attachment_id: generateCanonicalId(),
      name: 'resume.bin',
      mime: 'application/octet-stream',
      size: bytes.byteLength,
    });
    const done = uploadRemoteAttachment({
      sessionId: generateCanonicalId(),
      name: 'resume.bin',
      mime: 'application/octet-stream',
      bytes,
      sendControl: async (message) => {
        if (message.type === 'attachment.begin') {
          acks.push({ contiguous_offset: rawLimit, window_chunks: 1 });
        }
      },
      sendContent: async (message) => {
        contentOffsets.push(Number(message.offset));
        sent += 1;
        if (sent === 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(contentOffsets).toEqual([rawLimit]);
          acks.push({ contiguous_offset: rawLimit * 2, window_chunks: 1 });
        } else {
          acks.push({
            contiguous_offset: rawLimit * 2 + (bytes.byteLength - rawLimit * 2),
            window_chunks: 1,
          });
        }
      },
      registerWaiters: () => ({ result, acks, cleanup: () => undefined }),
    });
    await done;
    expect(contentOffsets[0]).toBe(rawLimit);
    expect(contentOffsets).toHaveLength(2);
  });

  it('clears timer waiters on both timeout and ack so callbacks do not accumulate', async () => {
    const acks = new TransferAckGate();
    await expect(acks.waitUntil(() => false, 25, 'boom')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'boom',
    });
    expect(acks.pendingWaiterCount).toBe(0);
    acks.push({ contiguous_offset: 1, window_chunks: 1 });
    expect(acks.pendingWaiterCount).toBe(0);
    await acks.waitUntil((ack) => ack.contiguous_offset >= 1, 25);
    expect(acks.pendingWaiterCount).toBe(0);
  });

  it('aborts in-flight window waiters so upload cleanup cannot hang', async () => {
    const acks = new TransferAckGate();
    const waiting = acks.waitUntil(() => false, 8_000, 'should abort');
    acks.abort(new Error('upload aborted'));
    await expect(waiting).rejects.toThrow('upload aborted');
    expect(acks.pendingWaiterCount).toBe(0);
  });
});
