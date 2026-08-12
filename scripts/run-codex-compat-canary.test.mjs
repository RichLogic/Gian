import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runCodexCompatibilityCanary } from './run-codex-compat-canary.mjs';

const scriptUrl = new URL('./run-codex-compat-canary.mjs', import.meta.url);

class FakeCodexClient extends EventEmitter {
  static calls = [];

  constructor(options) {
    super();
    FakeCodexClient.calls.push(['construct', options, process.env.CODEX_HOME]);
  }

  async ensureStarted() {
    FakeCodexClient.calls.push(['ensureStarted']);
  }

  async listAllModels() {
    FakeCodexClient.calls.push(['listAllModels']);
    return [{ id: 'fake-model' }];
  }

  async startThread(options) {
    FakeCodexClient.calls.push(['startThread', options]);
    return {
      thread: { id: 'thread-1' },
      configuredPermissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } },
    };
  }

  async setThreadName(threadId, name) {
    FakeCodexClient.calls.push(['setThreadName', threadId, name]);
  }

  async readThread(threadId) {
    FakeCodexClient.calls.push(['readThread', threadId]);
    return { thread: { id: threadId, name: 'Gian Codex compatibility canary' } };
  }

  async resumeThread(threadId) {
    FakeCodexClient.calls.push(['resumeThread', threadId]);
    return {
      thread: { id: threadId },
      configuredPermissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } },
    };
  }

  async listSkills(cwd) {
    FakeCodexClient.calls.push(['listSkills', cwd]);
    return { data: [{ cwd, errors: [], skills: [] }] };
  }

  async stop() {
    FakeCodexClient.calls.push(['stop']);
    this.emit('runtimeStopped');
  }
}

test('compatibility canary is protocol-only, isolated, ordered, and self-cleaning', async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/sentinel/codex-home';
  FakeCodexClient.calls = [];

  try {
    const summary = await runCodexCompatibilityCanary({
      ClientClass: FakeCodexClient,
      codexBin: '/fake/codex',
    });

    assert.deepEqual(summary, {
      protocolOnly: true,
      modelTurnSent: false,
      isolatedCodexHome: true,
      modelCount: 1,
      threadNamed: true,
      threadRead: true,
      threadResumed: true,
      skillRootCount: 1,
      runtimeStopped: true,
      debugLineCount: 0,
    });
    assert.equal(process.env.CODEX_HOME, '/sentinel/codex-home');
    assert.deepEqual(
      FakeCodexClient.calls.map(call => call[0]),
      [
        'construct',
        'ensureStarted',
        'listAllModels',
        'startThread',
        'setThreadName',
        'readThread',
        'resumeThread',
        'listSkills',
        'stop',
      ],
    );
    assert.notEqual(FakeCodexClient.calls[0][2], '/sentinel/codex-home');
    assert.deepEqual(FakeCodexClient.calls[3][1], {
      cwd: FakeCodexClient.calls[7][1],
    });
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test('compatibility canary contains no model-turn operation', async () => {
  const source = await readFile(scriptUrl, 'utf8');
  assert.doesNotMatch(source, /\.startTurn\s*\(/);
  assert.doesNotMatch(source, /['"]turn\/start['"]/);
  assert.match(source, /maxRetries:\s*20/);
});
