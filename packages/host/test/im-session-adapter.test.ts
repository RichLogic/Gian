// Pure mapping coverage for the shared Slack/Discord session adapter.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Session, Workspace } from '@gian/shared';
import type { ApprovalRecord } from '../src/approval/manager.js';
import {
  LOCAL_USER,
  toMessagingSession,
  toWorkspaceSummary,
  toPendingApproval,
  toModelOption,
} from '../src/im/build-options.js';

// ---------------------------------------------------------------------------
// toMessagingSession — fields read by both platform managers.
// ---------------------------------------------------------------------------

function makeGianSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    workspace_id: 'ws-1',
    name: 'demo session',
    executor: 'claude',
    model: 'claude-sonnet-4-5',
    approval_mode: 'ask',
    status: 'idle',
    archived: 0,
    thinking_effort: 'medium',
    active_channel: 'web',
    native_session_id: 'cc_native_abc',
    created_at: '2026-05-17T10:00:00.000Z',
    updated_at: '2026-05-17T10:30:00.000Z',
    ...overrides,
  } as Session;
}

test('IM-INV-001: toMessagingSession maps core identity + workspace + executor fields', () => {
  const out = toMessagingSession(makeGianSession());

  assert.equal(out.id, 'sess-1');
  assert.equal(out.threadId, 'cc_native_abc',
    'threadId must use native_session_id so codex/cc threads round-trip through IM');
  assert.equal(out.title, 'demo session');
  assert.equal(out.autoTitle, false, 'autoTitle is false when session has an explicit name');
  assert.equal(out.workspace, 'ws-1');
  assert.equal(out.workspaceId, 'ws-1');
  assert.equal(out.executor, 'claude');
  assert.equal(out.model, 'claude-sonnet-4-5');
  assert.equal(out.approvalMode, 'ask');
  assert.equal(out.sessionType, 'code',
    'IM module only supports code sessions in current scope');
  assert.equal(out.createdAt, '2026-05-17T10:00:00.000Z');
  assert.equal(out.updatedAt, '2026-05-17T10:30:00.000Z');
});

test('IM-INV-001: toMessagingSession falls back to (unnamed) and autoTitle=true when name missing', () => {
  const out = toMessagingSession(makeGianSession({ name: null }));
  assert.equal(out.title, '(unnamed)');
  assert.equal(out.autoTitle, true,
    'autoTitle must be true when session has no explicit name — IM rebrands the title');
});

test('IM-INV-001: toMessagingSession uses session id as threadId when native_session_id is null', () => {
  const out = toMessagingSession(makeGianSession({ native_session_id: null }));
  assert.equal(out.threadId, 'sess-1',
    'fallback to session id keeps the threadId field non-null for downstream consumers');
});

test('IM-INV-001: toMessagingSession maps status running/error/needs-approval; new and done map to idle', () => {
  const cases: Array<[Session['status'], string]> = [
    ['running', 'running'],
    ['pending', 'needs-approval'],
    ['error', 'error'],
    ['new', 'idle'],
    ['done', 'idle'],
  ];
  for (const [input, expected] of cases) {
    const out = toMessagingSession(makeGianSession({ status: input }));
    assert.equal(out.status, expected,
      `status ${input} must translate to ${expected}, got ${out.status}`);
  }
});

test('IM-INV-001: toMessagingSession sets archivedAt only when archived=1', () => {
  const live = toMessagingSession(makeGianSession({ archived: 0 }));
  assert.equal(live.archivedAt, null);
  const archived = toMessagingSession(
    makeGianSession({ archived: 1, updated_at: '2026-05-17T11:00:00.000Z' }),
  );
  assert.equal(archived.archivedAt, '2026-05-17T11:00:00.000Z',
    'archivedAt reuses updated_at as the archive timestamp');
});

test('IM-INV-001: toMessagingSession maps thinking_effort through toReasoningEffort', () => {
  // off → none is a non-obvious display rename.
  assert.equal(
    toMessagingSession(makeGianSession({ thinking_effort: 'off' })).reasoningEffort,
    'none',
  );
  assert.equal(
    toMessagingSession(makeGianSession({ thinking_effort: 'medium' })).reasoningEffort,
    'medium',
  );
  // max → xhigh and xhigh → xhigh are both valid; assert that the alias
  // collapses correctly.
  assert.equal(
    toMessagingSession(makeGianSession({ thinking_effort: 'max' })).reasoningEffort,
    'xhigh',
  );
  assert.equal(
    toMessagingSession(makeGianSession({ thinking_effort: 'xhigh' })).reasoningEffort,
    'xhigh',
  );
});

test('IM-INV-001: toMessagingSession pins owner to LOCAL_USER (single-user model)', () => {
  const out = toMessagingSession(makeGianSession());
  assert.equal(out.ownerUserId, LOCAL_USER.id);
  assert.equal(out.ownerUsername, LOCAL_USER.username);
  assert.equal(LOCAL_USER.id, 'local', 'LOCAL_USER id is the stable single-user constant');
});

// ---------------------------------------------------------------------------
// toWorkspaceSummary
// ---------------------------------------------------------------------------

