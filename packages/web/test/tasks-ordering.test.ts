// Coverage for the Tasks rail task ordering (migration 067 manual drag
// order) — packages/web/src/views/TasksView.tsx `compareTasks`, plus the
// 2026-09-15 owner ordering for the Done group and the 未分配 session group
// (both updated_at DESC).

import { describe, expect, it } from 'vitest';
import type { Session, Task } from '@gian/shared';
import {
  compareSessionsByUpdatedDesc,
  compareTasks,
  compareTasksByUpdatedDesc,
} from '../src/views/TasksView.js';

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

describe('compareTasksByUpdatedDesc: Done group (2026-09-15 owner)', () => {
  it('orders by updated_at DESC, ignoring sort_order and created_at', () => {
    const staleManual = task('a', { sort_order: 1, updated_at: '2026-08-01T00:00:00.000Z' });
    const recent = task('b', { updated_at: '2026-08-04T00:00:00.000Z' });
    const middle = task('c', { created_at: '2026-08-05T00:00:00.000Z', updated_at: '2026-08-03T00:00:00.000Z' });
    expect([staleManual, recent, middle].sort(compareTasksByUpdatedDesc).map(t => t.id))
      .toEqual(['b', 'c', 'a']);
  });
});

describe('compareSessionsByUpdatedDesc: 未分配 group (2026-09-15 owner)', () => {
  it('orders by updated_at DESC, ignoring created_at', () => {
    const session = (id: string, created: string, updated: string) => ({
      id,
      created_at: created,
      updated_at: updated,
    } as Session);
    const oldestCreated = session('a', '2026-08-05T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    const freshest = session('b', '2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z');
    const middle = session('c', '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z');
    expect([oldestCreated, freshest, middle].sort(compareSessionsByUpdatedDesc).map(s => s.id))
      .toEqual(['b', 'c', 'a']);
  });
});
