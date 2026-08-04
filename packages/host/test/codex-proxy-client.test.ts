import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProxyNotification } from '@gian/shared';
import {
  CodexProxyHost,
  CodexProxySessionClient,
} from '../src/proxy/codex-proxy-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'fake-codex-proxy.mjs');

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-codex-test-'));
  const host = new CodexProxyHost({ entry: FIXTURE, dataDir: dir });
  return { host, dir };
}

test('CodexProxyHost answers initialize / capabilities / createSession', async () => {
  const { host, dir } = makeHost();
  try {
    const init = await host.initialize();
    assert.equal(init.protocolVersion, '0.1.0');

    const caps = await host.capabilities();
    assert.equal(caps.protocolVersion, '0.1.0');
    assert.ok(Array.isArray(caps.models));

    const facade = new CodexProxySessionClient(host);
    const sess = await facade.createSession({ cwd: '/tmp' });
    assert.match(sess.session.id, /^codex_sess_/);
    // Native id is the codex threadId; the wrapper exposes it under
    // nativeSessionId so the host can persist + reuse it for adoption.
    assert.ok(typeof sess.nativeSessionId === 'string' && sess.nativeSessionId.length > 0);
    // sessionKey is dead — neither the wire nor the public type carries it.
    assert.equal((sess.session as Record<string, unknown>).sessionKey, undefined);
  } finally {
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CodexProxyHost routes notifications to the matching session by sessionId', async () => {
  const { host, dir } = makeHost();
  try {
    await host.initialize();

    const sessionA = new CodexProxySessionClient(host);
    const sessionB = new CodexProxySessionClient(host);

    const receivedA: ProxyNotification[] = [];
    const receivedB: ProxyNotification[] = [];
    sessionA.onNotification(n => receivedA.push(n));
    sessionB.onNotification(n => receivedB.push(n));

    const a = await sessionA.createSession({ cwd: '/tmp' });
    const b = await sessionB.createSession({ cwd: '/tmp' });

    // Each turn fires output.text + turn.completed under its own sessionId.
    await sessionA.startTurn({
      sessionId: a.session.id,
      input: [{ type: 'text', text: 'hi from alice' }],
    });
    await sessionB.startTurn({
      sessionId: b.session.id,
      input: [{ type: 'text', text: 'hi from bob' }],
    });

    // Allow trailing notifications to flush.
    await new Promise(r => setTimeout(r, 50));

    const methodsA = receivedA.map(n => n.method);
    const methodsB = receivedB.map(n => n.method);
    assert.deepEqual(methodsA, ['output.text', 'turn.completed']);
    assert.deepEqual(methodsB, ['output.text', 'turn.completed']);

    // Notification.params.sessionId is the proxy session id, which equals
    // result.session.id — that's what routes the message to the right facade.
    const paramsA = receivedA[0]!.params as { sessionId: string; data: { text: string } };
    const paramsB = receivedB[0]!.params as { sessionId: string; data: { text: string } };
    assert.equal(paramsA.sessionId, a.session.id);
    assert.equal(paramsB.sessionId, b.session.id);
    assert.equal(paramsA.data.text, `pong from ${a.session.id}`);
    assert.equal(paramsB.data.text, `pong from ${b.session.id}`);

    // Neither incoming notification carries a sessionKey field anymore.
    for (const n of [...receivedA, ...receivedB]) {
      assert.equal((n.params as Record<string, unknown>).sessionKey, undefined);
    }
  } finally {
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CodexProxySessionClient.shutdown closes the session without killing the host', async () => {
  const { host, dir } = makeHost();
  try {
    await host.initialize();

    const sessionA = new CodexProxySessionClient(host);
    const sessionB = new CodexProxySessionClient(host);
    await sessionA.createSession({ cwd: '/tmp' });
    await sessionB.createSession({ cwd: '/tmp' });

    assert.equal(host.hasSessions(), true);
    await sessionA.shutdown();
    // Host still alive because sessionB is open.
    assert.equal(host.hasSessions(), true);

    await sessionB.shutdown();
    assert.equal(host.hasSessions(), false);

    // Host can still answer requests after sessions closed.
    const init = await host.initialize();
    assert.equal(init.protocolVersion, '0.1.0');
  } finally {
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host process exit notifies all session facades', async () => {
  const { host, dir } = makeHost();
  try {
    await host.initialize();

    const sessionA = new CodexProxySessionClient(host);
    const sessionB = new CodexProxySessionClient(host);
    await sessionA.createSession({ cwd: '/tmp' });
    await sessionB.createSession({ cwd: '/tmp' });

    let exitedA: number | null | undefined = undefined;
    let exitedB: number | null | undefined = undefined;
    sessionA.onExit(code => (exitedA = code));
    sessionB.onExit(code => (exitedB = code));

    await host.shutdown();
    await new Promise(r => setTimeout(r, 50));

    assert.notEqual(exitedA, undefined);
    assert.notEqual(exitedB, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
