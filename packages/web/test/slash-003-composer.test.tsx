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
import { typeInlineComposer } from './inline-composer-test-utils.js';
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

    typeInlineComposer(textbox, '/');
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
    expect(textbox).toHaveTextContent('');
    await waitFor(() => expect(document.querySelector('.cmp-slash-pop')).toBeNull());

    typeInlineComposer(textbox, '/');
    await screen.findByText('/clear');
    await user.keyboard('{Escape}');
    expect(document.querySelector('.cmp-slash-pop')).toBeNull();
    expect(textbox).toHaveTextContent('/');
  });

  it('keeps Escape dismissed when discovery finishes until the input changes', async () => {
    let resolveDiscovery!: (commands: SlashCommand[]) => void;
    apiMocks.loadSlashCommands.mockImplementationOnce(
      () => new Promise<SlashCommand[]>(resolve => { resolveDiscovery = resolve; }),
    );
    const user = userEvent.setup();
    renderComposer(makeSession('codex', 'workspace-delayed'));
    const textbox = screen.getByRole('textbox');

    typeInlineComposer(textbox, '/');
    await waitFor(() => expect(document.querySelector('.cmp-slash-pop')).not.toBeNull());
    await user.keyboard('{Escape}');
    expect(document.querySelector('.cmp-slash-pop')).toBeNull();

    resolveDiscovery(codexCommands);
    await waitFor(() => {
      expect(getSlashCached('codex', 'workspace-delayed')).toEqual(codexCommands);
    });
    expect(document.querySelector('.cmp-slash-pop')).toBeNull();

    typeInlineComposer(textbox, 'p');
    expect(await screen.findByText((_text, element) => element?.classList.contains('cmp-slash-cmd') === true
      && element.textContent === '/project-check')).toBeVisible();
  });

  it('closes an open popup and never dispatches a typed skill after hard-disable', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    typeInlineComposer(textbox, '/p');
    expect(await screen.findByText((_text, element) => element?.classList.contains('cmp-slash-cmd') === true
      && element.textContent === '/project-check')).toBeVisible();

    callbacks.rerenderGate({ disabled: true, disabledSubmitBehavior: 'block' });

    await waitFor(() => expect(document.querySelector('.cmp-slash-pop')).toBeNull());
    expect(textbox).toHaveAttribute('contenteditable', 'false');
    expect(callbacks.onSendSkill).not.toHaveBeenCalled();
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(callbacks.onQueueAdd).not.toHaveBeenCalled();
  });
});

describe('SLASH-003 unified trigger-menu anatomy', () => {
  beforeEach(() => {
    clearSlashCache();
    localStorage.clear();
    apiMocks.loadSlashCommands.mockReset().mockResolvedValue(codexCommands);
    apiMocks.loadSessionSlashCommands.mockReset().mockResolvedValue([]);
  });

  function slashRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('.cmp-slash-pop .cmp-file-row')];
  }

  function rowFor(name: string): HTMLElement {
    const row = slashRows().find(candidate => candidate.textContent?.includes(name));
    if (!row) throw new Error(`no slash row for ${name}`);
    return row;
  }

  it('renders icon + name + subtitle rows under source group headers with a hint footer', async () => {
    renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    typeInlineComposer(textbox, '/');
    await screen.findByText('/clear');

    const sections = [...document.querySelectorAll('.cmp-slash-pop .cmp-slash-section')]
      .map(el => el.textContent);
    expect(sections).toEqual(['BUILTIN', 'REPO (.claude/commands)', 'USER (~/.claude/commands)']);

    const rows = slashRows();
    expect(rows).toHaveLength(3);
    const clear = rowFor('/clear');
    expect(clear.querySelector('.cmp-slash-icon svg')).not.toBeNull();
    expect(clear.querySelector('.cmp-slash-cmd')!.textContent).toBe('/clear');
    expect(clear.querySelector('.cmp-slash-desc')!.textContent).toBe('Clear');
    expect(clear).toHaveAttribute('role', 'option');
    expect(clear).toHaveAttribute('aria-selected', 'true');

    expect(document.querySelector('.cmp-slash-pop .cmp-file-hint')!.textContent).toContain('↑↓');
  });

  it('bolds the matched substring in filtered results', async () => {
    renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    typeInlineComposer(textbox, '/pro');
    await waitFor(() => expect(document.querySelector('.cmp-slash-cmd strong')).not.toBeNull());

    const strong = document.querySelector('.cmp-slash-cmd strong')!;
    expect(strong.textContent).toBe('/pro');
    expect(strong.closest('.cmp-slash-cmd')!.textContent).toBe('/project-check');
    expect(slashRows()).toHaveLength(1);
  });

  it('wraps arrow navigation around both ends and accepts with Tab', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    typeInlineComposer(textbox, '/');
    await screen.findByText('/clear');
    expect(rowFor('/clear')).toHaveClass('active');

    await user.keyboard('{ArrowUp}');
    expect(rowFor('/user-check')).toHaveClass('active');
    await user.keyboard('{ArrowDown}');
    expect(rowFor('/clear')).toHaveClass('active');

    await user.keyboard('{ArrowDown}{Tab}');
    expect(callbacks.onSendSkill).toHaveBeenCalledWith(
      'project-check',
      '/repo/.codex/skills/project-check/SKILL.md',
    );
    await waitFor(() => expect(document.querySelector('.cmp-slash-pop')).toBeNull());
  });

  it('keeps focus in the editor when Tab is pressed with no row to accept', async () => {
    const user = userEvent.setup();
    renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    typeInlineComposer(textbox, '/');
    await screen.findByText('/clear');
    await user.keyboard('{Tab}');

    // The first row was accepted as text; the caret stays in the editor and
    // focus never moved to another element.
    expect(textbox).toHaveFocus();
  });

  it('inserts a text-path command with a trailing space', async () => {
    const user = userEvent.setup();
    renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    typeInlineComposer(textbox, '/');
    await screen.findByText('/clear');
    await user.keyboard('{Enter}');

    expect(textbox.textContent).toBe('/clear ');
    await waitFor(() => expect(document.querySelector('.cmp-slash-pop')).toBeNull());
  });

  it('shows a quiet empty state when no commands are available', async () => {
    apiMocks.loadSlashCommands.mockResolvedValue([]);
    renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    typeInlineComposer(textbox, '/');
    await waitFor(() => {
      expect(document.querySelector('.cmp-slash-pop .cmp-file-empty')?.textContent)
        .toBe('No matching commands');
    });
    expect(slashRows()).toHaveLength(0);
    expect(document.querySelector('.cmp-slash-pop .cmp-file-hint')!.textContent).toContain('↑↓');
  });
});

