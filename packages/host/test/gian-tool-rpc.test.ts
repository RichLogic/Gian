// GIAN-TOOL-001 system boundary: the Tool transport is a private, bounded
// Unix-domain socket and never steals an active or unsafe filesystem path.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GianToolService } from '../src/tool/service.js';
import { gianToolSocketPath, startGianToolRpc } from '../src/tool/rpc-server.js';

function socketJson(options: {
  socketPath: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}): Promise<{ status: number; body: unknown }> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: options.socketPath,
      method: options.method,
      path: options.path,
      headers: payload ? { 'content-length': Buffer.byteLength(payload) } : undefined,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        });
      });
    });
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function fakeService() {
  let closed = false;
  const calls: unknown[] = [];
  const service = {
    async call(value: unknown) {
      calls.push(value);
      const requestId = value && typeof value === 'object'
        && typeof (value as { request_id?: unknown }).request_id === 'string'
        ? (value as { request_id: string }).request_id
        : '';
      return { ok: true, request_id: requestId, data: { echoed: true } };
    },
    close() { closed = true; },
  } as unknown as GianToolService;
  return { service, calls, isClosed: () => closed };
}

test('GIAN-TOOL-001: UDS exposes ping/schema/RPC with private permissions and single ownership', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-tool-rpc-test-'));
  const fake = fakeService();
  const handle = await startGianToolRpc({ dataDir, service: fake.service });
  try {
    const socketStat = await lstat(handle.socketPath);
    const runStat = await lstat(dirname(handle.socketPath));
    assert.equal(socketStat.mode & 0o777, 0o600);
    assert.equal(runStat.mode & 0o777, 0o700);

    const ping = await socketJson({ socketPath: handle.socketPath, method: 'GET', path: '/ping' });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body, { ok: true, protocol: 'gian.tool', version: 1 });

    const schema = await socketJson({ socketPath: handle.socketPath, method: 'GET', path: '/schema' });
    assert.equal(schema.status, 200);
    assert.ok((schema.body as { methods: string[] }).methods.includes('session.send'));
    assert.ok((schema.body as { mutations: string[] }).mutations.includes('interaction.respond'));

    const rpc = await socketJson({
      socketPath: handle.socketPath,
      method: 'POST',
      path: '/rpc',
      body: {
        request_id: 'rpc-request',
        caller_id: 'rpc-test',
        method: 'task.list',
        params: {},
      },
    });
    assert.equal(rpc.status, 200);
    assert.deepEqual(rpc.body, { ok: true, request_id: 'rpc-request', data: { echoed: true } });
    assert.equal(fake.calls.length, 1);

    await assert.rejects(
      startGianToolRpc({ dataDir, service: fakeService().service }),
      /another Gian Host owns the Tool socket/,
    );
  } finally {
    await handle.close();
    assert.equal(fake.isClosed(), true);
    await assert.rejects(lstat(handle.socketPath), error => (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GIAN-TOOL-001: UDS refuses a regular file at the socket path', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-tool-rpc-unsafe-test-'));
  const socketPath = gianToolSocketPath(dataDir);
  try {
    mkdirSync(dirname(socketPath), { recursive: true });
    writeFileSync(socketPath, 'do not delete');
    await assert.rejects(
      startGianToolRpc({ dataDir, service: fakeService().service }),
      /refusing unsafe Gian Tool socket path/,
    );
    assert.equal((await lstat(socketPath)).isFile(), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GIAN-TOOL-001: UDS refuses a symlink and safely replaces a stale socket', async () => {
  const symlinkDir = mkdtempSync(join(tmpdir(), 'gian-tool-rpc-symlink-test-'));
  const symlinkPath = gianToolSocketPath(symlinkDir);
  try {
    mkdirSync(dirname(symlinkPath), { recursive: true });
    const target = join(symlinkDir, 'target');
    writeFileSync(target, 'do not follow');
    symlinkSync(target, symlinkPath);
    await assert.rejects(
      startGianToolRpc({ dataDir: symlinkDir, service: fakeService().service }),
      /refusing unsafe Gian Tool socket path/,
    );
  } finally {
    rmSync(symlinkDir, { recursive: true, force: true });
  }

  const staleDir = mkdtempSync(join(tmpdir(), 'gian-tool-rpc-stale-test-'));
  const stalePath = gianToolSocketPath(staleDir);
  mkdirSync(dirname(stalePath), { recursive: true });
  const child = spawn(process.execPath, [
    '-e',
    "require('node:net').createServer(() => {}).listen(process.argv[1], () => process.stdout.write('ready'))",
    stalePath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`stale-socket child exited early: ${String(code)}`)));
    });
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    assert.equal((await lstat(stalePath)).isSocket(), true);
    const handle = await startGianToolRpc({ dataDir: staleDir, service: fakeService().service });
    await handle.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(staleDir, { recursive: true, force: true });
  }
});

test('GIAN-TOOL-001: UDS bounds request bodies and concurrent waits', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-tool-rpc-bounds-test-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: unknown[] = [];
  const service = {
    async call(value: unknown) {
      calls.push(value);
      await gate;
      const requestId = (value as { request_id: string }).request_id;
      return { ok: true, request_id: requestId, data: { outcome: 'timeout' } };
    },
    close() {},
  } as unknown as GianToolService;
  const handle = await startGianToolRpc({ dataDir, service });
  try {
    const waits = Array.from({ length: 8 }, (_, index) => socketJson({
      socketPath: handle.socketPath,
      method: 'POST',
      path: '/rpc',
      body: {
        request_id: `wait-${index}`,
        caller_id: 'bounds-test',
        method: 'session.wait',
        params: { session_id: 'session-1', timeout_ms: 45_000 },
      },
    }));
    while (calls.length < 8) await new Promise(resolve => setTimeout(resolve, 5));
    const ninth = await socketJson({
      socketPath: handle.socketPath,
      method: 'POST',
      path: '/rpc',
      body: {
        request_id: 'wait-9',
        caller_id: 'bounds-test',
        method: 'session.wait',
        params: { session_id: 'session-1', timeout_ms: 45_000 },
      },
    });
    assert.equal(ninth.status, 503);
    assert.deepEqual(ninth.body, {
      ok: false,
      request_id: '',
      error: { code: 'CONFLICT', message: 'Too many concurrent waits', retryable: true },
    });
    release();
    await Promise.all(waits);

    const oversized = await socketJson({
      socketPath: handle.socketPath,
      method: 'POST',
      path: '/rpc',
      body: { text: 'x'.repeat(1_048_576) },
    });
    assert.equal(oversized.status, 400);
    assert.deepEqual(oversized.body, {
      ok: false,
      request_id: '',
      error: { code: 'INVALID_ARGUMENT', message: 'Invalid Gian Tool request', retryable: false },
    });
  } finally {
    release();
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
