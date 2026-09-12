import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskQueue } from '../src/core/task-queue.js';

test('session tasks run strictly one at a time: the next starts only after the previous settles', async () => {
  const queue = createTaskQueue('test');
  const started: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  queue.enqueueSession(async () => { started.push('first'); await firstGate; });
  queue.enqueueSession(async () => { started.push('second'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first'],
    'the second session task must not start while the first is still in flight');
  releaseFirst();
  await queue.drain();
  assert.deepEqual(started, ['first', 'second'], 'the second session task must start once the first settles');
  assert.equal(queue.pendingCount(), 0);
});

test('pipelined tasks never wait on the session queue', async () => {
  const queue = createTaskQueue('test');
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  queue.enqueueSession(async () => { started.push('session'); await gate; });
  queue.enqueuePipelined(async () => { started.push('scan'); });
  // The pipelined task dispatches synchronously; the session task starts
  // only once the lock lets it (microtask) and then stays in flight on the
  // gate — the scan must never wait for either.
  assert.deepEqual(started, ['scan'], 'a pipelined task must not wait for the session queue');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['scan', 'session'], 'the session task must start once the lock settles');
  release();
  await queue.drain();
});

test('a rejecting task never triggers process unhandledRejection, is dropped from in-flight, and does not poison the queue', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const queue = createTaskQueue('test');
    // Simulates a dispatch/writer exception escaping its own error path: the
    // tracked task itself rejects.
    queue.enqueueSession(async () => { throw new Error('writer exploded'); });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'the rejecting task must not surface as an unhandled rejection');
    assert.equal(queue.pendingCount(), 0, 'the rejecting task must be removed from the in-flight set');
    let ran = false;
    queue.enqueueSession(async () => { ran = true; });
    await queue.drain();
    assert.equal(ran, true, 'a later task must still run after a rejected one');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('drain settles only after every tracked task (including pipelined ones) has settled', async () => {
  const queue = createTaskQueue('test');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  queue.enqueuePipelined(() => gate);
  let drained = false;
  const drain = queue.drain().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, 'drain must wait for in-flight pipelined work');
  release();
  await drain;
  assert.equal(queue.pendingCount(), 0);
});