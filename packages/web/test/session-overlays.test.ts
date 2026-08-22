import { describe, expect, it } from 'vitest';
import type { Session } from '@gian/shared';

import { applySessionOverlays, sessionEntityKey } from '../src/operations/session.js';
import type { OptimisticOverlay } from '../src/operations/types.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Canonical',
    type: 'coding',
    task_id: null,
    workspace_id: 'workspace-1',
    executor: 'codex',
    model: 'gpt-5',
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: null,
    service_tier: null,
    active_channel: 'web',
    status: 'running',
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
    ...overrides,
  };
}

function overlay(entityFieldKey: string, value: unknown): OptimisticOverlay {
  return { entityFieldKey, operationId: 'op-1', value, previous: null };
}

describe('sessionEntityKey', () => {
  it('is session:<id>', () => {
    expect(sessionEntityKey('abc-123')).toBe('session:abc-123');
  });
});

describe('applySessionOverlays', () => {
  it('overlays same-name fields on a copy', () => {
    const canonical = session();
    const merged = applySessionOverlays(canonical, [
      overlay('session:session-1:name', 'Renamed'),
      overlay('session:session-1:unread', 1),
    ]);
    expect(merged).not.toBe(canonical);
    expect(merged.name).toBe('Renamed');
    expect(merged.unread).toBe(1);
    expect(canonical.name).toBe('Canonical');
    expect(canonical.unread).toBe(0);
  });

  it('ignores fields outside SESSION_OVERLAY_FIELDS', () => {
    const canonical = session();
    const merged = applySessionOverlays(canonical, [
      overlay('session:session-1:status', 'error'),
      overlay('session:session-1:workspace_id', 'other'),
    ]);
    expect(merged).toBe(canonical);
    expect(merged.status).toBe('running');
  });

  it('returns the original object when no overlay hits', () => {
    const canonical = session();
    const other = applySessionOverlays(canonical, [
      overlay('session:other-id:name', 'Nope'),
    ]);
    expect(other).toBe(canonical);
  });
});
