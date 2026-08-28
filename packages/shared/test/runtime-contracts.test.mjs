import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  RuntimeContractError,
  parseListNativeSessionsResponse,
  parseSession,
  parseSessionList,
  parseSideChatInfo,
  parseStateSyncMessage,
} from '../dist/index.js';

function sessionFixture() {
  return {
    id: 'session-1',
    name: 'Contract session',
    type: 'coding',
    task_id: null,
    workspace_id: 'workspace-1',
    created_by_actor_kind: 'internal_session',
    created_by_actor_id: 'session-parent',
    created_by_session_id: 'session-parent',
    executor: 'codex',
    runtime_profile: {
      id: 'profile-1',
      agentId: 'agent-1',
      proxy: 'codex',
      cliPath: '/usr/local/bin/codex',
      cliVersion: '0.146.0',
      configHome: '/Users/test/.codex',
      cliFingerprint: 'sha256-runtime',
      proxyVersion: '0.2.8',
      verifiedCliVersions: ['0.146.0'],
      verification: 'verified',
      skill: { name: 'gian-session', version: '0.2.8', state: 'ready' },
    },
    model: 'gpt-5',
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: { sandbox: 'workspace-write', fast: true } },
    native_config_options: [{
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: 'ask',
      choices: [{ value: 'ask', label: 'Ask' }],
      scope: 'session',
    }],
    thinking_effort: 'high',
    service_tier: 'fast',
    active_channel: 'web',
    status: 'running',
    archived: 0,
    pinned_at: null,
    unread: 1,
    worktree_path: '/tmp/worktree',
    detected_worktree_path: null,
    detected_worktree_source: 'agent',
    detected_worktree_revision: 3,
    branch: 'fix/contract',
    base_branch: 'main',
    worktree_outcome: null,
    native_session_id: 'native-1',
    context_tokens_used: 42,
    context_window_tokens: 128_000,
    context_usage_updated_at: '2026-08-08T00:00:00.000Z',
    conversation_input_tokens: 10,
    conversation_output_tokens: 20,
    conversation_cached_input_tokens: 5,
    conversation_total_tokens: 35,
    conversation_usage_complete: 1,
    summary: null,
    completed_at: null,
    created_at: '2026-08-08T00:00:00.000Z',
    updated_at: '2026-08-08T00:01:00.000Z',
  };
}

function stateSyncFixture() {
  return {
    type: 'state_sync',
    runner: {
      host: '127.0.0.1',
      latency: 0,
      started_ago: '1s',
      agents: 1,
      disk: '10 GB',
      codex_version: '1.0.0',
      cc_version: '2.0.0',
      ws_root: '/workspaces',
    },
    sessions: [sessionFixture()],
    workspaces: [{
      id: 'workspace-1',
      name: 'Workspace',
      path: '/workspaces/project',
      sort_order: 0,
      hidden: 0,
      pinned: 1,
      created_at: '2026-08-08T00:00:00.000Z',
      updated_at: '2026-08-08T00:00:00.000Z',
    }],
    tasks: [{
      id: 'task-1',
      name: 'Task',
      description: null,
      status: 'open',
      created_at: '2026-08-08T00:00:00.000Z',
      updated_at: '2026-08-08T00:00:00.000Z',
      pinned_at: null,
    }],
    approvals: [{
      id: 'approval-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      category: 'command',
      title: 'Run tests',
      command: 'pnpm test',
      reason: null,
      status: 'pending',
      resolved_by: null,
      resolved_at: null,
      created_at: '2026-08-08T00:00:00.000Z',
      native_options: [{ optionId: 'allow', label: 'Allow', kind: 'allow_once' }],
    }],
    config: {
      host: '127.0.0.1',
      port: 8990,
      workspace_root: '/workspaces',
      theme: 'dark',
      accent: 'plum',
      density: 'cozy',
      font_scale_chrome: 'md',
      font_scale_chat: 'lg',
      font_scale_code: 'sm',
      terminal: {
        font_family: 'jetbrains-mono',
        font_size: 13,
        line_height: 1.2,
        cursor_style: 'block',
        cursor_blink: true,
        scrollback_lines: 5000,
        shell: '',
        start_directory: 'context',
      },
      locale: 'zh-CN',
      default_claude_model: '',
      default_claude_effort: '',
      default_codex_model: '',
      default_codex_effort: '',
      auth_username: 'admin',
      external_editors: [{ id: 'code', name: 'Code', command: 'code', args: ['{path}'] }],
      open_apps: { code: 'Visual Studio Code', pdf: 'Preview' },
    },
  };
}

