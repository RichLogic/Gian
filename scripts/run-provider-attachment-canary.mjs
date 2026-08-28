import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { runKimiStorePreflight } from './run-kimi-store-preflight.mjs';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const allowRealAgentTurnEnvironment = 'GIAN_ALLOW_REAL_AGENT_TURN';
const providers = new Set(['claude', 'codex', 'kimi', 'grok']);
const defaultTimeoutMs = 120_000;
const proxyPaths = {
  claude: join(rootDir, 'packages/proxies/cc-proxy/dist/src/cli/spawn.js'),
  codex: join(rootDir, 'packages/proxies/codex-proxy/dist/src/cli/spawn.js'),
  kimi: join(rootDir, 'packages/proxies/kimi-proxy/dist/src/cli/spawn.js'),
  grok: join(rootDir, 'packages/proxies/grok-proxy/dist/src/cli/spawn.js'),
};
const binaryEnvironment = {
  claude: 'CLAUDE_BIN',
  codex: 'CODEX_BIN',
  kimi: 'KIMI_BIN',
  grok: 'GROK_BIN',
};

function requireExplicitModelTurnAuthorization(options) {
  const allowed = options.allowRealAgentTurn
    ?? process.env[allowRealAgentTurnEnvironment] === '1';
  if (!allowed) {
    throw new Error(
      `Refusing to send a quota-consuming provider model turn. Set ${allowRealAgentTurnEnvironment}=1 only after explicit authorization.`,
    );
  }
}

function normalizeProvider(value) {
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!providers.has(provider)) {
    throw new Error('Provider must be one of: claude, codex, kimi, grok.');
  }
  return provider;
}

export async function resolveProviderBinary(provider, override) {
  const environmentName = binaryEnvironment[provider];
  const requested = override ?? process.env[environmentName] ?? provider;
  const candidates = isAbsolute(requested)
    ? [requested]
    : (process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map(directory => join(directory, requested));

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Could not resolve an executable ${provider} CLI (${requested}).`);
}

export async function runDefaultKimiPreflight(binaryPath) {
  const kimiCodeHome = process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
  const officialBinary = join(kimiCodeHome, 'bin', 'kimi');
  const [candidatePath, officialPath] = await Promise.all([
    access(binaryPath, fsConstants.X_OK).then(() => realpath(binaryPath)),
    access(officialBinary, fsConstants.X_OK).then(() => realpath(officialBinary)),
  ]);
  if (candidatePath !== officialPath) {
    throw new Error(
      `Kimi attachment canary requires the official same-home binary: ${officialBinary}`,
    );
  }
  return runKimiStorePreflight({ kimiCodeHome, binaryPath: officialBinary });
}

export async function activateDefaultKimiStore(binaryPath) {
  const preflight = await runDefaultKimiPreflight(binaryPath);
  const guardModule = await import(
    join(rootDir, 'packages/host/dist/runtime/kimi-session-store.js')
  );
  const guard = new guardModule.KimiSessionStoreGuard(preflight.kimiCodeHome);
  await guard.assertCompatible(preflight.candidateVersion, preflight.candidateVersion);
  await guard.recordActivation(preflight.candidateVersion);
  return {
    ...preflight,
    storeMutated: true,
    activationRecorded: true,
  };
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for provider proxy exit after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

function signalProcessTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may have exited between the liveness check and signal.
  }
}

export class JsonLineProxyClient extends EventEmitter {
  constructor(options) {
    super();
    this.provider = options.provider;
    this.proxyPath = options.proxyPath;
    this.binaryPath = options.binaryPath;
    this.environment = { ...process.env, ...options.environment };
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultTimeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.runtimeStopped = false;
  }

  async ensureStarted() {
    if (this.child) return;
    const binaryName = binaryEnvironment[this.provider];
    const args = [this.proxyPath];
    if (this.provider === 'codex') args.push('--codex-bin', this.binaryPath);
    if (this.provider === 'kimi') args.push('--kimi-bin', this.binaryPath);
    if (this.provider === 'grok') args.push('--grok-bin', this.binaryPath);
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...this.environment,
        [binaryName]: this.binaryPath,
        GIAN_ATTACHMENT_CANARY_PROVIDER: this.provider,
        ...(this.provider === 'kimi' ? { KIMI_CODE_NO_AUTO_UPDATE: '1' } : {}),
        ...(this.provider === 'grok'
          ? { GROK_DISABLE_AUTOUPDATER: '1', GIAN_PROTOCOL_VERSIONS: '2.1' }
          : {}),
      },
    });
    this.child = child;

    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (cause) {
        this.fail(new Error(`Provider proxy emitted invalid JSON: ${cause?.message ?? cause}`));
        return;
      }

      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(message.error.message || 'Provider proxy request failed.');
          error.code = message.error.data?.domainCode ?? message.error.code;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      this.emit('notification', message);
    });
    child.stderr.on('data', chunk => {
      if (this.stderr.length < 20_000) this.stderr += chunk.toString();
    });
    child.once('error', cause => this.fail(cause));
    child.once('exit', (code, signal) => {
      this.runtimeStopped = true;
      const suffix = this.stderr.trim() ? `\n${this.stderr.trim()}` : '';
      this.fail(new Error(`Provider proxy exited (code=${code}, signal=${signal}).${suffix}`));
      this.emit('runtimeStopped');
    });
  }

  fail(cause) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(cause);
    }
  }

  async request(method, params, timeoutMs = this.requestTimeoutMs) {
    await this.ensureStarted();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Provider proxy is not running.');
    }
    const id = `req-${this.nextId++}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for provider proxy ${method} after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      await this.request('shutdown', undefined, 5_000);
      await waitForProcessExit(child, 5_000);
      return;
    } catch {
      signalProcessTree(child, 'SIGTERM');
    }
    try {
      await waitForProcessExit(child, 2_000);
    } catch {
      signalProcessTree(child, 'SIGKILL');
      await waitForProcessExit(child, 2_000).catch(() => {});
    }
  }
}

