import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ProxyNotification } from '@gian/shared';

import { projectNotification } from '../src/event/project-notification.js';

function v2Notification(
  method: string,
  data: Record<string, unknown>,
): ProxyNotification {
  return {
    jsonrpc: '2.0',
    method,
    params: {
      eventId: 'event-1',
      streamId: 'stream-1',
      sequence: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      sourceTurnId: 'source-1',
      emittedAt: '2026-08-18T05:30:00.000Z',
      data,
    },
  } as ProxyNotification;
}

test('input.recorded joins text items and keeps the raw input array', () => {
  const input = [
    { type: 'text', text: 'first' },
    { type: 'localFile', path: '/tmp/notes.md' },
    { type: 'text', text: 'second' },
  ];
  const [event] = projectNotification(
    'claude',
    v2Notification('input.recorded', { input }),
    'session-1',
    3,
  );

  assert.equal(event?.event, 'user_message');
  assert.equal(event?.call_id, 'event-1');
  assert.equal(event?.turn, 3);
  assert.equal(event?.data.text, 'first\n\nsecond');
  assert.deepEqual(event?.data.input, input);
});

test('step.updated and request.updated do not project transcript events', () => {
  assert.deepEqual(projectNotification(
    'claude',
    v2Notification('step.updated', {
      stepId: 'step-1',
      index: 0,
      status: 'running',
    }),
    'session-1',
    1,
  ), []);

  assert.deepEqual(projectNotification(
    'claude',
    v2Notification('request.updated', {
      requestId: 'req-1',
      reason: 'initial',
    }),
    'session-1',
    1,
  ), []);
});
