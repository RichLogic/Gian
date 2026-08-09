import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runKimiStorePreflight } from './run-kimi-store-preflight.mjs';

const scriptUrl = new URL('./run-kimi-store-preflight.mjs', import.meta.url);

class FakeGuard {
  static calls = [];

  constructor(home) {
    FakeGuard.calls.push(['construct', home]);
  }

  async hasSessionData() {
    FakeGuard.calls.push(['hasSessionData']);
    return true;
  }

  async assertCompatible(candidate, observed) {
    FakeGuard.calls.push(['assertCompatible', candidate, observed]);
  }
}

test('Kimi store preflight is read-only and checks the same-home CLI version', async () => {
  FakeGuard.calls = [];
  const execCalls = [];
  const summary = await runKimiStorePreflight({
    kimiCodeHome: '/fixture/kimi-home',
    binaryPath: '/fixture/kimi-home/bin/kimi',
    GuardClass: FakeGuard,
    async execFileImpl(command, args, options) {
      execCalls.push([command, args, options]);
      return { stdout: 'kimi 0.31.1\n', stderr: '' };
    },
  });

  assert.deepEqual(summary, {
    protocolOnly: true,
    modelTurnSent: false,
    storeMutated: false,
    kimiCodeHome: '/fixture/kimi-home',
    binaryPath: '/fixture/kimi-home/bin/kimi',
    candidateVersion: '0.31.1',
    sessionDataPresent: true,
    compatible: true,
  });
  assert.deepEqual(FakeGuard.calls, [
    ['construct', '/fixture/kimi-home'],
    ['hasSessionData'],
    ['assertCompatible', '0.31.1', '0.31.1'],
  ]);
  assert.equal(execCalls[0][0], '/fixture/kimi-home/bin/kimi');
  assert.deepEqual(execCalls[0][1], ['--version']);
  assert.equal(execCalls[0][2].env.KIMI_CODE_HOME, '/fixture/kimi-home');
  assert.equal(execCalls[0][2].env.KIMI_CODE_NO_AUTO_UPDATE, '1');
});

test('Kimi store preflight contains no runtime activation or model-turn operation', async () => {
  const source = await readFile(scriptUrl, 'utf8');
  assert.doesNotMatch(source, /\.recordActivation\s*\(/);
  assert.doesNotMatch(source, /\.activate\s*\(/);
  assert.doesNotMatch(source, /\.startTurn\s*\(/);
  assert.doesNotMatch(source, /['"]turn\/start['"]/);
});
