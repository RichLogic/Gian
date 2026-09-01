// Coverage for the Tasks rail task ordering (migration 067 manual drag
// order) — packages/web/src/views/TasksView.tsx `compareTasks`.

import { describe, expect, it } from 'vitest';
import type { Task } from '@gian/shared';
import { compareTasks } from '../src/views/TasksView.js';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    description: null,
    status: 'open',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    pinned_at: null,
    ...overrides,
  };
}

describe('compareTasks: manual drag order (migration 067)', () => {
  it('manual sort_order wins; NULL (never dragged) keeps created_at DESC above the manual range', () => {
    const dragged1 = task('a', { sort_order: 1, created_at: '2026-08-01T00:00:00.000Z' });
    const dragged2 = task('b', { sort_order: 2, created_at: '2026-08-03T00:00:00.000Z' });
    const fresh = task('c', { created_at: '2026-08-04T00:00:00.000Z' });
    const older = task('d', { created_at: '2026-08-02T00:00:00.000Z' });
    expect([dragged2, older, dragged1, fresh].sort(compareTasks).map(t => t.id))
      .toEqual(['c', 'd', 'a', 'b']);
  });

  it('tasks predating the migration (no sort_order field) keep pure created_at DESC', () => {
    const a = task('a', { created_at: '2026-08-01T00:00:00.000Z' });
    const b = task('b', { created_at: '2026-08-02T00:00:00.000Z' });
    expect([a, b].sort(compareTasks).map(t => t.id)).toEqual(['b', 'a']);
  });
});
