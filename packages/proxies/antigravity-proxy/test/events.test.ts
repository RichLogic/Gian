import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import { usageDataSchema } from '@gian/proxy-protocol';

import {
  completeTurnProjection,
  createProjectionContext,
  projectSessionUpdate,
} from '../src/core/events.js';
import type { WireEventDraft } from '../src/contracts.js';

function nativeUpdate(value: Record<string, unknown>): SessionNotification['update'] {
  return value as SessionNotification['update'];
}

function textChunk(text: string, kind: 'agent_message_chunk' | 'agent_thought_chunk' = 'agent_message_chunk') {
  return nativeUpdate({
    sessionUpdate: kind,
    content: { type: 'text', text },
  });
}

function toolCall(fields: Record<string, unknown>, initial = true) {
  return nativeUpdate({
    sessionUpdate: initial ? 'tool_call' : 'tool_call_update',
    ...fields,
  });
}

function activity(drafts: WireEventDraft[], activityId: string): WireEventDraft | undefined {
  return drafts.find((event) => event.method === 'activity.updated' && event.data.activityId === activityId);
}

test('literal deltas keep prefix overlap and repeated chunks', () => {
  const context = createProjectionContext('s:1', 't:2');
  const first = projectSessionUpdate(textChunk('a'), context);
  const second = projectSessionUpdate(textChunk('ab'), context);
  const repeated = createProjectionContext('s:1', 't:2');
  projectSessionUpdate(textChunk('ha'), repeated);
  projectSessionUpdate(textChunk('ha'), repeated);
  const prose = 'Bearer sekret stays in the answer';
  const proseContext = createProjectionContext('prose', 'turn');
  const proseDraft = projectSessionUpdate(textChunk(prose), proseContext);
  assert.equal(first[0]?.data.delta, 'a');
  assert.equal(second[0]?.data.delta, 'ab');
  assert.equal(first[0]?.data.contentId, second[0]?.data.contentId);
  assert.equal(context.text.get(String(first[0]?.data.contentId)), 'aab');
  assert.equal([...repeated.text.values()][0], 'haha');
  assert.equal(proseDraft[0]?.data.delta, prose);
  assert.deepEqual(projectSessionUpdate(textChunk(''), context), []);
  assert.deepEqual(projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', data: 'abc', mimeType: 'image/png' },
  }), context), []);
  assert.deepEqual(projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'echo' },
  }), context), []);
  assert.deepEqual(projectSessionUpdate(nativeUpdate(null as unknown as Record<string, unknown>), context), []);
});

test('reasoning and text ids stay scoped across turns', () => {
  const first = createProjectionContext('session', 'turn-a');
  const second = createProjectionContext('session', 'turn-b');
  const text = projectSessionUpdate(textChunk('hello'), first);
  const reasoning = projectSessionUpdate(textChunk('think', 'agent_thought_chunk'), first);
  projectSessionUpdate(textChunk('other'), second);
  assert.equal(text[0]?.data.kind, 'text');
  assert.equal(reasoning[0]?.data.kind, 'reasoning');
  assert.equal(text[0]?.data.contentId, 'content:session:turn-a:text:default');
  assert.equal(reasoning[0]?.data.contentId, 'content:session:turn-a:reasoning:default');
  assert.equal(second.text.has('content:session:turn-a:text:default'), false);
  assert.equal([...second.text.keys()][0], 'content:session:turn-b:text:default');
});

test('sparse tool updates keep prior fields and a bare completed close stays failed', () => {
  const context = createProjectionContext('session', 'turn');
  assert.deepEqual(projectSessionUpdate(toolCall({ toolCallId: 'missing-title', status: 'pending' }), context), []);
  assert.deepEqual(projectSessionUpdate(toolCall({ title: 'No id', status: 'pending' }), context), []);
  const started = projectSessionUpdate(toolCall({
    toolCallId: 'read-1',
    title: 'Read notes',
    status: 'in_progress',
    kind: 'read',
    locations: [{ path: 'notes.txt' }],
    rawInput: { target_file: 'notes.txt', inputTokens: 15 },
  }), context);
  const activityId = 'tool:session:turn:read-1';
  assert.equal(started[0]?.data.activityId, activityId);
  assert.equal(started[0]?.data.status, 'running');
  assert.equal((started[0]?.data.presentation as { type?: string }).type, 'file');
  const sparse = projectSessionUpdate(toolCall({
    toolCallId: 'read-1',
    status: 'in_progress',
  }, false), context);
  assert.equal(sparse[0]?.data.title, 'Read notes');
  assert.deepEqual(sparse[0]?.data.details, started[0]?.data.details);

  const failed = projectSessionUpdate(toolCall({
    toolCallId: 'run-1',
    title: 'Run',
    status: 'failed',
    kind: 'execute',
    rawInput: { command: 'npm test' },
  }), context);
  assert.equal(failed[0]?.data.status, 'failed');
  const closed = projectSessionUpdate(toolCall({
    toolCallId: 'run-1',
    status: 'completed',
  }, false), context);
  assert.equal(closed[0]?.data.status, 'failed');
  assert.equal(closed[0]?.data.title, 'Run');
  const finished = projectSessionUpdate(toolCall({
    toolCallId: 'run-1',
    status: 'completed',
    rawOutput: { exit: 0 },
  }, false), context);
  assert.equal(finished[0]?.data.status, 'succeeded');
});

