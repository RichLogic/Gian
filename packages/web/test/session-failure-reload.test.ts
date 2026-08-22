import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@gian/shared';

import { reloadFailedSessionMetadata } from '../src/controllers/session-failure-reload.js';
import type { OperationName } from '../src/operations/types.js';

function session(): Session {
  return {
    id: 'session-1',
    name: 'Reloaded',
    type: 'coding',
    task_id: null,
    workspace_id: 'workspace-1',
    executor: 'claude',
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

describe('reloadFailedSessionMetadata', () => {
  it('reloads only SESSION_METADATA_OPERATIONS and applies the loader array', async () => {
    const rows = [session()];
    const loader = vi.fn(async () => rows);
    const apply = vi.fn();
    const names: OperationName[] = [
      'session.rename',
      'session.archive',
      'session.setModel',
    ];
    for (const name of names) {
      loader.mockClear();
      apply.mockClear();
      await expect(reloadFailedSessionMetadata({ name }, apply, loader)).resolves.toBe(true);
      expect(loader).toHaveBeenCalledOnce();
      expect(apply).toHaveBeenCalledOnce();
      expect(apply).toHaveBeenCalledWith(rows);
    }
  });

  it('returns false and skips the loader for other operations', async () => {
    const loader = vi.fn(async () => [session()]);
    const apply = vi.fn();
    for (const name of ['session.create', 'session.delete', 'message.send', 'task.rename'] as const) {
      loader.mockClear();
      apply.mockClear();
      await expect(reloadFailedSessionMetadata({ name }, apply, loader)).resolves.toBe(false);
      expect(loader).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    }
  });
});
