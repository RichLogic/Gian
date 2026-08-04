import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProxyNotification } from '@gian/shared';
import { CcProxyClient } from '../src/proxy/cc-proxy-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'fake-proxy.mjs');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gian-proxy-test-'));
}

function makeClient() {
  const dir = makeTempDir();
  const client = new CcProxyClient({ entry: FIXTURE, dataDir: dir });
  return { client, dir };
}

test('CcProxyClient routes responses by request id', async () => {
  const { client, dir } = makeClient();
  try {
    const init = await client.initialize();
    assert.equal(init.protocolVersion, '0.1.0');
    assert.equal(init.mode, 'spawn');

    const caps = await client.capabilities();
    assert.equal(caps.protocolVersion, '0.1.0');
    assert.ok(Array.isArray(caps.models));

    const sess = await client.createSession({ cwd: '/tmp' });
    assert.equal(sess.session.id, 'sess_fixture');
    assert.equal(sess.nativeSessionId, 'cc_fixture');
    assert.equal((sess.session as Record<string, unknown>).sessionKey, undefined);
  } finally {
    await client.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CcProxyClient surfaces error responses', async () => {
  const { client, dir } = makeClient();
  try {
    await client.initialize();
    await assert.rejects(
      // accessing private method via cast — testing error-path dispatch
      (client as unknown as { request: (m: string) => Promise<unknown> }).request('fail.me'),
      /forced failure/,
    );
  } finally {
    await client.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CcProxyClient dispatches notifications to subscribers', async () => {
  const { client, dir } = makeClient();
  const received: ProxyNotification[] = [];
  const off = client.onNotification(n => received.push(n));
  try {
    await client.initialize();
    await client.startTurn({
      sessionId: 'sess_fixture',
      input: [{ type: 'text', text: 'hi' }],
    });
    // allow any trailing notifications to flush
    await new Promise(r => setTimeout(r, 50));

    const methods = received.map(n => n.method);
    assert.ok(methods.includes('debug'), 'expected startup debug notification');
    assert.ok(methods.includes('turn.completed'), 'expected turn.completed notification');
  } finally {
    off();
    await client.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CcProxyClient rejects requests after shutdown', async () => {
  const { client, dir } = makeClient();
  try {
    await client.initialize();
    await client.shutdown();
    // Give the exit event a tick to land.
    await new Promise(r => setTimeout(r, 50));
    await assert.rejects(client.initialize(), /exited|already/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
