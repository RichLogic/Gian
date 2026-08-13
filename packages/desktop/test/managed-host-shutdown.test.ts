import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import {
  ManagedHostDrainCoordinator,
  ManagedHostQuitGate,
  ManagedHostReplacementGate,
  stopManagedHostGracefully,
  type ManagedHostShutdownScheduler,
} from '../src/managed-host-shutdown.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  ended = 0;
  signals: Array<NodeJS.Signals | number | undefined> = [];
  stdin = { end: () => { this.ended += 1; } };

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
}

function schedulerFixture() {
  let callback: (() => void) | null = null;
  let cleared = 0;
  const scheduler: ManagedHostShutdownScheduler = {
    setTimeout: next => {
      callback = next;
      return next;
    },
    clearTimeout: () => { cleared += 1; },
  };
  return {
    scheduler,
    fire: () => { callback?.(); },
    cleared: () => cleared,
  };
}

test('waits for the managed Host exit after requesting graceful shutdown', async () => {
  const child = new FakeChild();
  const timers = schedulerFixture();
  const pending = stopManagedHostGracefully(child as unknown as ChildProcess, {
    scheduler: timers.scheduler,
  });
  assert.equal(child.ended, 1);
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.equal(await pending, 'exited');
  assert.equal(timers.cleared(), 1);
});

test('releases the caller after a bounded timeout and accepts an exited child', async () => {
  const child = new FakeChild();
  const timers = schedulerFixture();
  const pending = stopManagedHostGracefully(child as unknown as ChildProcess, {
    scheduler: timers.scheduler,
  });
  timers.fire();
  assert.equal(await pending, 'timed-out');

  child.exitCode = 0;
  assert.equal(
    await stopManagedHostGracefully(child as unknown as ChildProcess),
    'exited',
  );
  assert.equal(child.ended, 1, 'an exited child is not signalled again');
});

test('quit gate prevents re-entry and releases only after observed Host exit', async () => {
  const child = new FakeChild() as unknown as ChildProcess;
  let resolve!: (result: 'exited' | 'timed-out') => void;
  const shutdown = new Promise<'exited' | 'timed-out'>(next => { resolve = next; });
  const gate = new ManagedHostQuitGate(() => shutdown);
  let released = 0;
  let blocked = 0;
  const callbacks = {
    onReleased: () => { released += 1; },
    onBlocked: () => { blocked += 1; },
  };

  assert.equal(gate.intercept(child, callbacks), true);
  assert.equal(gate.intercept(child, callbacks), true, 're-entrant before-quit stays prevented');
  resolve('exited');
  await shutdown;
  await Promise.resolve();
  assert.equal(released, 1);
  assert.equal(blocked, 0);
  assert.equal(gate.intercept(child, callbacks), false, 'second app.quit is released');
});

test('quit gate fails closed on timeout and permits a later retry', async () => {
  const child = new FakeChild() as unknown as ChildProcess;
  const outcomes: Array<'exited' | 'timed-out'> = ['timed-out', 'exited'];
  const gate = new ManagedHostQuitGate(async () => outcomes.shift()!);
  let released = 0;
  let blocked = 0;
  const callbacks = {
    onReleased: () => { released += 1; },
    onBlocked: () => { blocked += 1; },
  };

  assert.equal(gate.intercept(child, callbacks), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(released, 0);
  assert.equal(blocked, 1);

  assert.equal(gate.intercept(child, callbacks), true, 'blocked quit can be retried');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(released, 1);
  assert.equal(gate.intercept(child, callbacks), false);
});

test('replacement gate arms only after the managed Host exit is observed', async () => {
  const child = new FakeChild() as unknown as ChildProcess;
  let resolve!: (result: 'exited' | 'timed-out') => void;
  const shutdown = new Promise<'exited' | 'timed-out'>(next => { resolve = next; });
  const gate = new ManagedHostReplacementGate(() => shutdown);
  let replacements = 0;

  const pending = gate.run(child, () => {
    replacements += 1;
    return true;
  });
  assert.equal(gate.isDraining(), true);
  assert.equal(gate.isArmed(), false);
  assert.equal(replacements, 0, 'replacement must not be armed during shutdown');

  resolve('exited');
  assert.equal(await pending, 'started');
  assert.equal(replacements, 1);
  assert.equal(gate.isArmed(), true);
});

test('replacement gate never invokes the replacement on timeout and can retry', async () => {
  const child = new FakeChild() as unknown as ChildProcess;
  const outcomes: Array<'exited' | 'timed-out'> = ['timed-out', 'exited'];
  const gate = new ManagedHostReplacementGate(async () => outcomes.shift()!);
  let replacements = 0;
  const start = () => {
    replacements += 1;
    return true;
  };

  assert.equal(await gate.run(child, start), 'blocked');
  assert.equal(replacements, 0);
  assert.equal(gate.isDraining(), false);
  assert.equal(gate.isArmed(), false);

  assert.equal(await gate.run(child, start), 'started');
  assert.equal(replacements, 1);
});

test('replacement gate treats a failed replacement action as retryable', async () => {
  const gate = new ManagedHostReplacementGate();
  assert.equal(await gate.run(null, () => false), 'failed');
  assert.equal(gate.isArmed(), false);
  assert.equal(await gate.run(null, () => true), 'started');
});

test('drain coordinator reuses one signal request after timeout', async () => {
  const child = new FakeChild();
  const timers = schedulerFixture();
  const coordinator = new ManagedHostDrainCoordinator({
    scheduler: timers.scheduler,
  });

  const first = coordinator.stop(child as unknown as ChildProcess);
  timers.fire();
  assert.equal(await first, 'timed-out');
  assert.equal(child.ended, 1);
  assert.deepEqual(child.signals, ['SIGTERM']);

  const second = coordinator.stop(child as unknown as ChildProcess);
  assert.equal(child.ended, 1, 'retry must reuse the existing drain request');
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.equal(await second, 'exited');
});