describe('SLASH-003 disabled entries and inventory join id', () => {
  const disabledSkill: SlashCommand = {
    name: '/off-skill',
    description: 'Configured but disabled',
    source: 'project',
    filePath: '/repo/.codex/skills/off-skill',
    argHints: [],
    disabled: true,
    customizationId: 'ci1_0123456789abcdef0123456789abcdef',
  };
  const commandsWithDisabled: SlashCommand[] = [...codexCommands, disabledSkill];

  beforeEach(() => {
    clearSlashCache();
    localStorage.clear();
    apiMocks.loadSlashCommands.mockReset().mockResolvedValue(commandsWithDisabled);
    apiMocks.loadSessionSlashCommands.mockReset().mockResolvedValue([]);
  });

  function slashRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('.cmp-slash-pop .cmp-file-row')];
  }

  function rowFor(name: string): HTMLElement {
    const row = slashRows().find(candidate => candidate.textContent?.includes(name));
    if (!row) throw new Error(`no slash row for ${name}`);
    return row;
  }

  it('carries disabled and customizationId through the slash cache', async () => {
    const commands = await fetchSlashCached('codex', 'workspace-join');
    const row = commands.find(command => command.name === '/off-skill');
    expect(row?.disabled).toBe(true);
    expect(row?.customizationId).toBe('ci1_0123456789abcdef0123456789abcdef');
    expect(getSlashCached('codex', 'workspace-join')?.find(command => command.name === '/off-skill')
      ?.customizationId).toBe('ci1_0123456789abcdef0123456789abcdef');
    const enabled = commands.find(command => command.name === '/clear');
    expect(enabled?.disabled).toBeUndefined();
    expect(enabled?.customizationId).toBeUndefined();
  });

  it('renders disabled rows dimmed with an aria flag and a suffix, and never dispatches them', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('codex'));
    const textbox = screen.getByRole('textbox');

    typeInlineComposer(textbox, '/');
    await screen.findByText('/off-skill');

    const row = rowFor('/off-skill');
    expect(row).toHaveClass('disabled');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row.querySelector('.cmp-slash-desc')!.textContent)
      .toBe('Configured but disabled · disabled');

    // Pointer pick is refused: no dispatch, no text change, popover stays.
    await user.click(row);
    expect(callbacks.onSendSkill).not.toHaveBeenCalled();
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(textbox).toHaveTextContent('/');
    expect(document.querySelector('.cmp-slash-pop')).not.toBeNull();

    // Pointer hover already selected this row; keyboard acceptance must
    // still refuse it without moving to a different command first.
    expect(row).toHaveClass('active');
    await user.keyboard('{Enter}');
    expect(callbacks.onSendSkill).not.toHaveBeenCalled();
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(textbox).toHaveTextContent('/');
    expect(document.querySelector('.cmp-slash-pop')).not.toBeNull();
    await user.keyboard('{Tab}');
    expect(textbox).toHaveTextContent('/');
    expect(document.querySelector('.cmp-slash-pop')).not.toBeNull();

    // An enabled neighbor still dispatches normally.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(callbacks.onSendSkill).toHaveBeenCalledWith(
      'user-check',
      '/users/me/.codex/skills/user-check/SKILL.md',
    );
  });
});
