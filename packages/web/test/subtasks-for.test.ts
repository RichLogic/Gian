import { describe, expect, it } from 'vitest';
import type { Session } from '@gian/shared';
import { reorderableSubtasks, subtasksFor } from '../src/views/TasksView.js';

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

  // 2026-09-06 owner call: no pin concept in the Tasks rail — a pinned row
  // sorts by the same rules as everything else; open rows follow creation
  // order (created_at ASC), completed sink to the bottom.
  it('orders open rows by created_at ASC (pins have no effect), then completed', () => {
    const rows = [
      session({ id: 'done', completed_at: '2026-08-10T00:00:00.000Z', created_at: '2026-08-09T00:00:00.000Z' }),
      session({ id: 'old-open', created_at: '2026-08-07T00:00:00.000Z' }),
      session({ id: 'pin', pinned_at: '2026-08-06T12:00:00.000Z', created_at: '2026-08-06T00:00:00.000Z' }),
      session({ id: 'new-open', created_at: '2026-08-08T00:00:00.000Z' }),
    ];
    expect(subtasksFor(rows, 'task-unit').map(row => row.id)).toEqual(['pin', 'old-open', 'new-open', 'done']);
  });

  // Manual drag order (migration 067): task_order wins among open rows;
  // NULL (never dragged) keeps created_at ASC ABOVE the manual range.
  it('applies task_order within open rows, NULL first by created_at ASC', () => {
    const rows = [
      session({ id: 'dragged-2', task_order: 2, created_at: '2026-08-08T00:00:00.000Z' }),
      session({ id: 'older-auto', created_at: '2026-08-07T00:00:00.000Z' }),
      session({ id: 'dragged-1', task_order: 1, created_at: '2026-08-06T00:00:00.000Z' }),
      session({ id: 'fresh-auto', created_at: '2026-08-09T00:00:00.000Z' }),
    ];
    expect(subtasksFor(rows, 'task-unit').map(row => row.id))
      .toEqual(['older-auto', 'fresh-auto', 'dragged-1', 'dragged-2']);
  });

  it('completed rows ignore task_order and stay at the bottom', () => {
    const rows = [
      session({ id: 'done', completed_at: '2026-08-09T00:00:00.000Z', task_order: 1 }),
      session({ id: 'dragged', task_order: 2 }),
      session({ id: 'auto' }),
    ];
    expect(subtasksFor(rows, 'task-unit').map(row => row.id)).toEqual(['auto', 'dragged', 'done']);
  });
});

describe('reorderableSubtasks', () => {
  it('covers exactly the open rows, in display order (pinned included)', () => {
    const rows = [
      session({ id: 'done', completed_at: '2026-08-09T00:00:00.000Z' }),
      session({ id: 'open-2', created_at: '2026-08-07T00:00:00.000Z' }),
      session({ id: 'pin', pinned_at: '2026-08-08T00:00:00.000Z', created_at: '2026-08-06T00:00:00.000Z' }),
      session({ id: 'open-1', created_at: '2026-08-08T00:00:00.000Z' }),
    ];
    expect(reorderableSubtasks(rows, 'task-unit').map(row => row.id)).toEqual(['pin', 'open-2', 'open-1']);
  });
});
