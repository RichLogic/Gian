// Coverage for SES-001 (issue #57, chat-panel layout) — NewSessionView
// mirrors the session chat panel: the transcript area stays empty (task
// context / create errors only); agent + workspace selectors sit in a row
// above the message box; the composer bar carries model / thinking / mode
// chips that follow the picked agent. Send stays disabled until an agent is
// picked (multi-agent) and a message typed; a single ready agent
// auto-selects into a static chip. Chip choices are explicit-only in the
// payload; the last used workspace/agent/chips are remembered for the next
// open. The workspace drop is Codex-style (search + "+ New workspace" jump
// to the Workspaces sheet) — the page never creates workspaces inline.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstallStatus, CodexModelCapabilities, Executor, Workspace } from '@gian/shared';
import { loadAgents, loadProxyCapabilities, loadProxyModels } from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { NewSessionView } from '../src/views/new-session-view.js';

vi.mock('../src/api.js', () => ({
  loadAgents: vi.fn(),
  peekAgents: vi.fn(() => null),
  loadProxyModels: vi.fn(),
  loadProxyCapabilities: vi.fn(),
}));

function agent(id: Executor, name: string, ready = true): AgentInstallStatus {
  return {
    id,
    name,
    ready,
    cli: ready
      ? { state: 'ready', path: `/bin/${id}`, version: '1.0.0', source: 'path' }
      : { state: 'missing', path: null, version: null, source: null },
    proxy: ready
      ? {
          state: 'ready', path: `/proxy/${id}`, version: '0.1.0', source: 'github-release',
          defaults: { model: '', thinking: '', mode: '' },
        }
      : {
          state: 'missing', path: `/proxy/${id}`, version: null, source: 'github-release',
          defaults: { model: '', thinking: '', mode: '' },
        },
    officialInstallUrl: 'https://example.invalid',
  };
}

function workspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    sort_order: 0,
    hidden: 0,
    pinned: 0,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

const agents = [
  agent('codex', 'Codex'),
  agent('claude', 'Claude Code'),
  agent('kimi', 'Kimi Code', false),
];

function codexModel(overrides: Partial<CodexModelCapabilities> = {}): CodexModelCapabilities {
  return {
    id: 'gpt-5-codex',
    model: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    description: '',
    hidden: false,
    isDefault: true,
    defaultThinking: 'medium',
    supportedThinking: ['low', 'medium', 'high'],
    ...overrides,
  };
}

const codexModels = [
  codexModel(),
  codexModel({
    id: 'gpt-5', model: 'gpt-5', displayName: 'GPT-5',
    isDefault: false, defaultThinking: 'low', supportedThinking: ['low', 'medium'],
  }),
];

function renderView(props: Partial<Parameters<typeof NewSessionView>[0]> = {}) {
  const onCreate = vi.fn();
  const onNewWorkspace = vi.fn();
  const view = render(
    <LocaleProvider locale="en">
      <NewSessionView
        workspaces={[workspace('ws-1', 'Alpha'), workspace('ws-2', 'Beta')]}
        onNewWorkspace={onNewWorkspace}
        onCreate={onCreate}
        onCancel={vi.fn()}
        creating={false}
        {...props}
      />
    </LocaleProvider>,
  );
  return { onCreate, onNewWorkspace, unmount: view.unmount };
}

async function openAgentPicker() {
  await userEvent.click(await screen.findByTestId('ns-agent-picker'));
}

