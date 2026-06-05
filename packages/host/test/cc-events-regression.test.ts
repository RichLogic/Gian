// Regression corpus for Claude Code event-shape drift.
//
// These tests intentionally exercise fixtures captured from Claude Code style
// JSONL / hook payloads and cc-proxy notifications, then compare the stable
// normalized transcript signature against golden JSON. When Claude Code moves
// fields, renames tools, or changes hook payloads, this suite should fail
// loudly before Beta silently loses events.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProxyNotification, ServerToClientMessage, UnifiedEvent } from '@gian/shared';
import { normalizeCcNotification } from '../src/event/normalize-cc.js';
import { parseCcLine, type NormalizedEvent, type ParsedLine } from '../src/native/replay.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { TtyManager } from '../src/tty/manager.js';

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

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  sent: Array<{ client: unknown; message: ServerToClientMessage }> = [];
  add() {}
  remove() {}
  send(client: unknown, message: ServerToClientMessage) {
    this.sent.push({ client, message });
  }
  broadcast(msg: ServerToClientMessage) {
    this.messages.push(msg);
  }
  get size() {
    return 0;
  }
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
    normalizeCcNotification(notification, 'session-claude', 1)
      .map(projectUnifiedEvent),
  );
}

function projectParsedEvent(boundary: ParsedLine['boundary'], event: NormalizedEvent): StableEvent {
  return clean({
    boundary,
    type: event.type,
    ...(shouldKeepCallId(event.type) ? { callId: event.callId } : {}),
    data: projectData(event.type, event.data),
  });
}

function projectUnifiedEvent(event: UnifiedEvent): StableEvent {
  return clean({
    type: event.type,
    ...(shouldKeepCallId(event.type) ? { callId: event.call_id } : {}),
    data: projectData(event.type, event.data as unknown as Record<string, unknown>),
  });
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

function setupHookHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-cc-events-regression-'));
  const db = openDatabase(dir);
  const broadcaster = new CapturingBroadcaster();
  const proxy = { get: () => null } as unknown as ProxyManager;
  const mgr = new TtyManager(
    db,
    proxy,
    broadcaster as unknown as WsBroadcaster,
    'http://127.0.0.1:8991',
  );
  seedClaudeSession(db);
  return {
    dir,
    db,
    broadcaster,
    mgr,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedClaudeSession(db: Db): void {
  const now = '2026-06-01T00:00:00.000Z';
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(
    'ws-cc-events',
    'cc events',
    '/tmp/cc-events',
  );
  db.prepare(`
    INSERT INTO sessions (
      id, name, type, workspace_id, executor, model, approval_mode,
      thinking_effort, turns, active_channel, status, archived,
      worktree_path, branch, base_branch, worktree_outcome,
      native_session_id, runtime_mode, created_at, updated_at
    ) VALUES (
      'sess-cc-events', 'cc events', 'coding', 'ws-cc-events', 'claude',
      NULL, 'ask', NULL, 1, 'web', 'new', 0, NULL, NULL, NULL, NULL,
      'cc-events-native', 'tty', ?, ?
    )
  `).run(now, now);
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
  const resolved = parsed!.events.find(e => e.type === 'approval_resolved');
  assert.ok(resolved, 'expected an approval_resolved event for the cancelled tool');
  assert.equal((resolved!.data as { decision: string }).decision, 'decline');
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
  const resolved = parsed!.events.find(e => e.type === 'approval_resolved');
  assert.equal((resolved!.data as { decision: string }).decision, 'allow_once');
  // Answers ride along so a reloaded transcript can still show what was picked.
  assert.deepEqual(
    (resolved!.data as { answers?: unknown }).answers,
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

test('CC-EVENTS: Claude Code hook fixture drives expected TTY hook events and status transitions', async () => {
  const h = setupHookHarness();
  try {
    const hooks = readJson<Array<{ event: string; body: Record<string, unknown> }>>('hooks/lifecycle.json');
    for (const hook of hooks) {
      const result = await h.mgr.handleHook('sess-cc-events', hook.event, hook.body);
      assert.equal(result.status, 200, `hook ${hook.event} should return 200`);
    }

    const actual = {
      eventNames: h.broadcaster.messages
        .filter(m => m.type === 'event')
        .map(m => (m as { event: string }).event),
      statusUpdates: h.broadcaster.messages
        .filter(m => m.type === 'session:updated')
        .map(m => (m as { session: { status?: string } }).session.status)
        .filter(Boolean),
      finalStatus: (h.db
        .prepare('SELECT status FROM sessions WHERE id = ?')
        .get('sess-cc-events') as { status: string }).status,
    };
    const expected = readJson<typeof actual>('golden/hooks-lifecycle.json');
    assert.deepEqual(actual, expected);
  } finally {
    h.cleanup();
  }
});
