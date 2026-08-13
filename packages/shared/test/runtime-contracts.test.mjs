import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  RuntimeContractError,
  parseListNativeSessionsResponse,
  parseSession,
  parseSessionList,
  parseStateSyncMessage,
} from '../dist/index.js';

function sessionFixture() {
  return {
    id: 'session-1',
    name: 'Contract session',
    type: 'coding',
    task_id: null,
    workspace_id: 'workspace-1',
    executor: 'codex',
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
