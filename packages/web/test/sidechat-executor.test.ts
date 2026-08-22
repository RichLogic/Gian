import { describe, expect, it } from 'vitest';
import type { Session } from '@gian/shared';
import { sideChatExecutor } from '../src/presentation/sidechat.js';

function session(executor: Session['executor']): Session {
  return {
    id: 's-1',
    name: null,
    type: 'coding',
    task_id: null,
    workspace_id: 'ws-1',
    executor,
    model: null,
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: null,
    service_tier: null,
    active_channel: 'web',
    status: 'done',
    archived: 0,
    pinned_at: null,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: null,
    summary: null,
    completed_at: null,
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
  };
}

describe('sideChatExecutor', () => {
  it('uses the parent executor and falls back to claude', () => {
    expect(sideChatExecutor(session('codex'))).toBe('codex');
    expect(sideChatExecutor(session('kimi'))).toBe('kimi');
    expect(sideChatExecutor(null)).toBe('claude');
    expect(sideChatExecutor(undefined)).toBe('claude');
  });
});
