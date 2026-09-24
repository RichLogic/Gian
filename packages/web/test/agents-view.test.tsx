import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProductExecutor,
  ManagedRuntimeGeneration,
  ProxyCatalogEntry,
  ProxyCatalogItem,
  ProxyCatalogList,
  ProxyCapabilities,
  UserAgentStatus,
} from '@gian/shared';
import { AgentsView, __resetIntegrationInstallTerminals } from '../src/views/AgentsView.js';
import { __resetCatalogDocCache } from '../src/agents/ProxyDetailPanel.js';
import { renderWithOperations } from './operation-test-utils.js';
import { Toaster } from '../src/components/Toaster.js';
import { __resetFeedback } from '../src/feedback.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { localizeCatalogItem } from '../src/agents/catalog-model.js';
import * as api from '../src/api.js';

// Agents page = My Agents + shared Agent Integrations, driven by the
// Host catalog projection (catalog.items) and the open pluginId contract.

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadAgents: vi.fn(),
    loadProxies: vi.fn(),
    loadProxyCatalog: vi.fn(),
    loadCatalogDocument: vi.fn(),
    loadAgentDraftDefaults: vi.fn(),
    loadManagedRuntimeStatus: vi.fn(),
    loadProxyCapabilities: vi.fn(),
    loadResolvedProxyCatalog: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    checkAgentProxyUpdate: vi.fn(),
    installAgentCli: vi.fn(),
    installAgentProxy: vi.fn(),
    pickAgentCliPath: vi.fn(),
    pickAgentHome: vi.fn(),
    syncProxyCatalog: vi.fn(),
    installCatalogProxy: vi.fn(),
    installManagedRuntime: vi.fn(),
    updateCatalogProxy: vi.fn(),
    rollbackCatalogProxy: vi.fn(),
    uninstallIntegration: vi.fn(),
  };
});

let seq = 0;

function catalogItem(overrides: {
  pluginId: string;
  displayName?: string;
  tagline?: string;
  compatibility?: Partial<ProxyCatalogItem['compatibility']>;
  installation?: Partial<ProxyCatalogItem['installation']>;
  runtime?: Partial<ProxyCatalogItem['runtime']>;
  availableActions?: ProxyCatalogItem['availableActions'];
}): ProxyCatalogItem {
  const pluginId = overrides.pluginId;
  return {
    pluginId,
    displayName: overrides.displayName ?? pluginId,
    tagline: overrides.tagline ?? `${pluginId} tagline`,
    logo: {
      light: `/api/proxies/${pluginId}/logo/light`,
      dark: `/api/proxies/${pluginId}/logo/dark`,
    },
    documentation: {
      overview: `/api/proxies/${pluginId}/docs/overview`,
      setup: `/api/proxies/${pluginId}/docs/setup`,
      usage: `/api/proxies/${pluginId}/docs/usage`,
      troubleshooting: `/api/proxies/${pluginId}/docs/troubleshooting`,
    },
    compatibility: {
      state: 'compatible',
      hostVersions: ['2.1', '2.0'],
      protocolRange: '^2.0',
      reason: null,
      ...overrides.compatibility,
    },
    installation: {
      state: 'not_installed',
      installedVersion: null,
      latestVersion: '1.0.0',
      updateAvailable: false,
      source: null,
      ...overrides.installation,
    },
    runtime: {
      state: 'not_required',
      displayName: null,
      ...overrides.runtime,
    },
    availableActions: overrides.availableActions ?? ['install_proxy'],
  };
}

const READY = catalogItem({
  pluginId: 'io.acme.ready',
  displayName: 'Acme Ready',
  installation: { state: 'installed', installedVersion: '1.0.0', latestVersion: '1.0.0', source: 'gian-official' },
  availableActions: ['create_agent'],
});
const INSTALLABLE = catalogItem({
  pluginId: 'io.acme.installable',
  displayName: 'Acme Installable',
  availableActions: ['install_proxy'],
});
const MANAGED_INSTALLABLE = catalogItem({
  pluginId: 'io.acme.managed',
  displayName: 'Acme Managed',
  runtime: { state: 'setup_required', displayName: 'Acme CLI' },
  availableActions: ['install_runtime'],
});
const UNTRUSTED_MANAGED = catalogItem({
  pluginId: 'io.acme.legacy',
  displayName: 'Acme Legacy',
  installation: {
    state: 'quarantined', installedVersion: '0.9.0', latestVersion: '1.0.0',
    updateAvailable: true, source: null,
  },
  runtime: { state: 'setup_required', displayName: 'Acme CLI' },
  availableActions: ['install_runtime'],
});
const NEEDS_APP = catalogItem({
  pluginId: 'io.acme.needs-app',
  displayName: 'Acme Needs App',
  compatibility: { state: 'requires_app_update', reason: 'requires gian.proxy/2.2', protocolRange: '^2.2' },
  availableActions: [],
});
const NEEDS_PROXY = catalogItem({
  pluginId: 'io.acme.needs-proxy',
  displayName: 'Acme Needs Proxy',
  compatibility: { state: 'requires_proxy_update', reason: 'supports only 2.0', protocolRange: '2.0' },
  availableActions: [],
});
const UPDATABLE = catalogItem({
  pluginId: 'io.acme.updatable',
  displayName: 'Acme Updatable',
  installation: {
    state: 'installed', installedVersion: '1.0.0', latestVersion: '1.2.0',
    updateAvailable: true, source: 'gian-official',
  },
  availableActions: ['update_proxy', 'create_agent'],
});

const CATALOG_ITEMS = [READY, INSTALLABLE, NEEDS_APP, NEEDS_PROXY, UPDATABLE];

function catalogList(items: ProxyCatalogItem[] = CATALOG_ITEMS): ProxyCatalogList {
  return {
    source: { id: 'gian-official', sequence: 7, state: 'ready', error: null },
    items,
  };
}

const LEGACY_PROXIES: ProxyCatalogEntry[] = [
  { id: 'claude' as ProductExecutor, name: 'Claude Code', logo: { light: '/l.png', dark: '/d.png' }, tagline: 'Claude kind', officialInstallUrl: 'https://example.invalid/claude' },
];

function agent(overrides: Partial<UserAgentStatus>): UserAgentStatus {
  seq += 1;
  return {
    id: overrides.id ?? `agent-${seq}`,
    name: overrides.name ?? `Agent ${seq}`,
    pluginId: overrides.pluginId ?? 'claude',
    proxy: overrides.proxy !== undefined ? overrides.proxy : 'claude',
    ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
    home: overrides.home !== undefined ? overrides.home : { kind: 'managed', path: '/Users/test/.gian/homes/claude/a-1' },
    cliPath: overrides.cliPath !== undefined ? overrides.cliPath : '/bin/claude',
    defaults: overrides.defaults ?? { model: '', thinking: '', mode: '' },
    proxyName: overrides.proxyName ?? 'Claude Code',
    ready: overrides.ready ?? true,
    cli: overrides.cli ?? { state: 'ready', path: '/bin/claude', version: '1.0.0', source: 'path' },
    plugin: overrides.plugin ?? {
      state: 'ready', path: '/proxy/claude', version: '0.1.0', source: 'development',
      defaults: { model: '', thinking: '', mode: '' },
    },
    runtimeProfile: overrides.runtimeProfile ?? null,
    officialInstallUrl: overrides.officialInstallUrl ?? 'https://example.invalid/claude',
  };
}

function capabilities(): ProxyCapabilities {
  return {
    protocolVersion: '0.1.0',
    models: [{
      id: 'm1', model: 'm1', displayName: 'M1', description: '', hidden: false, isDefault: true,
      defaultEffort: 'high', supportedEfforts: ['high'],
    }],
    modes: [{ id: 'ask', label: 'Ask', description: '', isDefault: true }],
    slashCommands: [],
  } as ProxyCapabilities;
}

