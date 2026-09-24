// Coverage for SES-001 (issue #57, chat-panel layout) — NewSessionView
// mirrors the session chat panel: the transcript area stays empty except for
// create errors; agent + workspace selectors sit above a two-row composer
// whose optional title precedes the required first message. The composer bar
// carries model / thinking / mode chips that follow the picked agent, plus a
// Codex-only Fast toggle. Attachments align with the session Composer: image
// paste, a file picker for arbitrary files, and global Desktop captures all
// stage Blobs in the pre-session IndexedDB store (20 MB cap) and are uploaded
// into the Session after it is created; image thumbnails zoom through the
// app-level ImageLightbox (ImageZoomContext), same as the Composer's chips. Send stays disabled until an agent is
// picked (multi-agent) and a message typed;
// a single ready agent auto-selects into a static chip. Chip choices are
// explicit-only in the payload; the last used workspace/agent/chips are
// remembered for the next open. The workspace drop is Codex-style (search +
// "+ New workspace" jump to the Workspaces sheet) — the page never creates
// workspaces inline. There is no dedicated screenshot button in this surface.

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
import { remoteRequest, type RemoteEnvironmentCatalog } from '../src/remote-environments.js';
import {
  clearNewSessionDraft,
  NewSessionView,
  newSessionDraftStorageKey,
} from '../src/views/new-session-view.js';
import { storeNewSessionAttachment, storeNewSessionScreenshot } from '../src/screenshot-drafts.js';
import { ImageZoomContext } from '../src/transcript/items.js';
import { typeInlineComposer } from './inline-composer-test-utils.js';
import { createOperationDispatcher } from '../src/operations/dispatcher.js';
import { createOperationStore } from '../src/operations/store.js';
import {
  OperationDispatcherProvider,
  OperationStoreProvider,
} from '../src/operations/use-operations.js';

const { pickResourcesMock, screenshotStartMock, desktopResourcesAvailable, desktopScreenshotAvailable } = vi.hoisted(() => ({
  pickResourcesMock: vi.fn(),
  screenshotStartMock: vi.fn(),
  desktopResourcesAvailable: { current: true },
  desktopScreenshotAvailable: { current: false },
}));

vi.mock('../src/desktop-bridge.js', () => ({
  desktopBridge: () => desktopResourcesAvailable.current
    ? {
        resources: { pick: pickResourcesMock },
        ...(desktopScreenshotAvailable.current
          ? { screenshot: { start: screenshotStartMock, setTarget: vi.fn(async () => true) } }
          : {}),
      }
    : undefined,
}));

vi.mock('../src/api.js', () => ({
  loadAgents: vi.fn(),
  peekAgents: vi.fn(() => null),
  loadProxyModels: vi.fn(),
  loadProxyCapabilities: vi.fn(),
  loadResolvedProxyCatalog: vi.fn(),
}));

vi.mock('../src/remote-environments.js', async () => ({
  ...await vi.importActual<typeof import('../src/remote-environments.js')>('../src/remote-environments.js'),
  remoteRequest: vi.fn(),
}));

const hostA = '11111111-1111-4111-8111-111111111111';
const hostB = '22222222-2222-4222-8222-222222222222';
const remoteAgentId = '33333333-3333-4333-8333-333333333333';
const hostChoices = { environments: [
  { id: hostA, name: 'Build Mac', host_id: 'host-a', server_origin: 'https://remote.example.com', pending: false, connected: true },
  { id: hostB, name: 'Office Mac', host_id: 'host-b', server_origin: 'https://remote.example.com', pending: false, connected: false },
] };
const remoteCatalog: RemoteEnvironmentCatalog = {
  catalog_revision: 'remote-1',
  agents: [{ id: remoteAgentId, name: 'Remote Codex', proxy: 'codex', readiness: 'ready' }],
  workspaces: [{ id: 'remote-workspace', name: 'Remote project' }],
};

