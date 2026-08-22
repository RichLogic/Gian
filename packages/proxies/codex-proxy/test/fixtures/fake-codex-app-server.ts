#!/usr/bin/env node

import { createInterface } from 'node:readline';

const listenIndex = process.argv.indexOf('--listen');
const listenUrl = listenIndex >= 0 ? process.argv[listenIndex + 1] : undefined;
if (listenUrl !== 'stdio://') {
  throw new Error('fake codex app-server requires --listen stdio://');
}

if (process.env.GIAN_FAKE_CODEX_UNSUPPORTED_STDIO === '1') {
  process.stderr.write("error: unexpected argument '--listen' found\n");
  process.exit(2);
}
if (process.env.GIAN_FAKE_CODEX_STARTUP_FAILURE === '1') {
  process.stderr.write('fixture failed while loading config\n');
  process.exit(2);
}

function encode(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function send(value: unknown, split = false) {
  const line = encode(value);
  if (!split) {
    process.stdout.write(line);
    return;
  }
  const midpoint = Math.max(1, Math.floor(line.length / 2));
  process.stdout.write(line.slice(0, midpoint));
  setImmediate(() => process.stdout.write(line.slice(midpoint)));
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line) as {
    jsonrpc?: unknown;
    id?: number;
    method?: string;
  };
  if (message.jsonrpc !== undefined) {
    process.stderr.write('fixture received a forbidden jsonrpc wire header\n');
    process.exit(3);
  }
  if (process.env.GIAN_FAKE_CODEX_HANG_INITIALIZE === '1') return;
  if (message.method === 'initialize' && typeof message.id === 'number') {
    send({ id: message.id, result: { fixture: true } }, true);
  } else if (message.method === 'initialized') {
    process.stderr.write('fixture diagnostic on stderr\n');
    process.stdout.write(
      encode({ method: 'fixture/notification', params: { chunk: 'shared' } })
      + encode({
        id: 901,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'fixture-command' },
      }),
    );
  } else if (message.id === 901 && !message.method) {
    // The parent observed and answered the server request. Exit while it has
    // another RPC pending so runtimeStopped must drain that request.
    process.exit(0);
  }
  // All other requests intentionally remain pending.
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