function mockApi(agents: UserAgentStatus[], catalog: ProxyCatalogList | Error = catalogList()) {
  vi.mocked(api.loadAgents).mockResolvedValue(agents);
  vi.mocked(api.loadProxies).mockResolvedValue(LEGACY_PROXIES);
  if (catalog instanceof Error) {
    vi.mocked(api.loadProxyCatalog).mockRejectedValue(catalog);
  } else {
    vi.mocked(api.loadProxyCatalog).mockResolvedValue({
      proxies: LEGACY_PROXIES,
      catalog,
    });
  }
  vi.mocked(api.loadCatalogDocument).mockImplementation(async url => {
    if (url.includes('/docs/overview')) {
      return '# Overview\n\nWelcome. [safe](https://example.com/docs) [bad](javascript:alert(1))';
    }
    if (url.includes('/docs/usage')) {
      return '## Usage\n\nDo the thing. [safe](https://example.com/docs) [bad](javascript:alert(1))';
    }
    if (url.includes('/docs/setup')) return '## Setup\n\nInstall it.';
    if (url.includes('/docs/troubleshooting')) return '## Troubleshooting\n\nRestart it.';
    return null;
  });
  vi.mocked(api.loadAgentDraftDefaults).mockResolvedValue({ name: 'Claude Code', cliPath: null });
  vi.mocked(api.loadManagedRuntimeStatus).mockImplementation(async pluginId => ({
    pluginId,
    active: null,
    staged: [],
  }));
  vi.mocked(api.loadProxyCapabilities).mockResolvedValue(capabilities());
  vi.mocked(api.loadResolvedProxyCatalog).mockResolvedValue(capabilities() as never);
  vi.mocked(api.createAgent).mockImplementation(async input => agent({
    name: input.name,
    pluginId: input.pluginId ?? 'claude',
    proxy: null,
    cliPath: input.cliPath ?? null,
  }));
  vi.mocked(api.updateAgent).mockImplementation(async (id, patch) => agent({
    id, name: patch.name ?? 'Agent', pluginId: 'claude',
  }));
  vi.mocked(api.deleteAgent).mockResolvedValue(undefined);
  vi.mocked(api.pickAgentHome).mockResolvedValue('/Users/test/custom-home');
  vi.mocked(api.syncProxyCatalog).mockResolvedValue(catalogList());
  vi.mocked(api.installCatalogProxy).mockResolvedValue({ pluginId: 'io.acme.installable', pluginVersion: '1.0.0' });
  vi.mocked(api.installManagedRuntime).mockResolvedValue({} as never);
  vi.mocked(api.updateCatalogProxy).mockResolvedValue({ pluginId: 'io.acme.updatable', pluginVersion: '1.2.0' });
  vi.mocked(api.rollbackCatalogProxy).mockResolvedValue({ pluginId: 'io.acme.updatable', pluginVersion: '1.0.0' });
  vi.mocked(api.uninstallIntegration).mockResolvedValue({
    removedAgents: 0,
    removedRuntime: true,
    removedProxy: true,
  });
}

function renderAgents() {
  return renderWithOperations(
    <>
      <Toaster />
      <AgentsView />
    </>,
  );
}

