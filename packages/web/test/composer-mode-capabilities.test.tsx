import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Executor, ProxyModeCapabilities, Session } from '@gian/shared';

import { Composer } from '../src/components/Composer.js';
import { clearComposerCapabilityCaches } from '../src/components/composer/capabilities.js';
import { LocaleProvider } from '../src/i18n/index.js';

const CODEX_MODES: ProxyModeCapabilities[] = [
  { id: 'plan', label: 'Plan', description: 'Plan before making changes', isDefault: false },
  { id: 'ask', label: 'Ask', description: 'Ask before each action', isDefault: true },
  { id: 'auto', label: 'Auto', description: 'Approve safe actions', isDefault: false },
  { id: 'custom', label: 'Custom', description: 'Use config.toml permissions', isDefault: false },
  { id: 'full-access', label: 'Full access', description: 'No restrictions', isDefault: false },
  // Unknown id: no i18n key exists, so the advertised label/description render.
  { id: 'yolo', label: 'YOLO everything', description: 'Approve everything, always', isDefault: false },
];

const CLAUDE_MODES: ProxyModeCapabilities[] = [
  { id: 'plan', label: 'Plan', description: 'Plan first', isDefault: false },
  { id: 'ask', label: 'Ask', description: 'Ask first', isDefault: true },
  { id: 'auto', label: 'Auto', description: 'Auto-approve', isDefault: false },
];

const loadProxyCapabilitiesMock = vi.fn();

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
  loadProxyCapabilities: (...args: unknown[]) => loadProxyCapabilitiesMock(...args),
  loadSlashCommands: vi.fn().mockResolvedValue([]),
  loadSessionSlashCommands: vi.fn().mockResolvedValue([]),
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
  locale: 'en' | 'zh-CN' = 'en',
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
    onSetTurnConfig: vi.fn(),
    onSetServiceTier: vi.fn(),
  };
  render(
    <LocaleProvider locale={locale}>
      <Composer
        session={session}
        executor={session.executor}
        workspaceId={session.workspace_id}
        disabled={false}
        running={false}
        {...callbacks}
      />
    </LocaleProvider>,
  );
  return callbacks;
}

