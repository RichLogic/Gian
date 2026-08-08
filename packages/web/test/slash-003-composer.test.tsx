import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Executor, Session, SlashCommand } from '@gian/shared';

const apiMocks = vi.hoisted(() => ({
  loadSlashCommands: vi.fn(),
  loadSessionSlashCommands: vi.fn(),
}));

vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn().mockResolvedValue([]),
  loadProxyCapabilities: vi.fn().mockResolvedValue({ modes: [] }),
  loadSlashCommands: apiMocks.loadSlashCommands,
  loadSessionSlashCommands: apiMocks.loadSessionSlashCommands,
  loadNativeConfig: vi.fn().mockResolvedValue(null),
}));

import { Composer } from '../src/components/Composer.js';
import {
  clearSlashCache,
  fetchSlashCached,
  getSlashCached,
  invalidateSlashCacheForWorkspace,
} from '../src/components/composer/capabilities.js';
import { LocaleProvider } from '../src/i18n/index.js';

function makeSession(executor: Executor, workspaceId = 'workspace-1'): Session {
  return {
    id: `session-${executor}-${workspaceId}`,
    name: executor,
    type: 'coding',
    workspace_id: workspaceId,
    executor,
    model: null,
    approval_mode: executor === 'kimi' ? null : 'ask',
    thinking_effort: null,
    active_channel: 'web',
    status: 'done',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: `native-${executor}`,
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    created_at: '2026-08-08T00:00:00.000Z',
    updated_at: '2026-08-08T00:00:00.000Z',
  } as Session;
}

function renderComposer(
  session: Session,
  gate: { disabled?: boolean; disabledSubmitBehavior?: 'queue' | 'block' } = {},
) {
  const callbacks = {
    onSend: vi.fn(),
    onSendSkill: vi.fn(),
    onStop: vi.fn(),
    onQueueAdd: vi.fn(),
    onSetMode: vi.fn(),
    onSetModel: vi.fn(),
    onSetEffort: vi.fn(),
    onSetNativeConfig: vi.fn(),
    onSetServiceTier: vi.fn(),
  };
  const ui = (current: typeof gate) => (
    <LocaleProvider locale="en">
      <Composer
        session={session}
        executor={session.executor}
        workspaceId={session.workspace_id}
        disabled={current.disabled ?? false}
        disabledSubmitBehavior={current.disabledSubmitBehavior}
        running={false}
        {...callbacks}
      />
    </LocaleProvider>
  );
  const rendered = render(ui(gate));
  return {
    ...callbacks,
    rerenderGate: (next: typeof gate) => rendered.rerender(ui({ ...gate, ...next })),
  };
}

const codexCommands: SlashCommand[] = [
  { name: '/clear', description: 'Clear', source: 'builtin', argHints: [] },
  {
    name: '/project-check',
    description: 'Project check',
    source: 'project',
    filePath: '/repo/.codex/skills/project-check/SKILL.md',
    argHints: [],
  },
  {
    name: '/user-check',
    description: 'User check',
    source: 'user',
    filePath: '/users/me/.codex/skills/user-check/SKILL.md',
    argHints: [],
  },
];