/** Query-aware viewport mock for the 1100px detail-swap boundary. */
function mockViewport({ narrow = false }: { narrow?: boolean; phone?: boolean } = {}) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1100px') && narrow,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('AgentsView (My Agents + Agent Integrations)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seq = 0;
    __resetFeedback();
    __resetCatalogDocCache();
    __resetIntegrationInstallTerminals();
    delete (window as { gianDesktop?: unknown }).gianDesktop;
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('keeps a page-level refresh action that syncs the Catalog and reloads Agents', async () => {
    mockApi([]);
    renderAgents();

    const refresh = await screen.findByTestId('agents-page-refresh');
    fireEvent.click(refresh);
    await waitFor(() => expect(api.syncProxyCatalog).toHaveBeenCalledTimes(1));
    // The confirmed sync reloads both projections (initial load + refresh).
    await waitFor(() => expect(vi.mocked(api.loadProxyCatalog).mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(vi.mocked(api.loadAgents).mock.calls.length).toBeGreaterThan(1));
    // No Integrations-subhead refresh button anymore.
    expect(screen.queryByTestId('agent-integrations-refresh')).toBeNull();
  });

  it('renders lean Integration rows: logo, name, and status badges only', async () => {
    mockApi([]);
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.installable');
    expect(within(card).getByText('Acme Installable')).toBeTruthy();
    expect(within(card).queryByText('io.acme.installable tagline')).toBeNull();
    expect(within(card).queryByLabelText('View Integration')).toBeNull();
    // The whole row opens the detail.
    fireEvent.click(within(card).getByTestId('catalog-open-io.acme.installable'));
    expect(await screen.findByTestId('proxy-detail-panel')).toBeTruthy();
  });

  it('opens a Workspace-style Add Agent dialog without replacing the Agents page', async () => {
    mockApi([agent({ name: 'Writer' })]);
    renderAgents();
    expect(await screen.findByText(/My Agents · 1/)).toBeTruthy();
    expect(screen.getByText(/Agent Integrations · 5/)).toBeTruthy();
    expect(screen.getByTestId('agent-integrations-list')).toBeTruthy();
    expect(screen.queryByTestId('proxy-catalog-list')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
    expect(screen.getByTestId('agent-integrations-list')).toBeTruthy();
    expect(screen.queryByTestId('proxy-catalog-list')).toBeNull();
    expect(screen.queryByTestId('agent-draft-panel')).toBeNull();
    const integration = within(dialog).getByRole('combobox', { name: 'Agent Integration' });
    expect(within(integration).getAllByRole('option')).toHaveLength(1);
    expect(within(integration).getByRole('option', { name: 'Acme Ready' })).toBeTruthy();
    expect(within(integration).queryByRole('option', { name: 'Acme Installable' })).toBeNull();
    expect(within(integration).queryByRole('option', { name: 'Acme Updatable' })).toBeNull();
  });

  it('opens a My Agent Integration on the home management surface', async () => {
    mockApi([agent({
      id: 'shared-agent',
      name: 'Shared Agent',
      pluginId: 'io.acme.ready',
      proxy: null,
    })]);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Shared Agent/ }));
    const agentPanel = await screen.findByTestId('agents-detail-panel');
    // The Integration jump is a header icon button, not an in-body row.
    const jump = within(agentPanel.querySelector('.p2-head') as HTMLElement)
      .getByTestId('agent-open-integration');
    expect(agentPanel.textContent).not.toContain('Agent Integration');
    fireEvent.click(jump);
    expect(await screen.findByTestId('proxy-detail-panel')).toBeTruthy();
    expect(screen.getByTestId('agent-integrations-list')).toBeTruthy();
    expect(screen.queryByTestId('proxy-catalog-list')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
  });

  it('gates install by Host availableActions and shows the incompatibility reason', async () => {
    mockApi([]);
    renderAgents();
    const installable = await screen.findByTestId('catalog-item-io.acme.installable');
    fireEvent.click(within(installable).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const install = within(panel).getByTestId('proxy-action-install');
    expect((install as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(install);
    await waitFor(() => expect(api.installCatalogProxy)
      .toHaveBeenCalledWith('io.acme.installable'));
    expect((await within(panel).findByTestId('proxy-install-terminal')).getAttribute('data-status'))
      .toBe('completed');
    // A confirmed install refreshes the projection.
    await waitFor(() => expect(vi.mocked(api.loadProxyCatalog).mock.calls.length).toBeGreaterThan(1));

    fireEvent.click(within(panel).getByLabelText('Close'));
    const needsApp = await screen.findByTestId('catalog-item-io.acme.needs-app');
    fireEvent.click(within(needsApp).getByTestId(/^catalog-open-/));
    const appPanel = await screen.findByTestId('proxy-detail-panel');
    expect(within(appPanel).queryByTestId('proxy-action-install')).toBeNull();
    expect(within(appPanel).getByText(/requires a newer Gian App/)).toBeTruthy();
    expect(within(appPanel).getByText(/requires gian\.proxy\/2\.2/)).toBeTruthy();

    fireEvent.click(within(appPanel).getByLabelText('Close'));
    const needsProxy = await screen.findByTestId('catalog-item-io.acme.needs-proxy');
    fireEvent.click(within(needsProxy).getByTestId(/^catalog-open-/));
    const proxyPanel = await screen.findByTestId('proxy-detail-panel');
    expect(within(proxyPanel).getByText(/too old for this Gian App/)).toBeTruthy();
  });

  it('requires installation in Agent Integrations before an Agent can be created', async () => {
    mockApi([], catalogList([MANAGED_INSTALLABLE]));
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    expect(within(dialog).getByText(/Install an Agent Integration/)).toBeTruthy();
    expect((within(dialog).getByTestId('agent-create-save') as HTMLButtonElement).disabled).toBe(true);
    expect(api.installManagedRuntime).not.toHaveBeenCalled();
    expect(api.createAgent).not.toHaveBeenCalled();
  });

  it('opens an Integration installation TTY and streams real Host progress', async () => {
    mockApi([], catalogList([MANAGED_INSTALLABLE]));
    let finishInstall: (generation: ManagedRuntimeGeneration) => void = () => undefined;
    const installation = new Promise<ManagedRuntimeGeneration>(resolve => { finishInstall = resolve; });
    vi.mocked(api.installManagedRuntime).mockImplementation((_pluginId, _agentId, onProgress) => {
      onProgress?.({ stage: 'catalog', status: 'started' });
      onProgress?.({ stage: 'catalog', status: 'completed' });
      onProgress?.({
        stage: 'runtime-download', status: 'started', componentId: 'acme-cli', version: '1.0.0',
        receivedBytes: 0, totalBytes: 100,
      });
      onProgress?.({
        stage: 'runtime-download', status: 'progress', componentId: 'acme-cli', version: '1.0.0',
        receivedBytes: 50, totalBytes: 100,
      });
      return installation;
    });
    renderAgents();
    const row = await screen.findByTestId('catalog-item-io.acme.managed');
    fireEvent.click(within(row).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    fireEvent.click(within(panel).getByTestId('proxy-action-install-runtime'));

    const terminal = await within(panel).findByTestId('proxy-install-terminal');
    expect(terminal.getAttribute('data-status')).toBe('running');
    expect(within(terminal).getByRole('log').textContent).toContain('Checking the signed Catalog');
    expect(within(terminal).getByRole('log').textContent)
      .toContain('Downloading acme-cli 1.0.0: 50%');
    fireEvent.click(within(terminal).getByRole('button', { name: 'Hide' }));
    fireEvent.click(await within(panel).findByTestId('proxy-install-terminal-show'));
    expect(await within(panel).findByTestId('proxy-install-terminal')).toBeTruthy();

    await act(async () => finishInstall({} as ManagedRuntimeGeneration));
    await waitFor(() => expect(
      within(panel).getByTestId('proxy-install-terminal').getAttribute('data-status'),
    ).toBe('completed'));
    expect(within(panel).getByRole('log').textContent).toContain('Installation completed successfully');
  });

  it('keeps an untrusted Proxy with no Runtime installable only from Agent Integrations', async () => {
    mockApi([], catalogList([UNTRUSTED_MANAGED]));
    renderAgents();
    const integration = await screen.findByTestId('catalog-item-io.acme.legacy');
    expect(within(integration).getByText('Not installed')).toBeTruthy();
    fireEvent.click(within(integration).getByTestId('catalog-open-io.acme.legacy'));
    const detail = await screen.findByTestId('proxy-detail-panel');
    expect(within(detail).getByTestId('proxy-action-install-runtime').textContent).toBe('Install');
    expect(within(detail).queryByTestId('proxy-action-create-agent')).toBeNull();
    fireEvent.click(within(detail).getByLabelText('Close'));
    fireEvent.click(screen.getByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    expect(within(dialog).queryByRole('option', { name: 'Acme Legacy' })).toBeNull();
  });

  it('keeps installed-only local leftovers out of Integrations and Add Agent', async () => {
    const orphan = catalogItem({
      pluginId: 'grok',
      installation: {
        state: 'installed', installedVersion: '0.2.3', latestVersion: null,
        updateAvailable: false, source: null,
      },
      runtime: { state: 'ready' },
      availableActions: ['create_agent'],
    });
    mockApi([], catalogList([READY, orphan]));
    renderAgents();
    expect(await screen.findByText(/Agent Integrations · 1/)).toBeTruthy();
    expect(screen.queryByTestId('catalog-item-grok')).toBeNull();
    fireEvent.click(screen.getByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    expect(within(dialog).getByRole('option', { name: 'Acme Ready' })).toBeTruthy();
    expect(within(dialog).queryByRole('option', { name: 'grok' })).toBeNull();
  });

  it('shows the update action in the footer and runs it', async () => {
    mockApi([]);
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.updatable');
    fireEvent.click(within(card).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const footer = panel.querySelector('.p2-foot') as HTMLElement;
    const update = within(footer).getByTestId('proxy-action-update');
    expect(update.closest('.p2-head')).toBeNull();
    expect(panel.querySelector('.proxy-tools')).toBeNull();
    fireEvent.click(update);
    await waitFor(() => expect(api.updateCatalogProxy)
      .toHaveBeenCalledWith('io.acme.updatable'));
    expect((await within(panel).findByTestId('proxy-install-terminal')).getAttribute('data-status'))
      .toBe('completed');
  });

  it('renders Install in the footer only when installable, and no footer without actions', async () => {
    mockApi([], catalogList([INSTALLABLE, NEEDS_APP]));
    renderAgents();
    fireEvent.click(within(await screen.findByTestId('catalog-item-io.acme.installable'))
      .getByTestId(/^catalog-open-/));
    let panel = await screen.findByTestId('proxy-detail-panel');
    let footer = panel.querySelector('.p2-foot') as HTMLElement;
    expect(within(footer).getByTestId('proxy-action-install')).toBeTruthy();
    // Install and Uninstall are mutually exclusive.
    expect(within(footer).queryByTestId('proxy-action-uninstall')).toBeNull();
    fireEvent.click(within(panel).getByLabelText('Close'));

    fireEvent.click(within(await screen.findByTestId('catalog-item-io.acme.needs-app'))
      .getByTestId(/^catalog-open-/));
    panel = await screen.findByTestId('proxy-detail-panel');
    expect(panel.querySelector('.p2-foot')).toBeNull();
  });

  it('lays Basic out as a status summary plus a Runtime path row', async () => {
    mockApi([agent({ pluginId: READY.pluginId, proxy: null })], catalogList([{ ...READY, installation: {
      ...READY.installation, latestVersion: '9.0.0', updateAvailable: true,
    } }]));
    vi.mocked(api.loadManagedRuntimeStatus).mockResolvedValue({
      pluginId: 'io.acme.ready',
      active: {
        schemaVersion: 1,
        generationId: 'io.acme.ready-1.0.0-darwin-arm64',
        pluginId: 'io.acme.ready',
        platform: 'darwin-arm64',
        proxy: {
          pluginVersion: '1.0.0',
          manifestSha256: 'a'.repeat(64),
          artifactSha256: 'b'.repeat(64),
          entryPath: '/Users/test/.gian/plugins/io.acme.ready/1.0.0/spawn.js',
          processScope: 'shared',
          protocolRange: '^2.0',
        },
        runtime: {
          runtimeId: 'acme-cli',
          version: '2.3.0',
          artifactSha256: 'c'.repeat(64),
          entryPath: '/Users/test/.gian/runtimes/acme-cli/2.3.0/bin/acme',
          ownership: 'managed',
        },
        companions: [{
          id: 'helper',
          version: '4.5.0',
          artifactSha256: 'd'.repeat(64),
          entryPath: '/Users/test/.gian/runtimes/helper/4.5.0/bin/helper',
        }],
        certificate: { id: 'cert-1', sha256: 'e'.repeat(64) },
        state: 'active',
        installedAt: '2026-09-14T00:00:00.000Z',
        activatedAt: '2026-09-14T00:00:01.000Z',
      } as ManagedRuntimeGeneration,
      staged: [],
    });
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const basic = within(panel).getByTestId('proxy-basic-information');
    await waitFor(() => expect(basic.textContent)
      .toContain('/Users/test/.gian/runtimes/acme-cli/2.3.0/bin/acme'));

    // Two tiers: a status summary (CLI · Proxy versions + installation badge)
    // and the Runtime path row with its copy button. No kv-grid labels, no
    // action row — actions live in the header (Refresh) and footer.
    expect(basic.querySelector('dl')).toBeNull();
    expect(panel.querySelector('.proxy-tools')).toBeNull();
    expect(within(basic).queryByTestId('proxy-action-refresh')).toBeNull();
    expect(within(basic).queryByTestId('proxy-action-uninstall')).toBeNull();
    const summary = basic.querySelector('.proxy-basic-summary') as HTMLElement;
    expect(summary.textContent).toContain('2.3.0');
    expect(summary.textContent).toContain('1.0.0');
    expect(summary.textContent).not.toContain('9.0.0');
    expect(summary.textContent).not.toContain('Development source');
    expect(basic.textContent).not.toContain('/bin/claude');
    expect(summary.querySelector('[data-badge="update-required"]')).toBeTruthy();
    const pathRow = basic.querySelector('.proxy-basic-path') as HTMLElement;
    expect(within(pathRow).getByLabelText('Copy')).toBeTruthy();
    expect(basic.textContent).not.toContain('darwin-arm64');
    expect(summary.textContent).not.toContain('io.acme.ready');
    expect(basic.textContent).not.toContain('shared');
    expect(basic.textContent).not.toContain('helper');
    expect(panel.textContent).not.toContain('io.acme.ready tagline');
    expect(panel.textContent).not.toContain('Current Runtime state is up to date');
    expect(api.loadCatalogDocument).not.toHaveBeenCalledWith('/api/proxies/io.acme.ready/docs/overview');
  });

  it('does not present a Catalog target or quarantined Proxy as installed', async () => {
    mockApi([agent({ pluginId: 'io.acme.unrelated', proxy: null })],
      catalogList([MANAGED_INSTALLABLE, UNTRUSTED_MANAGED]));
    renderAgents();
    for (const id of ['io.acme.managed', 'io.acme.legacy']) {
      fireEvent.click(within(await screen.findByTestId(`catalog-item-${id}`)).getByTestId(/^catalog-open-/));
      const panel = await screen.findByTestId('proxy-detail-panel');
      const basic = within(panel).getByTestId('proxy-basic-information');
      expect(within(basic).getByLabelText('Runtime version').textContent).toBe('Not installed');
      expect(within(basic).getByLabelText('Proxy version').textContent).toBe('Not installed');
      expect(basic.textContent).not.toContain('1.0.0');
      expect(basic.textContent).not.toContain('0.9.0');
      expect(within(basic).queryByLabelText('Copy')).toBeNull();
      fireEvent.click(within(panel).getByLabelText('Close'));
    }
  });

  it('labels actual source-development versions in Web without a Desktop bridge', async () => {
    const local = agent({ pluginId: 'io.acme.managed', proxy: null,
      cli: { state: 'ready', path: '/dev/bin/runtime', version: '2.5.0', source: 'path' },
      plugin: { state: 'ready', path: '/dev/proxy.mjs', version: '0.3.1', source: 'development',
        defaults: { model: '', thinking: '', mode: '' } },
    });
    mockApi([local], catalogList([MANAGED_INSTALLABLE]));
    renderAgents();
    fireEvent.click(within(await screen.findByTestId('catalog-item-io.acme.managed')).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const basic = within(panel).getByTestId('proxy-basic-information');
    expect(within(basic).getByLabelText('Runtime version').textContent).toBe('2.5.0');
    expect(within(basic).getByLabelText('Proxy version').textContent).toBe('0.3.1');
    expect(within(basic).getByText('Development source')).toBeTruthy();
    expect(within(basic).getByText('/dev/bin/runtime')).toBeTruthy();
    expect(within(panel).getByText('Development version')).toBeTruthy();
    expect(within(panel).queryByText('Installed version')).toBeNull();
  });

  it('loads Catalog 1.8 history in Version updates without dropping tutorial documents', async () => {
    const catalog = catalogList([READY]);
    catalog.source.sequence = 8;
    mockApi([], catalog);
    const previous = vi.mocked(api.loadCatalogDocument).getMockImplementation()!;
    vi.mocked(api.loadCatalogDocument).mockImplementation(async url => url.endsWith('/overview')
      ? '## 0.3.1\n\nReleased September 20.\n\n### Fixed\n\nPreserve session state.' : previous(url));
    renderAgents();
    fireEvent.click(within(await screen.findByTestId('catalog-item-io.acme.ready')).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const heading = within(panel).getByText('Version updates', { selector: '.s2-subhead' });
    const history = heading.closest('section')!;
    expect(await within(history).findByRole('heading', { name: '0.3.1' })).toBeTruthy();
    expect(within(history).getByText('Preserve session state.')).toBeTruthy();
    expect(within(panel).queryByText(/does not publish a release-indexed/)).toBeNull();
    for (const key of ['overview', 'setup', 'usage', 'troubleshooting']) {
      expect(api.loadCatalogDocument).toHaveBeenCalledWith(`/api/proxies/io.acme.ready/docs/${key}`);
    }
    expect(await within(panel).findByRole('heading', { name: 'Setup' })).toBeTruthy();
  });

  it('switches signed descriptions, tutorials and history with the UI locale without sharing cached text', async () => {
    const localized = structuredClone(READY);
    localized.localizations = {};
    for (const locale of ['en', 'zh-CN'] as const) localized.localizations[locale] = {
      displayName: locale === 'en' ? 'English Integration' : '中文集成',
      tagline: locale === 'en' ? 'English summary' : '中文简介',
      documentation: Object.fromEntries(Object.entries(READY.documentation).map(([key, url]) =>
        [key, `${url}?locale=${locale}`])) as ProxyCatalogItem['documentation'],
    };
    expect(localizeCatalogItem(localized, 'en').tagline).toBe('English summary');
    expect(localizeCatalogItem(localized, 'zh-CN').tagline).toBe('中文简介');
    expect(localizeCatalogItem(READY, 'zh-CN')).toBe(READY);
    const catalog = catalogList([localized]);
    catalog.source.sequence = 9;
    mockApi([], catalog);
    vi.mocked(api.loadCatalogDocument).mockImplementation(async url => {
      const chinese = url.includes('locale=zh-CN');
      return url.includes('/overview') ? (chinese ? '# 中文版本日志' : '# English version history')
        : (chinese ? '中文教程正文' : 'English tutorial body');
    });
    const view = renderWithOperations(<LocaleProvider locale="en"><AgentsView /></LocaleProvider>);
    fireEvent.click(within(await screen.findByTestId('catalog-item-io.acme.ready')).getByTestId(/^catalog-open-/));
    expect(await screen.findByRole('heading', { name: 'English version history' })).toBeTruthy();
    expect(screen.getAllByText('English tutorial body')).toHaveLength(3);
    view.rerender(<LocaleProvider locale="zh-CN"><AgentsView /></LocaleProvider>);
    expect(screen.queryByRole('heading', { name: 'English version history' })).toBeNull();
    expect(await screen.findByRole('heading', { name: '中文版本日志' })).toBeTruthy();
    expect(screen.getAllByText('中文教程正文')).toHaveLength(3);
    expect(screen.queryByText('English tutorial body')).toBeNull();
    expect(api.loadCatalogDocument).toHaveBeenCalledWith('/api/proxies/io.acme.ready/docs/overview?locale=en');
    expect(api.loadCatalogDocument).toHaveBeenCalledWith('/api/proxies/io.acme.ready/docs/overview?locale=zh-CN');
    view.rerender(<LocaleProvider locale="en"><AgentsView /></LocaleProvider>);
    expect(await screen.findByRole('heading', { name: 'English version history' })).toBeTruthy();
    expect(screen.queryByText('中文教程正文')).toBeNull();
    expect(vi.mocked(api.loadCatalogDocument).mock.calls.filter(([url]) => url.endsWith('overview?locale=en'))).toHaveLength(1);
  });

  it.each([
    ['gian-official', 7], ['giandev', 8], ['gian-official', null],
  ])('does not relabel an older or unrelated overview as history (%s, %s)', async (id, sequence) => {
    const catalog = catalogList([READY]);
    catalog.source = { ...catalog.source, id: id as string, sequence: sequence as number | null };
    mockApi([], catalog);
    renderAgents();
    fireEvent.click(within(await screen.findByTestId('catalog-item-io.acme.ready')).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    expect(within(panel).getByText(/does not publish a release-indexed/)).toBeTruthy();
    expect(api.loadCatalogDocument).not.toHaveBeenCalledWith('/api/proxies/io.acme.ready/docs/overview');
  });

  it.each(['missing', 'error'] as const)('shows the history %s state instead of a permanent pending placeholder', async state => {
    const catalog = catalogList([READY]);
    catalog.source.sequence = 8;
    mockApi([], catalog);
    vi.mocked(api.loadCatalogDocument).mockImplementation(async url => {
      if (!url.endsWith('/overview')) return 'Tutorial';
      if (state === 'error') throw new Error('Network unavailable');
      return null;
    });
    renderAgents();
    fireEvent.click(within(await screen.findByTestId('catalog-item-io.acme.ready')).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const history = within(panel).getByText('Version updates', { selector: '.s2-subhead' }).closest('section')!;
    expect(await within(history).findByText(state === 'missing'
      ? 'This document is not available in the cached Catalog.' : 'The document could not be loaded.')).toBeTruthy();
  });

  it('syncs the Catalog and reloads all state from the header Refresh', async () => {
    mockApi([], catalogList([READY]));
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const refresh = within(panel.querySelector('.p2-head') as HTMLElement)
      .getByTestId('proxy-action-refresh');
    const catalogCalls = vi.mocked(api.loadProxyCatalog).mock.calls.length;
    const runtimeCalls = vi.mocked(api.loadManagedRuntimeStatus).mock.calls.length;
    fireEvent.click(refresh);
    await waitFor(() => expect(api.syncProxyCatalog).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(api.loadProxyCatalog).mock.calls.length)
      .toBeGreaterThan(catalogCalls));
    await waitFor(() => expect(vi.mocked(api.loadManagedRuntimeStatus).mock.calls.length)
      .toBeGreaterThan(runtimeCalls));
  });

  it('uninstalls an Integration after a confirm that names the linked Agent count', async () => {
    mockApi([
      agent({ id: 'a-1', name: 'One', pluginId: 'io.acme.ready', proxy: null }),
      agent({ id: 'a-2', name: 'Two', pluginId: 'io.acme.ready', proxy: null }),
    ], catalogList([READY]));
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    // Uninstall lives in the footer now; installed Integrations show it
    // instead of Install.
    const footer = panel.querySelector('.p2-foot') as HTMLElement;
    expect(within(footer).queryByTestId('proxy-action-install')).toBeNull();
    fireEvent.click(within(footer).getByTestId('proxy-action-uninstall'));

    const dialog = await screen.findByRole('alertdialog', { name: 'Uninstall this Integration?' });
    expect(dialog.textContent).toContain('2');
    expect(api.uninstallIntegration).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(api.uninstallIntegration).toHaveBeenCalledWith('io.acme.ready'));
    // A confirmed uninstall closes the detail and refreshes the projection.
    await waitFor(() => expect(screen.queryByTestId('proxy-detail-panel')).toBeNull());
    await waitFor(() => expect(vi.mocked(api.loadProxyCatalog).mock.calls.length).toBeGreaterThan(1));
  });

  it('keeps the detail open with the conflict notice when uninstall is refused', async () => {
    mockApi([
      agent({ id: 'a-1', name: 'Busy One', pluginId: 'io.acme.ready', proxy: null }),
    ], catalogList([READY]));
    vi.mocked(api.uninstallIntegration).mockRejectedValue(new Error(
      'INTEGRATION_UNINSTALL_BLOCKED:'
      + JSON.stringify([{ agentId: 'a-1', name: 'Busy One', runningSessions: 2 }]),
    ));
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    fireEvent.click(within(panel).getByTestId('proxy-action-uninstall'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Uninstall this Integration?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));

    expect(await within(panel).findByText(
      'Uninstall blocked — sessions are still in progress: Busy One (2)',
    )).toBeTruthy();
    expect(screen.getByTestId('proxy-detail-panel')).toBeTruthy();
  });

  it('renders three scroll anchors and sanitizes the continuous tutorial document', async () => {
    mockApi([]);
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    for (const section of ['basic', 'tutorial', 'versions']) {
      expect(within(panel).getByTestId(`proxy-anchor-${section}`)).toBeTruthy();
    }
    // Tutorial docs load and an unsafe link degrades to plain text.
    expect(await within(panel).findByText(/Do the thing\./)).toBeTruthy();
    const doc = within(panel).getAllByTestId('catalog-doc')
      .find(node => node.textContent?.includes('Do the thing.'))!;
    const links = doc.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com/docs');
    expect(doc.textContent).toContain('bad');

    expect(api.loadCatalogDocument).toHaveBeenCalledWith('/api/proxies/io.acme.ready/docs/usage');
  });

  it('creates an Agent from the modal with an autogenerated name and managed HOME', async () => {
    mockApi([agent({ name: 'Writer' })]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    expect(within(dialog).queryByLabelText('Name')).toBeNull();
    expect(within(dialog).getByLabelText('Create a new Gian-managed HOME')).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId('agent-create-save'));
    await waitFor(() => expect(api.createAgent).toHaveBeenCalledWith({
      name: 'Acme Ready',
      pluginId: 'io.acme.ready',
      home: { kind: 'managed' },
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Agent' })).toBeNull());
    expect(api.installManagedRuntime).not.toHaveBeenCalled();
    expect(api.installCatalogProxy).not.toHaveBeenCalled();
  });

  it('creates an Agent with a user-selected existing HOME', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    fireEvent.click(within(dialog).getByLabelText('Use an existing HOME'));
    const home = within(dialog).getByLabelText('HOME Path') as HTMLInputElement;
    expect(home.value).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: /Browse/ }));
    await waitFor(() => expect(home.value).toBe('/Users/test/custom-home'));
    fireEvent.click(within(dialog).getByTestId('agent-create-save'));
    await waitFor(() => expect(api.createAgent).toHaveBeenCalledWith({
      name: 'Acme Ready',
      pluginId: 'io.acme.ready',
      home: { kind: 'custom', path: '/Users/test/custom-home' },
    }));
  });

  it('Add Agent on an empty catalog opens a disabled modal and starts Catalog sync', async () => {
    mockApi([], catalogList([]));
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    expect(within(dialog).getByText(/Install an Agent Integration/)).toBeTruthy();
    expect((within(dialog).getByTestId('agent-create-save') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(api.syncProxyCatalog).toHaveBeenCalled());
  });

  it('uses Host legacy metadata only as a GianDev fallback when Catalog is empty', async () => {
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'development' };
    mockApi([], catalogList([]));
    renderAgents();
    const card = await screen.findByTestId('catalog-item-claude');
    expect(within(card).getByText('Claude Code')).toBeTruthy();
  });

  it('Add Agent on a populated catalog opens the modal without a redundant sync', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    expect(await screen.findByRole('dialog', { name: 'New Agent' })).toBeTruthy();
    expect(api.syncProxyCatalog).not.toHaveBeenCalled();
  });

  it('narrow windows keep the Agents page mounted behind the modal', async () => {
    mockViewport({ narrow: true, phone: false });
    mockApi([]);
    const { container } = renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    expect(container.querySelector('main.main')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(container.querySelector('main.main')).not.toBeNull();
  });

  it('shows a draggable main | panel-2 seam while the detail is open', async () => {
    mockApi([]);
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const seam = document.querySelector('[data-panel-seam="main-panel2"]') as HTMLElement;
    expect(seam).toBeTruthy();
    // The CSS clamp stays the baseline until the user drags; the first drag
    // pins an explicit width (440 default, right-side panel: left = wider).
    expect(panel.style.width).toBe('');
    fireEvent.mouseDown(seam, { button: 0, clientX: 900 });
    fireEvent.mouseMove(window, { clientX: 820 });
    fireEvent.mouseUp(window, { clientX: 820 });
    expect((await screen.findByTestId('proxy-detail-panel')).style.width).toBe('520px');
  });

  it('autogenerates a unique Agent name instead of exposing a name field', async () => {
    mockApi([agent({ name: 'Acme Ready' })]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    expect(within(dialog).queryByLabelText('Name')).toBeNull();
    fireEvent.click(within(dialog).getByTestId('agent-create-save'));
    await waitFor(() => expect(api.createAgent).toHaveBeenCalledWith({
      name: 'Acme Ready 2',
      pluginId: 'io.acme.ready',
      home: { kind: 'managed' },
    }));
  });

  it('narrow windows (900px) replace the list with the detail and Back returns', async () => {
    mockViewport({ narrow: true, phone: false });
    mockApi([agent({ name: 'Writer' })]);
    const { container } = renderAgents();
    await screen.findByText(/My Agents · 1/);
    fireEvent.click(screen.getByTestId('agent-row-agent-1'));
    const panel = await screen.findByTestId('agents-detail-panel');
    // The list column is replaced, not squeezed.
    expect(container.querySelector('main.main')).toBeNull();
    fireEvent.click(within(panel).getByLabelText('Back'));
    await waitFor(() => expect(screen.queryByTestId('agents-detail-panel')).toBeNull());
    expect(container.querySelector('main.main')).not.toBeNull();
  });

  it('renders legacy open-pluginId Agents (proxy null) without crashing', async () => {
    mockApi([
      agent({
        name: 'Legacy Open',
        pluginId: 'com.legacy.tool',
        proxy: null,
        proxyName: 'com.legacy.tool',
        cli: { state: 'missing', path: null, version: null, source: null },
      }),
    ]);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Legacy Open/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    // No Integration section and no jump affordance without a Catalog entry.
    expect(within(panel).queryByTestId('agent-open-integration')).toBeNull();
    // No kind-scoped affordances for an open pluginId.
    expect(within(panel).queryByRole('button', { name: /Install official CLI/ })).toBeNull();
    expect(within(panel).getByText(/manages its own defaults/)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('shows the stale-cache banner and syncs on Refresh', async () => {
    mockApi([], {
      source: {
        id: 'gian-official', sequence: 7, state: 'stale',
        error: { code: 'NET', message: 'offline' },
      },
      items: CATALOG_ITEMS,
    });
    renderAgents();
    expect(await screen.findByTestId('catalog-source-state')).toBeTruthy();
    expect(screen.getByText(/last synced Catalog/)).toBeTruthy();
    // Stale items stay usable (last-known-good).
    expect(screen.getByTestId('catalog-item-io.acme.ready')).toBeTruthy();
    fireEvent.click(screen.getByTestId('agents-page-refresh'));
    await waitFor(() => expect(api.syncProxyCatalog).toHaveBeenCalled());
  });

  it('shows an error state when the catalog fails to load but keeps My Agents', async () => {
    mockApi([agent({ name: 'Writer' })], new Error('boom'));
    renderAgents();
    expect(await screen.findByText(/My Agents · 1/)).toBeTruthy();
    expect(await screen.findByText(/could not be loaded: boom/)).toBeTruthy();
  });

  it('does not render search in either Agents mode', async () => {
    mockApi([agent({ name: 'Writer' })]);
    renderAgents();
    await screen.findByText(/My Agents · 1/);
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByTestId('agents-add'));
    await screen.findByRole('dialog', { name: 'New Agent' });
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('keeps an Integration row explorable without inventing a create action', async () => {
    const official = catalogItem({
      pluginId: 'claude',
      displayName: 'Claude Code',
      // Host has no operation for this entry. The row still opens details,
      // but Web must not invent an install/create action.
      availableActions: [],
    });
    mockApi([], catalogList([official]));
    renderAgents();
    const card = await screen.findByTestId('catalog-item-claude');
    expect((within(card).getByTestId('catalog-open-claude') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(card).getByTestId('catalog-open-claude'));
    const panel = await screen.findByTestId('proxy-detail-panel');
    expect(within(panel).queryByTestId('proxy-action-create-agent')).toBeNull();
  });

  it('marks a disabled Agent in My Agents without greying the row', async () => {
    mockApi([
      agent({ id: 'a-off', name: 'Off Duty', enabled: false }),
      agent({ id: 'a-on', name: 'On Duty' }),
    ]);
    renderAgents();
    expect(await screen.findByTestId('agent-disabled-badge-a-off')).toBeTruthy();
    expect(screen.queryByTestId('agent-disabled-badge-a-on')).toBeNull();
    const row = screen.getByTestId('agent-row-a-off');
    expect(row.className).not.toContain('disabled');
    expect(row.textContent).toContain('Disabled');
  });

  it('toggles an Agent disabled from the detail panel footer via agent.patch', async () => {
    mockApi([agent({ id: 'a-toggle', name: 'Writer' })]);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    // The Enabled switch lives in the footer, left of Delete.
    const footer = panel.querySelector('.p2-foot') as HTMLElement;
    expect(within(footer).getByRole('button', { name: 'Delete' })).toBeTruthy();
    const toggle = within(footer).getByTestId('agent-enabled-toggle');
    const input = within(toggle).getByRole('switch') as HTMLInputElement;
    expect(input.checked).toBe(true);
    fireEvent.click(input);
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalledWith('a-toggle', { enabled: false }));
  });

  it('shows the localized running-session notice when disabling is refused', async () => {
    mockApi([agent({ id: 'a-busy', name: 'Writer' })]);
    vi.mocked(api.updateAgent).mockRejectedValue(new Error('AGENT_DISABLE_BLOCKED:2'));
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    fireEvent.click(within(within(panel).getByTestId('agent-enabled-toggle')).getByRole('switch'));
    expect(await within(panel).findByText(
      'This Agent cannot be disabled while 2 session(s) are still in progress.',
    )).toBeTruthy();
  });

  it('explains HOME and Defaults with hover tooltips', async () => {
    mockApi([agent({ id: 'a-hint', name: 'Writer' })]);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    const tooltips = within(panel).getAllByRole('tooltip');
    expect(tooltips).toHaveLength(2);
    expect(tooltips[0]!.textContent).toContain('configuration and state root');
    expect(tooltips[1]!.textContent).toContain('Defaults for new sessions');
  });

  it('changes the Agent HOME through the native picker and a home patch', async () => {
    mockApi([agent({ id: 'a-home', name: 'Writer' })]);
    vi.mocked(api.pickAgentHome).mockResolvedValue('/Users/test/new-home');
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    fireEvent.click(within(panel).getByTestId('agent-home-change'));
    await waitFor(() => expect(api.pickAgentHome).toHaveBeenCalledWith('a-home'));
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalledWith('a-home', {
      home: { kind: 'custom', path: '/Users/test/new-home' },
    }));
  });

  it('does not patch the HOME when the picker is canceled', async () => {
    mockApi([agent({ id: 'a-home-cancel', name: 'Writer' })]);
    vi.mocked(api.pickAgentHome).mockResolvedValue(null);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    fireEvent.click(within(panel).getByTestId('agent-home-change'));
    await waitFor(() => expect(api.pickAgentHome).toHaveBeenCalledWith('a-home-cancel'));
    expect(api.updateAgent).not.toHaveBeenCalled();
  });

  it('hides the HOME change entry for external-App Agents', async () => {
    mockApi([agent({ id: 'a-ext', name: 'Writer', home: null })]);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    expect(within(panel).queryByTestId('agent-home-change')).toBeNull();
  });

  it('renames an Agent write-through from the detail panel', async () => {
    mockApi([agent({ id: 'a-1', name: 'Writer' })]);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    const nameInput = within(panel).getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Renamed' } });
    fireEvent.blur(nameInput);
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalledWith('a-1', { name: 'Renamed' }));
  });

  // ── Role-less catalog option defaults (e.g. dsh provider) ────────────────

  function dshLikeCapabilities(providerChoices = [
    { value: 'deepseek-official', displayName: 'DeepSeek' },
    { value: 'vendor-b', displayName: 'Vendor B' },
  ]) {
    return {
      catalogRevision: 'dsh-rev-1',
      capabilities: { 'catalog.resolve': {} },
      configOptions: [
        {
          id: 'provider', displayName: 'Provider', binding: 'turn', control: 'select',
          required: false, defaultValue: 'deepseek-official', choices: providerChoices,
        },
        {
          id: 'model', displayName: 'Model', binding: 'turn', role: 'model', control: 'select',
          required: true, defaultValue: 'deepseek-chat',
          choices: [
            { value: 'deepseek-chat', displayName: 'DeepSeek Chat' },
            { value: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
          ],
        },
        {
          id: 'region', displayName: 'Region', binding: 'turn', control: 'select',
          required: false, defaultValue: 'us',
          choices: [
            { value: 'us', displayName: 'US' },
            { value: 'eu', displayName: 'EU' },
          ],
          enabledWhen: [{ optionId: 'provider', oneOf: ['vendor-b'] }],
        },
      ],
      input: [{ type: 'text' }],
      slashCommands: [],
    };
  }

  function dshAgent(defaults?: Partial<UserAgentStatus['defaults']>) {
    return agent({
      id: 'a-dsh',
      name: 'DSH Agent',
      pluginId: 'ai.deepseek.harness',
      proxy: 'dsh',
      proxyName: 'DeepSeek Harness',
      defaults: {
        model: 'deepseek-chat',
        thinking: '',
        mode: '',
        options: {},
        ...defaults,
      },
    });
  }

  /** Resolve mock: model choices depend on the requested provider. */
  function mockProviderDependentResolve() {
    vi.mocked(api.loadResolvedProxyCatalog).mockImplementation(async (_kind, params) => {
      const provider = (params.turnConfig?.['provider'] ?? params.sessionConfig?.['provider'])
        ?? 'deepseek-official';
      const base = dshLikeCapabilities();
      return {
        ...base,
        configOptions: base.configOptions.map(option => (
          option.id === 'model'
            ? provider === 'vendor-b'
              ? { ...option, choices: [{ value: 'vendor-b-model', displayName: 'Vendor B Model' }] }
              : option
            : option
        )),
        resolvedDefaults: { sessionConfig: {}, turnConfig: {} },
      } as never;
    });
  }

  it('renders a Provider default select for a dsh-like catalog, never for claude-like', async () => {
    mockApi([dshAgent(), agent({ id: 'a-claude', name: 'Claude Agent' })]);
    vi.mocked(api.loadProxyCapabilities).mockImplementation(async kind => (
      kind === 'dsh' ? dshLikeCapabilities() as never : capabilities()
    ));
    mockProviderDependentResolve();
    renderAgents();

    fireEvent.click(await screen.findByRole('button', { name: /DSH Agent/ }));
    const dshPanel = await screen.findByTestId('agents-detail-panel');
    await waitFor(() => expect(
      within(dshPanel).getByTestId('agent-default-option-provider'),
    ).toBeTruthy());
    // A role-less option gated by enabledWhen stays disabled while the stored
    // provider does not satisfy the condition.
    expect(
      (within(dshPanel).getByTestId('agent-default-option-region') as HTMLSelectElement).disabled,
    ).toBe(true);

    fireEvent.click(within(dshPanel).getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: /Claude Agent/ }));
    const claudePanel = await screen.findByTestId('agents-detail-panel');
    await waitFor(() => expect(within(claudePanel).getByLabelText('Model')).toBeTruthy());
    expect(within(claudePanel).queryByTestId('agent-default-option-provider')).toBeNull();
  });

  it('changing Provider writes one atomic patch and clears the dependent model default', async () => {
    mockApi([dshAgent({ options: { provider: 'deepseek-official' } })]);
    vi.mocked(api.loadProxyCapabilities).mockResolvedValue(dshLikeCapabilities() as never);
    mockProviderDependentResolve();
    renderAgents();

    fireEvent.click(await screen.findByRole('button', { name: /DSH Agent/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    const provider = await waitFor(() => {
      const select = within(panel).getByTestId('agent-default-option-provider') as HTMLSelectElement;
      expect(select.disabled).toBe(false);
      return select;
    });
    expect(provider.value).toBe('deepseek-official');
    // The initial re-resolve matches the stored defaults: no write yet.
    expect(api.updateAgent).not.toHaveBeenCalled();

    fireEvent.change(provider, { target: { value: 'vendor-b' } });
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalledTimes(1));
    expect(api.updateAgent).toHaveBeenCalledWith('a-dsh', {
      defaults: { options: { provider: 'vendor-b' }, model: '' },
    });
  });

  it('an enabledWhen-satisfying provider default enables the gated option', async () => {
    mockApi([dshAgent({ model: '', options: { provider: 'vendor-b' } })]);
    vi.mocked(api.loadProxyCapabilities).mockResolvedValue(dshLikeCapabilities() as never);
    mockProviderDependentResolve();
    renderAgents();

    fireEvent.click(await screen.findByRole('button', { name: /DSH Agent/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    await waitFor(() => expect(
      (within(panel).getByTestId('agent-default-option-region') as HTMLSelectElement).disabled,
    ).toBe(false));
  });

  // ── No-restart Agent management (WP7 semantics on the WP4 surface): Agent
  //  create/delete/path changes take effect immediately; no restart confirm,
  //  no restartApp, no restartRequired affordance anywhere. ────────────────

  it('creates from the modal immediately on desktop without any restart', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    mockApi([]);
    renderAgents();

    fireEvent.click(await screen.findByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    fireEvent.click(within(dialog).getByTestId('agent-create-save'));

    // No restart dialog, no relaunch: the create goes straight to the Host.
    expect(screen.queryByRole('alertdialog', { name: 'Restart Gian?' })).toBeNull();
    await waitFor(() => {
      expect(api.createAgent).toHaveBeenCalledWith({
        name: 'Acme Ready',
        pluginId: 'io.acme.ready',
        home: { kind: 'managed' },
      });
    });
    expect(restartApp).not.toHaveBeenCalled();
    expect(screen.queryByTestId('agent-restart-required')).toBeNull();
  }, 10_000);

  it('deletes a saved Agent after the delete confirm only', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    const saved = agent({ id: 'a-del', name: 'Claude Work' });
    mockApi([saved]);
    renderAgents();

    fireEvent.click(await screen.findByRole('button', { name: /Claude Work/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete' }));
    const deleteDialog = await screen.findByRole('alertdialog', { name: 'Delete this Agent?' });
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalledWith('a-del'));
    // No second restart confirm, no relaunch.
    expect(screen.queryByRole('alertdialog', { name: 'Restart Gian?' })).toBeNull();
    expect(restartApp).not.toHaveBeenCalled();
  }, 10_000);

  it('shows the fixed HOME read-only and keeps CLI controls out of My Agent', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    const saved = agent({ id: 'a-path', name: 'Writer' });
    mockApi([saved]);
    renderAgents();

    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    expect(within(panel).queryByDisplayValue('/bin/claude')).toBeNull();
    expect(panel.textContent).not.toContain('/bin/claude');
    expect(panel.textContent).not.toContain('Agent Integration');
    expect(within(panel).getByTestId('agent-home-path').textContent)
      .toBe('/Users/test/.gian/homes/claude/a-1');
    expect(within(panel).queryByLabelText('Use custom HOME')).toBeNull();
    expect(within(panel).queryByLabelText('Custom HOME')).toBeNull();
    expect(within(panel).queryByRole('button', { name: /Browse/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /CLI terminal|CLI Shell/ })).toBeNull();
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();
  }, 10_000);

  it('keeps Runtime verification detail out of the My Agent surface', async () => {
    const saved = agent({
      id: 'a-unverified',
      name: 'Writer',
      cli: {
        state: 'ready', path: '/bin/claude', version: '9.9.9', source: 'path',
      },
      runtimeProfile: {
        id: 'rp-1',
        agentId: 'a-unverified',
        pluginId: 'claude',
        runtimeId: null,
        path: '/bin/claude',
        version: '9.9.9',
        configHome: null,
        contentFingerprint: null,
        verifiedVersions: ['1.0.0'],
        verification: 'unverified',
      },
    });
    mockApi([saved]);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    expect(within(panel).queryByText(/Unverified version/)).toBeNull();
    expect(panel.textContent).not.toContain('Agent Integration');
  });

  it('refetches Catalog docs when the source generation advances', async () => {
    const seqList = (sequence: number): ProxyCatalogList => ({
      source: {
        id: 'gian-official', sequence,
        state: sequence === 7 ? 'stale' : 'ready',
        error: sequence === 7 ? { code: 'NET', message: 'offline' } : null,
      },
      items: [READY],
    });
    vi.mocked(api.loadAgents).mockResolvedValue([]);
    vi.mocked(api.loadProxies).mockResolvedValue(LEGACY_PROXIES);
    vi.mocked(api.loadProxyCatalog)
      .mockResolvedValueOnce({ proxies: LEGACY_PROXIES, catalog: seqList(7) })
      .mockResolvedValue({ proxies: LEGACY_PROXIES, catalog: seqList(8) });
    vi.mocked(api.syncProxyCatalog).mockResolvedValue(seqList(8));
    let setupCalls = 0;
    vi.mocked(api.loadCatalogDocument).mockImplementation(async url => {
      if (url.includes('/docs/setup')) {
        setupCalls += 1;
        return `## Setup v${setupCalls}`;
      }
      return null;
    });
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByTestId(/^catalog-open-/));
    const panel = await screen.findByTestId('proxy-detail-panel');
    expect(await within(panel).findByRole('heading', { level: 2, name: 'Setup v1' })).toBeTruthy();
    expect(setupCalls).toBe(1);

    // Sync advances the Catalog generation: same doc URL, new content —
    // the cache key includes the generation, so this refetches.
    fireEvent.click(screen.getByTestId('agents-page-refresh'));
    expect(await within(panel).findByRole('heading', { level: 2, name: 'Setup v2' })).toBeTruthy();
    expect(setupCalls).toBe(2);
  });

  it('a successful sync recovers the full projection after an initial load failure', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([agent({ name: 'Writer' })]);
    vi.mocked(api.loadProxies).mockResolvedValue(LEGACY_PROXIES);
    vi.mocked(api.loadProxyCatalog).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(api.syncProxyCatalog).mockResolvedValue(catalogList());
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    expect(await screen.findByText(/could not be loaded: boom/)).toBeTruthy();
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });

    vi.mocked(api.loadProxyCatalog).mockResolvedValue({
      proxies: LEGACY_PROXIES,
      catalog: catalogList(),
    });
    await waitFor(() => expect(api.syncProxyCatalog).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/could not be loaded/)).toBeNull());
    expect(await screen.findByTestId('catalog-item-io.acme.ready')).toBeTruthy();
    // My Agents recovers its legacy display data too.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /Writer/ }).textContent).toContain('Claude Code');
  });

  it('narrow windows (900px) render the list with the full toolbar until a detail opens', async () => {
    mockViewport({ narrow: true, phone: false });
    mockApi([agent({ name: 'Writer' })]);
    const { container } = renderAgents();
    await screen.findByText(/My Agents · 1/);
    // List state: no panel, main list visible, toolbar intact.
    expect(screen.queryByTestId('proxy-detail-panel')).toBeNull();
    expect(screen.queryByTestId('agents-detail-panel')).toBeNull();
    expect(container.querySelector('main.main')).not.toBeNull();
    expect(screen.getByTestId('agents-add')).toBeTruthy();
    expect(screen.getByTestId('agents-page-refresh')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('keyboard activation keeps Integration selection on its detail surface', async () => {
    mockApi([]);
    const user = userEvent.setup();
    renderAgents();
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    within(card).getByTestId('catalog-open-io.acme.ready').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('proxy-detail-panel')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'New Agent' })).toBeNull();
  });

  it('does not expose Runtime installation or CLI path controls in Add Agent', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New Agent' });
    expect(dialog.textContent).not.toContain('Runtime');
    expect(dialog.textContent).not.toContain('~/.gian/runtimes');
    expect(within(dialog).queryByPlaceholderText('/absolute/path/to/cli')).toBeNull();
  });

  it('keeps Integration installation status out of My Agent details', async () => {
    mockApi([agent({ name: 'Writer' })]);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    expect(panel.querySelector('.p2-head .st')).toBeNull();
    expect(panel.querySelector('[data-testid="agent-runtime-action"]')).toBeNull();
    expect(panel.textContent).not.toContain('Agent Integration');
    expect(panel.textContent).toContain('HOME');
  });
});
