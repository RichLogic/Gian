import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proxyNotificationSchema } from '@gian/proxy-protocol';

import {
  grokDiffUpdatedData,
  isExcludedExtension,
  parsePromptUsage,
  translateExtension,
  translateSessionUpdate,
} from '../src/core/events.js';

function assertValidDiffUpdated(data: Record<string, unknown>) {
  assert.equal('path' in data, false);
  assert.equal(typeof data.diffId, 'string');
  assert.equal(data.truncated, false);
  const parsed = proxyNotificationSchema.safeParse({
    jsonrpc: '2.0',
    method: 'diff.updated',
    params: {
      eventId: 'evt-1',
      streamId: 'stream-1',
      sequence: 1,
      sessionId: 'sess-1',
      turnId: 'turn-1',
      sourceTurnId: 'turn-1',
      emittedAt: new Date().toISOString(),
      data,
    },
  });
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.format()));
}

test('standard ACP updates keep tool content, diffs, and reasoning separate', () => {
  assert.equal(translateSessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking' },
  })[0]?.data.kind, 'reasoning');

  const tool = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-1',
    status: 'in_progress',
    locations: [{ path: 'src/a.ts' }],
    content: [
      { type: 'content', content: { type: 'text', text: 'running' } },
      { type: 'diff', path: 'src/a.ts', diff: '@@ -1 +1 @@' },
    ],
  });
  assert.deepEqual(tool.map(event => event.method), ['diff.updated', 'activity.updated']);
  assert.deepEqual(tool[0]?.data, grokDiffUpdatedData('src/a.ts', '@@ -1 +1 @@'));
  assertValidDiffUpdated(tool[0]!.data);
  const presentation = tool[1]?.data.presentation as { type?: string; data?: { name?: string } };
  assert.equal(presentation?.type, 'tool');
  assert.equal(presentation?.data?.name, 'tool');
  assert.deepEqual(
    (tool[1]?.data.details as { locations?: unknown[] }).locations?.[0],
    { path: 'src/a.ts' },
  );
});

test('extension diffs also omit the illegal top-level path field', () => {
  const events = translateExtension('x.ai/file_diff', {
    path: 'README.md',
    diff: '@@ -1 +1 @@',
  });
  assert.equal(events[0]?.method, 'diff.updated');
  assertValidDiffUpdated(events[0]!.data);
});

test('excluded Grok extensions never leak through activity events', () => {
  assert.equal(isExcludedExtension('session/rewind_marker'), true);
  assert.equal(translateExtension('x.ai/plugin/marketplace', { id: 'x' }).length, 0);
  assert.equal(translateExtension('x.ai/mcp/list', {}).length, 0);
  assert.equal(translateExtension('x.ai/feedback/request', {}).length, 0);
});

test('allowed Grok extensions map to usage, agents, notices, or generic activities', () => {
  const compact = translateExtension('x.ai/auto_compact_started', { tokens: 12 });
  assert.deepEqual(compact.map(event => event.method), ['usage.updated', 'activity.updated']);
  assert.deepEqual(compact[0]?.data, { conversation: { mode: 'reset' } });
  assert.equal((compact[1]?.data.presentation as { type?: string }).type, 'notice');

  const agent = translateExtension('x.ai/subagent/spawned', { agentId: 'child-1' });
  assert.equal(agent[0]?.method, 'activity.updated');
  assert.deepEqual(agent[0]?.data.presentation, {
    type: 'agent',
    data: { agentId: 'child-1', state: 'running' },
  });

  const unknown = translateExtension('x.ai/session/recap', { text: 'summary' });
  assert.equal(unknown[0]?.method, 'activity.updated');
  assert.equal((unknown[0]?.data.presentation as { type?: string }).type, 'generic');
});

test('unknown visible ACP session updates degrade to a diagnostic activity', () => {
  const events = translateSessionUpdate({
    sessionUpdate: 'future_kind',
    payload: { detail: 'visible' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.method, 'activity.updated');
  assert.equal((events[0]?.data.presentation as { type?: string }).type, 'generic');
  assert.match(String(events[0]?.data.activityId), /^grok-session-update-future_kind-/);
  assert.deepEqual(
    ((events[0]?.data.presentation as { data?: { payload?: { payload?: unknown } } }).data?.payload as {
      payload?: unknown;
    }).payload,
    { detail: 'visible' },
  );
});

test('prompt _meta usage is read from official token fields only', () => {
  assert.deepEqual(parsePromptUsage({
    inputTokens: 3,
    outputTokens: 2,
    cachedReadTokens: 1,
    reasoningTokens: 4,
    totalTokens: 10,
  }), {
    inputTokens: 3,
    outputTokens: 2,
    cachedInputTokens: 1,
    thoughtTokens: 4,
    totalTokens: 10,
  });
  assert.equal(parsePromptUsage('used 12 tokens'), null);
});

test('native subagent lifecycle updates map to owned agent activities', () => {
  const spawned = translateSessionUpdate({
    sessionUpdate: 'subagent_spawned',
    subagentId: 'child-1',
    childSessionId: 'native-child-1',
    parentSessionId: 'native-parent',
    subagentType: 'explore',
    description: 'Scan repo',
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.method, 'activity.updated');
  assert.equal((spawned[0]!.data.presentation as { type: string }).type, 'agent');

  const finished = translateSessionUpdate({
    sessionUpdate: 'subagent_finished',
    subagentId: 'child-1',
    childSessionId: 'native-child-1',
    status: 'failed',
    error: 'blew up',
  });
  assert.equal(finished[0]!.method, 'activity.updated');
  assert.equal((finished[0]!.data.presentation as { data: { state: string } }).data.state, 'failed');
});

test('session_notification envelopes translate their inner update', () => {
  const events = translateExtension('x.ai/session_notification', {
    sessionId: 'native-1',
    update: {
      sessionUpdate: 'subagent_progress',
      subagentId: 'child-2',
      childSessionId: 'native-child-2',
      turnCount: 2,
      toolCallCount: 5,
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.method, 'activity.updated');
});

test('session directory changes translate to session-scoped updates', () => {
  const events = translateExtension('x.ai/sessions/changed', {});
  assert.equal(events[0]!.method, 'session.updated');
});

test('mcp status notifications surface notices; request methods stay excluded', () => {
  const failed = translateExtension('x.ai/mcp/tools_changed', {});
  assert.equal(failed[0]!.method, 'activity.updated');
  assert.equal(translateExtension('x.ai/mcp/list', {}).length, 0);
  assert.equal(translateExtension('x.ai/mcp/toggle_tool', {}).length, 0);
});