function createTurnWatcher(client, timeoutMs) {
  const notifications = [];
  let closed = false;
  const onNotification = notification => notifications.push(notification);
  client.on('notification', onNotification);

  return {
    async wait(sessionId, turnId) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const failure = notifications.find(notification => (
          notification?.method === 'runtime.error'
          || (
            notification?.params?.sessionId === sessionId
            && notification?.params?.turnId === turnId
            && notification?.method === 'turn.failed'
          )
        ));
        if (failure) throw new Error(`Provider turn failed: ${JSON.stringify(failure)}`);
        const approval = notifications.find(notification => (
          (notification?.method === 'interaction.requested' || notification?.method === 'approval.requested')
          && notification?.params?.sessionId === sessionId
        ));
        if (approval) {
          throw new Error('Attachment canary unexpectedly requested approval for a read-only fixture.');
        }
        const completion = notifications.find(notification => (
          notification?.method === 'turn.completed'
          && notification?.params?.sessionId === sessionId
          && notification?.params?.turnId === turnId
        ));
        if (completion) return { completion, notifications: [...notifications] };
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      throw new Error(`Timed out waiting for provider turn ${turnId} after ${timeoutMs}ms.`);
    },
    close() {
      if (closed) return;
      closed = true;
      client.off('notification', onNotification);
    },
  };
}

