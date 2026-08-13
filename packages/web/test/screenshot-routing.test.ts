import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GianScreenshotCapture, Session } from '@gian/shared';
import {
  loadNewSessionScreenshotBlob,
  readNewSessionScreenshotAttachments,
} from '../src/screenshot-drafts.js';
import { routeScreenshotCapture } from '../src/screenshot-routing.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Locked target',
    type: 'coding',
    task_id: null,
    workspace_id: 'workspace-1',
    executor: 'codex',
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
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

function capture(
  target: GianScreenshotCapture['target'] = {
    kind: 'session',
    sessionId: 'session-1',
    label: 'Locked target',
  },
): GianScreenshotCapture {
  return {
    id: `capture-${Math.random()}`,
    target,
    filename: 'screenshot.png',
    mime: 'image/png',
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };
}

describe('screenshot result routing', () => {
  beforeEach(() => localStorage.clear());

  it('uploads and injects only into the Session snapshotted at capture start', async () => {
    const locked = session();
    const upload = vi.fn().mockResolvedValue({
      path: '/attachments/screenshot.png',
      name: 'screenshot.png',
      mime: 'image/png',
      size: 4,
    });
    const inject = vi.fn();
    const onSelectSession = vi.fn();

    const result = await routeScreenshotCapture(capture(), {
      findSession: id => id === locked.id ? locked : null,
      upload,
      inject,
      onSelectSession,
    });

    expect(result).toEqual({ ok: true, kind: 'session' });
    expect(upload).toHaveBeenCalledWith(
      locked.id,
      expect.objectContaining({ type: 'image/png', size: 4 }),
      'screenshot.png',
    );
    expect(inject).toHaveBeenCalledWith(locked.id, expect.objectContaining({
      path: '/attachments/screenshot.png',
    }));
    expect(onSelectSession).toHaveBeenCalledWith(locked);
  });

  it('does not redirect when the locked Session disappears during upload', async () => {
    const locked = session();
    let lookup = 0;
    const inject = vi.fn();
    const onSelectSession = vi.fn();
    const result = await routeScreenshotCapture(capture(), {
      findSession: () => (++lookup === 1 ? locked : null),
      upload: vi.fn().mockResolvedValue({
        path: '/attachments/screenshot.png', name: 'screenshot.png', mime: 'image/png', size: 4,
      }),
      inject,
      onSelectSession,
    });

    expect(result).toEqual({ ok: false, reason: 'missing-target' });
    expect(inject).not.toHaveBeenCalled();
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('persists one independent screenshot Blob per new-session scope', async () => {
    const scope = { kind: 'task' as const, id: 'task-1' };
    const result = await routeScreenshotCapture(capture({
      kind: 'new-session',
      scope,
      label: 'Task one',
    }), {
      findSession: () => null,
      upload: vi.fn(),
      onSelectSession: vi.fn(),
    });

    expect(result).toEqual({ ok: true, kind: 'new-session' });
    const metadata = readNewSessionScreenshotAttachments(scope);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({ name: 'screenshot.png', mime: 'image/png', size: 4 });
    await expect(loadNewSessionScreenshotBlob(scope, metadata[0]!.id))
      .resolves.toMatchObject({ type: 'image/png', size: 4 });
    expect(readNewSessionScreenshotAttachments({ kind: 'task', id: 'task-2' })).toEqual([]);
  });
});
