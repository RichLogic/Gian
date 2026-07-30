import { describe, it, expect } from 'vitest';
import type { Executor, Session, Workspace } from '@gian/shared';
import { groupSidechatCandidates } from '../src/components/SidechatPicker.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    name: 'session one',
    type: 'coding',
    workspace_id: 'ws-1',
    executor: 'claude' as Executor,
    model: 'sonnet',
    approval_mode: 'ask',
    thinking_effort: 'high',
    turns: 1,
    active_channel: 'web',
    status: 'idle',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: 'native-1',
    runtime_mode: 'structured',
    service_tier: null,
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function makeWs(id: string, name: string): Workspace {
  return { id, name, path: `/tmp/${name}`, hidden: 0, sort_order: 0 } as Workspace;
}

const WS = [makeWs('ws-1', 'Alpha'), makeWs('ws-2', 'Beta')];

describe('groupSidechatCandidates', () => {
  it('groups sessions by workspace in workspace order, newest first', () => {
    const sessions = [
      makeSession({ id: 'a', workspace_id: 'ws-2', updated_at: '2026-07-01T00:00:00.000Z' }),
      makeSession({ id: 'b', workspace_id: 'ws-1', updated_at: '2026-07-02T00:00:00.000Z' }),
      makeSession({ id: 'c', workspace_id: 'ws-1', updated_at: '2026-07-03T00:00:00.000Z' }),
    ];
    const groups = groupSidechatCandidates(sessions, WS, new Set());
    expect(groups.map(g => g.wsId)).toEqual(['ws-1', 'ws-2']);
    expect(groups[0]!.wsName).toBe('Alpha');
    expect(groups[0]!.rows.map(r => r.session.id)).toEqual(['c', 'b']);
    expect(groups[1]!.rows.map(r => r.session.id)).toEqual(['a']);
  });

  it('excludes manager sessions and archived sessions', () => {
    const sessions = [
      makeSession({ id: 'keep' }),
      makeSession({ id: 'mgr', type: 'manager' }),
      makeSession({ id: 'arch', archived: 1 }),
    ];
    const groups = groupSidechatCandidates(sessions, WS, new Set());
    const ids = groups.flatMap(g => g.rows.map(r => r.session.id));
    expect(ids).toEqual(['keep']);
  });

  it('marks excluded (already-open) sessions disabled but keeps them listed', () => {
    const sessions = [makeSession({ id: 'open' }), makeSession({ id: 'free' })];
    const groups = groupSidechatCandidates(sessions, WS, new Set(['open']));
    const rows = groups[0]!.rows;
    expect(rows.find(r => r.session.id === 'open')?.disabled).toBe(true);
    expect(rows.find(r => r.session.id === 'free')?.disabled).toBe(false);
  });

  it('appends orphan workspace ids after the known workspaces', () => {
    const sessions = [
      makeSession({ id: 'a', workspace_id: 'ws-2' }),
      makeSession({ id: 'b', workspace_id: 'ws-orphan' }),
    ];
    const groups = groupSidechatCandidates(sessions, WS, new Set());
    expect(groups.map(g => g.wsId)).toEqual(['ws-2', 'ws-orphan']);
    expect(groups[1]!.wsName).toBe('ws-orphan');
  });
});
