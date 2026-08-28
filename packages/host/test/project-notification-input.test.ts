import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ProxyNotification } from '@gian/shared';

import { projectNotification } from '../src/event/project-notification.js';
import {
  compileContextIntoInput,
  normalizeMessageComposerDocument,
  normalizeMessageContextItems,
} from '../src/session/context-items.js';

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

test('replayed compiled input recovers user text, context items, and the composer document', () => {
  const context = normalizeMessageContextItems([
    { type: 'pastedText', id: 'paste-1', text: 'quoted material', lineCount: 1, byteSize: 1 },
  ]);
  const document = normalizeMessageComposerDocument({
    version: 1,
    segments: [
      { type: 'text', text: 'Summarize ' },
      { type: 'reference', id: 'paste-1', referenceType: 'context', label: 'Pasted text' },
    ],
  }, undefined, context);
  assert.ok(document);
  const compiled = compileContextIntoInput('ignored', undefined, context, document);
  const compiledText = (compiled[0] as { type: 'text'; text: string }).text;
  const input = [{ type: 'text', text: compiledText }];

  const [event] = projectNotification(
    'claude',
    v2Notification('input.recorded', { input }),
    'session-1',
    3,
  );

  assert.equal(event?.event, 'user_message');
  assert.equal(event?.data.text, 'Summarize ');
  assert.deepEqual(event?.data.input, input);
  assert.deepEqual(event?.data.context_items, context);
  assert.deepEqual(event?.data.composer_document, document);
});

test('plain replayed text projects unchanged without context fields', () => {
  const input = [{ type: 'text', text: 'typed in an external CLI' }];
  const [event] = projectNotification(
    'claude',
    v2Notification('input.recorded', { input }),
    'session-1',
    1,
  );

  assert.equal(event?.data.text, 'typed in an external CLI');
  assert.equal('context_items' in (event?.data ?? {}), false);
  assert.equal('composer_document' in (event?.data ?? {}), false);
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
