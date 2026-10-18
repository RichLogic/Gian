import { MAX_NDJSON_LINE_BYTES } from '@gian/proxy-protocol';

import { AcpFrameLimitError } from './errors.js';

/** Same ceiling as Gian Host/Proxy NDJSON. One ACP record may not grow past it. */
export const ACP_MAX_FRAME_BYTES = MAX_NDJSON_LINE_BYTES;

export interface FrameCursor {
  current: number;
}

/** Counts bytes of the current line. A newline resets the count. `\n` itself is free. */
export function consumeFrameBytes(state: FrameCursor, chunk: Uint8Array, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Frame limit must be a positive integer.');
  }
  for (let index = 0; index < chunk.length; index += 1) {
    const byte = chunk[index];
    if (byte === undefined) continue;
    if (byte === 0x0a) {
      state.current = 0;
      continue;
    }
    state.current += 1;
    if (state.current > maxBytes) {
      throw new AcpFrameLimitError(state.current, maxBytes);
    }
  }
}

/** Payload length of one SDK write. A single trailing LF is the record separator. */
export function outboundFrameLength(chunk: Uint8Array): number {
  const length = chunk.byteLength;
  const last = length > 0 ? chunk[length - 1] : undefined;
  if (last === 0x0a) return length - 1;
  return length;
}

export function assertOutboundFrame(chunk: Uint8Array, maxBytes: number): void {
  const length = outboundFrameLength(chunk);
  if (length > maxBytes) throw new AcpFrameLimitError(length, maxBytes);
}