describe('SLASH-003 command cache', () => {
  beforeEach(() => {
    clearSlashCache();
    localStorage.clear();
    apiMocks.loadSlashCommands.mockReset();
    apiMocks.loadSessionSlashCommands.mockReset().mockResolvedValue([]);
  });

  it('isolates executor/workspace keys, coalesces a key, and refetches invalidated workspace entries', async () => {
    apiMocks.loadSlashCommands.mockImplementation(
      async (executor: 'claude' | 'codex', workspaceId?: string) => [{
        name: `/${executor}-${workspaceId ?? 'global'}`,
        description: 'scoped',
        source: 'project',
      } satisfies SlashCommand],
    );

    const [first, coalesced] = await Promise.all([
      fetchSlashCached('codex', 'workspace-a'),
      fetchSlashCached('codex', 'workspace-a'),
    ]);
    expect(first).toEqual(coalesced);
    expect(apiMocks.loadSlashCommands).toHaveBeenCalledTimes(1);

    await fetchSlashCached('codex', 'workspace-b');
    await fetchSlashCached('claude', 'workspace-a');
    expect(apiMocks.loadSlashCommands).toHaveBeenCalledTimes(3);
    expect(getSlashCached('codex', 'workspace-a')?.[0]?.name).toBe('/codex-workspace-a');
    expect(getSlashCached('codex', 'workspace-b')?.[0]?.name).toBe('/codex-workspace-b');
    expect(getSlashCached('claude', 'workspace-a')?.[0]?.name).toBe('/claude-workspace-a');

    invalidateSlashCacheForWorkspace('workspace-a');
    expect(getSlashCached('codex', 'workspace-a')).toBeUndefined();
    expect(getSlashCached('claude', 'workspace-a')).toBeUndefined();
    expect(getSlashCached('codex', 'workspace-b')).toBeDefined();

    await fetchSlashCached('codex', 'workspace-a');
    await fetchSlashCached('claude', 'workspace-a');
    expect(apiMocks.loadSlashCommands).toHaveBeenCalledTimes(5);
  });

  it('does not poison the cache after a failed discovery', async () => {
    apiMocks.loadSlashCommands
      .mockRejectedValueOnce(new Error('temporary discovery failure'))
      .mockResolvedValueOnce(codexCommands);

    await expect(fetchSlashCached('codex', 'workspace-a')).rejects.toThrow('temporary discovery failure');
    await expect(fetchSlashCached('codex', 'workspace-a')).resolves.toEqual(codexCommands);
    expect(apiMocks.loadSlashCommands).toHaveBeenCalledTimes(2);
  });

  it('does not let an invalidated in-flight request repopulate the cache', async () => {
    let resolveStale!: (commands: SlashCommand[]) => void;
    let resolveFresh!: (commands: SlashCommand[]) => void;
    apiMocks.loadSlashCommands
      .mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveFresh = resolve; }));

    const staleRequest = fetchSlashCached('codex', 'workspace-a');
    invalidateSlashCacheForWorkspace('workspace-a');
    const freshRequest = fetchSlashCached('codex', 'workspace-a');

    const staleCommands = [{ name: '/stale', description: 'stale', source: 'project' }] satisfies SlashCommand[];
    resolveStale(staleCommands);
    await expect(staleRequest).resolves.toEqual(staleCommands);
    expect(getSlashCached('codex', 'workspace-a')).toBeUndefined();

    resolveFresh(codexCommands);
    await expect(freshRequest).resolves.toEqual(codexCommands);
    expect(getSlashCached('codex', 'workspace-a')).toEqual(codexCommands);
  });
});

describe('SLASH-003 Composer keyboard behavior', () => {
  beforeEach(() => {
    clearSlashCache();
    localStorage.clear();
    apiMocks.loadSlashCommands.mockReset().mockResolvedValue(codexCommands);
    apiMocks.loadSessionSlashCommands.mockReset().mockResolvedValue([]);
  });

  it('moves down/up, Enter sends a typed Codex project skill, and Escape dismisses the popup', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    await user.type(textbox, '/');
    const clear = (await screen.findByText('/clear')).closest('button')!;
    const project = screen.getByText('/project-check').closest('button')!;
    expect(clear).toHaveClass('active');

    await user.keyboard('{ArrowDown}');
    expect(project).toHaveClass('active');
    await user.keyboard('{ArrowUp}');
    expect(clear).toHaveClass('active');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(callbacks.onSendSkill).toHaveBeenCalledWith(
      'project-check',
      '/repo/.codex/skills/project-check/SKILL.md',
    );
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('');
    await waitFor(() => expect(document.querySelector('.cmp-slash-pop')).toBeNull());

    await user.type(textbox, '/');
    await screen.findByText('/clear');
    await user.keyboard('{Escape}');
    expect(document.querySelector('.cmp-slash-pop')).toBeNull();
    expect(textbox).toHaveValue('/');
  });

  it('keeps Escape dismissed when discovery finishes until the input changes', async () => {
    let resolveDiscovery!: (commands: SlashCommand[]) => void;
    apiMocks.loadSlashCommands.mockImplementationOnce(
      () => new Promise<SlashCommand[]>(resolve => { resolveDiscovery = resolve; }),
    );
    const user = userEvent.setup();
    renderComposer(makeSession('codex', 'workspace-delayed'));
    const textbox = screen.getByRole('textbox');

    await user.type(textbox, '/');
    await waitFor(() => expect(document.querySelector('.cmp-slash-pop')).not.toBeNull());
    await user.keyboard('{Escape}');
    expect(document.querySelector('.cmp-slash-pop')).toBeNull();

    resolveDiscovery(codexCommands);
    await waitFor(() => {
      expect(getSlashCached('codex', 'workspace-delayed')).toEqual(codexCommands);
    });
    expect(document.querySelector('.cmp-slash-pop')).toBeNull();

    await user.type(textbox, 'p');
    expect(await screen.findByText('/project-check')).toBeVisible();
  });

  it('closes an open popup and never dispatches a typed skill after hard-disable', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    await user.type(textbox, '/p');
    expect(await screen.findByText('/project-check')).toBeVisible();

    callbacks.rerenderGate({ disabled: true, disabledSubmitBehavior: 'block' });

    await waitFor(() => expect(document.querySelector('.cmp-slash-pop')).toBeNull());
    expect(textbox).toBeDisabled();
    expect(callbacks.onSendSkill).not.toHaveBeenCalled();
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(callbacks.onQueueAdd).not.toHaveBeenCalled();
  });
});
