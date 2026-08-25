// Coverage for SES-001 (issue #57, chat-panel layout) — NewSessionView
// mirrors the session chat panel: the transcript area stays empty except for
// create errors; agent + workspace selectors sit above a two-row composer
// whose optional title precedes the required first message. The composer bar
// carries model / thinking / mode chips that follow the picked agent, plus a
// Codex-only Fast toggle. Attachments align with the session Composer: image
// paste, a file picker for arbitrary files, and Desktop screenshot capture all
// stage Blobs in the pre-session IndexedDB store (20 MB cap) and are uploaded
// into the Session after it is created; image thumbnails zoom through the
// app-level ImageLightbox (ImageZoomContext), same as the Composer's chips. Send stays disabled until an agent is
// picked (multi-agent) and a message typed;
// a single ready agent auto-selects into a static chip. Chip choices are
// explicit-only in the payload; the last used workspace/agent/chips are
// remembered for the next open. The workspace drop is Codex-style (search +
// "+ New workspace" jump to the Workspaces sheet) — the page never creates
// workspaces inline.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexModelCapabilities, Executor, UserAgentStatus, Workspace } from '@gian/shared';
import {
  loadAgents,
  loadProxyCapabilities,
  loadProxyModels,
  loadResolvedProxyCatalog,
} from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { clearComposerCapabilityCaches } from '../src/components/composer/capabilities.js';
import {
  clearNewSessionDraft,
  NewSessionView,
  newSessionDraftStorageKey,
} from '../src/views/new-session-view.js';
import { storeNewSessionAttachment, storeNewSessionScreenshot } from '../src/screenshot-drafts.js';
import { ImageZoomContext } from '../src/transcript/items.js';

vi.mock('../src/api.js', () => ({
  loadAgents: vi.fn(),
  peekAgents: vi.fn(() => null),
  loadProxyModels: vi.fn(),
  loadProxyCapabilities: vi.fn(),
  loadResolvedProxyCatalog: vi.fn(),
}));

const AGENT_COLORS = { claude: 'ember', codex: 'ink', kimi: 'citron', dsh: 'teal' } as const;

