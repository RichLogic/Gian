#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';

const listenIndex = process.argv.indexOf('--listen');
const rawListenUrl = listenIndex >= 0 ? process.argv[listenIndex + 1] : undefined;
if (!rawListenUrl) throw new Error('fake codex app-server requires --listen');
const listenUrl = new URL(rawListenUrl);

function textFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function receiveFrames(socket: Duplex) {
  let buffered = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const opcode = buffered[0]! & 0x0f;
      const masked = (buffered[1]! & 0x80) !== 0;
      let payloadLength = buffered[1]! & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (buffered.length < 4) return;
        payloadLength = buffered.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffered.length < 10) return;
        const wideLength = buffered.readBigUInt64BE(2);
        if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('oversized fixture frame');
        payloadLength = Number(wideLength);
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffered.length < offset + maskLength + payloadLength) return;
      const mask = masked ? buffered.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(buffered.subarray(offset, offset + payloadLength));
      buffered = buffered.subarray(offset + payloadLength);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode !== 0x1) continue;
      const message = JSON.parse(payload.toString('utf8')) as {
        id?: number;
        method?: string;
      };
      if (message.method === 'initialize' && typeof message.id === 'number') {
        socket.write(textFrame({ jsonrpc: '2.0', id: message.id, result: { fixture: true } }));
      } else if (message.method === 'initialized') {
        socket.write(textFrame({
          jsonrpc: '2.0',
          id: 901,
          method: 'item/commandExecution/requestApproval',
          params: { command: 'fixture-command' },
        }));
      } else if (message.id === 901 && !message.method) {
        // The parent observed and answered the server request. Exit while it
        // has another RPC pending so runtimeStopped must drain that request.
        socket.destroy();
        process.exit(0);
      }
      // All other requests intentionally remain pending.
    }
  };
}

const server = createServer((request, response) => {
  if (request.url === '/readyz') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ready');
    return;
  }
  response.writeHead(404).end('not found');
});

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  socket.on('data', receiveFrames(socket));
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
server.listen(Number(listenUrl.port), listenUrl.hostname);
