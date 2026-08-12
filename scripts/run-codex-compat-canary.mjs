import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const defaultClientModule = join(
  rootDir,
  'packages/proxies/codex-proxy/dist/src/runtime/codex-app-server-client.js',
);
const canaryThreadName = 'Gian Codex compatibility canary';

function assertThreadBootstrap(value, expectedThreadId) {
  assert.ok(value && typeof value === 'object', 'Codex returned no thread bootstrap.');
  assert.equal(typeof value.thread?.id, 'string', 'Codex returned no thread id.');
  assert.ok(value.thread.id, 'Codex returned an empty thread id.');
  if (expectedThreadId) {
    assert.equal(value.thread.id, expectedThreadId, 'Codex resumed a different thread.');
  }
  assert.ok(
    value.configuredPermissions && typeof value.configuredPermissions === 'object',
    'Codex returned no effective permission configuration.',
  );
}

function restoreEnvironment(name, previousValue) {
  if (previousValue === undefined) delete process.env[name];
  else process.env[name] = previousValue;
}

export async function runCodexCompatibilityCanary(options = {}) {
  const canaryRoot = await mkdtemp(join(tmpdir(), 'gian-codex-compat-'));
  const codexHome = join(canaryRoot, 'codex-home');
  const workspace = join(canaryRoot, 'workspace');
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  let client;
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

    await client.ensureStarted();

    const models = await client.listAllModels();
    assert.ok(Array.isArray(models) && models.length > 0, 'Codex returned no models.');

    // This persistent thread exists only inside the temporary CODEX_HOME. It
    // lets the canary verify native resume, then disappears with canaryRoot.
    const started = await client.startThread({ cwd: workspace });
    assertThreadBootstrap(started);
    const threadId = started.thread.id;

    await client.setThreadName(threadId, canaryThreadName);
    const read = await client.readThread(threadId);
    assert.ok(read && typeof read === 'object' && read.thread, 'Codex could not read the thread.');
    assert.equal(
      read.thread.name,
      canaryThreadName,
      'Codex did not expose the updated thread name through its native thread record.',
    );

    const resumed = await client.resumeThread(threadId);
    assertThreadBootstrap(resumed, threadId);

    const skills = await client.listSkills(workspace);
    assert.ok(skills && Array.isArray(skills.data), 'Codex returned an invalid skills list.');

    await client.stop();
    assert.equal(runtimeStopped, true, 'Codex shutdown did not emit runtimeStopped.');

    return {
      protocolOnly: true,
      modelTurnSent: false,
      isolatedCodexHome: true,
      modelCount: models.length,
      threadNamed: true,
      threadRead: true,
      threadResumed: true,
      skillRootCount: skills.data.length,
      runtimeStopped,
      debugLineCount: debug.length,
    };
  } finally {
    if (client && !runtimeStopped) await client.stop().catch(() => {});
    restoreEnvironment('CODEX_HOME', previousCodexHome);
    // Codex may still be winding down a background plugin clone after the
    // app-server socket closes. Let recursive removal retry that short race so
    // the isolated CODEX_HOME is never left behind.
    await rm(canaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
}

export async function main() {
  const summary = await runCodexCompatibilityCanary();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`Codex compatibility canary failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