function agent(kind: Executor, name: string, ready = true): UserAgentStatus {
  return {
    id: `agent-${kind}-1`,
    name,
    color: (AGENT_COLORS as Record<string, 'ember'>)[kind] ?? 'azure',
    proxy: kind as UserAgentStatus['proxy'],
    cliPath: ready ? `/bin/${kind}` : null,
    defaults: { model: '', thinking: '', mode: '' },
    proxyName: name,
    ready,
    cli: ready
      ? { state: 'ready', path: `/bin/${kind}`, version: '1.0.0', source: 'path' }
      : { state: 'missing', path: null, version: null, source: null },
    plugin: ready
      ? {
          state: 'ready', path: `/proxy/${kind}`, version: '0.1.0', source: 'github-release',
          defaults: { model: '', thinking: '', mode: '' },
        }
      : {
          state: 'missing', path: `/proxy/${kind}`, version: null, source: 'github-release',
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
    clearComposerCapabilityCaches();
    // The view remembers the last choices in localStorage — isolate tests.
    localStorage.clear();
    vi.mocked(loadAgents).mockResolvedValue(agents);
    vi.mocked(loadProxyModels).mockResolvedValue(codexModels);
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      protocolVersion: 'test', models: [], modes: [], slashCommands: [],
    });
    vi.mocked(loadResolvedProxyCatalog).mockResolvedValue({
      catalogRevision: 'resolved',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
      resolvedDefaults: { sessionConfig: {}, turnConfig: {} },
    });
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:new-session-screenshot') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
  });

  it('lists only saved-and-ready agents in the picker', async () => {
    vi.mocked(loadAgents).mockResolvedValue([...agents, agent('dsh', 'DeepSeek Harness', false)]);
    renderView();
    await openAgentPicker();
    expect(screen.getByTestId('ns-agent-option-agent-codex-1')).toBeEnabled();
    expect(screen.getByTestId('ns-agent-option-agent-claude-1')).toBeEnabled();
    // Saved but not-ready Agents are not offered (⌘J/⌘K stays disabled too).
    expect(screen.queryByTestId('ns-agent-option-agent-kimi-1')).toBeNull();
    expect(screen.queryByTestId('ns-agent-option-agent-dsh-1')).toBeNull();
  });

  it('calls catalog.resolve only after a Proxy-advertised option changes', async () => {
    vi.mocked(loadAgents).mockResolvedValue([
      agent('claude', 'Claude Code'),
      agent('codex', 'Codex'),
    ]);
    const options = [
      {
        id: 'workspace_mode',
        displayName: 'Workspace Dynamic',
        binding: 'session' as const,
        control: 'select' as const,
        required: false,
        defaultValue: 'default',
        choices: [
          { value: 'default', displayName: 'Default' },
          { value: 'strict', displayName: 'Strict' },
        ],
      },
      {
        id: 'model',
        displayName: 'Model',
        binding: 'turn' as const,
        role: 'model',
        control: 'select' as const,
        required: true,
        defaultValue: 'mock-model',
        choices: [{ value: 'mock-model', displayName: 'Mock Model' }],
      },
    ];
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      protocolVersion: '2.0',
      catalogRevision: 'catalog-1',
      input: [{ type: 'text' }],
      configOptions: options,
      slashCommands: [],
      capabilities: { 'catalog.resolve': 1 },
      models: [],
      modes: [],
    });
    vi.mocked(loadResolvedProxyCatalog).mockResolvedValue({
      catalogRevision: 'catalog-1',
      input: [{ type: 'text' }],
      configOptions: options,
      slashCommands: [],
      resolvedDefaults: { sessionConfig: {}, turnConfig: {} },
    });

    renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    const select = await screen.findByLabelText('Workspace Dynamic');
    const row = screen.getByTestId('ns-agent-row');
    const sessionConfig = screen.getByTestId('ns-session-config');
    expect(row).toContainElement(sessionConfig);
    expect(
      screen.getByTestId('ns-workspace-chip').compareDocumentPosition(sessionConfig)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(loadResolvedProxyCatalog).not.toHaveBeenCalled();
    await userEvent.selectOptions(select, 'strict');
    await waitFor(() => expect(loadResolvedProxyCatalog).toHaveBeenCalledWith('codex', {
      catalogRevision: 'catalog-1',
      sessionConfig: { workspace_mode: 'strict' },
      turnConfig: {},
    }, 'agent-codex-1'));
  });

  it('shows DSH Catalog controls with Settings defaults without making them explicit', async () => {
    const dsh = agent('dsh', 'DeepSeek Harness');
    dsh.defaults = {
      model: 'deepseek-reasoner',
      thinking: 'high',
      mode: 'never',
    };
    vi.mocked(loadAgents).mockResolvedValue([dsh]);
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      protocolVersion: '2.0',
      catalogRevision: 'dsh-v2',
      input: [{ type: 'text' }],
      configOptions: [
        {
          id: 'model',
          displayName: 'Model',
          binding: 'turn',
          role: 'model',
          control: 'select',
          required: true,
          defaultValue: 'deepseek-chat',
          choices: [
            { value: 'deepseek-chat', displayName: 'DeepSeek Chat' },
            { value: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
          ],
        },
        {
          id: 'effort',
          displayName: 'Reasoning effort',
          binding: 'turn',
          role: 'effort',
          control: 'select',
          required: false,
          defaultValue: 'medium',
          choices: [
            { value: 'medium', displayName: 'Medium' },
            { value: 'high', displayName: 'High' },
          ],
        },
        {
          id: 'approval_policy',
          displayName: 'Approval policy',
          binding: 'turn',
          role: 'approval_mode',
          control: 'select',
          required: false,
          defaultValue: 'ask',
          choices: [
            { value: 'ask', displayName: 'Ask' },
            { value: 'never', displayName: 'Never' },
          ],
        },
      ],
      slashCommands: [],
      capabilities: {},
      models: [],
      modes: [],
    });
    localStorage.setItem(newSessionDraftStorageKey({ kind: 'workspace', id: 'ws-1' }), JSON.stringify({
      workspaceId: 'ws-1',
      executor: 'codex',
      model: 'gpt-5',
      thinkingEffort: 'low',
      approvalMode: 'auto',
    }));

    const { onCreate } = renderView({ initialAgentId: 'agent-dsh-1' });
    expect(await screen.findByTestId('ns-agent-picker')).toHaveTextContent('DeepSeek Harness');
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('DeepSeek Reasoner'));
    expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('High');
    expect(screen.getByTestId('ns-mode-chip')).toHaveTextContent('Never');

    await userEvent.type(screen.getByTestId('ns-message-input'), 'use configured defaults');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      agentId: 'agent-dsh-1',
      executor: 'dsh',
      firstMessage: 'use configured defaults',
    });
  });

  it('keeps Send disabled until an agent is picked and a message typed (multi-agent)', async () => {
    renderView();
    const send = screen.getByTestId('ns-send');
    await screen.findByTestId('ns-agent-picker');
    // Message alone is not enough — no agent selected yet.
    await userEvent.type(screen.getByTestId('ns-message-input'), 'fix the bug');
    expect(send).toBeDisabled();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
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
      agentId: 'agent-kimi-1',
      executor: 'kimi',
      firstMessage: 'summarize this repo',
    });
  });

  it('shows an optional title above the message and submits both trimmed values', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-claude-1'));
    expect(screen.queryByTestId('ns-fast-chip')).toBeNull();
    const title = screen.getByTestId('ns-title-input');
    const message = screen.getByTestId('ns-message-input');
    expect(title.nextElementSibling).toBe(message);
    await userEvent.type(title, '  Auth cleanup  ');
    await userEvent.type(screen.getByTestId('ns-message-input'), '  refactor auth  ');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: 'Auth cleanup',
      agentId: 'agent-claude-1',
      executor: 'claude',
      firstMessage: 'refactor auth',
    });
  });

  it('preselects initialWorkspaceId (sidebar workspace-row "+" entry)', async () => {
    const { onCreate } = renderView({ initialWorkspaceId: 'ws-2' });
    await screen.findByTestId('ns-agent-picker');
    expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'go');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-2',
      name: '',
      agentId: 'agent-codex-1',
      executor: 'codex',
      firstMessage: 'go',
    });
  });

  it('preselects initialAgentId (⌘J/⌘K shortcut carries the agent choice)', async () => {
    const { onCreate } = renderView({ initialAgentId: 'agent-claude-1' });
    expect(await screen.findByTestId('ns-agent-picker')).toHaveTextContent('Claude Code');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'go');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      agentId: 'agent-claude-1',
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
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'go');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-2' }));
  });

  it('"+ New workspace" stashes the draft and jumps to the Workspaces sheet', async () => {
    const { onNewWorkspace } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(within(document.querySelector('.catalog-options-pop') as HTMLElement).getByRole('switch', { name: 'Fast' }));
    await userEvent.type(screen.getByTestId('ns-title-input'), 'Draft title');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'draft keeps me');
    await userEvent.click(screen.getByTestId('ns-workspace-chip'));
    await userEvent.click(screen.getByTestId('ns-workspace-new'));
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
    const draft = JSON.parse(localStorage.getItem(newSessionDraftStorageKey({
      kind: 'workspace',
      id: 'ws-1',
    })) ?? 'null');
    expect(draft).toMatchObject({
      sessionName: 'Draft title',
      message: 'draft keeps me',
      executor: 'codex',
      serviceTier: 'fast',
    });
    expect(localStorage.getItem('gian.new-session.return.v1')).toBe('1');
  });

  it('restores the stashed draft on the return trip', async () => {
    const key = newSessionDraftStorageKey({ kind: 'workspace', id: 'ws-2' });
    localStorage.setItem(key, JSON.stringify({
      workspaceId: 'ws-2',
      sessionName: 'Backlog cleanup',
      message: 'back from the sheet',
      executor: 'codex',
      model: 'gpt-5',
      serviceTier: 'fast',
    }));
    renderView({ initialWorkspaceId: 'ws-2' });
    expect(screen.getByTestId('ns-title-input')).toHaveValue('Backlog cleanup');
    expect(screen.getByTestId('ns-message-input')).toHaveValue('back from the sheet');
    // A legacy (executor-only) draft resolves to the kind's ready Agent once
    // the agents list lands — wait for the async pick.
    await waitFor(
      () => expect(screen.getByTestId('ns-agent-picker')).toHaveTextContent('Codex'),
      { timeout: 5_000 },
    );
    expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5'));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('Fast'));
    // Navigation drafts remain until creation succeeds; merely reopening the
    // page is not a destructive read.
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toMatchObject({
      sessionName: 'Backlog cleanup',
      message: 'back from the sheet',
    });
  });

  it('keeps independent drafts per Workspace and reopens the last active one', async () => {
    vi.mocked(loadAgents).mockResolvedValue([agent('kimi', 'Kimi Code')]);

    const alpha = renderView({ initialWorkspaceId: 'ws-1' });
    await screen.findByTestId('ns-agent-picker');
    await userEvent.type(screen.getByTestId('ns-title-input'), 'Alpha draft');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'work in alpha');
    alpha.unmount();

    const beta = renderView({ initialWorkspaceId: 'ws-2' });
    await screen.findByTestId('ns-agent-picker');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('');
    expect(screen.getByTestId('ns-message-input')).toHaveValue('');
    await userEvent.type(screen.getByTestId('ns-title-input'), 'Beta draft');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'work in beta');
    beta.unmount();

    // Header "+" has no explicit Workspace. It returns to the Workspace draft
    // that was actually in the foreground when the user navigated away.
    const active = renderView();
    await screen.findByText('Kimi Code');
    expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('Beta draft');
    expect(screen.getByTestId('ns-message-input')).toHaveValue('work in beta');
    active.unmount();

    renderView({ initialWorkspaceId: 'ws-1' });
    await screen.findByText('Kimi Code');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('Alpha draft');
    expect(screen.getByTestId('ns-message-input')).toHaveValue('work in alpha');
  });

  it('keeps independent drafts per Task even when they share a Workspace', async () => {
    vi.mocked(loadAgents).mockResolvedValue([agent('kimi', 'Kimi Code')]);

    const first = renderView({ draftScope: { kind: 'task', id: 'task-1' } });
    await screen.findByTestId('ns-agent-picker');
    await userEvent.type(screen.getByTestId('ns-title-input'), 'Task one draft');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'first task work');
    first.unmount();

    const second = renderView({ draftScope: { kind: 'task', id: 'task-2' } });
    await screen.findByTestId('ns-agent-picker');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'second task work');
    second.unmount();

    renderView({ draftScope: { kind: 'task', id: 'task-1' } });
    await screen.findByText('Kimi Code');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('Task one draft');
    expect(screen.getByTestId('ns-message-input')).toHaveValue('first task work');
  });

  it('accepts an attachment-only screenshot draft and submits its original Blob', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    await act(async () => {
      await storeNewSessionScreenshot(
        { kind: 'workspace', id: 'ws-1' },
        {
          id: 'capture-new-session',
          target: {
            kind: 'new-session',
            scope: { kind: 'workspace', id: 'ws-1' },
            label: 'Alpha',
          },
          filename: 'screenshot.png',
          mime: 'image/png',
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
      );
    });

    expect(await screen.findByText('screenshot.png')).toBeInTheDocument();
    expect(screen.getByTestId('ns-send')).toBeEnabled();
    await userEvent.click(screen.getByTestId('ns-send'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const input = onCreate.mock.calls[0]![0];
    expect(input).toMatchObject({
      workspaceId: 'ws-1',
      agentId: 'agent-codex-1',
      executor: 'codex',
      firstMessage: '',
      firstAttachments: [{
        id: 'capture-new-session',
        name: 'screenshot.png',
        mime: 'image/png',
        size: 4,
      }],
    });
    expect(input.firstAttachments[0].blob).toBeInstanceOf(Blob);
    expect(input.firstAttachments[0].blob.size).toBe(4);
  });

  it('stages a pasted image as an attachment chip and submits its Blob', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));

    const pasted = new File([new Uint8Array([0x89, 0x50])], '', { type: 'image/png' });
    fireEvent.paste(screen.getByTestId('ns-message-input'), {
      clipboardData: {
        items: [
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
          { kind: 'file', type: 'image/png', getAsFile: () => pasted },
        ],
      },
    });

    // Unnamed screenshots get a fabricated paste-<ts>.png name (Composer parity).
    expect(await screen.findByText(/^paste-.*\.png$/)).toBeInTheDocument();
    expect(screen.getByTestId('ns-send')).toBeEnabled();
    await userEvent.click(screen.getByTestId('ns-send'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const input = onCreate.mock.calls[0]![0];
    expect(input.firstMessage).toBe('');
    expect(input.firstAttachments).toHaveLength(1);
    expect(input.firstAttachments[0]).toMatchObject({ mime: 'image/png', size: 2 });
    expect(input.firstAttachments[0].name).toMatch(/^paste-.*\.png$/);
    expect(input.firstAttachments[0].blob).toBeInstanceOf(Blob);
  });

  it('ignores a text-only paste (no chip, normal paste passes through)', async () => {
    renderView();
    await screen.findByTestId('ns-agent-picker');
    fireEvent.paste(screen.getByTestId('ns-message-input'), {
      clipboardData: {
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      },
    });
    expect(screen.queryByTestId('new-session-screenshots')).toBeNull();
  });

  it('stages picked files (including non-images) and submits their Blobs', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));

    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'spec.pdf', { type: 'application/pdf' });
    const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('ns-file-input'), { target: { files: [pdf, image] } });

    expect(await screen.findByText('spec.pdf')).toBeInTheDocument();
    expect(await screen.findByText('shot.png')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('ns-send'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const input = onCreate.mock.calls[0]![0];
    expect(input.firstAttachments).toHaveLength(2);
    expect(input.firstAttachments.map((a: { name: string }) => a.name)).toEqual(['spec.pdf', 'shot.png']);
    expect(input.firstAttachments[0]).toMatchObject({ mime: 'application/pdf', size: 4 });
    expect(input.firstAttachments[0].blob).toBeInstanceOf(Blob);
  });

  it('renders a file icon (no thumbnail) for non-image attachments', async () => {
    renderView();
    await screen.findByTestId('ns-agent-picker');
    const pdf = new File([new Uint8Array([0x25])], 'notes.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('ns-file-input'), { target: { files: [pdf] } });

    const chip = (await screen.findByText('notes.pdf')).closest('.att-chip') as HTMLElement;
    expect(chip.querySelector('.att-file-icon')).not.toBeNull();
    expect(chip.querySelector('.att-thumb')).toBeNull();
    expect(chip.querySelector('.att-size')).toHaveTextContent('1 B');
  });

  it('opens the app lightbox when an image attachment thumbnail is clicked', async () => {
    const zoomImage = vi.fn();
    render(
      <LocaleProvider locale="en">
        <ImageZoomContext.Provider value={zoomImage}>
          <NewSessionView
            workspaces={[workspace('ws-1', 'Alpha'), workspace('ws-2', 'Beta')]}
            onNewWorkspace={vi.fn()}
            onCreate={vi.fn()}
            onCancel={vi.fn()}
            creating={false}
          />
        </ImageZoomContext.Provider>
      </LocaleProvider>,
    );
    await screen.findByTestId('ns-agent-picker');

    const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('ns-file-input'), { target: { files: [image] } });

    const chip = (await screen.findByText('shot.png')).closest('.att-chip') as HTMLElement;
    // The thumb button appears once the async Blob preview resolves.
    const thumbBtn = await within(chip).findByRole('button', { name: 'shot.png' });
    await userEvent.click(thumbBtn);
    expect(zoomImage).toHaveBeenCalledWith('blob:new-session-screenshot', 'shot.png');
  });

  it('rejects files over 20 MB with a visible error and keeps Send disabled', async () => {
    renderView();
    await screen.findByTestId('ns-agent-picker');
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'huge.bin', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByTestId('ns-file-input'), { target: { files: [big] } });

    expect(await screen.findByTestId('new-session-attachment-error')).toHaveTextContent('20 MB');
    expect(screen.queryByTestId('new-session-screenshots')).toBeNull();
    expect(screen.getByTestId('ns-send')).toBeDisabled();
  });

  it('removing an attachment chip clears it from the persisted draft', async () => {
    renderView();
    await screen.findByTestId('ns-agent-picker');
    await act(async () => {
      await storeNewSessionAttachment(
        { kind: 'workspace', id: 'ws-1' },
        { name: 'draft.png', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) },
      );
    });
    expect(await screen.findByText('draft.png')).toBeInTheDocument();

    const chip = screen.getByText('draft.png').closest('.att-chip') as HTMLElement;
    await userEvent.click(within(chip).getByRole('button', { name: 'Remove attachment' }));
    expect(screen.queryByText('draft.png')).toBeNull();
    const draft = JSON.parse(localStorage.getItem(newSessionDraftStorageKey({
      kind: 'workspace',
      id: 'ws-1',
    })) ?? 'null');
    expect(draft?.screenshotAttachments ?? []).toEqual([]);
  });

  it('restores staged attachments when reopening the Workspace draft', async () => {
    const first = renderView();
    await screen.findByTestId('ns-agent-picker');
    const pdf = new File([new Uint8Array([0x25, 0x50])], 'keep.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('ns-file-input'), { target: { files: [pdf] } });
    expect(await screen.findByText('keep.pdf')).toBeInTheDocument();
    first.unmount();

    renderView({ initialWorkspaceId: 'ws-1' });
    expect(await screen.findByText('keep.pdf')).toBeInTheDocument();
  });

  it('renders capability chips for the picked agent and sends explicit choices', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    // The single summary shows only model / effort; Fast appears only when on.
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5 Codex'));
    expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('Medium');
    expect(screen.getByTestId('ns-model-chip')).not.toHaveTextContent('Fast');
    expect(screen.getByTestId('ns-mode-chip')).toHaveTextContent('Ask for approval');

    await userEvent.click(screen.getByTestId('ns-model-chip'));
    let options = document.querySelector('.catalog-options-pop') as HTMLElement;
    const fast = within(options).getByRole('switch', { name: 'Fast' });
    expect(fast).not.toBeChecked();
    await userEvent.click(fast);
    expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('Fast');
    await userEvent.click(
      within(options).getByText('GPT-5', { selector: '.mp-row-title' }),
    );
    expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5');
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    options = document.querySelector('.catalog-options-pop') as HTMLElement;
    await userEvent.click(
      within(options).getByText('Medium', { selector: '.mp-row-title' }),
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
      agentId: 'agent-codex-1',
      executor: 'codex',
      firstMessage: 'do the thing',
      model: 'gpt-5',
      thinkingEffort: 'medium',
      approvalMode: 'auto',
      serviceTier: 'fast',
    });
  });

  it('disables and clears Fast when the catalog says the selected model lacks it', async () => {
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      protocolVersion: '2.0',
      catalogRevision: 'codex-fast-by-model',
      capabilities: {},
      models: [],
      modes: [],
      input: [{ type: 'text' }],
      slashCommands: [],
      configOptions: [{
        id: 'model',
        displayName: 'Model',
        binding: 'turn',
        role: 'model',
        control: 'select',
        required: false,
        defaultValue: 'gpt-5-codex',
        choices: [
          { value: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
          { value: 'gpt-5', displayName: 'GPT-5' },
        ],
      }, {
        id: 'service_tier',
        displayName: 'Fast',
        binding: 'turn',
        role: 'fast',
        control: 'boolean',
        required: false,
        defaultValue: false,
        enabledWhen: [{ optionId: 'model', oneOf: ['gpt-5-codex'] }],
      }],
    });
    renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    await userEvent.click(await screen.findByTestId('ns-model-chip'));
    const options = document.querySelector('.catalog-options-pop') as HTMLElement;
    const fast = within(options).getByRole('switch', { name: 'Fast' });
    expect(fast).toBeEnabled();
    await userEvent.click(fast);
    await userEvent.click(within(options).getByText('GPT-5', { selector: '.mp-row-title' }));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).not.toHaveTextContent('Fast'));

    await userEvent.click(screen.getByTestId('ns-model-chip'));
    expect(within(document.querySelector('.catalog-options-pop') as HTMLElement)
      .getByRole('switch', { name: 'Fast' })).toBeDisabled();
  });

  it('leaves model/effort/mode out of the payload unless explicitly picked', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5 Codex'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'defaults please');
    await userEvent.click(screen.getByTestId('ns-send'));
    // The host applies its configured defaults — the payload must not invent
    // capability-list guesses.
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      agentId: 'agent-codex-1',
      executor: 'codex',
      firstMessage: 'defaults please',
    });
  });

  it('does not carry leftover Claude effort onto a Kimi catalog that only advertises on', async () => {
    vi.mocked(loadAgents).mockResolvedValue([
      agent('claude', 'Claude Code'),
      agent('kimi', 'Kimi Code'),
    ]);
    vi.mocked(loadProxyModels).mockResolvedValue([{
      id: 'sonnet',
      model: 'sonnet',
      displayName: 'Sonnet',
      description: '',
      hidden: false,
      isDefault: true,
      defaultEffort: 'medium',
      supportedEfforts: ['low', 'medium', 'high'],
    }]);
    vi.mocked(loadProxyCapabilities).mockImplementation(async (executor) => {
      if (executor !== 'kimi') {
        return { protocolVersion: 'test', models: [], modes: [], slashCommands: [] };
      }
      return {
        protocolVersion: '2.0',
        catalogRevision: 'kimi-on',
        capabilities: {},
        input: [{ type: 'text' }],
        slashCommands: [],
        configOptions: [
          {
            id: 'model',
            displayName: 'Model',
            binding: 'turn',
            role: 'model',
            control: 'select',
            required: false,
            defaultValue: 'kimi-code/kimi-for-coding',
            choices: [
              { value: 'kimi-code/kimi-for-coding', displayName: 'Kimi for Coding' },
              { value: 'kimi-code/k3', displayName: 'K3' },
            ],
          },
          {
            id: 'thinking',
            displayName: 'Thinking',
            binding: 'turn',
            role: 'effort',
            control: 'select',
            required: false,
            defaultValue: 'on',
            choices: [{ value: 'on', displayName: 'On' }],
          },
        ],
      };
    });
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-claude-1'));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('Sonnet'));
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(
      within(document.querySelector('.catalog-options-pop') as HTMLElement).getByText('Low', { selector: '.mp-row-title' }),
    );
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-kimi-1'));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('On'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'test kimi');
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    const kimiMenu = document.querySelector('.catalog-options-pop') as HTMLElement;
    expect(within(kimiMenu).getByText('Kimi for Coding')).toBeInTheDocument();
    expect(within(kimiMenu).getByText('K3')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledTimes(1);
    const payload = onCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.executor).toBe('kimi');
    expect(payload.thinkingEffort).toBeUndefined();
    expect(payload.turnConfig).toBeUndefined();
  });

  it('remembers the last workspace / agent / chips as the next defaults', async () => {
    const first = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5 Codex'));
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(
      within(document.querySelector('.catalog-options-pop') as HTMLElement).getByText('GPT-5', { selector: '.mp-row-title' }),
    );
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(within(document.querySelector('.catalog-options-pop') as HTMLElement).getByRole('switch', { name: 'Fast' }));
    await userEvent.click(screen.getByTestId('ns-workspace-chip'));
    await userEvent.click(screen.getByTestId('ns-workspace-option-ws-2'));
    await userEvent.type(screen.getByTestId('ns-title-input'), 'One-off title');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'first run');
    await userEvent.click(screen.getByTestId('ns-send'));
    // NewSessionView only submits; CodingView owns the operation result and
    // clears this Workspace draft after the create run is confirmed.
    clearNewSessionDraft({ kind: 'workspace', id: 'ws-2' });
    first.unmount();

    const second = renderView();
    await waitFor(() => {
      expect(screen.getByTestId('ns-agent-picker')).toHaveTextContent('Codex');
      expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    });
    // A title belongs only to the session being created; unlike workspace,
    // agent, and capability choices, it must never become a next-open default.
    expect(screen.getByTestId('ns-title-input')).toHaveValue('');
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5'));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('Fast'));
    await userEvent.type(screen.getByTestId('ns-message-input'), 'second run');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(second.onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-2',
      name: '',
      agentId: 'agent-codex-1',
      executor: 'codex',
      firstMessage: 'second run',
      model: 'gpt-5',
      serviceTier: 'fast',
    });
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