function providerFromArgv(argv) {
  const index = argv.indexOf('--provider');
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runProviderAttachmentCanary(options = {}) {
  // Keep this first: the default command must not resolve binaries, allocate
  // temp data, import a proxy, or start a provider process.
  requireExplicitModelTurnAuthorization(options);
  const provider = normalizeProvider(options.provider);
  const canaryRoot = await mkdtemp(join(tmpdir(), `gian-${provider}-attachment-`));
  const fixturePath = join(canaryRoot, 'attachment-fixture.txt');
  const fixtureContent = `GIAN_ATTACHMENT_CANARY_${randomUUID()}`;
  await writeFile(fixturePath, `${fixtureContent}\n`, 'utf8');
  const steerFixturePath = join(canaryRoot, 'steer-attachment-fixture.txt');
  const steerFixtureContent = provider === 'codex'
    ? `GIAN_STEER_ATTACHMENT_CANARY_${randomUUID()}`
    : null;
  if (steerFixtureContent) {
    await writeFile(steerFixturePath, `${steerFixtureContent}\n`, 'utf8');
  }

  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  let client;
  let watcher;
  let sessionId;
  let streamId;
  let turnId;
  let completed = false;
  let sessionClosed = false;
  let runtimeStopped = false;
  let sameTurnSteered = false;
  let sessionStoreActivated = false;

  try {
    const binaryPath = await resolveProviderBinary(provider, options.binaryPath);
    if (provider === 'kimi') {
      const activate = options.kimiActivationImpl ?? activateDefaultKimiStore;
      const result = await activate(binaryPath);
      assert.equal(result?.compatible, true, 'Kimi session store activation did not pass.');
      assert.equal(result?.activationRecorded, true, 'Kimi session store activation was not recorded.');
      sessionStoreActivated = true;
    }
    const ClientClass = options.ClientClass ?? JsonLineProxyClient;
    client = new ClientClass({
      provider,
      proxyPath: options.proxyPath ?? proxyPaths[provider],
      binaryPath,
      requestTimeoutMs: timeoutMs,
      environment: options.proxyEnvironment,
    });
    client.on('runtimeStopped', () => { runtimeStopped = true; });
    watcher = createTurnWatcher(client, timeoutMs);

    await client.ensureStarted();
    const fixtureStat = await readFile(fixturePath);
    const input = [
      {
        type: 'text',
        text: 'Use the file-reading capability available to you to read the attached plain-text file. Reply with its exact complete content and nothing else.',
      },
      {
        type: 'localFile',
        path: fixturePath,
        name: 'attachment-fixture.txt',
        mime: 'text/plain',
        mimeType: 'text/plain',
        size: fixtureStat.byteLength,
      },
    ];
    const initialized = await client.request('initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.1'] },
      host: { name: 'Gian', version: 'canary' },
    });
    assert.equal(initialized?.protocol?.version, '2.1', 'Attachment canary must negotiate gian.proxy/2.1.');
    assert.equal(
      initialized?.capabilities?.['input.localFile'],
      1,
      `${provider} canary must advertise input.localFile.`,
    );
    sessionId = randomUUID();
    const created = await client.request('session.create', {
      sessionId,
      workspace: { cwd: canaryRoot, roots: [canaryRoot] },
      ...(provider === 'codex' ? { nativeSession: { history: 'none' } } : {}),
      config: {},
    });
    streamId = created?.session?.streamId;
    assert.equal(created?.session?.id, sessionId, 'session.create must echo the Host session id.');
    assert.equal(typeof streamId, 'string', 'session.create returned no streamId.');
    turnId = randomUUID();
    const started = await client.request('turn.start', {
      sessionId,
      streamId,
      turnId,
      input,
      config: {},
    });
    assert.equal(started?.accepted, true, 'turn.start was not accepted.');
    assert.equal(started?.turnId, turnId, 'turn.start must echo the Host turn id.');

    if (provider === 'codex') {
      const steerFixtureStat = await readFile(steerFixturePath);
      const steered = await client.request('turn.steer', {
        sessionId,
        streamId,
        turnId,
        input: [
          {
            type: 'text',
            text: 'Steering update: also read this second attached file. Reply with the full contents of both attachments verbatim.',
          },
          {
            type: 'localFile',
            path: steerFixturePath,
            name: 'steer-attachment-fixture.txt',
            mime: 'text/plain',
            mimeType: 'text/plain',
            size: steerFixtureStat.byteLength,
          },
        ],
      });
      assert.equal(steered?.turnId, turnId, 'Codex attachment steer targeted a different turn.');
      sameTurnSteered = true;
    }

    const result = await watcher.wait(sessionId, turnId);
    completed = true;
    assert.equal(
      result.completion?.params?.data?.stopReason,
      'completed',
      'Provider did not report a completed attachment turn.',
    );
    assert.ok(
      JSON.stringify(result.notifications).includes(fixtureContent),
      'Provider response did not contain the unique content available only inside the attachment.',
    );
    if (steerFixtureContent) {
      assert.ok(
        JSON.stringify(result.notifications).includes(steerFixtureContent),
        'Codex response did not contain the unique content available only inside the steered attachment.',
      );
    }

    await client.request('session.close', { sessionId, streamId });
    sessionClosed = true;
    await client.stop();
    assert.equal(runtimeStopped, true, 'Provider proxy shutdown did not emit runtimeStopped.');

    return {
      provider,
      quotaConsuming: true,
      modelTurnSent: true,
      localFileSent: true,
      attachmentCount: provider === 'codex' ? 2 : 1,
      attachmentContentObserved: true,
      sameTurnSteered,
      completed: true,
      sessionClosed,
      ephemeralThread: provider === 'codex',
      sessionStoreActivated,
      runtimeStopped,
    };
  } finally {
    watcher?.close();
    if (client && sessionId && !sessionClosed) {
      if (turnId && !completed) {
        await client.request('turn.interrupt', { sessionId, streamId, turnId }).catch(() => {});
      }
      if (streamId) {
        await client.request('session.close', { sessionId, streamId }).catch(() => {});
      }
    }
    if (client && !runtimeStopped) await client.stop().catch(() => {});
    await rm(canaryRoot, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const summary = await runProviderAttachmentCanary({ provider: providerFromArgv(argv) });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`Provider attachment canary failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
