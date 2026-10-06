import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { GrokProtocolV2Adapter } from '../src/protocol/v2-adapter.js';
import { NativeTurnIdentityStore } from '../src/protocol/replay-identity.js';
import type { GrokProxyService } from '../src/core/service.js';

import {
  grokDiffUpdatedData,
  isExcludedExtension,
  parsePromptUsage,
  translateExtension,
  translateSessionUpdate,
} from '../src/core/events.js';

test('identical session metadata occurrences carry distinct ids and contiguous sequences', () => {
  const emitted: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new GrokProtocolV2Adapter({ setEventSink() {} } as unknown as GrokProxyService,
    'test', (method, params) => emitted.push({ method, params }), new NativeTurnIdentityStore(''));
  const emitter = adapter as unknown as {
    emitSessionEvent(method: string, session: { id: string; streamId: string; sequence: number }, data: Record<string, unknown>): void;
  };
  const session = { id: 'session', streamId: 'stream', sequence: 0 };
  emitter.emitSessionEvent('session.updated', session, { state: 'idle' });
  emitter.emitSessionEvent('session.updated', session, { state: 'idle' });
  assert.deepEqual(emitted.map(event => event.params.sequence), [1, 2]);
  assert.notEqual(emitted[0]!.params.eventId, emitted[1]!.params.eventId);
  for (const event of emitted) proxyNotificationSchema.parse({ jsonrpc: '2.0', ...event });
});

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

test('standard ACP oldText/newText diff content renders a real unified diff', () => {
  const modified = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-edit',
    status: 'completed',
    content: [{ type: 'diff', path: 'src/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }],
  });
  const diffEvent = modified.find((event) => event.method === 'diff.updated');
  assert.ok(diffEvent, 'oldText/newText must produce a diff event');
  const diff = String(diffEvent!.data.diff);
  assert.match(diff, /--- a\/src\/a\.ts/);
  assert.match(diff, /\+\+\+ b\/src\/a\.ts/);
  assert.match(diff, /-two/);
  assert.match(diff, /\+TWO/);
  assert.match(diff, / one/);
  assertValidDiffUpdated(diffEvent!.data);
  assert.deepEqual(diffEvent!.data.files, [{ path: 'src/a.ts', status: 'modified' }]);
});

test('new and deleted files map to added/deleted; an emptied file stays modified', () => {
  const added = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-add',
    status: 'completed',
    content: [{ type: 'diff', path: 'src/new.ts', oldText: null, newText: 'created\n' }],
  }).find((event) => event.method === 'diff.updated');
  assert.ok(added);
  assert.deepEqual(added!.data.files, [{ path: 'src/new.ts', status: 'added' }]);
  assert.match(String(added!.data.diff), /\+created/);
  assertValidDiffUpdated(added!.data);

  const deleted = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-del',
    status: 'completed',
    content: [{ type: 'diff', path: 'src/old.ts', oldText: 'gone\n', newText: null }],
  }).find((event) => event.method === 'diff.updated');
  assert.ok(deleted);
  assert.deepEqual(deleted!.data.files, [{ path: 'src/old.ts', status: 'deleted' }]);
  assert.match(String(deleted!.data.diff), /-gone/);
  assertValidDiffUpdated(deleted!.data);

  // An emptied file is not evidence of deletion.
  const emptied = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-empty',
    status: 'completed',
    content: [{ type: 'diff', path: 'src/emptied.ts', oldText: 'gone\n', newText: '' }],
  }).find((event) => event.method === 'diff.updated');
  assert.ok(emptied);
  assert.deepEqual(emptied!.data.files, [{ path: 'src/emptied.ts', status: 'modified' }]);
  assert.match(String(emptied!.data.diff), /-gone/);
  assertValidDiffUpdated(emptied!.data);
});

test('unicode and trailing-newline-only edits still produce a diff; identical text does not', () => {
  const unicode = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-uni',
    status: 'completed',
    content: [{ type: 'diff', path: 'src/u.ts', oldText: 'café\n', newText: 'café\n\n' }],
  }).find((event) => event.method === 'diff.updated');
  assert.ok(unicode, 'a trailing empty line is a real diff');
  assertValidDiffUpdated(unicode!.data);

  // The line split alone cannot see a trailing-newline change; the patch must
  // carry it explicitly.
  const newlineAdded = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-nl-add',
    status: 'completed',
    content: [{ type: 'diff', path: 'src/nl.ts', oldText: 'abc', newText: 'abc\n' }],
  }).find((event) => event.method === 'diff.updated');
  assert.ok(newlineAdded, 'adding a trailing newline is a real diff');
  assert.match(String(newlineAdded!.data.diff), /\\ No newline at end of file/);
  assertValidDiffUpdated(newlineAdded!.data);

  const newlineRemoved = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-nl-del',
    status: 'completed',
    content: [{ type: 'diff', path: 'src/nl.ts', oldText: 'abc\n', newText: 'abc' }],
  }).find((event) => event.method === 'diff.updated');
  assert.ok(newlineRemoved, 'removing a trailing newline is a real diff');
  assert.match(String(newlineRemoved!.data.diff), /\\ No newline at end of file/);
  assertValidDiffUpdated(newlineRemoved!.data);

  const identical = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-same',
    status: 'completed',
    content: [{ type: 'diff', path: 'src/s.ts', oldText: 'same\n', newText: 'same\n' }],
  }).find((event) => event.method === 'diff.updated');
  assert.equal(identical, undefined);
});

test('a pre-rendered runtime diff wins over oldText/newText and stays verbatim', () => {
  const events = translateSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-ext',
    status: 'completed',
    content: [{
      type: 'diff',
      path: 'src/x.ts',
      diff: '@@ -9 +9 @@\n-native\n+rendered\n',
      oldText: 'native\n',
      newText: 'rendered\n',
    }],
  });
  const diffEvent = events.find((event) => event.method === 'diff.updated');
  assert.equal(diffEvent?.data.diff, '@@ -9 +9 @@\n-native\n+rendered\n');
});

test('extension diff notifications accept oldText/newText too', () => {
  const events = translateExtension('x.ai/file_diff', {
    path: 'README.md',
    oldText: 'before\n',
    newText: 'after\n',
  });
  assert.equal(events[0]?.method, 'diff.updated');
  assert.match(String(events[0]?.data.diff), /-before/);
  assert.match(String(events[0]?.data.diff), /\+after/);
  assertValidDiffUpdated(events[0]!.data);
});


test('known native bookkeeping updates never masquerade as tool activities', () => {
  for (const sessionUpdate of ['model_changed', 'config_option_update',
    'session_info_update', 'session_summary_generated']) {
    assert.deepEqual(translateSessionUpdate({ sessionUpdate }).map(event => event.method), ['session.updated']);
  }
  for (const sessionUpdate of ['tool_call_delta_chunk', 'pending_interaction',
    'interaction_resolved', 'response_completed', 'turn_completed']) {
    assert.deepEqual(translateSessionUpdate({ sessionUpdate }), [], sessionUpdate);
  }
  for (const method of ['x.ai/settings/update', 'x.ai/session/prompt_complete']) {
    assert.deepEqual(translateExtension(method, {}).map(event => event.method), ['session.updated']);
  }
});