test('tool payloads redact credential values and suppress whole env payloads', () => {
  const context = createProjectionContext('session', 'turn');
  const secret = 'sekret-value';
  const drafts = projectSessionUpdate(toolCall({
    toolCallId: 'call-1',
    title: 'Call',
    status: 'pending',
    kind: 'other',
    rawInput: {
      inputTokens: 15,
      outputTokens: 4,
      token: secret,
      headers: { Authorization: `Bearer ${secret}`, Accept: 'text/plain' },
      env: { PATH: '/secret/bin', API_TOKEN: secret, CUSTOM_REGION: 'us-central1' },
      environ: { HOME: '/Users/hidden' },
      environment: { SAFE_LOOKING: 'credential-value' },
    },
  }), context);
  const input = (drafts[0]?.data.details as { input: Record<string, unknown> }).input;
  assert.equal(input.inputTokens, 15);
  assert.equal(input.outputTokens, 4);
  assert.equal(input.token, '[REDACTED]');
  assert.deepEqual(input.headers, { Authorization: '[REDACTED]', Accept: '[REDACTED]' });
  assert.equal(input.env, '[REDACTED]');
  assert.equal(input.environ, '[REDACTED]');
  assert.equal(input.environment, '[REDACTED]');
  const serialized = JSON.stringify(drafts);
  for (const planted of [secret, '/secret/bin', 'us-central1', 'credential-value', '/Users/hidden', 'API_TOKEN']) {
    assert.equal(serialized.includes(planted), false);
  }
});

test('plans skip bad entries and file plans do not echo their uri', () => {
  const context = createProjectionContext('session', 'turn');
  const plan = projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'plan',
    entries: [
      { content: '', status: 'pending' },
      null,
      { content: 'Ship the projection', status: 'pending' },
      { content: 'Skip me', status: 'nope' },
    ],
  }), context);
  assert.equal(plan[0]?.method, 'plan.updated');
  assert.equal(plan[0]?.data.planId, 'plan:session:turn');
  assert.deepEqual(plan[0]?.data.steps, [{
    id: 'step:2',
    text: 'Ship the projection',
    status: 'pending',
  }]);
  assert.deepEqual(projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'plan',
    entries: [{ content: 'Bad', status: 'nope' }],
  }), context), []);
  const cleared = projectSessionUpdate(nativeUpdate({ sessionUpdate: 'plan', entries: [] }), context);
  assert.deepEqual(cleared[0]?.data.steps, []);
  const uri = 'file:///tmp/sekret-plan.md';
  const filePlan = projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'plan_update',
    plan: { type: 'file', id: 'plan-1', uri },
  }), context);
  assert.equal(JSON.stringify(filePlan).includes(uri), false);
  assert.equal(JSON.stringify(filePlan).includes('sekret-plan'), false);
  const markdown = projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'plan_update',
    plan: { type: 'markdown', id: 'plan-2', content: 'Bearer sekret stays in the plan' },
  }), context);
  assert.equal((markdown[0]?.data.steps as Array<{ text: string }>)[0]?.text, 'Bearer sekret stays in the plan');
});

test('usage_update maps used and size only, including a zero used count', () => {
  const context = createProjectionContext('session', 'turn');
  const secret = 'planted-secret';
  const notice = projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'future_kind',
    token: secret,
    env: { PATH: secret },
  }), context);
  assert.equal(notice[0]?.data.kind, 'notice');
  assert.equal(JSON.stringify(notice).includes(secret), false);
  assert.deepEqual(projectSessionUpdate(textChunk('hello world, this is long enough to estimate'), context)
    .map((event) => event.method), ['content.delta']);
  assert.deepEqual(context.usage, {});

  const usage = projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'usage_update',
    used: 0,
    size: 0,
    inputTokens: 0,
    outputTokens: 4,
    totalTokens: 4,
    cachedReadTokens: 1,
    thoughtTokens: 9,
    cachedWriteTokens: 2,
    cost: 3,
    usage: { used: 5, inputTokens: 99, outputTokens: 7 },
  }), context);
  assert.equal(usage.length, 1);
  usageDataSchema.parse(usage[0]?.data);
  assert.deepEqual(usage[0]?.data, { context: { used: 0 } });
  assert.equal('conversation' in (usage[0]?.data ?? {}), false);
  const usageJson = JSON.stringify(usage[0]?.data);
  for (const unsupported of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens', 'conversation']) {
    assert.equal(usageJson.includes(unsupported), false);
  }
  assert.deepEqual(projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'usage_update',
    used: 0,
    size: 0,
    inputTokens: 0,
    outputTokens: 4,
    totalTokens: 4,
    cachedReadTokens: 1,
    thoughtTokens: 9,
    cachedWriteTokens: 2,
    cost: 3,
    usage: { used: 5, inputTokens: 99, outputTokens: 7 },
  }), context), []);

  const windowed = createProjectionContext('session', 'other');
  const occupancy = projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'usage_update',
    used: 0,
    size: 128,
    inputTokens: 2,
    outputTokens: 9,
    cachedReadTokens: 3,
  }), windowed);
  usageDataSchema.parse(occupancy[0]?.data);
  assert.deepEqual(occupancy[0]?.data, { context: { used: 0, window: 128 } });
  assert.equal(JSON.stringify(occupancy[0]?.data).includes('conversation'), false);
  assert.equal(JSON.stringify(occupancy[0]?.data).includes('inputTokens'), false);
  assert.deepEqual(projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'usage_update',
    usage: { used: 0, size: 128, inputTokens: 2, outputTokens: 9 },
  }), createProjectionContext('session', 'nested')), []);
  assert.deepEqual(projectSessionUpdate(nativeUpdate({
    sessionUpdate: 'usage_update',
    used: -1,
    size: 10,
    inputTokens: 4,
  }), createProjectionContext('session', 'drop')), []);
});

