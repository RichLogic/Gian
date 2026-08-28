import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { runProviderAttachmentCanary } from './run-provider-attachment-canary.mjs';

const scriptUrl = new URL('./run-provider-attachment-canary.mjs', import.meta.url);
const fakeProxyPath = new URL('./fixtures/fake-provider-attachment-proxy.mjs', import.meta.url).pathname;

class ExplodingClient {
  constructor() {
    throw new Error('client must not be constructed');
  }
}

test('attachment canary refuses before constructing a client without explicit authorization', async () => {
  const previous = process.env.GIAN_ALLOW_REAL_AGENT_TURN;
  delete process.env.GIAN_ALLOW_REAL_AGENT_TURN;
  try {
    await assert.rejects(
      runProviderAttachmentCanary({ provider: 'codex', ClientClass: ExplodingClient }),
      /Refusing to send a quota-consuming provider model turn/,
    );
  } finally {
    if (previous === undefined) delete process.env.GIAN_ALLOW_REAL_AGENT_TURN;
    else process.env.GIAN_ALLOW_REAL_AGENT_TURN = previous;
  }
});

test('Kimi attachment canary fails closed when its session-store activation does not pass', async () => {
  await assert.rejects(
    runProviderAttachmentCanary({
      provider: 'kimi',
      allowRealAgentTurn: true,
      binaryPath: process.execPath,
      kimiActivationImpl: async () => ({ compatible: false, activationRecorded: false }),
      ClientClass: ExplodingClient,
    }),
    /session store activation did not pass/,
  );
});

for (const provider of ['claude', 'codex', 'kimi', 'grok']) {
  test(`${provider} attachment canary sends localFile through one real JSONL proxy process`, async () => {
    const summary = await runProviderAttachmentCanary({
      provider,
      allowRealAgentTurn: true,
      binaryPath: process.execPath,
      proxyPath: fakeProxyPath,
      timeoutMs: 2_000,
      ...(provider === 'kimi'
        ? { kimiActivationImpl: async () => ({ compatible: true, activationRecorded: true }) }
        : {}),
    });

    assert.deepEqual(summary, {
      provider,
      quotaConsuming: true,
      modelTurnSent: true,
      localFileSent: true,
      attachmentCount: provider === 'codex' ? 2 : 1,
      attachmentContentObserved: true,
      sameTurnSteered: provider === 'codex',
      completed: true,
      sessionClosed: true,
      ephemeralThread: provider === 'codex',
      sessionStoreActivated: provider === 'kimi',
      runtimeStopped: true,
    });
  });
}

test('attachment canary rejects a response that did not read the fixture', async () => {
  let canaryRoot;
  class MissingContentClient {
    constructor() {
      this.listeners = new Map();
    }
    on(name, listener) {
      this.listeners.set(name, listener);
    }
    off(name) {
      this.listeners.delete(name);
    }
    async ensureStarted() {}
    async request(method, params) {
      if (method === 'initialize') {
        return { protocol: { version: '2.1' }, capabilities: { 'input.localFile': 1 } };
      }
      if (method === 'session.create') {
        canaryRoot = params.workspace?.cwd ?? params.cwd;
        return { session: { id: params.sessionId, streamId: 'stream-1' } };
      }
      if (method === 'turn.start') {
        queueMicrotask(() => {
          this.listeners.get('notification')?.({
            method: 'content.delta',
            params: {
              sessionId: params.sessionId,
              turnId: params.turnId,
              data: { kind: 'text', delta: 'guessed' },
            },
          });
          this.listeners.get('notification')?.({
            method: 'turn.completed',
            params: {
              sessionId: params.sessionId,
              turnId: params.turnId,
              data: { stopReason: 'completed' },
            },
          });
        });
        return { accepted: true, turnId: params.turnId };
      }
      return { ok: true };
    }
    async stop() {
      this.listeners.get('runtimeStopped')?.();
    }
  }

  await assert.rejects(
    runProviderAttachmentCanary({
      provider: 'claude',
      allowRealAgentTurn: true,
      binaryPath: process.execPath,
      ClientClass: MissingContentClient,
      timeoutMs: 1_000,
    }),
    /unique content available only inside the attachment/,
  );
  await assert.rejects(stat(canaryRoot), { code: 'ENOENT' });
});

test('Grok attachment canary preserves the original failure and cleans up with 2.1 ids', async () => {
  let canaryRoot;
  let interruptParams;
  let closeParams;
  let stopped = false;
  class FailingGrokClient extends EventEmitter {
    async ensureStarted() {}
    async request(method, params) {
      if (method === 'initialize') {
        return { protocol: { version: '2.1' }, capabilities: { 'input.localFile': 1 } };
      }
      if (method === 'session.create') {
        canaryRoot = params.workspace?.cwd ?? params.cwd;
        return { session: { id: params.sessionId, streamId: 'stream-grok' } };
      }
      if (method === 'turn.start') throw new Error('controlled Grok turn failure');
      if (method === 'turn.interrupt') interruptParams = params;
      if (method === 'session.close') closeParams = params;
      return { ok: true };
    }
    async stop() {
      stopped = true;
      this.emit('runtimeStopped');
    }
  }

  await assert.rejects(
    runProviderAttachmentCanary({
      provider: 'grok',
      allowRealAgentTurn: true,
      binaryPath: process.execPath,
      ClientClass: FailingGrokClient,
      timeoutMs: 1_000,
    }),
    /controlled Grok turn failure/,
  );
  assert.ok(interruptParams);
  const { sessionId, turnId } = interruptParams;
  assert.deepEqual(interruptParams, {
    sessionId,
    streamId: 'stream-grok',
    turnId,
  });
  assert.equal(typeof sessionId, 'string');
  assert.equal(typeof turnId, 'string');
  assert.deepEqual(closeParams, {
    sessionId,
    streamId: 'stream-grok',
  });
  assert.equal(stopped, true);
  await assert.rejects(stat(canaryRoot), { code: 'ENOENT' });
});

test('attachment canary source keeps its quota gate and localFile contract visible', async () => {
  const source = await readFile(scriptUrl, 'utf8');
  assert.match(source, /GIAN_ALLOW_REAL_AGENT_TURN/);
  assert.match(source, /type: 'localFile'/);
  assert.match(source, /provider === 'codex' \? \{ nativeSession: \{ history: 'none' \} \}/);
  assert.match(source, /client\.request\('turn\.steer'/);
  assert.match(source, /runDefaultKimiPreflight/);
  assert.match(source, /attachmentContentObserved: true/);
  assert.match(source, /GIAN_PROTOCOL_VERSIONS: '2.1'/);
  assert.match(source, /provider === 'grok'/);
  assert.match(source, /versions: \['2.1'\]/);
});
