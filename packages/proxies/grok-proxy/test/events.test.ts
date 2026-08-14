import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isExcludedExtension,
  parsePromptUsage,
  translateExtension,
  translateSessionUpdate,
} from '../src/core/events.js';

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
  assert.deepEqual(tool.map(event => event.method), ['diff.updated', 'tool.updated']);
  assert.deepEqual((tool[1]?.data.data as { locations?: unknown[] }).locations?.[0], { path: 'src/a.ts' });
});

test('excluded Grok extensions never leak through extension.event', () => {
  assert.equal(isExcludedExtension('session/rewind_marker'), true);
  assert.equal(translateExtension('x.ai/plugin/marketplace', { id: 'x' }).length, 0);
  assert.equal(translateExtension('x.ai/mcp/list', {}).length, 0);
  assert.equal(translateExtension('x.ai/feedback/request', {}).length, 0);
});

test('allowed Grok extensions map to usage, agents, notices, or grok namespace events', () => {
  const compact = translateExtension('x.ai/auto_compact_started', { tokens: 12 });
  assert.deepEqual(compact.map(event => event.method), ['usage.updated', 'notice.created']);
  assert.equal(compact[0]?.data.reason, 'compact_started');

  const agent = translateExtension('x.ai/subagent/spawned', { agentId: 'child-1' });
  assert.equal(agent[0]?.method, 'agent.updated');

  const unknown = translateExtension('x.ai/session/recap', { text: 'summary' });
  assert.equal(unknown[0]?.method, 'extension.event');
  assert.equal((unknown[0]?.data as { namespace?: string }).namespace, 'grok');
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