describe('NewSessionView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The view remembers the last choices in localStorage — isolate tests.
    localStorage.clear();
    vi.mocked(loadAgents).mockResolvedValue(agents);
    vi.mocked(loadProxyModels).mockResolvedValue(codexModels);
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      protocolVersion: 'test', models: [], modes: [], slashCommands: [],
    });
  });

  it('lists agents from /api/agents in the picker; unready agents are disabled', async () => {
    renderView();
    await openAgentPicker();
    expect(screen.getByTestId('ns-agent-option-codex')).toBeEnabled();
    expect(screen.getByTestId('ns-agent-option-claude')).toBeEnabled();
    expect(screen.getByTestId('ns-agent-option-kimi')).toBeDisabled();
  });

  it('keeps Send disabled until an agent is picked and a message typed (multi-agent)', async () => {
    renderView();
    const send = screen.getByTestId('ns-send');
    await screen.findByTestId('ns-agent-picker');
    // Message alone is not enough — no agent selected yet.
    await userEvent.type(screen.getByTestId('ns-message-input'), 'fix the bug');
    expect(send).toBeDisabled();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-codex'));
    expect(send).toBeEnabled();
  });

  it('auto-selects the only ready agent (single-agent default path)', async () => {
    vi.mocked(loadAgents).mockResolvedValue([agent('kimi', 'Kimi Code')]);
    const { onCreate } = renderView();
    // The picker shows the auto-selected agent without opening the drop.
    expect(await screen.findByTestId('ns-agent-picker')).toHaveTextContent('Kimi Code');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'summarize this repo');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      executor: 'kimi',
      firstMessage: 'summarize this repo',
    });
  });

  it('submits the picked agent and trimmed first message (no title field)', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-claude'));
    await userEvent.type(screen.getByTestId('ns-message-input'), '  refactor auth  ');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      executor: 'claude',
      firstMessage: 'refactor auth',
    });
  });

  it('preselects initialWorkspaceId (sidebar workspace-row "+" entry)', async () => {
    const { onCreate } = renderView({ initialWorkspaceId: 'ws-2' });
    await screen.findByTestId('ns-agent-picker');
    expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-codex'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'go');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-2',
      name: '',
      executor: 'codex',
      firstMessage: 'go',
    });
  });

  it('preselects initialExecutor (⌘J/⌘K shortcut carries the agent choice)', async () => {
    const { onCreate } = renderView({ initialExecutor: 'claude' });
    expect(await screen.findByTestId('ns-agent-picker')).toHaveTextContent('Claude Code');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'go');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      executor: 'claude',
      firstMessage: 'go',
    });
  });

  it('workspace drop filters by search and selects a row', async () => {
    const { onCreate } = renderView();
    await userEvent.click(await screen.findByTestId('ns-workspace-chip'));
    expect(screen.getByTestId('ns-workspace-option-ws-1')).toBeEnabled();
    expect(screen.getByTestId('ns-workspace-option-ws-2')).toBeEnabled();
    await userEvent.type(screen.getByTestId('ns-workspace-search'), 'bet');
    expect(screen.queryByTestId('ns-workspace-option-ws-1')).toBeNull();
    await userEvent.click(screen.getByTestId('ns-workspace-option-ws-2'));
    expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-codex'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'go');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-2' }));
  });

  it('"+ New workspace" stashes the draft and jumps to the Workspaces sheet', async () => {
    const { onNewWorkspace } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-codex'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'draft keeps me');
    await userEvent.click(screen.getByTestId('ns-workspace-chip'));
    await userEvent.click(screen.getByTestId('ns-workspace-new'));
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
    const draft = JSON.parse(localStorage.getItem('gian.new-session.draft.v1') ?? 'null');
    expect(draft).toMatchObject({ message: 'draft keeps me', executor: 'codex' });
    expect(localStorage.getItem('gian.new-session.return.v1')).toBe('1');
  });

  it('restores the stashed draft on the return trip', async () => {
    localStorage.setItem('gian.new-session.draft.v1', JSON.stringify({
      message: 'back from the sheet',
      executor: 'codex',
      model: 'gpt-5',
    }));
    renderView({ initialWorkspaceId: 'ws-2' });
    expect(screen.getByTestId('ns-message-input')).toHaveValue('back from the sheet');
    expect(await screen.findByTestId('ns-agent-picker')).toHaveTextContent('Codex');
    expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5'));
    // The draft is consumed — a fresh open does not resurrect it.
    expect(localStorage.getItem('gian.new-session.draft.v1')).toBeNull();
  });

  it('renders capability chips for the picked agent and sends explicit choices', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-codex'));
    // Chips appear with the capability-list defaults (nothing explicit yet).
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5 Codex'));
    expect(screen.getByTestId('ns-effort-chip')).toHaveTextContent('Medium');
    expect(screen.getByTestId('ns-mode-chip')).toHaveTextContent('Ask for approval');

    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(
      within(document.querySelector('.model-pop') as HTMLElement).getByText('GPT-5'),
    );
    expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5');
    await userEvent.click(screen.getByTestId('ns-effort-chip'));
    await userEvent.click(
      within(document.querySelector('.think-pop') as HTMLElement).getByText('Medium'),
    );
    await userEvent.click(screen.getByTestId('ns-mode-chip'));
    await userEvent.click(
      within(document.querySelector('.approval-pop') as HTMLElement).getByText('Approve for me'),
    );

    await userEvent.type(screen.getByTestId('ns-message-input'), 'do the thing');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      executor: 'codex',
      firstMessage: 'do the thing',
      model: 'gpt-5',
      thinkingEffort: 'medium',
      approvalMode: 'auto',
    });
  });

  it('leaves model/effort/mode out of the payload unless explicitly picked', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-codex'));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5 Codex'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'defaults please');
    await userEvent.click(screen.getByTestId('ns-send'));
    // The host applies its configured defaults — the payload must not invent
    // capability-list guesses.
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      executor: 'codex',
      firstMessage: 'defaults please',
    });
  });

  it('remembers the last workspace / agent / chips as the next defaults', async () => {
    const first = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-codex'));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5 Codex'));
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(
      within(document.querySelector('.model-pop') as HTMLElement).getByText('GPT-5'),
    );
    await userEvent.click(screen.getByTestId('ns-workspace-chip'));
    await userEvent.click(screen.getByTestId('ns-workspace-option-ws-2'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'first run');
    await userEvent.click(screen.getByTestId('ns-send'));
    first.unmount();

    const second = renderView();
    await waitFor(() => {
      expect(screen.getByTestId('ns-agent-picker')).toHaveTextContent('Codex');
      expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    });
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'second run');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(second.onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-2',
      name: '',
      executor: 'codex',
      firstMessage: 'second run',
      model: 'gpt-5',
    });
  });

  it('shows the task context read-only when opened from a task-row "+"', async () => {
    renderView({ taskName: 'My task' });
    await screen.findByTestId('ns-agent-picker');
    expect(screen.getByTestId('ns-task-name')).toHaveTextContent('My task');
    // The workspace picker is still editable — only the task is fixed.
    expect(screen.getByTestId('ns-workspace-chip')).toBeEnabled();
  });

  it('keeps a session creation failure visible while preserving editable form state', async () => {
    renderView({ createError: 'executor failed to start' });
    await screen.findByTestId('ns-agent-picker');

    expect(screen.getByRole('alert')).toHaveTextContent('executor failed to start');
    expect(screen.getByTestId('ns-workspace-chip')).toBeEnabled();
    expect(screen.getByTestId('ns-message-input')).toBeEnabled();
  });

  it('interlocks an unknown create until the user refreshes canonical sessions', async () => {
    const onVerifyCreate = vi.fn();
    renderView({
      createUnknown: true,
      createError: 'Session creation status is unknown.',
      onVerifyCreate,
    });
    await screen.findByTestId('ns-agent-picker');

    expect(screen.getByTestId('ns-send')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh sessions before retrying' }));
    expect(onVerifyCreate).toHaveBeenCalledTimes(1);
  });
});
