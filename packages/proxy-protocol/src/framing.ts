import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

import { MAX_NDJSON_LINE_BYTES } from './constants.js';
import { protocolViolation } from './errors.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeLine(raw: Buffer): string {
  const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
  if (line.byteLength > MAX_NDJSON_LINE_BYTES) {
    throw protocolViolation(
      `NDJSON line is ${line.byteLength} bytes; maximum is ${MAX_NDJSON_LINE_BYTES}.`,
    );
  }
  try {
    return utf8.decode(line);
  } catch {
    throw protocolViolation('NDJSON line is not valid UTF-8.');
  }
}

/** Byte-oriented framing shared by Host stdout and Proxy stdin. It validates
 * a whole input chunk before exposing any of its complete lines to callers. */
export class NdjsonLineDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): string[] {
    this.buffer = Buffer.concat([
      this.buffer,
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
    ]);
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      lines.push(decodeLine(this.buffer.subarray(0, newline)));
      this.buffer = this.buffer.subarray(newline + 1);
    }
    const bufferedLimit = this.buffer.at(-1) === 0x0d
      ? MAX_NDJSON_LINE_BYTES + 1
      : MAX_NDJSON_LINE_BYTES;
    if (this.buffer.byteLength > bufferedLimit) {
      throw protocolViolation(
        `NDJSON line exceeds ${MAX_NDJSON_LINE_BYTES} bytes before newline.`,
      );
    }
    return lines;
  }

  finish(): string[] {
    if (this.buffer.byteLength === 0) return [];
    const line = decodeLine(this.buffer);
    this.buffer = Buffer.alloc(0);
    return [line];
  }
}

export async function* readNdjsonLines(
  input: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
  const decoder = new NdjsonLineDecoder();
  for await (const chunk of input) {
    for (const line of decoder.push(chunk)) yield line;
  }
  for (const line of decoder.finish()) yield line;
}
