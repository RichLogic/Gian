// Regression corpus for Claude Code event-shape drift.
//
// These tests intentionally exercise fixtures captured from Claude Code style
// JSONL and cc-proxy notifications, then compare the stable normalized
// transcript signature against golden JSON. When Claude Code moves fields or
// renames tools, this suite should fail loudly before Beta silently loses
// events.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DisplayEvent, DisplayEventType, ProxyNotification } from '@gian/shared';
import { projectCcNotification } from '../src/event/normalize-cc.js';
import { parseCcLine, type NormalizedEvent, type ParsedLine } from '../src/native/replay.js';

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'claude-code',
  '2.1.159',
);

interface StableEvent {
  boundary?: ParsedLine['boundary'];
  type: string;
  callId?: string;
  data: Record<string, unknown>;
}

function fixture(...parts: string[]): string {
  return join(FIXTURE_ROOT, ...parts);
}

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(fixture(...parts), 'utf8')) as T;
}

function readJsonl(...parts: string[]): string[] {
  return readFileSync(fixture(...parts), 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0);
}

function normalizeJsonl(path: string): StableEvent[] {
  const actual: StableEvent[] = [];
  for (const line of readJsonl(path)) {
    const parsed = parseCcLine(line);
    if (!parsed) continue;
    for (const event of parsed.events) {
      actual.push(projectParsedEvent(parsed.boundary, event));
    }
  }
  return actual;
}

function normalizeProxyNotifications(path: string): StableEvent[] {
  const notifications = readJson<ProxyNotification[]>(path);
  return notifications.flatMap(notification =>
    projectCcNotification(notification, 'session-claude', 1)
      .map(projectDisplayEvent),
  );
}

function projectParsedEvent(boundary: ParsedLine['boundary'], event: NormalizedEvent): StableEvent {
  const stored = event.data.__gian_event === 2 ? event.data : null;
  const display = stored?.display as { type?: DisplayEventType; data?: Record<string, unknown> } | undefined;
  const type = display?.type ? fixtureType(display.type) : event.type;
  const data = display?.data ?? event.data;
  return clean({
    boundary,
    type,
    ...(shouldKeepCallId(type) ? { callId: event.callId } : {}),
    data: projectData(type, data),
  });
}

function projectDisplayEvent(event: DisplayEvent): StableEvent {
  const type = fixtureType(event.type);
  return clean({
    type,
    ...(shouldKeepCallId(type) ? { callId: event.call_id } : {}),
    data: projectData(type, event.data as unknown as Record<string, unknown>),
  });
}

function fixtureType(type: DisplayEventType): string {
  return ({
    message: 'assistant_text',
    'activity.reasoning': 'reasoning',
    plan: 'plan_update',
    'activity.command': 'command_execution',
    'activity.file-change': 'file_change',
    'activity.file-read': 'file_read',
    'activity.file-search': 'file_search',
    'activity.web-search': 'web_search',
    'activity.tool': 'tool_execution',
    agent: 'agent_spawn',
    'interaction.question': 'approval_requested',
    'interaction.approval': 'approval_requested',
    'interaction.resolved': 'approval_resolved',
    'activity.classifier-denied': 'auto_classifier_denied',
    'activity.circuit-breaker': 'auto_circuit_breaker',
    'state.turn-started': 'turn_started',
    'state.turn-completed': 'turn_completed',
    'state.error': 'session_error',
  } satisfies Record<DisplayEventType, string>)[type];
}

function shouldKeepCallId(type: string): boolean {
  return !new Set(['user_message', 'assistant_text', 'session_error']).has(type);
}

