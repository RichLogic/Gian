import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  activateDefaultKimiStore,
  JsonLineProxyClient,
  resolveProviderBinary,
} from './run-provider-attachment-canary.mjs';

const execFileAsync = promisify(execFile);
const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const defaultProxyPath = join(rootDir, 'packages/proxies/kimi-proxy/dist/src/cli/spawn.js');
const authorizationEnvironment = 'GIAN_ALLOW_REAL_AGENT_TURN';
const defaultTimeoutMs = 120_000;
const defaultDetachedObservationMs = 60_000;
const defaultRssGrowthBudgetMiB = 256;

function requireExplicitModelTurnAuthorization(options) {
  const allowed = options.allowRealAgentTurn
    ?? process.env[authorizationEnvironment] === '1';
  if (!allowed) {
    throw new Error(
      `Refusing to send quota-consuming Kimi model turns. Set ${authorizationEnvironment}=1 only after explicit authorization.`,
    );
  }
}

function positiveNumber(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise(resolveWait => setTimeout(resolveWait, ms));
}

function notificationUpdate(notification) {
  return notification?.method === 'acp.sessionUpdate'
    ? notification?.params?.data?.update
    : null;
}

function optionValues(option) {
  if (!Array.isArray(option?.options)) return [];
  return option.options
    .map(item => item?.value)
    .filter(value => typeof value === 'string' && value.length > 0);
}

function chooseMutableConfig(configOptions) {
  const ordered = [...(configOptions ?? [])].sort((left, right) => (
    Number(right?.id === 'mode') - Number(left?.id === 'mode')
  ));
  for (const option of ordered) {
    const values = optionValues(option);
    const alternate = values.find(value => value !== option?.currentValue);
    if (typeof option?.id === 'string' && alternate) {
      return {
        id: option.id,
        originalValue: option.currentValue,
        alternateValue: alternate,
      };
    }
  }
  throw new Error('Kimi did not expose a mutable select configuration option.');
}

function configCurrentValue(response, configId) {
  return (response?.configOptions ?? response?.session?.configOptions ?? [])
    .find(option => option?.id === configId)?.currentValue;
}

function turnStatus(notification) {
  return notification?.params?.data?.status;
}

class NotificationJournal {
  constructor(client, timeoutMs) {
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.notifications = [];
    this.onNotification = notification => this.notifications.push(notification);
    client.on('notification', this.onNotification);
  }

  mark() {
    return this.notifications.length;
  }

  slice(from = 0) {
    return this.notifications.slice(from);
  }

  async waitFor(predicate, label, from = 0) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const relevant = this.notifications.slice(from);
      const runtimeFailure = relevant.find(notification => notification?.method === 'runtime.error');
      if (runtimeFailure) throw new Error(`Kimi runtime failed: ${JSON.stringify(runtimeFailure)}`);
      const approval = relevant.find(notification => notification?.method === 'approval.requested');
      if (approval) {
        throw new Error(`Kimi lifecycle canary unexpectedly requested approval: ${JSON.stringify(approval)}`);
      }
      const turnFailure = relevant.find(notification => notification?.method === 'turn.failed');
      if (turnFailure) throw new Error(`Kimi turn failed: ${JSON.stringify(turnFailure)}`);
      const match = relevant.find(predicate);
      if (match) return match;
      await sleep(25);
    }
    throw new Error(`Timed out waiting for ${label} after ${this.timeoutMs}ms.`);
  }

  waitForTurn(sessionId, turnId, from = 0) {
    return this.waitFor(
      notification => (
        notification?.method === 'turn.completed'
        && notification?.params?.sessionId === sessionId
        && notification?.params?.turnId === turnId
      ),
      `Kimi turn ${turnId}`,
      from,
    );
  }

  close() {
    this.client.off('notification', this.onNotification);
  }
}

export class KimiLifecycleClient extends JsonLineProxyClient {
  get processGroupId() {
    return this.child?.pid ?? null;
  }

