// GIAN-TOOL-001: the reference client keeps a stable caller identity and
// sends the exact JSON envelope over the Host-owned Unix socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  callGianTool,
  gianctlCallerId,
  gianToolSocketPath,
} from '../dist/client.js';

test('gianctl caller id is stable and private', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gianctl-id-test-'));
  try {
    const first = await gianctlCallerId(dataDir);
    const second = await gianctlCallerId(dataDir);
    assert.equal(second, first);
    assert.match(first, /^[0-9a-f-]{36}$/u);
    const directory = await lstat(join(dataDir, 'tool'));
    const file = await lstat(join(dataDir, 'tool', 'gianctl-caller-id'));
    assert.equal(directory.mode & 0o777, 0o700);
    assert.equal(file.mode & 0o777, 0o600);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('gianctl refuses a symlink caller-id file', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gianctl-id-symlink-test-'));
  try {
    mkdirSync(join(dataDir, 'tool'), { recursive: true });
    const target = join(dataDir, 'outside-id');
    writeFileSync(target, '00000000-0000-4000-8000-000000000000\n');
    symlinkSync(target, join(dataDir, 'tool', 'gianctl-caller-id'));
    await assert.rejects(gianctlCallerId(dataDir), /refusing unsafe gianctl caller id path/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reference client sends request, caller, method, params, and idempotency key', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gianctl-call-test-'));
  const socketPath = gianToolSocketPath(dataDir);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const output = JSON.stringify({ ok: true, request_id: received.request_id, data: { task: received.params } });
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(output) });
    response.end(output);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    const result = await callGianTool({
      dataDir,
      callerId: 'caller-test',
      requestId: 'request-test',
      method: 'task.create',
      params: { name: 'Create from CLI' },
      idempotencyKey: 'task-create-test',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(received, {
      request_id: 'request-test',
      caller_id: 'caller-test',
      method: 'task.create',
      params: { name: 'Create from CLI' },
      idempotency_key: 'task-create-test',
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
