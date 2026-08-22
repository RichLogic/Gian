import { describe, expect, it } from 'vitest';
import type { SystemConfig, Task, Workspace } from '@gian/shared';
import { applySettingsOverlays } from '../src/operations/settings.js';
import { applyTaskOverlays } from '../src/operations/task.js';
import { applyWorkspaceOrderOverlay, applyWorkspaceOverlays } from '../src/operations/workspace.js';
import type { OptimisticOverlay } from '../src/operations/types.js';

function overlay(entityFieldKey: string, value: unknown): OptimisticOverlay {
  return { entityFieldKey, operationId: 'op-1', value, previous: null };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Canonical',
    description: null,
    status: 'open',
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    pinned_at: null,
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Repo',
    path: '/tmp/repo',
    sort_order: 0,
    hidden: 0,
    pinned: 0,
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('applyTaskOverlays', () => {
  it('overlays allowed fields and ignores others', () => {
    const canonical = task();
    const merged = applyTaskOverlays(canonical, [
      overlay('task:task-1:name', 'Renamed'),
      overlay('task:task-1:description', 'nope'),
    ]);
    expect(merged).not.toBe(canonical);
    expect(merged.name).toBe('Renamed');
    expect(merged.description).toBeNull();
  });

  it('returns the same reference when nothing applies', () => {
    const canonical = task();
    expect(applyTaskOverlays(canonical, [overlay('task:other:name', 'x')])).toBe(canonical);
  });
});

describe('applyWorkspaceOverlays / applyWorkspaceOrderOverlay', () => {
  it('overlays workspace fields', () => {
    const canonical = workspace();
    const merged = applyWorkspaceOverlays(canonical, [
      overlay('workspace:ws-1:hidden', 1),
    ]);
    expect(merged.hidden).toBe(1);
    expect(canonical.hidden).toBe(0);
  });

  it('reorders by overlay ids and keeps leftovers at the end', () => {
    const a = workspace({ id: 'a' });
    const b = workspace({ id: 'b' });
    const c = workspace({ id: 'c' });
    const list = [a, b, c];
    const reordered = applyWorkspaceOrderOverlay(list, ['c', 'a']);
    expect(reordered.map(row => row.id)).toEqual(['c', 'a', 'b']);
    expect(applyWorkspaceOrderOverlay(list, ['a', 'b', 'c'])).toBe(list);
  });
});

describe('applySettingsOverlays', () => {
  it('returns null unchanged and overlays matching settings fields', () => {
    expect(applySettingsOverlays(null, [overlay('settings:system:theme', 'dark')])).toBeNull();
    const config = { theme: 'light', locale: 'en' } as SystemConfig;
    const merged = applySettingsOverlays(config, [
      overlay('settings:system:theme', 'dark'),
    ]);
    expect(merged).not.toBe(config);
    expect(merged?.theme).toBe('dark');
  });
});