  async crash(timeoutMs = 5_000) {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Kimi proxy is not running and cannot be crashed.');
    }
    const stopped = new Promise((resolveStopped, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for crashed Kimi proxy after ${timeoutMs}ms.`)),
        timeoutMs,
      );
      this.once('runtimeStopped', () => {
        clearTimeout(timer);
        resolveStopped();
      });
    });
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
    await stopped;
  }
}

export async function sampleProcessGroupRss(processGroupId, stage, options = {}) {
  assert.ok(Number.isInteger(processGroupId) && processGroupId > 0, 'Kimi proxy has no process group id.');
  const run = options.execFileImpl ?? execFileAsync;
  const result = await run('ps', ['-axo', 'pid=,pgid=,rss='], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  const processes = String(result.stdout ?? '')
    .split('\n')
    .map(line => line.trim().split(/\s+/).map(Number))
    .filter(parts => parts.length === 3 && parts.every(Number.isFinite))
    .filter(([, pgid]) => pgid === processGroupId);
  assert.ok(processes.length > 0, `No live process found for Kimi process group ${processGroupId}.`);
  return {
    stage,
    processGroupId,
    processCount: processes.length,
    rssKiB: processes.reduce((sum, [, , rss]) => sum + rss, 0),
    sampledAt: new Date().toISOString(),
  };
}

function proxyClientOptions(options, binaryPath, timeoutMs) {
  return {
    provider: 'kimi',
    proxyPath: options.proxyPath ?? defaultProxyPath,
    binaryPath,
    requestTimeoutMs: timeoutMs,
    environment: options.proxyEnvironment,
  };
}

async function startTextTurn(client, sessionId, text) {
  const started = await client.request('turn.start', {
    sessionId,
    input: [{ type: 'text', text }],
  });
  const turnId = started?.turn?.id;
  assert.equal(typeof turnId, 'string', 'Kimi proxy returned no turn id.');
  assert.ok(turnId, 'Kimi proxy returned an empty turn id.');
  return turnId;
}

async function waitForMarker(journal, sessionId, turnId, marker, from) {
  const completion = await journal.waitForTurn(sessionId, turnId, from);
  assert.equal(turnStatus(completion), 'completed', `Kimi turn ${turnId} did not complete.`);
  assert.ok(
    JSON.stringify(journal.slice(from)).includes(marker),
    `Kimi turn ${turnId} did not return its unique marker.`,
  );
}

export async function runKimiLifecycleCanary(options = {}) {
  // Keep authorization first: the default command must not resolve a binary,
  // mutate the Kimi store, allocate temp data, or start a provider process.
  requireExplicitModelTurnAuthorization(options);
  const timeoutMs = positiveNumber(options.timeoutMs, defaultTimeoutMs, 'timeoutMs');
  const detachedObservationMs = positiveNumber(
    options.detachedObservationMs ?? process.env.KIMI_DETACHED_OBSERVE_MS,
    defaultDetachedObservationMs,
    'detached observation duration',
  );
  const rssGrowthBudgetMiB = positiveNumber(
    options.rssGrowthBudgetMiB ?? process.env.KIMI_RSS_GROWTH_BUDGET_MIB,
    defaultRssGrowthBudgetMiB,
    'RSS growth budget',
  );
  const binaryPath = await resolveProviderBinary('kimi', options.binaryPath);
  const activationImpl = options.activationImpl ?? activateDefaultKimiStore;
  const activation = await activationImpl(binaryPath);
  assert.equal(activation?.compatible, true, 'Kimi session store activation did not pass.');
  assert.equal(activation?.activationRecorded, true, 'Kimi session store activation was not recorded.');

  const canaryRoot = await mkdtemp(join(tmpdir(), 'gian-kimi-lifecycle-'));
  const backgroundFixturePath = join(canaryRoot, 'background-agent-fixture.txt');
  const stopMarker = `GIAN_KIMI_STOP_${randomUUID()}`;
  const concurrentMarkerA = `GIAN_KIMI_CONCURRENT_A_${randomUUID()}`;
  const concurrentMarkerB = `GIAN_KIMI_CONCURRENT_B_${randomUUID()}`;
  const backgroundMarker = `GIAN_KIMI_BACKGROUND_${randomUUID()}`;
  const postCrashMarker = `GIAN_KIMI_POST_CRASH_${randomUUID()}`;
  await writeFile(backgroundFixturePath, `${backgroundMarker}\n`, 'utf8');

  const ClientClass = options.ClientClass ?? KimiLifecycleClient;
  const rssSampler = options.rssSampler ?? sampleProcessGroupRss;
  const clients = [];
  const rssSamples = [];
  let client;
  let journal;
  let sessionA;
  let sessionB;
  let survivorSession;
  let modelTurnsSent = 0;
  let crashed = false;

  const sample = async stage => {
    const value = await rssSampler(client.processGroupId, stage);
    assert.equal(typeof value?.rssKiB, 'number', `RSS sampler returned no rssKiB for ${stage}.`);
    rssSamples.push(value);
  };

  try {
    client = new ClientClass(proxyClientOptions(options, binaryPath, timeoutMs));
    clients.push(client);
    journal = new NotificationJournal(client, timeoutMs);
    await client.ensureStarted();
    const initialized = await client.request('initialize');
    for (const method of ['session.create', 'session.config.set', 'turn.start', 'turn.interrupt', 'session.close']) {
      assert.ok(initialized?.methods?.includes(method), `Kimi proxy does not support ${method}.`);
    }
    await sample('initialized');

    const createdA = await client.request('session.create', { cwd: canaryRoot });
    const createdB = await client.request('session.create', { cwd: canaryRoot });
    sessionA = createdA?.session;
    sessionB = createdB?.session;
    assert.ok(sessionA?.id && sessionA?.nativeSessionId, 'Kimi session A has no proxy/native id.');
    assert.ok(sessionB?.id && sessionB?.nativeSessionId, 'Kimi session B has no proxy/native id.');
    assert.notEqual(sessionA.id, sessionB.id, 'Kimi returned duplicate proxy session ids.');
    assert.notEqual(sessionA.nativeSessionId, sessionB.nativeSessionId, 'Kimi returned duplicate native session ids.');

    const mutableConfig = chooseMutableConfig(sessionA.configOptions);
    const changed = await client.request('session.config.set', {
      sessionId: sessionA.id,
      configId: mutableConfig.id,
      value: mutableConfig.alternateValue,
    });
    assert.equal(
      configCurrentValue(changed, mutableConfig.id),
      mutableConfig.alternateValue,
      'Kimi dynamic configuration did not round-trip the alternate value.',
    );
    if (mutableConfig.originalValue !== undefined) {
      const restored = await client.request('session.config.set', {
        sessionId: sessionA.id,
        configId: mutableConfig.id,
        value: mutableConfig.originalValue,
      });
      assert.equal(
        configCurrentValue(restored, mutableConfig.id),
        mutableConfig.originalValue,
        'Kimi dynamic configuration did not restore its original value.',
      );
    }

    const stopStart = journal.mark();
    const stopTurnId = await startTextTurn(
      client,
      sessionA.id,
      `Reply with ${stopMarker}, but do not finish until explicitly interrupted.`,
    );
    modelTurnsSent += 1;
    await assert.rejects(
      startTextTurn(client, sessionA.id, 'This second prompt must be rejected as busy.'),
      error => error?.code === 'SESSION_BUSY',
    );
    await client.request('turn.interrupt', { sessionId: sessionA.id });
    const stopped = await journal.waitForTurn(sessionA.id, stopTurnId, stopStart);
    assert.equal(turnStatus(stopped), 'cancelled', 'Interrupted Kimi turn did not report cancelled.');

    const concurrentStart = journal.mark();
    const [turnA, turnB] = await Promise.all([
      startTextTurn(client, sessionA.id, `Reply with exactly ${concurrentMarkerA}`),
      startTextTurn(client, sessionB.id, `Reply with exactly ${concurrentMarkerB}`),
    ]);
    modelTurnsSent += 2;
    await Promise.all([
      waitForMarker(journal, sessionA.id, turnA, concurrentMarkerA, concurrentStart),
      waitForMarker(journal, sessionB.id, turnB, concurrentMarkerB, concurrentStart),
    ]);
    await sample('dual-session-completed');

    const backgroundStart = journal.mark();
    const backgroundTurnId = await startTextTurn(
      client,
      sessionA.id,
      [
        'Use the Agent tool exactly once with subagent_type="coder" and run_in_background=true.',
        `Tell that child to read ${backgroundFixturePath} and return the complete file contents.`,
        'Do not read the file in the parent. Finish the parent response after launching the child.',
      ].join(' '),
    );
    modelTurnsSent += 1;
    const launched = await journal.waitFor(notification => {
      const update = notificationUpdate(notification);
      return (
        typeof update?.toolCallId === 'string'
        && update?.rawInput?.run_in_background === true
        && /status:\s*running/i.test(String(update?.rawOutput ?? ''))
      );
    }, 'Kimi background Agent launch', backgroundStart);
    const backgroundToolCallId = notificationUpdate(launched).toolCallId;
    await journal.waitForTurn(sessionA.id, backgroundTurnId, backgroundStart);
    const drained = await journal.waitFor(notification => {
      const update = notificationUpdate(notification);
      return (
        update?.toolCallId === backgroundToolCallId
        && /status:\s*completed/i.test(String(update?.rawOutput ?? ''))
        && String(update?.rawOutput ?? '').includes(backgroundMarker)
      );
    }, 'Kimi background Agent safe drain', backgroundStart);
    assert.ok(drained, 'Kimi background Agent did not drain.');
    await sample('background-agent-drained');

    const nativeSessionIdA = sessionA.nativeSessionId;
    journal.close();
    await client.crash();
    crashed = true;

    client = new ClientClass(proxyClientOptions(options, binaryPath, timeoutMs));
    clients.push(client);
    journal = new NotificationJournal(client, timeoutMs);
    await client.ensureStarted();
    await client.request('initialize');
    const adopted = await client.request('session.create', {
      cwd: canaryRoot,
      nativeSessionId: nativeSessionIdA,
      resumeMode: 'load',
    });
    sessionA = adopted?.session;
    assert.equal(sessionA?.nativeSessionId, nativeSessionIdA, 'Kimi crash recovery adopted a different native session.');
    assert.ok(
      JSON.stringify(adopted?.replayUpdates ?? []).includes(concurrentMarkerA),
      'Kimi native load replay did not contain pre-crash history.',
    );
    await sample('crash-recovered');

    const postCrashStart = journal.mark();
    const postCrashTurnId = await startTextTurn(
      client,
      sessionA.id,
      `Reply with exactly ${postCrashMarker}`,
    );
    modelTurnsSent += 1;
    await waitForMarker(journal, sessionA.id, postCrashTurnId, postCrashMarker, postCrashStart);

    const survivor = await client.request('session.create', { cwd: canaryRoot });
    survivorSession = survivor?.session;
    assert.ok(survivorSession?.id, 'Kimi returned no survivor session id.');
    const closeResult = await client.request('session.close', { sessionId: sessionA.id });
    if (closeResult?.detached) {
      assert.equal(closeResult?.nativeClosed, false, 'Kimi reported detach and native close simultaneously.');
    }
    sessionA = null;
    const survivorSnapshot = await client.request('session.snapshot', {
      sessionId: survivorSession.id,
    });
    assert.equal(
      survivorSnapshot?.session?.id,
      survivorSession.id,
      'Closing one Kimi session stopped or detached another live session.',
    );

    await sample('detached-observation-start');
    if (detachedObservationMs > 0) await sleep(detachedObservationMs / 2);
    await sample('detached-observation-midpoint');
    if (detachedObservationMs > 0) await sleep(detachedObservationMs / 2);
    await sample('detached-observation-end');

    const rssValues = rssSamples.map(entry => entry.rssKiB);
    const rssDeltaKiB = Math.max(...rssValues) - Math.min(...rssValues);
    const rssGrowthBudgetKiB = rssGrowthBudgetMiB * 1024;
    assert.ok(
      rssDeltaKiB <= rssGrowthBudgetKiB,
      `Kimi process-group RSS range ${rssDeltaKiB} KiB exceeded budget ${rssGrowthBudgetKiB} KiB.`,
    );

    await client.request('session.close', { sessionId: survivorSession.id });
    survivorSession = null;
    await client.stop();

    return {
      provider: 'kimi',
      quotaConsuming: true,
      modelTurnsSent,
      sessionStoreActivated: true,
      createSendStop: true,
      dynamicConfig: {
        configId: mutableConfig.id,
        alternateValue: mutableConfig.alternateValue,
        restored: mutableConfig.originalValue !== undefined,
      },
      sameSessionBusyRejected: true,
      interruptedTurnCancelled: true,
      dualSessionConcurrent: true,
      backgroundAgent: {
        launched: true,
        drainedAfterParentTurn: true,
        toolCallId: backgroundToolCallId,
      },
      crashResume: {
        proxyCrashed: crashed,
        nativeSessionReused: true,
        replayObserved: true,
        postCrashTurnCompleted: true,
      },
      closeSemantics: {
        nativeClosed: closeResult?.nativeClosed === true,
        detached: closeResult?.detached === true,
        survivorSessionRemainedUsable: true,
      },
      rss: {
        detachedObservationMs,
        growthBudgetMiB: rssGrowthBudgetMiB,
        rangeKiB: rssDeltaKiB,
        decision: 'mitigated-by-bounded-process-group-rss-and-explicit-global-shutdown',
        samples: rssSamples,
      },
      runtimeStopped: true,
    };
  } finally {
    journal?.close();
    if (client && sessionA?.id) {
      await client.request('turn.interrupt', { sessionId: sessionA.id }).catch(() => {});
      await client.request('session.close', { sessionId: sessionA.id }).catch(() => {});
    }
    if (client && sessionB?.id && client === clients[0] && !crashed) {
      await client.request('turn.interrupt', { sessionId: sessionB.id }).catch(() => {});
      await client.request('session.close', { sessionId: sessionB.id }).catch(() => {});
    }
    if (client && survivorSession?.id) {
      await client.request('session.close', { sessionId: survivorSession.id }).catch(() => {});
    }
    for (const ownedClient of clients.reverse()) await ownedClient.stop().catch(() => {});
    await rm(canaryRoot, { recursive: true, force: true });
  }
}

export async function main() {
  const summary = await runKimiLifecycleCanary();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`Kimi lifecycle canary failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
