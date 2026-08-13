import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type {
  ProgressInfo,
  UpdateCheckResult as ElectronUpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from 'electron-updater';
import {
  AppUpdateController,
  sanitizeUpdateError,
  shouldEnableAppUpdates,
  type AppUpdaterScheduler,
  type ElectronUpdaterAdapter,
} from '../src/app-updater.js';

function update(version = '0.4.3'): UpdateInfo {
  return {
    version,
    files: [{ url: `Gian-${version}-arm64.zip`, sha512: 'test' }],
    path: `Gian-${version}-arm64.zip`,
    sha512: 'test',
    releaseName: `Gian ${version}`,
    releaseDate: '2026-08-12T00:00:00.000Z',
  };
}

function checkResult(
  isUpdateAvailable: boolean,
  info = update(),
): ElectronUpdateCheckResult {
  return {
    isUpdateAvailable,
    updateInfo: info,
    versionInfo: info,
  };
}

class FakeUpdater implements ElectronUpdaterAdapter {
  autoDownload = false;
  allowPrerelease = true;
  allowDowngrade = true;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs = 0;
  installArguments: Array<[boolean | undefined, boolean | undefined]> = [];
  check: () => Promise<ElectronUpdateCheckResult | null> = async () => (
    checkResult(false, update('0.4.2'))
  );
  private readonly emitter = new EventEmitter();

  checkForUpdates(): Promise<ElectronUpdateCheckResult | null> {
    this.checks += 1;
    return this.check();
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs += 1;
    this.installArguments.push([isSilent, isForceRunAfter]);
  }

  on<Event extends Parameters<ElectronUpdaterAdapter['on']>[0]>(
    event: Event,
    listener: Parameters<ElectronUpdaterAdapter['on']>[1],
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emitChecking(): void {
    this.emitter.emit('checking-for-update');
  }

  emitAvailable(info = update()): void {
    this.emitter.emit('update-available', info);
  }

  emitNotAvailable(info = update('0.4.2')): void {
    this.emitter.emit('update-not-available', info);
  }

  emitProgress(progress: ProgressInfo): void {
    this.emitter.emit('download-progress', progress);
  }

  emitDownloaded(info = update()): void {
    const event: UpdateDownloadedEvent = {
      ...info,
      downloadedFile: '/private/var/folders/test/Gian.zip',
    };
    this.emitter.emit('update-downloaded', event);
  }

  emitError(error: Error): void {
    this.emitter.emit('error', error);
  }
}

class FakeScheduler implements AppUpdaterScheduler {
  private nextHandle = 1;
  readonly timeouts = new Map<number, { callback: () => void; delayMs: number }>();
  readonly intervals = new Map<number, { callback: () => void; intervalMs: number }>();
  readonly clearedTimeouts: number[] = [];
  readonly clearedIntervals: number[] = [];

  setTimeout(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.timeouts.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    const value = Number(handle);
    this.clearedTimeouts.push(value);
    this.timeouts.delete(value);
  }

  setInterval(callback: () => void, intervalMs: number): number {
    const handle = this.nextHandle++;
    this.intervals.set(handle, { callback, intervalMs });
    return handle;
  }

  clearInterval(handle: unknown): void {
    const value = Number(handle);
    this.clearedIntervals.push(value);
    this.intervals.delete(value);
  }

  runTimeout(): void {
    const item = this.timeouts.entries().next().value as
      | [number, { callback: () => void; delayMs: number }]
      | undefined;
    assert.ok(item, 'expected a scheduled timeout');
    this.timeouts.delete(item[0]);
    item[1].callback();
  }

  runIntervals(): void {
    for (const { callback } of [...this.intervals.values()]) callback();
  }
}

function controller(
  updater: FakeUpdater,
  overrides: Partial<ConstructorParameters<typeof AppUpdateController>[0]> = {},
): AppUpdateController {
  return new AppUpdateController({
    updater,
    isPackaged: true,
    signedRelease: true,
    platform: 'darwin',
    variant: 'production',
    ...overrides,
  });
}

async function flushTasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('the updater is enabled only for signed packaged macOS production', () => {
  assert.equal(shouldEnableAppUpdates({
    isPackaged: true,
    signedRelease: true,
    platform: 'darwin',
    variant: 'production',
  }), true);
  assert.equal(shouldEnableAppUpdates({
    isPackaged: false,
    signedRelease: true,
    platform: 'darwin',
    variant: 'production',
  }), false);
  assert.equal(shouldEnableAppUpdates({
    isPackaged: true,
    signedRelease: true,
    platform: 'linux',
    variant: 'production',
  }), false);
  assert.equal(shouldEnableAppUpdates({
    isPackaged: true,
    signedRelease: true,
    platform: 'darwin',
    variant: 'development',
  }), false);
  assert.equal(shouldEnableAppUpdates({
    isPackaged: true,
    signedRelease: true,
    platform: 'darwin',
    variant: 'production',
    disabled: true,
  }), false);
  assert.equal(shouldEnableAppUpdates({
    isPackaged: true,
    signedRelease: false,
    platform: 'darwin',
    variant: 'production',
  }), false);
});

test('disabled controllers stay inert and report a structured manual result', async () => {
  const updater = new FakeUpdater();
  const scheduler = new FakeScheduler();
  const subject = controller(updater, { disabled: true, scheduler });

  assert.equal(subject.isEnabled(), false);
  assert.equal(subject.getState().status, 'disabled');
  assert.equal(subject.start(), false);
  assert.equal(scheduler.timeouts.size, 0);
  assert.equal((await subject.checkForUpdates('manual')).state.status, 'disabled');
  assert.equal(updater.checks, 0);
  assert.equal(updater.autoDownload, false);
  assert.equal(subject.install(), false);
});

test('enabled controllers configure electron-updater safe release defaults', () => {
  const updater = new FakeUpdater();
  controller(updater);

  assert.equal(updater.autoDownload, true);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
});

test('startup and recurring automatic checks use injectable stoppable timers', async () => {
  const updater = new FakeUpdater();
  const scheduler = new FakeScheduler();
  const subject = controller(updater, {
    scheduler,
    startupDelayMs: 123,
    checkIntervalMs: 456,
  });

  assert.equal(subject.start(), true);
  assert.equal(subject.start(), false);
  assert.deepEqual([...scheduler.timeouts.values()].map(item => item.delayMs), [123]);

  scheduler.runTimeout();
  await flushTasks();
  assert.equal(updater.checks, 1);
  assert.deepEqual([...scheduler.intervals.values()].map(item => item.intervalMs), [456]);

  scheduler.runIntervals();
  await flushTasks();
  assert.equal(updater.checks, 2);

  subject.stop();
  assert.equal(scheduler.intervals.size, 0);
  assert.equal(scheduler.clearedIntervals.length, 1);
  scheduler.runIntervals();
  await flushTasks();
  assert.equal(updater.checks, 2);
});

test('stop clears a pending startup timer before it can check', async () => {
  const updater = new FakeUpdater();
  const scheduler = new FakeScheduler();
  const subject = controller(updater, { scheduler });

  subject.start();
  subject.stop();
  assert.equal(scheduler.timeouts.size, 0);
  assert.equal(scheduler.clearedTimeouts.length, 1);
  await flushTasks();
  assert.equal(updater.checks, 0);
});

test('manual update flow publishes immutable states and never installs on download', async () => {
  const updater = new FakeUpdater();
  updater.check = async () => {
    const info = update();
    updater.emitChecking();
    updater.emitAvailable(info);
    updater.emitProgress({
      percent: 37.5,
      transferred: 375,
      total: 1_000,
      delta: 25,
      bytesPerSecond: 125,
    });
    updater.emitDownloaded(info);
    return checkResult(true, info);
  };
  const subject = controller(updater);
  const statuses: string[] = [];
  const unsubscribe = subject.subscribe(state => statuses.push(state.status));

  assert.equal(subject.install(), false);
  const result = await subject.checkForUpdates('manual');

  assert.equal(result.trigger, 'manual');
  assert.equal(result.state.status, 'downloaded');
  assert.equal(result.state.trigger, 'manual');
  assert.equal(result.state.update?.version, '0.4.3');
  assert.equal(result.state.progress?.percent, 37.5);
  assert.equal(Object.isFrozen(result.state), true);
  assert.equal(Object.isFrozen(result.state.update), true);
  assert.deepEqual(statuses, [
    'idle',
    'checking',
    'available',
    'downloading',
    'downloading',
    'downloaded',
  ]);
  assert.equal(updater.installs, 0, 'download completion must not force-quit');
  assert.equal(subject.install(), true);
  assert.equal(updater.installs, 1);
  assert.deepEqual(updater.installArguments, [[false, true]]);

  unsubscribe();
});

test('not-available checks resolve as up-to-date for the requesting caller', async () => {
  const updater = new FakeUpdater();
  updater.check = async () => {
    const current = update('0.4.2');
    updater.emitNotAvailable(current);
    return checkResult(false, current);
  };
  const subject = controller(updater);

  const result = await subject.checkForUpdates('manual');
  assert.equal(result.trigger, 'manual');
  assert.equal(result.state.status, 'up-to-date');
  assert.equal(result.state.update?.version, '0.4.2');
});

test('concurrent callers share one feed check while retaining caller triggers', async () => {
  const updater = new FakeUpdater();
  let resolveCheck: ((result: ElectronUpdateCheckResult) => void) | undefined;
  updater.check = () => new Promise(resolve => {
    resolveCheck = resolve;
  });
  const subject = controller(updater);

  const automatic = subject.checkForUpdates('automatic');
  const manual = subject.checkForUpdates('manual');
  assert.equal(updater.checks, 1);

  resolveCheck?.(checkResult(false, update('0.4.2')));
  const [automaticResult, manualResult] = await Promise.all([automatic, manual]);
  assert.equal(automaticResult.trigger, 'automatic');
  assert.equal(manualResult.trigger, 'manual');
  assert.equal(automaticResult.state.status, 'up-to-date');
  assert.strictEqual(automaticResult.state, manualResult.state);
});

test('a re-entrant check requested by a checking subscriber joins the flight', async () => {
  const updater = new FakeUpdater();
  let resolveCheck: ((result: ElectronUpdateCheckResult) => void) | undefined;
  updater.check = () => new Promise(resolve => {
    resolveCheck = resolve;
  });
  const subject = controller(updater);
  let reentrant: Promise<unknown> | null = null;
  subject.subscribe(state => {
    if (state.status === 'checking' && reentrant === null) {
      reentrant = subject.checkForUpdates('manual');
    }
  });

  const first = subject.checkForUpdates('automatic');
  assert.equal(updater.checks, 1);
  assert.ok(reentrant);
  resolveCheck?.(checkResult(false, update('0.4.2')));
  await Promise.all([first, reentrant]);
  assert.equal(updater.checks, 1);
});

test('automatic failures remain tagged automatic while manual failures are consumable', async () => {
  const updater = new FakeUpdater();
  const warnings: string[] = [];
  updater.check = async () => {
    throw new Error(
      'GET https://user:secret@updates.example/latest.yml?token=top-secret '
      + 'Authorization: Bearer private-token /Users/rich/Downloads/latest.yml',
    );
  };
  const subject = controller(updater, {
    logger: { warn: message => warnings.push(message) },
  });

  const automatic = await subject.checkForUpdates('automatic');
  assert.equal(automatic.state.status, 'error');
  assert.equal(automatic.state.trigger, 'automatic');
  assert.doesNotMatch(automatic.state.error ?? '', /secret|private-token|\/Users\/rich/u);

  const manual = await subject.checkForUpdates('manual');
  assert.equal(manual.trigger, 'manual');
  assert.equal(manual.state.status, 'error');
  assert.equal(manual.state.trigger, 'manual');
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(warnings.join(' '), /top-secret|private-token|\/Users\/rich/u);
});

test('emitted updater errors are redacted and surfaced as state, not thrown', async () => {
  const updater = new FakeUpdater();
  updater.check = async () => {
    updater.emitError(new Error('token=ghp_1234567890abcdefghijkl /home/alice/update.zip'));
    throw new Error('token=ghp_1234567890abcdefghijkl /home/alice/update.zip');
  };
  const subject = controller(updater);

  const result = await subject.checkForUpdates('manual');
  assert.equal(result.state.status, 'error');
  assert.match(result.state.error ?? '', /\[redacted\]/u);
  assert.match(result.state.error ?? '', /\[redacted-path\]/u);
  assert.doesNotMatch(result.state.error ?? '', /ghp_|alice/u);
});

test('sanitization handles unknown failures and bounds output', () => {
  assert.equal(sanitizeUpdateError({ secret: 'not-stringified' }), 'The update could not be completed.');
  assert.equal(sanitizeUpdateError('  '), 'The update could not be completed.');
  assert.equal(sanitizeUpdateError('x'.repeat(800)).length, 500);
});