test('CONTRACT-005: model Session runtime contract accepts the complete canonical shape', () => {
  const fixture = sessionFixture();
  assert.equal(parseSession(fixture), fixture);
  const list = [fixture];
  assert.equal(parseSessionList(list), list);
});

test('CONTRACT-005 / WS-001: state_sync runtime contract validates the complete nested snapshot', () => {
  const fixture = stateSyncFixture();
  assert.equal(parseStateSyncMessage(fixture), fixture);
});

test('CONTRACT-005: malformed nested model/web fields are rejected at runtime', () => {
  const badSession = sessionFixture();
  badSession.status = 'busy';
  assert.throws(() => parseSession(badSession), RuntimeContractError);
  assert.throws(() => parseSessionList([badSession]), error =>
    error instanceof RuntimeContractError && error.contract === 'Session[]');

  const badSync = stateSyncFixture();
  badSync.config.density = 'dense';
  assert.throws(() => parseStateSyncMessage(badSync), error =>
    error instanceof RuntimeContractError && error.contract === 'StateSyncMessage');

  const badTerminal = stateSyncFixture();
  badTerminal.config.terminal.font_size = 'large';
  assert.throws(() => parseStateSyncMessage(badTerminal), error =>
    error instanceof RuntimeContractError && error.contract === 'StateSyncMessage');

  const oversizedTerminal = stateSyncFixture();
  oversizedTerminal.config.terminal.font_size = 23;
  assert.throws(() => parseStateSyncMessage(oversizedTerminal), error =>
    error instanceof RuntimeContractError && error.contract === 'StateSyncMessage');
});

test('CONTRACT-005: native-session REST response has positive and negative runtime evidence', () => {
  const fixture = {
    sessions: [{
      id: 'native-1',
      executor: 'claude',
      filePath: '/home/test/.claude/native-1.jsonl',
      cwd: '/workspaces/project',
      updatedAt: '2026-08-08T00:00:00.000Z',
      fileSize: 1024,
      turnCount: 3,
      firstUserMessage: 'Please fix the tests',
      adoptedBy: { gianSessionId: 'session-1', gianSessionName: null },
    }],
  };
  assert.equal(parseListNativeSessionsResponse(fixture), fixture);

  const malformed = structuredClone(fixture);
  malformed.sessions[0].fileSize = '1024';
  assert.throws(() => parseListNativeSessionsResponse(malformed), RuntimeContractError);
});

// ── Side Chat / Fork amendment (gian.proxy/2.0 proposal §10.2–§10.6) ──────

function sideChatFixture() {
  return {
    id: 'sc_01J',
    parent_session_id: 'session-1',
    ordinal: 1,
    name: null,
    stream_id: 'stream-side-1',
    state: 'idle',
    status: 'open',
    anchor: { type: 'turn', turn_id: 't_parent', source_turn_id: 'provider-turn-parent' },
    session_config: { execution_mode: 'agent' },
    last_error: null,
    uncertain_turn_id: null,
    events: [],
    user_inputs: [],
    created_at: '2026-08-20T08:00:00.000Z',
    updated_at: '2026-08-20T08:00:00.000Z',
  };
}

test('SideChatInfo runtime contract accepts every anchor and lifecycle status (§10.5)', () => {
  for (const anchor of [
    { type: 'empty' },
    { type: 'turn', turn_id: 't', source_turn_id: 'p' },
    { type: 'activeInput', turn_id: 't', source_turn_id: 'p' },
  ]) {
    const fixture = { ...sideChatFixture(), anchor };
    assert.equal(parseSideChatInfo(fixture), fixture);
  }
  for (const status of ['open', 'closing', 'unavailable']) {
    const fixture = { ...sideChatFixture(), status };
    assert.equal(parseSideChatInfo(fixture), fixture);
  }
  const withContext = sideChatFixture();
  withContext.user_inputs = [{
    turn_id: 'turn-context',
    input: [{ type: 'text', text: 'use this' }],
    created_at: '2026-08-20T08:00:00.000Z',
    context_items: [{
      type: 'pastedText', id: 'paste-1', text: 'context', lineCount: 1, byteSize: 7,
    }],
    composer_document: {
      version: 1,
      segments: [
        { type: 'text', text: 'use ' },
        { type: 'reference', id: 'paste-1', referenceType: 'context', label: 'context' },
      ],
    },
  }];
  assert.equal(parseSideChatInfo(withContext), withContext);

  const withBrowserContext = sideChatFixture();
  withBrowserContext.user_inputs = [{
    turn_id: 'turn-browser-context',
    input: [{ type: 'text', text: 'review this element' }],
    created_at: '2026-08-20T08:00:00.000Z',
    context_items: [{
      type: 'browserElement',
      id: 'browser-1',
      pageUrl: 'https://example.com/page',
      pageTitle: 'Example',
      tagName: 'button',
      selector: 'button[data-testid="save"]',
      role: 'button',
      name: 'Save',
      attributes: { 'data-testid': 'save' },
      contentOmitted: false,
      snippet: '<button data-testid="save">Save</button>',
    }],
  }];
  assert.equal(parseSideChatInfo(withBrowserContext), withBrowserContext);
});

