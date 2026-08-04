import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ProxyNotification } from '@gian/shared';
import { projectKimiNotification } from '../src/event/normalize-kimi.js';

const project = projectKimiNotification;

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
  const text = project(
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
  const thought = project(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'reasoning' },
      },
    }),
    'gian-1',
    3,
  );

  assert.equal(text[0]?.type, 'message');
  assert.equal(text[0]?.call_id, 'message-7');
  assert.deepEqual(text[0]?.data, {
    text: 'hello',
    delta: true,
    itemId: 'message-7',
  });
  assert.equal(thought[0]?.type, 'activity.reasoning');
  assert.equal(thought[0]?.call_id, 'turn-native-1');
});

test('Kimi known and unknown tool kinds map without dropping updates', () => {
  const command = project(
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
  const unknown = project(
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

  assert.equal(command[0]?.type, 'activity.command');
  assert.equal(command[0]?.call_id, 'tool-1');
  assert.deepEqual(command[0]?.data, {
    command: 'pnpm test',
    status: 'success',
    stdout: 'ok',
    itemId: 'tool-1',
  });
  assert.equal(unknown[0]?.type, 'activity.tool');
  assert.equal(unknown[0]?.call_id, 'tool-2');
  assert.deepEqual(unknown[0]?.data, {
    itemId: 'tool-2',
    title: 'Custom Kimi action',
    kind: 'custom',
    status: 'running',
    input: { target: 'x' },
  });
});

test('Kimi Agent tool lifecycle projects to one persistent agent run', () => {
  const running = project(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'agent-tool-1',
        title: 'Agent',
        kind: 'other',
        status: 'in_progress',
        rawInput: {
          description: 'Inspect the reducer',
          prompt: 'Read the reducer and report risks',
          subagent_type: 'Explore',
        },
      },
    }),
    'gian-1',
    1,
  );
  const completed = project(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent-tool-1',
        title: 'Agent',
        kind: 'other',
        status: 'completed',
        rawInput: {
          description: 'Inspect the reducer',
          subagent_type: 'Explore',
        },
        rawOutput: 'No reducer risks found.',
      },
    }),
    'gian-1',
    1,
  );

  assert.equal(running[0]?.type, 'agent');
  assert.equal(running[0]?.call_id, 'agent-tool-1');
  assert.equal((running[0]?.data as { status?: unknown }).status, 'running');
  assert.equal((running[0]?.data as { agentType?: unknown }).agentType, 'Explore');
  assert.equal(completed[0]?.type, 'agent');
  assert.equal((completed[0]?.data as { status?: unknown }).status, 'done');
  assert.equal((completed[0]?.data as { output?: unknown }).output, 'No reducer risks found.');
});

test('Kimi background Agent trusts child status and exposes native detail', () => {
  const launched = project(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent-tool-bg',
        title: 'Launching coder agent: Repair the reducer',
        kind: 'other',
        // ACP says the launch tool returned, not that its child finished.
        status: 'completed',
        rawInput: {
          description: 'Repair the reducer',
          prompt: 'Inspect the reducer, implement the fix, and run tests.',
          subagent_type: 'coder',
          run_in_background: true,
        },
        rawOutput: [
          'task_id: task-42',
          'agent_id: agent-42',
          'actual_subagent_type: coder',
          'status: running',
        ].join('\n'),
      },
    }),
    'gian-1',
    4,
  );
  const launchData = launched[0]?.data as Record<string, unknown>;

  assert.equal(launchData.status, 'running');
  assert.equal(launchData.agentId, 'agent-42');
  assert.equal(launchData.taskId, 'task-42');
  assert.equal(launchData.agentType, 'coder');
  assert.equal(launchData.background, true);
  assert.equal(launchData.output, undefined);
  assert.equal(
    (launchData.input as Record<string, unknown>).prompt,
    'Inspect the reducer, implement the fix, and run tests.',
  );

  const finished = project(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent-tool-bg',
        title: 'Agent',
        kind: 'other',
        status: 'completed',
        rawOutput: [
          'task_id: task-42',
          'agent_id: agent-42',
          'actual_subagent_type: coder',
          'status: completed',
          '',
          '[summary]',
          'Reducer repaired and tests pass.',
        ].join('\n'),
      },
    }),
    'gian-1',
    4,
  );
  const finishData = finished[0]?.data as Record<string, unknown>;

  assert.equal(finishData.status, 'done');
  assert.equal(finishData.output, 'Reducer repaired and tests pass.');
  assert.equal(finishData.agentId, 'agent-42');
  assert.equal(finishData.taskId, 'task-42');
});

test('Kimi Agent preserves a child failure summary', () => {
  const failed = project(
    notification('acp.sessionUpdate', {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent-tool-failed',
        title: 'Agent',
        kind: 'other',
        status: 'completed',
        rawOutput: [
          'agent_id: agent-failed',
          'status: failed',
          '',
          '[summary]',
          'The child could not read the requested path.',
        ].join('\n'),
      },
    }),
    'gian-1',
    4,
  );
  const data = failed[0]?.data as Record<string, unknown>;

  assert.equal(data.status, 'error');
  assert.equal(data.output, 'The child could not read the requested path.');
});

test('Kimi approval events preserve exact opaque option IDs', () => {
  const requested = project(
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
  const resolved = project(
    notification('approval.resolved', {
      approvalId: 'approval-1',
      nativeOptionId: 'kimi-once-42',
      cancelled: false,
    }),
    'gian-1',
    2,
  );

  assert.equal(requested[0]?.type, 'interaction.approval');
  assert.deepEqual(
    (requested[0]?.data as { nativeOptions?: unknown }).nativeOptions,
    [
      { optionId: 'kimi-once-42', label: 'Allow this time', kind: 'allow_once' },
      { optionId: 'kimi-no-42', label: 'Reject', kind: 'reject_once' },
    ],
  );
  assert.equal(resolved[0]?.type, 'interaction.resolved');
  assert.equal(
    (resolved[0]?.data as { nativeOptionId?: unknown }).nativeOptionId,
    'kimi-once-42',
  );
});

test('Kimi ExitPlanMode permission keeps native options and plan content', () => {
  const requested = project(
    notification('approval.requested', {
      approvalId: 'approval-plan',
      title: 'Review implementation plan',
      reason: 'Kimi wants to leave plan mode',
      nativeOptions: [
        { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
        { optionId: 'revise', name: 'Revise', kind: 'reject_once' },
      ],
      payload: {
        toolCall: {
          title: 'ExitPlanMode',
          rawInput: { plan: '1. Inspect\n2. Edit\n3. Test' },
        },
      },
    }),
    'gian-1',
    2,
  );

  assert.equal(requested[0]?.type, 'interaction.approval');
  assert.equal((requested[0]?.data as { category?: unknown }).category, 'exit_plan_mode');
  assert.equal(
    (requested[0]?.data as { subject?: unknown }).subject,
    '1. Inspect\n2. Edit\n3. Test',
  );
});

test('Kimi process-wide runtime stop is an explicit transcript no-op', () => {
  assert.deepEqual(
    project(
      notification('runtime.stopped', { expected: false, code: 1 }),
      'gian-1',
      0,
    ),
    [],
  );
});
