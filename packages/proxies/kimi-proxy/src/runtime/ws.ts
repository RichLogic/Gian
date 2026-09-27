/**
 * Minimal RFC 6455 WebSocket client (text frames only) — no external
 * dependencies. Sized for the Kimi local server (`/api/v1/ws`):
 * - client frames are masked (RFC requirement);
 * - protocol-level ping frames are answered with pongs;
 * - application JSON travels as text frames;
 * - fragmented messages are reassembled with a bounded budget.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { URL } from 'node:url';

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_FRAGMENT_BUFFERS = 4096;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsConnectOptions {
  url: string;
  headers?: Record<string, string>;
  /** Extra `Sec-WebSocket-Protocol` entries (kimi uses
   *  `kimi-code.bearer.<token>` when no Authorization header is set). */
  protocols?: string[];
  connectTimeoutMs?: number;
}

export class WsSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsSocketError';
  }
}

export class WsSocket extends EventEmitter {
  private socket: import('node:stream').Duplex | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  status: WsStatus = 'connecting';

  private constructor() {
    super();
  }

  static connect(options: WsConnectOptions): Promise<WsSocket> {
    const parsed = new URL(options.url);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'http:') {
      return Promise.reject(new WsSocketError(`Unsupported WebSocket URL: ${options.url}`));
    }
    const key = randomBytes(16).toString('base64');
    const headers: Record<string, string> = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      ...options.headers,
    };
    if (options.protocols && options.protocols.length > 0) {
      headers['Sec-WebSocket-Protocol'] = options.protocols.join(', ');
    }
    const ws = new WsSocket();
    return new Promise<WsSocket>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        rejectPromise(new WsSocketError(`WebSocket connect timed out: ${options.url}`));
      }, options.connectTimeoutMs ?? 15_000);
      const req = httpRequest({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'wss:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers,
      });
      req.on('upgrade', (res: IncomingMessage, socket) => {
        clearTimeout(timeout);
        const accept = res.headers['sec-websocket-accept'];
        if (typeof accept !== 'string' || res.statusCode !== 101) {
          socket.destroy();
          rejectPromise(new WsSocketError(`WebSocket upgrade refused (HTTP ${res.statusCode}).`));
          return;
        }
        ws.socket = socket;
        ws.status = 'open';
        socket.setNoDelay(true);
        socket.on('data', (chunk: Buffer) => ws.consume(chunk));
        socket.on('error', (error: Error) => ws.fail(error));
        socket.on('close', () => ws.fail(new WsSocketError('WebSocket closed by peer.')));
        resolvePromise(ws);
      });
      req.on('response', (res) => {
        clearTimeout(timeout);
        const body: Buffer[] = [];
        res.on('data', (chunk: Buffer) => body.push(chunk));
        res.on('end', () => {
          rejectPromise(new WsSocketError(
            `WebSocket upgrade failed (HTTP ${res.statusCode}): ${Buffer.concat(body).toString('utf8').slice(0, 200)}`,
          ));
        });
      });
      req.on('error', (error) => {
        clearTimeout(timeout);
        rejectPromise(new WsSocketError(`WebSocket connect failed: ${error.message}`));
      });
      req.end();
    });
  }

  sendText(payload: string): void {
    this.writeFrame(OP_TEXT, Buffer.from(payload, 'utf8'));
  }

  /** Protocol-level pong (reply to a RFC ping frame). */
  private sendPong(payload: Buffer): void {
    this.writeFrame(OP_PONG, payload);
  }

  close(code = 1000): void {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.writeFrame(OP_CLOSE, body);
    this.socket?.end();
    this.status = 'closed';
  }

  private fail(error: Error): void {
    if (this.status === 'closed') return;
    this.status = 'closed';
    try { this.socket?.destroy(); } catch { /* already gone */ }
    this.emit('close', error);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const socket = this.socket;
    if (socket === null || this.status !== 'open') {
      throw new WsSocketError('WebSocket is not open.');
    }
    const mask = randomBytes(4);
    const length = payload.length;
    const first = Buffer.from([0x80 | opcode]);
    let header: Buffer;
    if (length < 126) {
      header = Buffer.concat([first, Buffer.from([0x80 | length])]);
    } else if (length <= 0xffff) {
      const extended = Buffer.alloc(2);
      extended.writeUInt16BE(length);
      header = Buffer.concat([first, Buffer.from([0x80 | 126]), extended]);
    } else {
      const extended = Buffer.alloc(8);
      extended.writeBigUInt64BE(BigInt(length));
      header = Buffer.concat([first, Buffer.from([0x80 | 127]), extended]);
    }
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) {
      masked[index] = (masked[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    socket.write(Buffer.concat([header, mask, masked]));
  }

  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0]! & 0x0f;
      const fin = (this.buffer[0]! & 0x80) !== 0;
      const masked = (this.buffer[1]! & 0x80) !== 0;
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          this.fail(new WsSocketError('WebSocket frame exceeds the size budget.'));
          return;
        }
        length = Number(big);
        offset += 8;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (maskKey !== null) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = (payload[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
        }
      }
      this.buffer = this.buffer.subarray(offset + length);
      this.handleFrame(opcode, fin, payload);
    }
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    switch (opcode) {
      case OP_TEXT:
      case OP_CONT: {
        this.fragments.push(payload);
        if (this.fragments.length > MAX_FRAGMENT_BUFFERS) {
          this.fail(new WsSocketError('WebSocket fragment budget exceeded.'));
          return;
        }
        const total = this.fragments.reduce((sum, part) => sum + part.length, 0);
        if (total > MAX_MESSAGE_BYTES) {
          this.fail(new WsSocketError('WebSocket message exceeds the size budget.'));
          return;
        }
        if (!fin) return;
        const message = Buffer.concat(this.fragments).toString('utf8');
        this.fragments.length = 0;
        this.fragmentOpcode = 0;
        this.emit('message', message);
        return;
      }
      case OP_PING:
        this.sendPong(payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        this.status = 'closed';
        try { this.socket?.end(); } catch { /* already gone */ }
        this.emit('close', new WsSocketError(`WebSocket closed (code ${payload.length >= 2 ? payload.readUInt16BE(0) : 1005}).`));
        return;
      default:
        return;
    }
  }
}