test('SideChatInfo runtime contract rejects malformed records and resumeRef-free payloads stay valid', () => {
  const badState = { ...sideChatFixture(), status: 'closed' };
  assert.throws(() => parseSideChatInfo(badState), error =>
    error instanceof RuntimeContractError && error.contract === 'SideChatInfo');

  const badAnchor = sideChatFixture();
  badAnchor.anchor = { type: 'turn', turn_id: 't' }; // source_turn_id required
  assert.throws(() => parseSideChatInfo(badAnchor), RuntimeContractError);

  const unknownAnchor = sideChatFixture();
  unknownAnchor.anchor = { type: 'history', turn_id: 't', source_turn_id: 'p' };
  assert.throws(() => parseSideChatInfo(unknownAnchor), RuntimeContractError);

  const badContext = sideChatFixture();
  badContext.user_inputs = [{
    turn_id: 'turn-context',
    input: [],
    created_at: '2026-08-20T08:00:00.000Z',
    context_items: [{ type: 'folder', id: 'folder-1', path: 7, name: 'bad' }],
  }];
  assert.throws(() => parseSideChatInfo(badContext), RuntimeContractError);

  const badDocument = sideChatFixture();
  badDocument.user_inputs = [{
    turn_id: 'turn-document',
    input: [],
    created_at: '2026-08-20T08:00:00.000Z',
    composer_document: { version: 1, segments: [{ type: 'reference', id: '', label: 'bad' }] },
  }];
  assert.throws(() => parseSideChatInfo(badDocument), RuntimeContractError);
});

test('state_sync accepts and preserves the complete sidechats read-model set (§10.5.2)', () => {
  const fixture = stateSyncFixture();
  fixture.sidechats = [sideChatFixture()];
  assert.equal(parseStateSyncMessage(fixture), fixture);

  // Hosts predating the amendment omit the field and stay valid.
  assert.equal(parseStateSyncMessage(stateSyncFixture()).sidechats, undefined);
});

test('state_sync rejects an invalid sidechat record inside the snapshot', () => {
  const fixture = stateSyncFixture();
  fixture.sidechats = [{ ...sideChatFixture(), parent_session_id: 7 }];
  assert.throws(() => parseStateSyncMessage(fixture), error =>
    error instanceof RuntimeContractError && error.contract === 'StateSyncMessage');
});

test('Session accepts available_actions (§10.3) and fork origin (§10.6)', () => {
  const fixture = sessionFixture();
  fixture.available_actions = {
    'sidechat.create': { enabled: true },
    'session.fork': { enabled: false, reason: '当前没有可分叉的 Terminal Turn。' },
  };
  fixture.origin = {
    kind: 'fork',
    session_id: 's_parent',
    turn_id: 't_anchor',
    source_turn_id: 'provider-turn-anchor',
  };
  assert.equal(parseSession(fixture), fixture);

  // Fork origin always records the exact resolved Terminal boundary, including head.
  const headOrigin = sessionFixture();
  headOrigin.origin = {
    kind: 'fork',
    session_id: 's_parent',
    turn_id: 't_head',
    source_turn_id: 'provider-turn-head',
  };
  assert.equal(parseSession(headOrigin), headOrigin);

  const badAvailability = sessionFixture();
  badAvailability.available_actions = { 'session.fork': { enabled: 'yes' } };
  assert.throws(() => parseSession(badAvailability), RuntimeContractError);

  const badOrigin = sessionFixture();
  badOrigin.origin = { kind: 'fork', turn_id: 't' }; // session_id required
  assert.throws(() => parseSession(badOrigin), RuntimeContractError);
});