function projectData(type: string, data: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'assistant_text':
      return pick(data, ['text', 'delta']);
    case 'command_execution':
      return pick(data, ['command', 'cwd', 'status', 'itemId']);
    case 'file_change':
      return pick(data, ['files', 'diff']);
    case 'file_read':
      return pick(data, ['path', 'startLine', 'endLine']);
    case 'file_search':
      return pick(data, ['pattern', 'kind', 'matchCount', 'matches']);
    case 'web_search':
      return pick(data, ['query', 'resultCount']);
    case 'agent_spawn':
      return pick(data, ['description', 'status', 'input']);
    case 'approval_requested':
      return pick(data, [
        'approvalId',
        'category',
        'risk',
        'title',
        'description',
        'subject',
        'scopeOptions',
        'toolName',
        'questions',
        'planActions',
      ]);
    case 'approval_resolved':
      return pick(data, ['approvalId', 'decision', 'auto', 'answers']);
    case 'auto_classifier_denied':
      return pick(data, ['action', 'reason', 'consecutive', 'total']);
    case 'auto_circuit_breaker':
      return pick(data, ['trigger', 'consecutive', 'total']);
    case 'turn_started':
      return pick(data, ['turnId']);
    case 'turn_completed':
      return pick(data, ['turnId', 'summary']);
    case 'session_error':
      return pick(data, ['message', 'retryable', 'code']);
    default:
      return data;
  }
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('CC-EVENTS: Claude Code JSONL AskUserQuestion fixture matches golden events', () => {
  const actual = normalizeJsonl('jsonl/ask-user-question.jsonl');
  const expected = readJson<StableEvent[]>('golden/jsonl-ask-user-question.events.json');
  assert.deepEqual(actual, expected);
});

test('CC-EVENTS: AskUserQuestion tool_result with is_error resolves as decline', () => {
  // When the PTY-side selector is cancelled (Beta paste-back, user Esc, PTY
  // died mid-prompt) claude writes a tool_result with is_error=true and no
  // answers. The native JSONL replay must report this as a declined approval —
  // showing it as "allowed" would be misleading and would also leak through to
  // the Beta UI as a green check on an aborted question.
  const cancelledLine = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_cancelled',
        content: 'AskUserQuestion was interrupted.',
        is_error: true,
      }],
    },
    toolUseResult: {
      questions: [{ question: 'Pick dinner', options: [{ label: 'Rice' }] }],
    },
    timestamp: '2026-06-01T06:30:00.000Z',
    sessionId: 'cc-fixture-cancel',
  });
  const parsed = parseCcLine(cancelledLine);
  assert.ok(parsed, 'parser should pick up the cancelled tool_result');
  const resolved = parsed!.events.find(e => e.type === 'approval.resolved');
  assert.ok(resolved, 'expected an approval_resolved event for the cancelled tool');
  const resolvedDisplay = (resolved!.data.display as { data?: { decision?: string } }).data;
  assert.equal(resolvedDisplay?.decision, 'decline');
});

test('CC-EVENTS: AskUserQuestion tool_result with answers stays allow_once', () => {
  // The happy path the existing fixture covers — keep an explicit guard here
  // so a future refactor of isAskUserQuestionToolResult can\'t flip the polarity.
  const answeredLine = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_answered',
        content: 'Your questions have been answered.',
      }],
    },
    toolUseResult: {
      questions: [{ question: 'Pick dinner', options: [{ label: 'Rice' }] }],
      answers: { 'Pick dinner': 'Rice' },
    },
    timestamp: '2026-06-01T06:31:00.000Z',
    sessionId: 'cc-fixture-answered',
  });
  const parsed = parseCcLine(answeredLine);
  assert.ok(parsed);
  const resolved = parsed!.events.find(e => e.type === 'approval.resolved');
  const resolvedDisplay = (resolved!.data.display as { data?: { decision?: string; answers?: unknown } }).data;
  assert.equal(resolvedDisplay?.decision, 'allow_once');
  // Answers ride along so a reloaded transcript can still show what was picked.
  assert.deepEqual(
    resolvedDisplay?.answers,
    { 'Pick dinner': 'Rice' },
  );
});

test('CC-EVENTS: Claude Code JSONL tool matrix fixture matches golden events', () => {
  const actual = normalizeJsonl('jsonl/tool-matrix.jsonl');
  const expected = readJson<StableEvent[]>('golden/jsonl-tool-matrix.events.json');
  assert.deepEqual(actual, expected);
});

test('CC-EVENTS: cc-proxy structured notification fixture matches golden events', () => {
  const actual = normalizeProxyNotifications('proxy-notifications/structured-events.json');
  const expected = readJson<StableEvent[]>('golden/proxy-structured-events.json');
  assert.deepEqual(actual, expected);
});
