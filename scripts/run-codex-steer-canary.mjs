import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const defaultClientModule = join(
  rootDir,
  'packages/proxies/codex-proxy/dist/src/runtime/codex-app-server-client.js',
);
const allowRealAgentTurnEnvironment = 'GIAN_ALLOW_REAL_AGENT_TURN';
const defaultCompletionTimeoutMs = 120_000;
const steerMarker = 'GIAN_STEER_CANARY_OK';

function requireExplicitModelTurnAuthorization(options) {
  const allowed = options.allowRealAgentTurn
    ?? process.env[allowRealAgentTurnEnvironment] === '1';
  if (!allowed) {
    throw new Error(
      `Refusing to send a quota-consuming Codex model turn. Set ${allowRealAgentTurnEnvironment}=1 only after explicit authorization.`,
    );
  }
}

function createTurnCompletionWatcher(client, timeoutMs) {
  const completed = [];
  let closed = false;
  const onNotification = notification => {
    if (notification?.method !== 'turn/completed') return;
    const threadId = notification.params?.threadId;
    const turnId = notification.params?.turn?.id;
    const status = notification.params?.turn?.status;
    if (typeof threadId !== 'string' || typeof turnId !== 'string') return;
    completed.push({ threadId, turnId, status });
  };
  client.on('notification', onNotification);

  return {
    async wait(threadId, turnId) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = completed.find(entry => (
          entry.threadId === threadId && entry.turnId === turnId
        ));
        if (match) return match;
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      throw new Error(
        `Timed out waiting for Codex turn ${turnId} to complete after ${timeoutMs}ms.`,
      );
    },
    close() {
      if (closed) return;
      closed = true;
      client.off('notification', onNotification);
    },
  };
}

function getThreadTurns(readResponse) {
  const turns = readResponse?.thread?.turns;
  assert.ok(Array.isArray(turns), 'Codex thread/read returned no turns array.');
  return turns;
}

function getAgentText(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return items
    .filter(item => item?.type === 'agentMessage' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
}

export async function runCodexSteerCanary(options = {}) {
  // This check intentionally happens before temp allocation, client import,
  // or app-server startup. The default command must have no provider side effects.
  requireExplicitModelTurnAuthorization(options);

  const canaryRoot = await mkdtemp(join(tmpdir(), 'gian-codex-steer-'));
  const completionTimeoutMs = options.completionTimeoutMs ?? defaultCompletionTimeoutMs;
  let client;
  let watcher;
  let runtimeStopped = false;
  const debug = [];

  try {
    const ClientClass = options.ClientClass
      ?? (await import(defaultClientModule)).CodexAppServerClient;
    const codexBin = options.codexBin
      ?? process.env.CODEX_BIN
      ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/codex' : 'codex');
    client = new ClientClass({ codexBin });
    client.on('runtimeStopped', () => { runtimeStopped = true; });
    client.on('debug', message => {
      if (debug.length < 20) debug.push(String(message));
    });
    watcher = createTurnCompletionWatcher(client, completionTimeoutMs);

    await client.ensureStarted();
    const startedThread = await client.startThread({ cwd: canaryRoot, ephemeral: true });
    const threadId = startedThread?.thread?.id;
    assert.equal(typeof threadId, 'string', 'Codex returned no ephemeral thread id.');
    assert.ok(threadId, 'Codex returned an empty ephemeral thread id.');

    const firstInput = [{
      type: 'text',
      text: 'Codex steer canary: draft a four-paragraph explanation of why same-turn steering is useful. Do not use tools.',
    }];
    const startedTurn = await client.startTurn(threadId, firstInput);
    const turnId = startedTurn?.turn?.id;
    assert.equal(typeof turnId, 'string', 'Codex returned no turn id.');
    assert.ok(turnId, 'Codex returned an empty turn id.');

    const steerInput = [{
      type: 'text',
      text: `Steering update: include the exact marker ${steerMarker} in that same response.`,
    }];
    const steered = await client.steerTurn(threadId, turnId, steerInput);
    assert.equal(steered?.turnId, turnId, 'Codex steered a different turn.');

    const completion = await watcher.wait(threadId, turnId);
    assert.equal(completion.status, 'completed', 'Codex turn did not report completed status.');

    const read = await client.readThread(threadId);
    const turns = getThreadTurns(read);
    assert.equal(turns.length, 1, 'Steering unexpectedly created another turn.');
    assert.equal(turns[0]?.id, turnId, 'thread/read returned a different turn.');
    assert.equal(turns[0]?.status, 'completed', 'thread/read did not report a completed turn.');
    assert.match(
      getAgentText(turns[0]),
      new RegExp(steerMarker),
      'The completed turn response did not contain the steered marker.',
    );

    await client.stop();
    assert.equal(runtimeStopped, true, 'Codex shutdown did not emit runtimeStopped.');

    return {
      quotaConsuming: true,
      modelTurnSent: true,
      ephemeralThread: true,
      turnId,
      sameTurnSteered: true,
      steerMarkerObserved: true,
      turnCount: turns.length,
      completed: true,
      runtimeStopped,
      debugLineCount: debug.length,
    };
  } finally {
    watcher?.close();
    if (client && !runtimeStopped) await client.stop().catch(() => {});
    await rm(canaryRoot, { recursive: true, force: true });
  }
}

export async function main() {
  const summary = await runCodexSteerCanary();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`Codex steer canary failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
