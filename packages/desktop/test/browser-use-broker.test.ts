import assert from 'node:assert/strict';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BROWSER_USE_BROKER_PATH,
  BrowserUseBroker,
  resolveBrowserUseBrokerSocketPath,
} from '../src/browser-use-broker.js';
import { BrowserAutomationError } from '../src/browser-automation.js';

function request(socketPath: string, value: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      path: BROWSER_USE_BROKER_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('Browser Use broker validates the private protocol and forwards trusted actor context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-browser-broker-'));
  const socketPath = join(root, 'browser.sock');
  const calls: unknown[] = [];
  const broker = new BrowserUseBroker({
    socketPath,
    handler: () => ({
      async call(method, params, actor) {
        calls.push({ method, params, actor });
        return { revision: 1, tabs: [] } as never;
      },
    }),
  });
  try {
    await broker.start();
    assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);
    const result = await request(socketPath, {
      method: 'browser.tabs',
      params: {},
      actor: { caller_id: 'internal-session:session-1', session_id: 'session-1' },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, data: { revision: 1, tabs: [] } });
    assert.deepEqual(calls, [{
      method: 'browser.tabs',
      params: {},
      actor: { callerId: 'internal-session:session-1', sessionId: 'session-1' },
    }]);

    const invalid = await request(socketPath, {
      method: 'browser.evaluate',
      params: { tab_id: 'tab-1', expression: '' },
      actor: { caller_id: 'internal-session:session-1', session_id: 'session-1' },
    });
    assert.equal(invalid.status, 400);
    assert.equal((invalid.body.error as { code: string }).code, 'INVALID_ARGUMENT');
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Browser Use broker fails closed while Desktop has no Browser and preserves domain errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-browser-broker-'));
  const socketPath = join(root, 'browser.sock');
  let handler: ReturnType<ConstructorParameters<typeof BrowserUseBroker>[0]['handler']> = null;
  const broker = new BrowserUseBroker({ socketPath, handler: () => handler });
  try {
    await broker.start();
    const unavailable = await request(socketPath, {
      method: 'browser.tabs', params: {}, actor: { caller_id: 'internal-session:session-1', session_id: 'session-1' },
    });
    assert.equal(unavailable.status, 503);
    assert.equal((unavailable.body.error as { code: string }).code, 'EXECUTOR_NOT_READY');

    handler = {
      async call() {
        throw new BrowserAutomationError('PRECONDITION_FAILED', 'Browser snapshot is stale');
      },
    };
    const stale = await request(socketPath, {
      method: 'browser.click',
      params: { tab_id: 'tab-1', snapshot_id: 'old', ref: '@e1' },
      actor: { caller_id: 'internal-session:session-1', session_id: 'session-1' },
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, {
      ok: false,
      error: { code: 'PRECONDITION_FAILED', message: 'Browser snapshot is stale', retryable: false },
    });
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Browser Use broker socket path is deterministic and short', () => {
  const path = resolveBrowserUseBrokerSocketPath('/a/very/long/application/identity');
  assert.match(path, /gian-browser-[a-f0-9]{24}\.sock$/);
  assert.ok(Buffer.byteLength(path) < 104);
});