function agent(kind: Executor, name: string, ready = true): UserAgentStatus {
  return {
    id: `agent-${kind}-1`,
    name,
    pluginId: kind as UserAgentStatus['pluginId'],
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
    runtimeProfile: null,
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
  const store = createOperationStore();
  const dispatcher = createOperationDispatcher({ store });
  const view = render(
    <LocaleProvider locale="en">
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          <NewSessionView
            workspaces={[workspace('ws-1', 'Alpha'), workspace('ws-2', 'Beta')]}
            onNewWorkspace={onNewWorkspace}
            onCreate={onCreate}
            onCancel={vi.fn()}
            creating={false}
            {...props}
          />
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    </LocaleProvider>,
  );
  return { onCreate, onNewWorkspace, unmount: view.unmount, container: view.container };
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
    delete window.gianDesktop;
    desktopResourcesAvailable.current = true;
    desktopScreenshotAvailable.current = false;
    vi.mocked(remoteRequest).mockImplementation(async <T,>(path: string): Promise<T> => {
      if (path === '/environments') return hostChoices as T;
      if (path === `/environments/${hostA}/catalog`) return remoteCatalog as T;
      if (path.includes('/agents/')) return {
        catalogRevision: 'remote-1', input: [{ type: 'text' }], configOptions: [], slashCommands: [], resolveSupported: false,
      } as T;
      throw new Error('Remote Host unavailable');
    });
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
    pickResourcesMock.mockResolvedValue({ resources: [], rejectedFiles: [] });
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:new-session-screenshot') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
  });

  it('places the Host picker before Agent and workspace, with connection controls inside its popover', async () => {
    const { container } = renderView();
    const row = await screen.findByTestId('ns-agent-row');
    const picker = within(row).getByRole('button', { name: 'Host: This Mac' });
    expect(row.firstElementChild).toBe(picker);
    expect(picker.closest('.main-head')).toBeNull();
    expect(container.querySelector('.remote-environment-toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect Host' })).toBeNull();
    fireEvent.click(picker);
    const popover = await screen.findByRole('dialog', { name: 'Host' });
    expect(await within(popover).findByRole('button', { name: /Build Mac/ })).toBeTruthy();
    fireEvent.click(within(popover).getByRole('button', { name: 'Connect Host' }));
    expect(within(popover).getByLabelText('Remote Server URL')).toBeTruthy();
    expect(within(popover).getByLabelText('Host name')).toBeTruthy();
    expect(within(popover).getByLabelText('Pairing code')).toBeTruthy();
    expect(within(popover).queryByRole('button', { name: /GitHub/ })).toBeNull();
    fireEvent.keyDown(popover, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Host' })).toBeNull();
    expect(document.activeElement).toBe(picker);
    expect(screen.getByTestId('ns-agent-row')).toBeTruthy();
  });

  it('clears the previous Host choices immediately and allows switching back while the next Host loads', async () => {
    let resolveOffice!: (catalog: RemoteEnvironmentCatalog) => void;
    const office = new Promise<RemoteEnvironmentCatalog>(resolve => { resolveOffice = resolve; });
    const previous = vi.mocked(remoteRequest).getMockImplementation()!;
    vi.mocked(remoteRequest).mockImplementation(<T,>(path: string, body?: unknown): Promise<T> =>
      path === `/environments/${hostB}/catalog` ? office as Promise<T> : previous(path, body) as Promise<T>);
    const { onCreate } = renderView();
    await screen.findByTestId('ns-agent-picker');
    fireEvent.click(screen.getByTestId('ns-host-picker'));
    fireEvent.click(await screen.findByRole('button', { name: /Build Mac/ }));
    await waitFor(() => expect(screen.getByTestId('ns-agent-picker').textContent).toContain('Remote Codex'));
    expect(screen.getByTestId('ns-workspace-chip').textContent).toContain('Remote project');
    fireEvent.click(screen.getByTestId('ns-host-picker'));
    fireEvent.click(screen.getByRole('button', { name: /Office Mac/ }));
    expect(screen.queryByTestId('ns-agent-picker')).toBeNull();
    expect(screen.queryByTestId('ns-workspace-chip')).toBeNull();
    expect(screen.getByTestId('ns-host-picker').textContent).toContain('Office Mac');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('ns-host-picker'));
    fireEvent.click(screen.getByRole('button', { name: /This Mac/ }));
    await waitFor(() => expect(screen.getByTestId('ns-workspace-chip').textContent).toContain('Alpha'));
    await act(async () => { resolveOffice(remoteCatalog); await office; });
    expect(screen.getByTestId('ns-host-picker').textContent).toContain('This Mac');
    expect(screen.getByTestId('ns-workspace-chip').textContent).toContain('Alpha');
    expect(screen.queryByText('Remote Codex')).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
    expect(vi.mocked(remoteRequest).mock.calls.filter(([path]) => path === '/environments')).toHaveLength(1);
  });

  it('keeps the Host picker available after a connection failure', async () => {
    renderView();
    fireEvent.click(screen.getByTestId('ns-host-picker'));
    fireEvent.click(await screen.findByRole('button', { name: /Office Mac/ }));
    expect(await screen.findByText('Waiting for the remote Gian connection and device confirmation.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ns-host-picker'));
    fireEvent.click(screen.getByRole('button', { name: /This Mac/ }));
    expect(await screen.findByTestId('ns-agent-picker')).toBeTruthy();
  });

  it('keeps takeover attached to the selected Host in the picker menu', async () => {
    const previous = vi.mocked(remoteRequest).getMockImplementation()!;
    vi.mocked(remoteRequest).mockImplementation(async <T,>(path: string, body?: unknown): Promise<T> => {
      if (path === `/environments/${hostA}/sessions`) return { sessions: [{
        id: 'remote-session', name: 'Existing task', workspace_id: 'remote-workspace',
        agent: { id: remoteAgentId, name: 'Remote Codex', proxy: 'codex' },
      }] } as T;
      return previous(path, body) as Promise<T>;
    });
    const { onCreate } = renderView();
    fireEvent.click(screen.getByTestId('ns-host-picker'));
    fireEvent.click(await screen.findByRole('button', { name: /Build Mac/ }));
    await screen.findByTestId('ns-agent-picker');
    fireEvent.click(screen.getByTestId('ns-host-picker'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue remote session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Existing task' }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      executionEnvironmentId: hostA, remoteSessionId: 'remote-session',
      agentId: `remote:${hostA}:${remoteAgentId}`, workspaceId: 'remote-workspace',
    }));
  });

  it('locks the Host choice while Session creation is in progress', () => {
    renderView({ creating: true });
    expect(screen.getByTestId('ns-host-picker')).toBeDisabled();
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
    const codexRow = screen.getByTestId('ns-agent-option-agent-codex-1');
    expect(codexRow.querySelector('img[src="/api/proxies/codex/logo/light"]')).toBeTruthy();
    expect(codexRow.querySelector('img[src="/api/proxies/codex/logo/dark"]')).toBeTruthy();
    await userEvent.click(codexRow);
    const picker = screen.getByTestId('ns-agent-picker');
    expect(picker.querySelector('.agent-logo')).toBeTruthy();
    expect(document.querySelector('[data-testid="ns-model-chip"] .agent-logo')).toBeNull();
  });

  it('hides disabled Agents from the picker and never auto-selects one', async () => {
    vi.mocked(loadAgents).mockResolvedValue([
      { ...agent('codex', 'Codex'), enabled: false },
      agent('claude', 'Claude Code'),
      agent('kimi', 'Kimi Code'),
    ]);
    renderView();
    await openAgentPicker();
    // Ready but disabled: not offered.
    expect(screen.queryByTestId('ns-agent-option-agent-codex-1')).toBeNull();
    expect(screen.getByTestId('ns-agent-option-agent-claude-1')).toBeEnabled();
    expect(screen.getByTestId('ns-agent-option-agent-kimi-1')).toBeEnabled();
  });

  it('does not default-select when every ready Agent is disabled', async () => {
    vi.mocked(loadAgents).mockResolvedValue([{ ...agent('codex', 'Codex'), enabled: false }]);
    renderView();
    // One ready-but-disabled Agent is not "exactly one usable agent": the chip
    // stays an unselected chooser and the drop offers nothing.
    const picker = await screen.findByTestId('ns-agent-picker');
    expect(picker).not.toHaveTextContent('Codex');
    await openAgentPicker();
    expect(screen.queryByTestId('ns-agent-option-agent-codex-1')).toBeNull();
  });

  it('allows an unverified Agent but shows its red consequence warning', async () => {
    const codex = agent('codex', 'Codex');
    codex.runtimeProfile = {
      id: 'profile-unverified',
      agentId: codex.id,
      pluginId: 'codex',
      runtimeId: 'codex',
      path: '/bin/codex',
      version: '0.147.0',
      configHome: '/Users/test/.codex',
      contentFingerprint: 'runtime-new',
      verifiedVersions: ['0.146.0'],
      verification: 'unverified',
    };
    codex.skill = { name: 'gian-session', version: '0.2.8', state: 'ready' };
    vi.mocked(loadAgents).mockResolvedValue([codex]);
    renderView();
    expect(await screen.findByTestId('ns-runtime-unverified')).toHaveTextContent(
      /has not completed full regression/i,
    );
    expect(screen.getByTestId('ns-agent-picker')).toHaveTextContent('Codex');
  });

  it('matches the main Composer control order and has no screenshot button', async () => {
    window.gianDesktop = {
      screenshot: {
        setTarget: vi.fn(async () => true),
      },
    } as typeof window.gianDesktop;
    const view = renderView();
    try {
      await openAgentPicker();
      await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
      await screen.findByTestId('ns-thinking-chip');
      await screen.findByTestId('ns-fast-chip');

      const bar = document.querySelector('.composer-bar') as HTMLElement;
      const order = Array.from(bar.children).map(element => (
        element.classList.contains('spacer') ? 'spacer'
          : element.classList.contains('cmp-control-sep') ? 'separator'
            : element.getAttribute('data-testid')
      ));
      expect(order).toEqual([
        'ns-model-chip',
        'separator',
        'ns-thinking-chip',
        'separator',
        'ns-fast-chip',
        'spacer',
        'ns-mode-chip',
        'ns-attach-button',
        'ns-send',
      ]);
      expect(bar.querySelector('.cmp-bulb')).toBeNull();
      expect(bar.querySelector('.cmp-caret')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Screenshot' })).toBeNull();
    } finally {
      view.unmount();
      delete window.gianDesktop;
    }
  });

  it('falls back to the browser file input when Desktop folder picking is unavailable', async () => {
    desktopResourcesAvailable.current = false;
    renderView();
    const input = screen.getByTestId('ns-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');

    await userEvent.click(screen.getByRole('button', { name: 'Add context' }));
    expect(screen.getByText('Folder references require Gian Desktop')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Screenshot' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Files/ }));

    expect(click).toHaveBeenCalledTimes(1);
    expect(pickResourcesMock).not.toHaveBeenCalled();
  });

  it('starts a Desktop screenshot from the add menu when the bridge supports it', async () => {
    desktopScreenshotAvailable.current = true;
    screenshotStartMock.mockResolvedValue({ ok: true });
    renderView();

    await userEvent.click(screen.getByRole('button', { name: 'Add context' }));
    await userEvent.click(screen.getByRole('button', { name: 'Screenshot' }));

    await waitFor(() => expect(screenshotStartMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Files and folders' })).toBeNull();
    expect(screen.queryByTestId('new-session-attachment-error')).toBeNull();
  });

  it('hides the screenshot menu item when the bridge has no screenshot API', async () => {
    renderView();

    await userEvent.click(screen.getByRole('button', { name: 'Add context' }));

    expect(screen.getByRole('button', { name: 'Files and folders' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Screenshot' })).toBeNull();
  });

  it('surfaces the busy error when a screenshot is already in progress', async () => {
    desktopScreenshotAvailable.current = true;
    screenshotStartMock.mockResolvedValue({ ok: false, error: 'busy' });
    renderView();

    await userEvent.click(screen.getByRole('button', { name: 'Add context' }));
    await userEvent.click(screen.getByRole('button', { name: 'Screenshot' }));

    expect(await screen.findByTestId('new-session-attachment-error'))
      .toHaveTextContent('A screenshot is already in progress.');
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
      {
        id: 'workspace_policy',
        displayName: 'Workspace Policy',
        binding: 'session' as const,
        control: 'select' as const,
        required: false,
        defaultValue: 'safe',
        choices: [{ value: 'safe', displayName: 'Safe' }],
      },
    ];
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      protocolVersion: '2.0',
      catalogRevision: 'catalog-1',
      specialCatalogs: { model: 'workspace_mode' },
      input: [{ type: 'text' }],
      configOptions: options,
      slashCommands: [],
      capabilities: { 'catalog.resolve': 1 },
      models: [],
      modes: [],
    });
    vi.mocked(loadResolvedProxyCatalog).mockResolvedValue({
      catalogRevision: 'catalog-1',
      specialCatalogs: { model: 'workspace_mode' },
      input: [{ type: 'text' }],
      configOptions: options,
      slashCommands: [],
      resolvedDefaults: { sessionConfig: {}, turnConfig: {} },
    });

    renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    const select = await screen.findByLabelText('Workspace Dynamic');
    expect(await screen.findByLabelText('Workspace Policy')).toBeInTheDocument();
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

  it('keeps an explicit session-bound special value and sends its resolved turn defaults', async () => {
    const dsh = agent('dsh', 'DeepSeek Harness');
    const options = [
      {
        id: 'workspace_mode', displayName: 'Workspace Mock', binding: 'session' as const,
        control: 'select' as const, required: false, defaultValue: 'default',
        choices: [
          { value: 'default', displayName: 'Default' },
          { value: 'strict', displayName: 'Strict' },
        ],
      },
      {
        id: 'model', displayName: 'Mock Model', binding: 'session' as const, role: 'model',
        control: 'select' as const, required: true, defaultValue: 'mock-sonnet',
        choices: [
          { value: 'mock-sonnet', displayName: 'Mock Sonnet' },
          { value: 'mock-vision', displayName: 'Mock Vision' },
        ],
      },
      {
        id: 'mock_trace', displayName: 'Mock Trace', binding: 'turn' as const,
        control: 'boolean' as const, required: false, defaultValue: false,
        visibleWhen: [{ optionId: 'model', oneOf: ['mock-vision'] }],
      },
    ];
    vi.mocked(loadAgents).mockResolvedValue([dsh]);
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      protocolVersion: '2.3',
      catalogRevision: 'catalog-session-model',
      specialCatalogs: { model: 'model' },
      input: [{ type: 'text' }],
      configOptions: options,
      slashCommands: [],
      capabilities: { 'catalog.resolve': 1 },
      models: [],
      modes: [],
    });
    vi.mocked(loadResolvedProxyCatalog).mockResolvedValue({
      catalogRevision: 'catalog-session-model',
      specialCatalogs: { model: 'model' },
      input: [{ type: 'text' }],
      configOptions: options,
      slashCommands: [],
      resolvedDefaults: { sessionConfig: {}, turnConfig: { mock_trace: true } },
    });

    const { onCreate } = renderView({ initialAgentId: dsh.id });
    await userEvent.selectOptions(await screen.findByLabelText('Workspace Mock'), 'strict');
    await userEvent.selectOptions(await screen.findByLabelText('Mock Model'), 'mock-vision');
    await waitFor(() => {
      expect(screen.getByTestId('ns-catalog-options')).toHaveTextContent('Mock Trace: true');
    });

    typeInlineComposer(screen.getByTestId('ns-message-input'), 'inspect');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      agentId: dsh.id,
      sessionConfig: { workspace_mode: 'strict', model: 'mock-vision' },
      turnConfig: { mock_trace: true },
      firstMessage: 'inspect',
    }));
  });

  it('shows DSH Catalog controls with Settings defaults without making them explicit', async () => {
    const dsh = agent('dsh', 'DeepSeek Harness');
    dsh.defaults = {
      model: 'deepseek-reasoner',
      thinking: 'high',
      mode: '',
    };
    vi.mocked(loadAgents).mockResolvedValue([dsh]);
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      protocolVersion: '2.0',
      catalogRevision: 'dsh-v2',
      input: [{ type: 'text' }],
      configOptions: [
        {
          id: 'provider',
          displayName: 'Provider',
          binding: 'turn',
          control: 'select',
          required: false,
          defaultValue: 'deepseek-official',
          choices: [
            { value: 'deepseek-official', displayName: 'DeepSeek' },
            { value: 'opencode-go', displayName: 'opencode-go' },
          ],
        },
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
    expect(await screen.findByTestId('ns-catalog-options')).toHaveTextContent('Provider: DeepSeek');
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('DeepSeek Reasoner'));
    expect(screen.getByTestId('ns-thinking-chip')).toHaveTextContent('High');
    expect(screen.queryByTestId('ns-mode-chip')).toBeNull();

    typeInlineComposer(screen.getByTestId('ns-message-input'), 'use configured defaults');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      agentId: 'agent-dsh-1',
      executor: 'dsh',
      firstMessage: 'use configured defaults',
    });
  });

  it('switches DSH Provider visibly and submits the resolved OpenCode config', async () => {
    const dsh = agent('dsh', 'DeepSeek Harness');
    vi.mocked(loadAgents).mockResolvedValue([dsh]);
    const providerOption = {
      id: 'provider', displayName: 'Provider', binding: 'turn' as const,
      control: 'select' as const, required: false, defaultValue: 'deepseek-official',
      choices: [
        { value: 'deepseek-official', displayName: 'DeepSeek' },
        { value: 'opencode-go', displayName: 'opencode-go' },
      ],
    };
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      protocolVersion: '2.1',
      catalogRevision: 'dsh-base',
      input: [{ type: 'text' }],
      configOptions: [
        providerOption,
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
      capabilities: { 'catalog.resolve': 1 },
      models: [],
      modes: [],
    });
    vi.mocked(loadResolvedProxyCatalog).mockResolvedValue({
      catalogRevision: 'dsh-opencode',
      input: [{ type: 'text' }],
      configOptions: [
        { ...providerOption, defaultValue: 'opencode-go' },
        {
          id: 'model', displayName: 'Model', binding: 'turn', role: 'model',
          control: 'select', required: true, defaultValue: 'deepseek-v4-flash',
          choices: [{ value: 'deepseek-v4-flash', displayName: 'opencode-DS V4 Flash' }],
        },
        {
          id: 'effort', displayName: 'Reasoning effort', binding: 'turn', role: 'effort',
          control: 'select', required: false, defaultValue: 'off',
          choices: [{ value: 'off', displayName: 'Off' }],
        },
      ],
      slashCommands: [],
      resolvedDefaults: {
        sessionConfig: {},
        turnConfig: { provider: 'opencode-go', model: 'deepseek-v4-flash', effort: 'off' },
      },
    });

    const { onCreate } = renderView({ initialAgentId: 'agent-dsh-1' });
    const provider = await screen.findByTestId('ns-catalog-options');
    expect(provider).toHaveTextContent('Provider: DeepSeek');
    await userEvent.click(provider);
    await userEvent.click(await screen.findByTestId('catalog-option-provider-opencode-go'));
    await waitFor(() => expect(loadResolvedProxyCatalog).toHaveBeenCalledWith('dsh', {
      catalogRevision: 'dsh-base',
      sessionConfig: {},
      turnConfig: { provider: 'opencode-go' },
    }, 'agent-dsh-1'));
    await waitFor(() => {
      expect(screen.getByTestId('ns-catalog-options')).toHaveTextContent('Provider: opencode-go');
      expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('opencode-DS V4 Flash');
      expect(screen.getByTestId('ns-thinking-chip')).toHaveTextContent('Off');
    });

    typeInlineComposer(screen.getByTestId('ns-message-input'), 'use OpenCode');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: '',
      agentId: 'agent-dsh-1',
      executor: 'dsh',
      model: 'deepseek-v4-flash',
      thinkingEffort: 'off',
      turnConfig: {
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
        effort: 'off',
      },
      firstMessage: 'use OpenCode',
    });
  });

  it('keeps Send disabled until an agent is picked and a message typed (multi-agent)', async () => {
    renderView();
    const send = screen.getByTestId('ns-send');
    await screen.findByTestId('ns-agent-picker');
    // Message alone is not enough — no agent selected yet.
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'fix the bug');
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
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'summarize this repo');
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
    expect(title.nextElementSibling).toContainElement(message);
    await userEvent.type(title, '  Auth cleanup  ');
    typeInlineComposer(screen.getByTestId('ns-message-input'), '  refactor auth  ');
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
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'go');
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
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'go');
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
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'go');
    await userEvent.click(screen.getByTestId('ns-send'));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-2' }));
  });

  it('"+ New workspace" stashes the draft and jumps to the Workspaces sheet', async () => {
    const { onNewWorkspace } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    await userEvent.click(screen.getByTestId('ns-fast-chip'));
    await userEvent.type(screen.getByTestId('ns-title-input'), 'Draft title');
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'draft keeps me');
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

  it('seeds the composer with a one-shot initialMessage when no draft exists', async () => {
    renderView({ initialMessage: 'I want to create a Gian scheduled task.' });
    expect(screen.getByTestId('ns-message-input'))
      .toHaveTextContent('I want to create a Gian scheduled task.');
  });

  it('keeps a restored draft message over the one-shot initialMessage', async () => {
    localStorage.setItem(newSessionDraftStorageKey({ kind: 'workspace', id: 'ws-2' }), JSON.stringify({
      workspaceId: 'ws-2',
      message: 'back from the sheet',
    }));
    renderView({ initialWorkspaceId: 'ws-2', initialMessage: 'I want to create a Gian scheduled task.' });
    expect(screen.getByTestId('ns-message-input')).toHaveTextContent('back from the sheet');
    expect(screen.getByTestId('ns-message-input'))
      .not.toHaveTextContent('I want to create a Gian scheduled task.');
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
    expect(screen.getByTestId('ns-message-input')).toHaveTextContent('back from the sheet');
    // A legacy (executor-only) draft resolves to the kind's ready Agent once
    // the agents list lands — wait for the async pick.
    await waitFor(
      () => expect(screen.getByTestId('ns-agent-picker')).toHaveTextContent('Codex'),
      { timeout: 5_000 },
    );
    expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5'));
    expect(screen.getByTestId('ns-fast-chip')).toHaveAttribute('aria-pressed', 'true');
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
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'work in alpha');
    alpha.unmount();

    const beta = renderView({ initialWorkspaceId: 'ws-2' });
    await screen.findByTestId('ns-agent-picker');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('');
    expect(screen.getByTestId('ns-message-input')).toHaveTextContent('');
    await userEvent.type(screen.getByTestId('ns-title-input'), 'Beta draft');
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'work in beta');
    beta.unmount();

    // Header "+" has no explicit Workspace. It returns to the Workspace draft
    // that was actually in the foreground when the user navigated away.
    const active = renderView();
    await screen.findByText('Kimi Code');
    expect(screen.getByTestId('ns-workspace-chip')).toHaveTextContent('Beta');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('Beta draft');
    expect(screen.getByTestId('ns-message-input')).toHaveTextContent('work in beta');
    active.unmount();

    renderView({ initialWorkspaceId: 'ws-1' });
    await screen.findByText('Kimi Code');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('Alpha draft');
    expect(screen.getByTestId('ns-message-input')).toHaveTextContent('work in alpha');
  });

  it('keeps independent drafts per Task even when they share a Workspace', async () => {
    vi.mocked(loadAgents).mockResolvedValue([agent('kimi', 'Kimi Code')]);

    const first = renderView({ draftScope: { kind: 'task', id: 'task-1' } });
    await screen.findByTestId('ns-agent-picker');
    await userEvent.type(screen.getByTestId('ns-title-input'), 'Task one draft');
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'first task work');
    first.unmount();

    const second = renderView({ draftScope: { kind: 'task', id: 'task-2' } });
    await screen.findByTestId('ns-agent-picker');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('');
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'second task work');
    second.unmount();

    renderView({ draftScope: { kind: 'task', id: 'task-1' } });
    await screen.findByText('Kimi Code');
    expect(screen.getByTestId('ns-title-input')).toHaveValue('Task one draft');
    expect(screen.getByTestId('ns-message-input')).toHaveTextContent('first task work');
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

  it('stages a pasted image as an inline reference and submits its Blob', async () => {
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
        getData: () => '',
        types: ['text/plain'],
        files: [],
      },
    });
    expect(screen.queryByTestId('new-session-screenshots')).toBeNull();
  });

  it('stages long pasted text and folder paths as first-message context', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    const pasted = Array.from({ length: 10 }, (_, index) => `context ${index}`).join('\n');
    fireEvent.paste(screen.getByTestId('ns-message-input'), {
      clipboardData: { items: [], getData: () => pasted, types: ['text/plain'], files: [] },
    });
    expect(document.querySelector('.composer-inline-reference[data-reference-type="context"]'))
      .not.toBeNull();

    pickResourcesMock.mockResolvedValue({
      resources: [{ type: 'folder', path: '/tmp/reference-folder', name: 'reference-folder' }],
      rejectedFiles: [],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add context' }));
    await userEvent.click(screen.getByRole('button', { name: 'Files and folders' }));
    expect(await screen.findByText('reference-folder')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('ns-send'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      firstMessage: '',
      contextItems: [
        { type: 'pastedText', text: pasted, lineCount: 10 },
        { type: 'folder', path: '/tmp/reference-folder', name: 'reference-folder' },
      ],
    });
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

  it('opens a non-image attachment preview from its inline reference', async () => {
    renderView();
    await screen.findByTestId('ns-agent-picker');
    const pdf = new File([new Uint8Array([0x25])], 'notes.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('ns-file-input'), { target: { files: [pdf] } });

    // 2026-09-10 owner call: chips preview on hover; a plain click is a no-op.
    const chip = await screen.findByText('notes.pdf');
    await userEvent.click(chip);
    expect(screen.queryByTestId('new-session-screenshots')).toBeNull();
    await userEvent.hover(chip);
    const pop = await screen.findByTestId('new-session-screenshots');
    expect(pop.querySelector('.ref-pop-thumb')).toBeNull();
    expect(pop.querySelector('.ref-pop-meta')).toHaveTextContent('1 B');
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

    // 2026-09-10 owner call: a chip click zooms straight to the lightbox once
    // the blob preview has resolved (hover first to await it).
    const chip = await screen.findByText('shot.png');
    await userEvent.hover(chip);
    const pop = await screen.findByTestId('new-session-screenshots');
    await within(pop).findByRole('img', { name: 'shot.png' });
    await userEvent.unhover(chip);
    await userEvent.click(chip);
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

  it('removing an attachment from its inline-reference preview clears the draft', async () => {
    renderView();
    await screen.findByTestId('ns-agent-picker');
    await act(async () => {
      await storeNewSessionAttachment(
        { kind: 'workspace', id: 'ws-1' },
        { name: 'draft.png', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) },
      );
    });
    expect(await screen.findByText('draft.png')).toBeInTheDocument();

    await userEvent.click(screen.getByText('draft.png'));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove attachment' }));
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
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5 Codex'));
    expect(screen.getByTestId('ns-thinking-chip')).toHaveTextContent('Medium');
    expect(screen.getByTestId('ns-fast-chip')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('ns-mode-chip')).toHaveTextContent('Ask for approval');

    await userEvent.click(screen.getByTestId('ns-fast-chip'));
    expect(screen.getByTestId('ns-fast-chip')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(
      within(document.querySelector('.model-pop') as HTMLElement)
        .getByText('GPT-5', { selector: '.mp-row-title' }),
    );
    expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5');
    await userEvent.click(screen.getByTestId('ns-thinking-chip'));
    await userEvent.click(
      within(document.querySelector('.think-pop') as HTMLElement)
        .getByText('Medium', { selector: '.mp-row-title' }),
    );
    await userEvent.click(screen.getByTestId('ns-mode-chip'));
    await userEvent.click(
      within(document.querySelector('.approval-pop') as HTMLElement).getByText('Approve for me'),
    );

    typeInlineComposer(screen.getByTestId('ns-message-input'), 'do the thing');
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
    const fast = await screen.findByTestId('ns-fast-chip');
    expect(fast).toBeEnabled();
    await userEvent.click(fast);
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(
      within(document.querySelector('.model-pop') as HTMLElement)
        .getByText('GPT-5', { selector: '.mp-row-title' }),
    );
    await waitFor(() => expect(screen.getByTestId('ns-fast-chip')).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.getByTestId('ns-fast-chip')).toBeDisabled();
  });

  it('leaves model/effort/mode out of the payload unless explicitly picked', async () => {
    const { onCreate } = renderView();
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-codex-1'));
    await waitFor(() => expect(screen.getByTestId('ns-model-chip')).toHaveTextContent('GPT-5 Codex'));
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'defaults please');
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
    await userEvent.click(screen.getByTestId('ns-thinking-chip'));
    await userEvent.click(
      within(document.querySelector('.think-pop') as HTMLElement)
        .getByText('Low', { selector: '.mp-row-title' }),
    );
    await openAgentPicker();
    await userEvent.click(screen.getByTestId('ns-agent-option-agent-kimi-1'));
    await waitFor(() => expect(screen.getByTestId('ns-thinking-chip')).toHaveTextContent('On'));
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'test kimi');
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    const kimiMenu = document.querySelector('.model-pop') as HTMLElement;
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
      within(document.querySelector('.model-pop') as HTMLElement)
        .getByText('GPT-5', { selector: '.mp-row-title' }),
    );
    await userEvent.click(screen.getByTestId('ns-fast-chip'));
    await userEvent.click(screen.getByTestId('ns-workspace-chip'));
    await userEvent.click(screen.getByTestId('ns-workspace-option-ws-2'));
    await userEvent.type(screen.getByTestId('ns-title-input'), 'One-off title');
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'first run');
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
    expect(screen.getByTestId('ns-fast-chip')).toHaveAttribute('aria-pressed', 'true');
    typeInlineComposer(screen.getByTestId('ns-message-input'), 'second run');
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
