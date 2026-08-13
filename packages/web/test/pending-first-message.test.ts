import { describe, expect, it } from 'vitest';
import type { Session } from '@gian/shared';
import { pendingFirstMessageForCreatedSession } from '../src/pending-first-message.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1', name: null, type: 'coding', task_id: null, workspace_id: 'workspace-1',
    executor: 'codex', model: null, approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} }, native_config_options: [],
    thinking_effort: null, service_tier: null, active_channel: 'web', status: 'new',
    archived: 0, pinned_at: null, unread: 0, worktree_path: null, branch: null,
    base_branch: null, worktree_outcome: null, native_session_id: null, summary: null,
    completed_at: null, created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z', ...overrides,
  };
}

describe('new Session screenshot ownership', () => {
  it('matches a Workspace draft only to its exact interactive create', () => {
    const pending = {
      scope: { kind: 'workspace' as const, id: 'workspace-1' },
      text: 'hello',
      attachments: [],
    };
    expect(pendingFirstMessageForCreatedSession(
      pending,
      session(),
      'interactive-create',
    )).toBe(pending);
    expect(pendingFirstMessageForCreatedSession(
      pending,
      session({ id: 'other', workspace_id: 'workspace-2' }),
      'interactive-create',
    )).toBeNull();
  });

  it('matches a Task draft only to a subtask from that Task', () => {
    const pending = {
      scope: { kind: 'task' as const, id: 'task-1' },
      text: '',
      attachments: [],
    };
    expect(pendingFirstMessageForCreatedSession(
      pending,
      session({ type: 'subtask', task_id: 'task-1' }),
      'task-create',
    )).toBe(pending);
    expect(pendingFirstMessageForCreatedSession(
      pending,
      session({ type: 'subtask', task_id: 'task-2' }),
      'task-create',
    )).toBeNull();
  });

  it('never consumes an interactive draft for native adoption', () => {
    expect(pendingFirstMessageForCreatedSession(
      {
        scope: { kind: 'workspace', id: 'workspace-1' },
        text: 'keep me',
        attachments: [],
      },
      session(),
      'native-adopt',
    )).toBeNull();
  });
});
