import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ProxyNotification } from '@gian/shared';
import { normalizeKimiNotification } from '../src/event/normalize-kimi.js';

function notification(method: string, data: unknown): ProxyNotification {
  return {
    method,
    params: {
      sessionId: 'proxy-kimi-1',
      turnId: 'turn-native-1',
      data,
    },
  };
}

test('Kimi text and thought chunks keep stable ACP item identities', () => {
  const text = normalizeKimiNotification(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
        _meta: { itemId: 'message-7' },
      },
    }),
    'gian-1',
    3,
  );
  const thought = normalizeKimiNotification(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'reasoning' },
      },
    }),
    'gian-1',
    3,
  );

  assert.equal(text[0]?.type, 'assistant_text');
  assert.equal(text[0]?.call_id, 'message-7');
  assert.deepEqual(text[0]?.data, {
    text: 'hello',
    delta: true,
    itemId: 'message-7',
  });
  assert.equal(thought[0]?.type, 'reasoning');
  assert.equal(thought[0]?.call_id, 'turn-native-1');
});

test('Kimi known and unknown tool kinds map without dropping updates', () => {
  const command = normalizeKimiNotification(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Run tests',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'pnpm test' },
        rawOutput: 'ok',
      },
    }),
    'gian-1',
    1,
  );
  const unknown = normalizeKimiNotification(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-2',
        title: 'Custom Kimi action',
        kind: 'custom',
        status: 'in_progress',
        rawInput: { target: 'x' },
      },
    }),
    'gian-1',
    1,
  );

  assert.equal(command[0]?.type, 'command_execution');
  assert.equal(command[0]?.call_id, 'tool-1');
  assert.deepEqual(command[0]?.data, {
    command: 'pnpm test',
    status: 'success',
    stdout: 'ok',
    itemId: 'tool-1',
  });
  assert.equal(unknown[0]?.type, 'tool_execution');
  assert.equal(unknown[0]?.call_id, 'tool-2');
  assert.deepEqual(unknown[0]?.data, {
    itemId: 'tool-2',
    title: 'Custom Kimi action',
    kind: 'custom',
    status: 'running',
    input: { target: 'x' },
  });
});

test('Kimi approval events preserve exact opaque option IDs', () => {
  const requested = normalizeKimiNotification(
    notification('approval.requested', {
      approvalId: 'approval-1',
      title: 'Run deployment',
      reason: 'Needs permission',
      nativeOptions: [
        { optionId: 'kimi-once-42', name: 'Allow this time', kind: 'allow_once' },
        { optionId: 'kimi-no-42', name: 'Reject', kind: 'reject_once' },
      ],
    }),
    'gian-1',
    2,
  );
  const resolved = normalizeKimiNotification(
    notification('approval.resolved', {
      approvalId: 'approval-1',
      nativeOptionId: 'kimi-once-42',
      cancelled: false,
    }),
    'gian-1',
    2,
  );

  assert.equal(requested[0]?.type, 'approval_requested');
  assert.deepEqual(
    (requested[0]?.data as { nativeOptions?: unknown }).nativeOptions,
    [
      { optionId: 'kimi-once-42', label: 'Allow this time', kind: 'allow_once' },
      { optionId: 'kimi-no-42', label: 'Reject', kind: 'reject_once' },
    ],
  );
  assert.equal(resolved[0]?.type, 'approval_resolved');
  assert.equal(
    (resolved[0]?.data as { nativeOptionId?: unknown }).nativeOptionId,
    'kimi-once-42',
  );
});

test('Kimi process-wide runtime stop is an explicit transcript no-op', () => {
  assert.deepEqual(
    normalizeKimiNotification(
      notification('runtime.stopped', { expected: false, code: 1 }),
      'gian-1',
      0,
    ),
    [],
  );
});