describe('Composer mode dropdown from proxy capabilities', () => {
  beforeEach(() => {
    localStorage.clear();
    clearComposerCapabilityCaches();
    loadProxyCapabilitiesMock.mockReset();
  });

  // NOTE: the mode cache in composer/capabilities.ts is module-level, so this
  // fallback test must run before any test that resolves codex capabilities.
  it('falls back to the built-in codex list while capabilities are unavailable', async () => {
    const user = userEvent.setup();
    loadProxyCapabilitiesMock.mockRejectedValue(new Error('proxy not ready'));
    renderComposer(makeSession('codex'));

    await user.click(document.querySelector('.cmp-approval-btn')!);
    expect(await screen.findByText('Ask for approval', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Approve for me', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Full access', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Custom (config.toml)', { selector: '.mp-row-title' })).toBeTruthy();
    // The hardcoded fallback has no plan mode — it only appears once the
    // proxy capabilities resolve.
    expect(screen.queryByText('Plan', { selector: '.mp-row-title' })).toBeNull();
  });

  it('renders approval_mode configOptions as composer mode rows', async () => {
    const user = userEvent.setup();
    loadProxyCapabilitiesMock.mockResolvedValue({
      catalogRevision: 'rev-1',
      input: [{ type: 'text' }],
      slashCommands: [],
      configOptions: [{
        id: 'permissionMode',
        displayName: 'Permission mode',
        binding: 'turn',
        role: 'approval_mode',
        control: 'select',
        required: true,
        defaultValue: 'default',
        choices: [
          { value: 'plan', displayName: 'Plan', description: 'Plan first' },
          { value: 'default', displayName: 'Ask', description: 'Ask first' },
          { value: 'bypassPermissions', displayName: 'Skip permission prompts', description: 'Skip prompts' },
        ],
      }],
    });
    renderComposer(makeSession('claude'));

    await user.click(document.querySelector('.cmp-approval-btn')!);
    expect(await screen.findByText('Plan', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Ask', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Skip permission prompts', { selector: '.mp-row-title' })).toBeTruthy();
  });

  it('renders codex capability modes including plan once capabilities resolve', async () => {
    const user = userEvent.setup();
    loadProxyCapabilitiesMock.mockImplementation(async (executor: string) => ({
      protocolVersion: '1',
      models: [],
      slashCommands: [],
      modes: executor === 'codex' ? CODEX_MODES : CLAUDE_MODES,
    }));
    const callbacks = renderComposer(makeSession('codex'));

    await user.click(document.querySelector('.cmp-approval-btn')!);
    // Capability list order comes from the proxy; known ids keep their
    // localized composer labels.
    expect(await screen.findByText('Plan', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Ask for approval', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Approve for me', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Custom (config.toml)', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Full access', { selector: '.mp-row-title' })).toBeTruthy();
    // Unknown ids render the proxy-advertised label + description.
    expect(screen.getByText('YOLO everything', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Approve everything, always', { selector: '.mp-row-hint' })).toBeTruthy();

    await user.click(screen.getByText('Plan', { selector: '.mp-row-title' }).closest('button')!);
    expect(callbacks.onSetMode).toHaveBeenCalledWith('plan');
  });

  it('labels the collapsed codex button from the active mode, plan included', async () => {
    // Codex modes are cached from the previous test; a plan session must show
    // the Plan label instead of the old generic "Approval" fallback.
    renderComposer(makeSession('codex', { approval_mode: 'plan' }));
    await waitFor(() => {
      expect(document.querySelector('.cmp-approval-btn')?.textContent).toContain('Plan');
    });
  });

  it('renders claude capability modes and keeps the one-shot Bypass row', async () => {
    const user = userEvent.setup();
    renderComposer(makeSession('claude'));

    await user.click(document.querySelector('.cmp-approval-btn')!);
    expect(await screen.findByText('Plan', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Ask', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Auto', { selector: '.mp-row-title' })).toBeTruthy();
    expect(screen.getByText('Bypass', { selector: '.mp-row-title' })).toBeTruthy();
  });

  it('keeps Chinese hints for known codex ids in zh locale', async () => {
    const user = userEvent.setup();
    loadProxyCapabilitiesMock.mockImplementation(async (executor: string) => ({
      protocolVersion: '1',
      models: [],
      slashCommands: [],
      modes: executor === 'codex' ? CODEX_MODES : CLAUDE_MODES,
    }));
    renderComposer(makeSession('codex'), 'zh-CN');

    await user.click(document.querySelector('.cmp-approval-btn')!);
    // Known ids: zh composer.approval.* hints; unknown ids: advertised label.
    expect(await screen.findByText('编辑外部文件、使用网络前总是询问', { selector: '.mp-row-hint' })).toBeTruthy();
    expect(screen.getByText('无限制访问网络和本机任意文件', { selector: '.mp-row-hint' })).toBeTruthy();
    expect(screen.getByText('YOLO everything', { selector: '.mp-row-title' })).toBeTruthy();
  });

  it('does not auto-render unknown-role turn options', async () => {
    loadProxyCapabilitiesMock.mockResolvedValue({
      catalogRevision: 'rev-runtime',
      input: [{ type: 'text' }, { type: 'localFile' }],
      slashCommands: [],
      configOptions: [{
        id: 'verbosity',
        displayName: 'Verbosity',
        binding: 'turn',
        role: 'custom_verbosity',
        control: 'select',
        required: false,
        defaultValue: 'normal',
        choices: [
          { value: 'quiet', displayName: 'Quiet' },
          { value: 'normal', displayName: 'Normal' },
        ],
      }],
    });
    const callbacks = renderComposer(makeSession('claude'));
    await waitFor(() => {
      expect(screen.queryByText('Verbosity')).toBeNull();
      expect(screen.queryByText('Quiet')).toBeNull();
    });
    expect(callbacks.onSetTurnConfig).not.toHaveBeenCalled();
  });

  it('shows Fast when the catalog advertises role=fast on a non-codex executor', async () => {
    loadProxyCapabilitiesMock.mockResolvedValue({
      catalogRevision: 'rev-fast',
      input: [{ type: 'text' }],
      slashCommands: [],
      configOptions: [{
        id: 'fast',
        displayName: 'Turbo',
        binding: 'turn',
        role: 'fast',
        control: 'boolean',
        required: false,
        defaultValue: false,
      }],
    });
    const callbacks = renderComposer(makeSession('grok'));
    await userEvent.click(await screen.findByTestId('composer-fast-chip'));
    expect(callbacks.onSetServiceTier).toHaveBeenCalledWith('fast');
  });

  it('orders the restored Composer controls exactly around the spacer', async () => {
    loadProxyCapabilitiesMock.mockResolvedValue({
      catalogRevision: 'rev-21-layout',
      input: [{ type: 'text' }, { type: 'localFile' }],
      slashCommands: [],
      specialCatalogs: {
        model: 'model',
        thinking: 'thinking',
        fast: 'fast',
        approvalMode: 'approval',
      },
      configOptions: [
        { id: 'model', displayName: 'Model', binding: 'turn', control: 'select', required: false, defaultValue: 'gpt', choices: [{ value: 'gpt', displayName: 'GPT' }] },
        { id: 'thinking', displayName: 'Thinking', binding: 'turn', control: 'select', required: false, defaultValue: 'high', choices: [{ value: 'high', displayName: 'High' }] },
        { id: 'fast', displayName: 'Fast', binding: 'turn', control: 'boolean', required: false, defaultValue: false },
        { id: 'approval', displayName: 'Approval', binding: 'turn', control: 'select', required: false, defaultValue: 'ask', choices: [{ value: 'ask', displayName: 'Ask' }] },
      ],
    });
    renderComposer(makeSession('codex'));
    await screen.findByTestId('composer-fast-chip');
    const bar = document.querySelector('.composer-bar')!;
    const children = Array.from(bar.children);
    const index = (selector: string) => children.indexOf(bar.querySelector(selector)!);
    const order = children.map(element => {
      if (element.classList.contains('context-usage-anchor')) return 'context';
      if (element.classList.contains('cmp-control-sep')) return 'separator';
      if (element.classList.contains('spacer')) return 'spacer';
      return element.getAttribute('data-testid') ?? element.getAttribute('aria-label');
    });
    expect(order).toEqual([
      'context',
      'composer-model-chip',
      'separator',
      'composer-thinking-chip',
      'separator',
      'composer-fast-chip',
      'spacer',
      null,
      'Add context',
      'Send',
    ]);
    expect(index('.context-usage-anchor')).toBeLessThan(index('[data-testid="composer-model-chip"]'));
    expect(index('[data-testid="composer-model-chip"]')).toBeLessThan(index('[data-testid="composer-thinking-chip"]'));
    expect(index('[data-testid="composer-thinking-chip"]')).toBeLessThan(index('[data-testid="composer-fast-chip"]'));
    expect(index('[data-testid="composer-fast-chip"]')).toBeLessThan(index('.spacer'));
    expect(index('.spacer')).toBeLessThan(index('.cmp-approval-btn'));
    expect(index('.cmp-approval-btn')).toBeLessThan(index('[aria-label="Add context"]'));
    expect(index('[aria-label="Add context"]')).toBeLessThan(index('[aria-label="Send"]'));
    expect(bar.querySelector('[data-testid="composer-model-chip"] .agent-logo')).toBeNull();
    expect(bar.querySelector('[data-testid="composer-model-chip"] .cmp-executor-mark')).toBeNull();
    expect(bar.querySelector('.cmp-bulb')).toBeNull();
    expect(bar.querySelector('.cmp-caret')).toBeNull();
  });

  it('keeps every approval mode on the normal text treatment', async () => {
    const user = userEvent.setup();
    renderComposer(makeSession('codex', { approval_mode: 'auto' }));
    const approval = document.querySelector('.cmp-approval-btn')!;
    expect(approval).not.toHaveClass('risky');

    await user.click(approval);
    expect(await screen.findByText('Approve for me', { selector: '.mp-row-title' })).toBeTruthy();
    expect(document.querySelector('.danger-option')).toBeNull();
  });

  it('does not use the Codex Fast fallback once a catalog without role=fast is ready', async () => {
    loadProxyCapabilitiesMock.mockResolvedValue({
      catalogRevision: 'rev-codex-standard-only',
      input: [{ type: 'text' }],
      slashCommands: [],
      configOptions: [{
        id: 'model',
        displayName: 'Model',
        binding: 'turn',
        role: 'model',
        control: 'select',
        required: false,
        defaultValue: 'gpt-5.6-sol',
        choices: [{ value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }],
      }],
    });
    renderComposer(makeSession('codex'));
    await screen.findByTestId('composer-model-chip');
    expect(screen.queryByTestId('composer-fast-chip')).toBeNull();
  });

  it('clears Fast when the selected model does not satisfy the catalog condition', async () => {
    loadProxyCapabilitiesMock.mockResolvedValue({
      catalogRevision: 'rev-codex-fast-by-model',
      input: [{ type: 'text' }],
      slashCommands: [],
      configOptions: [{
        id: 'model',
        displayName: 'Model',
        binding: 'turn',
        role: 'model',
        control: 'select',
        required: false,
        defaultValue: 'gpt-5.6-sol',
        choices: [
          { value: 'gpt-5.6-sol', displayName: 'Sol' },
          { value: 'gpt-5.6-luna', displayName: 'Luna' },
        ],
      }, {
        id: 'service_tier',
        displayName: 'Fast',
        binding: 'turn',
        role: 'fast',
        control: 'boolean',
        required: false,
        defaultValue: false,
        enabledWhen: [{ optionId: 'model', oneOf: ['gpt-5.6-sol'] }],
      }],
    });
    const callbacks = renderComposer(makeSession('codex', { service_tier: 'fast' }));
    await userEvent.click(await screen.findByTestId('composer-model-chip'));
    await userEvent.click(await screen.findByText('Luna', { selector: '.mp-row-title' }));
    expect(callbacks.onSetModel).toHaveBeenCalledWith('gpt-5.6-luna');
    expect(callbacks.onSetServiceTier).toHaveBeenCalledWith(null);
  });

  it('hides the attachment button when the catalog only advertises text input', async () => {
    loadProxyCapabilitiesMock.mockResolvedValue({
      catalogRevision: 'rev-text',
      input: [{ type: 'text' }],
      slashCommands: [],
      configOptions: [],
    });
    renderComposer(makeSession('claude'));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    });
  });
});