test('IM-INV-001: toWorkspaceSummary copies id/name/path and defaults visible=true', () => {
  const ws: Workspace = {
    id: 'ws-1',
    name: 'demo',
    path: '/repo/demo',
    git_remote: '',
    sort_order: 3,
    created_at: '2026-05-17T00:00:00.000Z',
    updated_at: '2026-05-17T00:00:00.000Z',
  } as Workspace;

  const out = toWorkspaceSummary(ws);
  assert.equal(out.id, 'ws-1');
  assert.equal(out.name, 'demo');
  assert.equal(out.path, '/repo/demo');
  assert.equal(out.sortOrder, 3);
  assert.equal(out.visible, true,
    'Gian has no per-workspace visibility flag yet; default must be true so IM lists all workspaces');
});

// ---------------------------------------------------------------------------
// toPendingApproval
// ---------------------------------------------------------------------------

function makeApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'appr-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    category: 'shell',
    risk: 'medium',
    description: 'run npm install',
    subject: 'npm install',
    status: 'pending',
    resolvedBy: null,
    resolvedAt: null,
    createdAt: Date.UTC(2026, 4, 17, 10, 0, 0),
    payload: { approvalId: 'appr-1' },
    ...overrides,
  } as ApprovalRecord;
}

test('IM-INV-001: toPendingApproval maps id/sessionId/title/risk and preserves payload', () => {
  const out = toPendingApproval(makeApproval(), 'claude');
  assert.equal(out.id, 'appr-1');
  assert.equal(out.sessionId, 'sess-1');
  assert.equal(out.rpcRequestId, 'appr-1',
    'rpcRequestId mirrors the approval id; IM uses it to correlate ack messages');
  assert.equal(out.method, 'shell', 'method comes from the category field');
  assert.equal(out.title, 'run npm install',
    'title prefers description, falls back to category');
  assert.equal(out.risk, 'medium');
  assert.deepEqual(out.payload, { approvalId: 'appr-1' });
});

test('IM-INV-001: toPendingApproval falls back to category when description is empty', () => {
  const out = toPendingApproval(makeApproval({ description: '' }), 'codex');
  assert.equal(out.title, 'shell',
    'empty description must fall back to category, never an empty title');
});

test('IM-INV-001: toPendingApproval always offers once+session scope, regardless of source', () => {
  const claude = toPendingApproval(makeApproval(), 'claude');
  const codex = toPendingApproval(makeApproval(), 'codex');
  assert.deepEqual(claude.scopeOptions, ['once', 'session']);
  assert.deepEqual(codex.scopeOptions, ['once', 'session']);
  assert.equal(claude.source, 'claude');
  assert.equal(codex.source, 'codex');
});

test('IM-INV-001: toPendingApproval normalizes createdAt epoch ms to ISO', () => {
  const out = toPendingApproval(makeApproval(), 'claude');
  // Date.UTC(2026, 4, 17, 10, 0, 0) → 2026-05-17T10:00:00.000Z (month is 0-indexed).
  assert.equal(out.createdAt, '2026-05-17T10:00:00.000Z');
});

// ---------------------------------------------------------------------------
// toModelOption — bridges cc + codex capability shapes
// ---------------------------------------------------------------------------

test('IM-INV-001: toModelOption accepts cc capability shape (defaultEffort/supportedEfforts)', () => {
  const out = toModelOption({
    id: 'claude-sonnet-4-5',
    model: 'claude-sonnet-4-5-20250514',
    displayName: 'Claude Sonnet 4.5',
    description: 'desc',
    isDefault: true,
    hidden: false,
    defaultEffort: 'medium',
    supportedEfforts: ['low', 'medium', 'high'],
  });

  assert.equal(out.id, 'claude-sonnet-4-5');
  assert.equal(out.displayName, 'Claude Sonnet 4.5');
  assert.equal(out.model, 'claude-sonnet-4-5-20250514');
  assert.equal(out.isDefault, true);
  assert.equal(out.hidden, false);
  assert.equal(out.defaultReasoningEffort, 'medium');
  assert.deepEqual(out.supportedReasoningEfforts, ['low', 'medium', 'high']);
});

test('IM-INV-001: toModelOption accepts codex capability shape (defaultThinking/supportedThinking)', () => {
  const out = toModelOption({
    id: 'gpt-5-codex',
    model: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    isDefault: false,
    defaultThinking: 'high',
    supportedThinking: ['minimal', 'medium', 'high', 'xhigh'],
  });

  assert.equal(out.defaultReasoningEffort, 'high');
  assert.deepEqual(out.supportedReasoningEfforts, ['minimal', 'medium', 'high', 'xhigh']);
});

test('IM-INV-001: toModelOption falls back to id when displayName/model missing', () => {
  const out = toModelOption({ id: 'foo' });
  assert.equal(out.displayName, 'foo',
    'displayName falls back to id so IM model picker always renders a label');
  assert.equal(out.model, 'foo',
    'model wire id falls back to id when not separately provided');
  assert.equal(out.description, '');
  assert.equal(out.isDefault, false);
  assert.equal(out.hidden, false);
});

test('IM-INV-001: toModelOption defaults effort to medium when neither default* is set', () => {
  const out = toModelOption({ id: 'foo' });
  assert.equal(out.defaultReasoningEffort, 'medium',
    'no default effort declared must fall through to medium — IM has no concept of "unknown"');
});

test('IM-INV-001: toModelOption drops unsupported effort values', () => {
  const out = toModelOption({
    id: 'foo',
    supportedEfforts: ['low', 'bogus', 'high'],
  });
  // The mapper drops values the chat UI cannot present.
  assert.deepEqual(out.supportedReasoningEfforts, ['low', 'high']);
});