test('turn completion closes spinning tools without synthesizing success', () => {
  const context = createProjectionContext('session', 'turn');
  projectSessionUpdate(textChunk('a'), context);
  projectSessionUpdate(textChunk('ab'), context);
  projectSessionUpdate(toolCall({
    toolCallId: 'pending-tool',
    title: 'Pending',
    status: 'pending',
    kind: 'other',
  }), context);
  projectSessionUpdate(toolCall({
    toolCallId: 'running-tool',
    title: 'Running',
    status: 'in_progress',
    kind: 'other',
  }), context);
  projectSessionUpdate(toolCall({
    toolCallId: 'done-tool',
    title: 'Done',
    status: 'completed',
    kind: 'other',
    rawOutput: { ok: true },
  }), context);
  projectSessionUpdate(toolCall({
    toolCallId: 'failed-tool',
    title: 'Failed',
    status: 'failed',
    kind: 'other',
    content: [{ type: 'content', content: { type: 'text', text: 'disk full' } }],
  }), context);

  const completed = completeTurnProjection(context);
  assert.deepEqual(completed.map((event) => event.method), [
    'content.completed',
    'activity.updated',
    'activity.updated',
  ]);
  assert.equal(completed[0]?.data.content, 'aab');
  assert.equal(completed[0]?.data.kind, 'text');
  const pendingClose = activity(completed, 'tool:session:turn:pending-tool');
  const runningClose = activity(completed, 'tool:session:turn:running-tool');
  assert.equal(pendingClose?.data.status, 'failed');
  assert.equal(runningClose?.data.status, 'failed');
  assert.equal(String(pendingClose?.data.summary).includes('terminal result'), true);
  assert.equal(JSON.stringify(pendingClose).includes('succeeded'), false);
  assert.equal(activity(completed, 'tool:session:turn:done-tool'), undefined);
  assert.equal(activity(completed, 'tool:session:turn:failed-tool'), undefined);
  assert.equal(context.activities.get('tool:session:turn:done-tool')?.status, 'succeeded');
  assert.equal(context.activities.get('tool:session:turn:failed-tool')?.status, 'failed');
  assert.equal(context.activities.get('tool:session:turn:failed-tool')?.summary, 'disk full');
  assert.equal(completed.some((event) => event.method === 'usage.updated'), false);
  assert.deepEqual(completeTurnProjection(context, 'cancelled'), []);
  assert.equal(context.activities.get('tool:session:turn:pending-tool')?.status, 'failed');
  assert.deepEqual(projectSessionUpdate(textChunk('late'), context), []);

  const cancelled = createProjectionContext('session', 'cancel');
  projectSessionUpdate(toolCall({
    toolCallId: 'spin',
    title: 'Spin',
    status: 'in_progress',
    kind: 'other',
  }), cancelled);
  projectSessionUpdate(toolCall({
    toolCallId: 'kept',
    title: 'Kept',
    status: 'completed',
    kind: 'other',
  }), cancelled);
  const cancelDrafts = completeTurnProjection(cancelled, 'cancelled');
  assert.equal(cancelDrafts.length, 1);
  assert.equal(cancelDrafts[0]?.data.status, 'cancelled');
  assert.equal(String(cancelDrafts[0]?.data.summary).includes('terminal result'), true);
  assert.equal(cancelled.activities.get('tool:session:cancel:kept')?.status, 'succeeded');
  assert.deepEqual(completeTurnProjection(cancelled, 'failed'), []);

  const failed = createProjectionContext('session', 'fail');
  projectSessionUpdate(toolCall({
    toolCallId: 'spin',
    title: 'Spin',
    status: 'pending',
    kind: 'other',
  }), failed);
  const failedDrafts = completeTurnProjection(failed, 'failed');
  assert.equal(failedDrafts[0]?.data.status, 'failed');
  assert.notEqual(failedDrafts[0]?.data.status, 'succeeded');
  assert.deepEqual(completeTurnProjection(failed), []);
});
