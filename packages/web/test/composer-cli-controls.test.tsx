import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Executor, NativeConfigOption, Session } from '@gian/shared';

import { Composer } from '../src/components/Composer.js';
import { LocaleProvider } from '../src/i18n/index.js';

vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn(async (executor: 'claude' | 'codex') => executor === 'codex'
    ? [{
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        description: '',
        hidden: false,
        isDefault: true,
        defaultThinking: 'ultra',
        supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      }]
    : [{
        id: 'sonnet',
        model: 'sonnet',
        displayName: 'Sonnet',
        description: '',
        hidden: false,
        isDefault: true,
        defaultEffort: 'high',
        supportedEfforts: ['low', 'medium', 'high'],
      }]),
  loadSlashCommands: vi.fn().mockResolvedValue([{
    name: '/review',
    description: 'Review the current changes',
    source: 'builtin',
  }]),
  loadSessionSlashCommands: vi.fn().mockResolvedValue([{
    name: '/review',
    description: 'Review the current changes',
    source: 'builtin',
  }]),
  loadNativeConfig: vi.fn().mockResolvedValue(null),
}));

function makeSession(executor: Executor, overrides: Partial<Session> = {}): Session {
  return {
    id: `session-${executor}`,
    name: executor,
    type: 'coding',
    workspace_id: 'workspace-1',
    executor,
    model: executor === 'codex' ? 'gpt-5.6-sol' : executor === 'claude' ? 'sonnet' : null,
    approval_mode: executor === 'kimi' ? null : 'ask',
    thinking_effort: executor === 'kimi' ? null : executor === 'codex' ? 'ultra' : 'high',
    active_channel: 'web',
    status: 'idle',
    archived: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: `native-${executor}`,
    service_tier: null,
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function renderComposer(
  session: Session,
  extras: Partial<React.ComponentProps<typeof Composer>> = {},
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
  render(
    <LocaleProvider locale="en">
      <Composer
        session={session}
        executor={session.executor}
        workspaceId={session.workspace_id}
        disabled={false}
        running={false}
        {...callbacks}
        {...extras}
      />
    </LocaleProvider>,
  );
  return callbacks;
}

describe('CLI-aligned composer controls', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders Codex model, CLI effort ids, themed Fast, and a working Custom mode', async () => {
    const user = userEvent.setup();
    const session = makeSession('codex', { service_tier: 'fast' });
    const callbacks = renderComposer(session);

    await waitFor(() => {
      expect(document.querySelector('.cmp-options-btn')?.textContent).toContain('Ultra');
    });
    expect(document.querySelector('.cmp-executor-mark.codex')).toBeTruthy();

    await user.click(document.querySelector('.cmp-options-btn')!);
    expect(await screen.findByText('Max', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Ultra', { selector: '.mp-row-title' })).toBeTruthy();

    const fast = screen.getByRole('switch', { name: 'Fast' });
    expect(fast).toHaveAttribute('aria-checked', 'true');

    await user.click(document.querySelector('.cmp-approval-btn')!);
    const custom = await screen.findByText('Custom (config.toml)', { selector: '.mp-row-title' });
    expect(custom.closest('button')).not.toBeDisabled();
    await user.click(custom.closest('button')!);
    expect(callbacks.onSetMode).toHaveBeenCalledWith('custom');
  });

  it('renders Kimi model, effort, and mode from opaque ACP config choices', async () => {
    const user = userEvent.setup();
    const options: NativeConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'kimi-k2',
        choices: [
          { value: 'kimi-k2', label: 'Kimi K2' },
          { value: 'kimi-k2.5', label: 'Kimi K2.5' },
        ],
        scope: 'session',
      },
      {
        id: 'thinking',
        name: 'Thought',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        choices: [
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
        scope: 'session',
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'yolo',
        choices: [
          { value: 'default', label: 'Default' },
          { value: 'plan', label: 'Plan' },
          { value: 'auto', label: 'Auto' },
          { value: 'yolo', label: 'YOLO' },
        ],
        scope: 'session',
      },
    ];
    const callbacks = renderComposer(makeSession('kimi', {
      native_config_options: options,
      executor_config: {
        schemaVersion: 1,
        values: { model: 'kimi-k2', thinking: 'high', mode: 'yolo' },
      },
    }));

    expect(document.querySelector('.cmp-executor-mark.kimi')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Kimi K2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /High/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fast' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /High/ }));
    await user.click(await screen.findByText('Medium', { selector: '.mp-row-title' }));
    expect(callbacks.onSetNativeConfig).toHaveBeenCalledWith('thinking', 'medium');

    const mode = screen.getByRole('button', { name: /yolo/ });
    expect(mode.textContent).not.toContain('YOLO');
    await user.click(mode);
    expect(await screen.findByText('plan', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('auto', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('yolo', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.queryByText('YOLO', { selector: '.mp-row-title' })).toBeNull();
    await user.click(screen.getByText('plan', { selector: '.mp-row-title' }).closest('button')!);
    expect(callbacks.onSetNativeConfig).toHaveBeenCalledWith('mode', 'plan');

    await user.type(screen.getByRole('textbox'), '/');
    expect(await screen.findByText('/review')).toBeTruthy();
  });

  it('renders the Grok executor mark for Grok-native model options', async () => {
    const options: NativeConfigOption[] = [{
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'grok-build',
      choices: [{ value: 'grok-build', label: 'Grok Build' }],
      scope: 'session',
    }];
    renderComposer(makeSession('grok', {
      native_config_options: options,
      executor_config: {
        schemaVersion: 1,
        values: { model: 'grok-build' },
      },
    }));

    await waitFor(() => {
      expect(document.querySelector('.cmp-executor-mark.grok')).toBeTruthy();
    });
    expect(document.querySelector('.cmp-executor-mark.kimi')).toBeNull();
  });

  it('removes slash and Remote buttons while keeping typed slash discovery', async () => {
    const user = userEvent.setup();
    renderComposer(makeSession('claude'));

    expect(document.querySelector('.slash-box')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remote Control/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fast' })).toBeNull();
    expect(document.querySelector('.cmp-options-btn')).toBeTruthy();

    await user.type(screen.getByRole('textbox'), '/');
    expect(await screen.findByText('/review')).toBeTruthy();
  });
});
