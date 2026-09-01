import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Executor, Session } from '@gian/shared';

import { Composer } from '../src/components/Composer.js';
import { clearComposerCapabilityCaches } from '../src/components/composer/capabilities.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { loadResolvedProxyCatalog } from '../src/api.js';

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
  loadSlashCommands: vi.fn().mockResolvedValue([]),
  loadSessionSlashCommands: vi.fn().mockResolvedValue([]),
  loadNativeConfig: vi.fn().mockResolvedValue(null),
  loadProxyCapabilities: vi.fn(async (executor: Executor) => executor === 'dsh' ? ({
    catalogRevision: 'dsh-base',
    capabilities: { 'catalog.resolve': 1 },
    input: [{ type: 'text' }],
    configOptions: [
      {
        id: 'provider', displayName: 'Provider', binding: 'turn', control: 'select',
        required: false, defaultValue: 'deepseek-official',
        choices: [
          { value: 'deepseek-official', displayName: 'DeepSeek' },
          { value: 'opencode-go', displayName: 'opencode-go' },
        ],
      },
      {
        id: 'model', displayName: 'Model', binding: 'turn', control: 'select',
        required: true, defaultValue: 'deepseek-v4-flash',
        choices: [{ value: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' }],
      },
      {
        id: 'effort', displayName: 'Reasoning effort', binding: 'turn', control: 'select',
        required: false, defaultValue: 'high',
        choices: [{ value: 'high', displayName: 'High' }],
      },
    ],
    specialCatalogs: { model: 'model', thinking: 'effort' },
    slashCommands: [],
  }) : ({})),
  loadResolvedProxyCatalog: vi.fn(async () => ({
    catalogRevision: 'dsh-opencode',
    input: [{ type: 'text' }],
    configOptions: [
      {
        id: 'provider', displayName: 'Provider', binding: 'turn', control: 'select',
        required: false, defaultValue: 'opencode-go',
        choices: [
          { value: 'deepseek-official', displayName: 'DeepSeek' },
          { value: 'opencode-go', displayName: 'opencode-go' },
        ],
      },
      {
        id: 'model', displayName: 'Model', binding: 'turn', control: 'select',
        required: true, defaultValue: 'deepseek-v4-flash', role: 'model',
        choices: [{ value: 'deepseek-v4-flash', displayName: 'opencode-DS V4 Flash' }],
      },
      {
        id: 'effort', displayName: 'Reasoning effort', binding: 'turn', control: 'select',
        required: false, defaultValue: 'off', role: 'effort',
        choices: [{ value: 'off', displayName: 'Off' }],
      },
    ],
    slashCommands: [],
    resolvedDefaults: {
      sessionConfig: {},
      turnConfig: { provider: 'opencode-go', model: 'deepseek-v4-flash', effort: 'off' },
    },
  })),
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

describe('Composer independent catalog controls', () => {
  beforeEach(() => {
    localStorage.clear();
    clearComposerCapabilityCaches();
  });

  it('renders independent model and Thinking controls without a combined trigger', async () => {
    renderComposer(makeSession('claude'));

    await waitFor(() => {
      expect(screen.getByTestId('composer-model-chip')).toHaveTextContent('Sonnet');
    });
    expect(screen.getByTestId('composer-thinking-chip')).toHaveTextContent('High');
    expect(screen.queryByTestId('composer-fast-chip')).toBeNull();
    expect(document.querySelector('.cmp-options-btn')).toBeNull();
  });

  it('renders Fast as its own pressed button when the session is on the fast tier', async () => {
    renderComposer(makeSession('codex', { service_tier: 'fast' }));

    await waitFor(() => {
      expect(screen.getByTestId('composer-fast-chip')).toHaveTextContent('Fast');
    });
    expect(screen.getByTestId('composer-fast-chip')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('composer-model-chip')).toHaveTextContent('GPT-5.6-Sol');
    expect(screen.getByTestId('composer-thinking-chip')).toHaveTextContent('Ultra');
  });

  it('does not render the screenshot button', async () => {
    renderComposer(makeSession('claude'));

    // Let the async model fetch settle so no state update escapes act().
    await waitFor(() => {
      expect(screen.getByTestId('composer-model-chip')).toHaveTextContent('Sonnet');
    });
    expect(screen.queryByRole('button', { name: 'Screenshot' })).toBeNull();
  });

  it('places the context ring first and approval on the right of the spacer', async () => {
    renderComposer(makeSession('claude'));

    await waitFor(() => {
      expect(screen.getByTestId('composer-model-chip')).toHaveTextContent('Sonnet');
    });
    const approval = document.querySelector('.cmp-approval-btn');
    const ring = document.querySelector('.context-usage-anchor');
    expect(approval).toBeTruthy();
    expect(ring).toBeTruthy();
    expect(
      ring!.compareDocumentPosition(approval!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('selects a Model from the independent model popover and fires onSetModel', async () => {
    const user = userEvent.setup();
    const callbacks = renderComposer(makeSession('claude'));

    await waitFor(() => {
      expect(screen.getByTestId('composer-model-chip')).toHaveTextContent('Sonnet');
    });
    await user.click(screen.getByTestId('composer-model-chip'));
    const choice = await screen.findByText('Sonnet', { selector: '.model-pop .mp-row-title' });
    await user.click(choice.closest('button')!);

    expect(callbacks.onSetModel).toHaveBeenCalledWith('sonnet');
    expect(document.querySelector('.model-pop')).toBeNull();
  });

  it('shows an ordinary DSH Provider chip and resolves Model/Thinking after selection', async () => {
    const user = userEvent.setup();
    const onSetTurnConfig = vi.fn();
    renderComposer(makeSession('dsh', {
      model: 'deepseek-v4-flash',
      approval_mode: null,
      thinking_effort: null,
      turn_config: {},
    }), { onSetTurnConfig });

    const provider = await screen.findByTestId('composer-catalog-options');
    expect(provider).toHaveTextContent('Provider: DeepSeek');
    await user.click(provider);
    await user.click(await screen.findByTestId('catalog-option-provider-opencode-go'));

    expect(onSetTurnConfig).toHaveBeenCalledWith('provider', 'opencode-go');
    await waitFor(() => {
      expect(loadResolvedProxyCatalog).toHaveBeenCalled();
      expect(screen.getByTestId('composer-catalog-options')).toHaveTextContent('Provider: opencode-go');
      expect(screen.getByTestId('composer-model-chip')).toHaveTextContent('opencode-DS V4 Flash');
      expect(screen.getByTestId('composer-thinking-chip')).toHaveTextContent('Off');
    });
  });
});
