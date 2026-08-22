import { describe, expect, it } from 'vitest';
import type { Session } from '@gian/shared';
import { subtasksFor } from '../src/views/TasksView.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's',
    name: null,
    type: 'subtask',
    task_id: 'task-unit',
    workspace_id: 'workspace-1',
    executor: 'codex',
    model: null,
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: null,
    service_tier: null,
    active_channel: 'web',
    status: 'new',
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
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('subtasksFor', () => {
  it('returns [] when nothing matches the task', () => {
    expect(subtasksFor([
      session({ id: 'coding', type: 'coding', task_id: 'task-unit' }),
      session({ id: 'other', task_id: 'task-other' }),
    ], 'task-unit')).toEqual([]);
  });

  it('keeps open pinned rows above newer unpinned rows, then completed', () => {
    const rows = [
      session({ id: 'done', completed_at: '2026-08-10T00:00:00.000Z', created_at: '2026-08-09T00:00:00.000Z' }),
      session({ id: 'new-open', created_at: '2026-08-08T00:00:00.000Z' }),
      session({ id: 'old-open', created_at: '2026-08-07T00:00:00.000Z' }),
      session({ id: 'pin', pinned_at: '2026-08-06T12:00:00.000Z', created_at: '2026-08-06T00:00:00.000Z' }),
    ];
    expect(subtasksFor(rows, 'task-unit').map(row => row.id)).toEqual(['pin', 'new-open', 'old-open', 'done']);
  });
});
