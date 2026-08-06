import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Executor, ProxyModeCapabilities, Session } from '@gian/shared';

import { Composer } from '../src/components/Composer.js';
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
    renderComposer(makeSession('codex'), 'zh-CN');

    await user.click(document.querySelector('.cmp-approval-btn')!);
    // Known ids: zh composer.approval.* hints; unknown ids: advertised label.
    expect(await screen.findByText('编辑外部文件、使用网络前总是询问', { selector: '.mp-row-hint' })).toBeTruthy();
    expect(screen.getByText('无限制访问网络和本机任意文件', { selector: '.mp-row-hint' })).toBeTruthy();
    expect(screen.getByText('YOLO everything', { selector: '.mp-row-title' })).toBeTruthy();
  });
});
