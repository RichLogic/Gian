import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProductExecutor,
  ProxyCatalogEntry,
  ProxyCatalogItem,
  ProxyCatalogList,
  ProxyCapabilities,
  UserAgentStatus,
} from '@gian/shared';
import { AgentsView } from '../src/views/AgentsView.js';
import { __resetCatalogDocCache } from '../src/agents/ProxyDetailPanel.js';
import { renderWithOperations } from './operation-test-utils.js';
import { Toaster } from '../src/components/Toaster.js';
import { __resetFeedback } from '../src/feedback.js';
import * as api from '../src/api.js';

// WP4 (issue #146): Agents page = My Agents + Proxy Catalog, driven by the
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
    updateCatalogProxy: vi.fn(),
    rollbackCatalogProxy: vi.fn(),
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
    if (url.includes('/docs/usage')) return '## Usage\n\nDo the thing.';
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
  vi.mocked(api.updateCatalogProxy).mockResolvedValue({ pluginId: 'io.acme.updatable', pluginVersion: '1.2.0' });
  vi.mocked(api.rollbackCatalogProxy).mockResolvedValue({ pluginId: 'io.acme.updatable', pluginVersion: '1.0.0' });
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

describe('AgentsView (My Agents + Proxy Catalog)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seq = 0;
    __resetFeedback();
    __resetCatalogDocCache();
    delete (window as { gianDesktop?: unknown }).gianDesktop;
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('keeps My Agents separate, then shows every Proxy in Add Agent', async () => {
    mockApi([agent({ name: 'Writer' })]);
    renderAgents();
    expect(await screen.findByText(/My Agents · 1/)).toBeTruthy();
    expect(screen.queryByTestId('proxy-catalog-list')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByTestId('agents-add'));
    expect(await screen.findByText(/Choose a Proxy · 5/)).toBeTruthy();
    for (const item of CATALOG_ITEMS) {
      expect(screen.getByTestId(`catalog-item-${item.pluginId}`)).toBeTruthy();
    }
    // Distinct incompatible badges: app-too-old vs proxy-too-old.
    expect(screen.getAllByText('Requires Gian update').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Requires Proxy update').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Update available').length).toBeGreaterThan(0);
  });

  it('gates install by Host availableActions and shows the incompatibility reason', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const installable = await screen.findByTestId('catalog-item-io.acme.installable');
    fireEvent.click(within(installable).getByLabelText('View in Catalog'));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const install = within(panel).getByTestId('proxy-action-install');
    expect((install as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(install);
    await waitFor(() => expect(api.installCatalogProxy)
      .toHaveBeenCalledWith('io.acme.installable'));
    // A confirmed install refreshes the projection.
    await waitFor(() => expect(vi.mocked(api.loadProxyCatalog).mock.calls.length).toBeGreaterThan(1));

    fireEvent.click(within(panel).getByLabelText('Close'));
    const needsApp = await screen.findByTestId('catalog-item-io.acme.needs-app');
    fireEvent.click(within(needsApp).getByLabelText('View in Catalog'));
    const appPanel = await screen.findByTestId('proxy-detail-panel');
    expect(within(appPanel).queryByTestId('proxy-action-install')).toBeNull();
    expect(within(appPanel).getByText(/requires a newer Gian App/)).toBeTruthy();
    expect(within(appPanel).getByText(/requires gian\.proxy\/2\.2/)).toBeTruthy();

    fireEvent.click(within(appPanel).getByLabelText('Close'));
    const needsProxy = await screen.findByTestId('catalog-item-io.acme.needs-proxy');
    fireEvent.click(within(needsProxy).getByLabelText('View in Catalog'));
    const proxyPanel = await screen.findByTestId('proxy-detail-panel');
    expect(within(proxyPanel).getByText(/too old for this Gian App/)).toBeTruthy();
  });

  it('shows the update action in the Runtime action row and runs it', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const card = await screen.findByTestId('catalog-item-io.acme.updatable');
    fireEvent.click(within(card).getByLabelText('View in Catalog'));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const update = within(panel).getByTestId('proxy-action-update');
    expect(update.closest('.act-row')).toBeTruthy();
    expect(update.closest('.p2-head')).toBeNull();
    fireEvent.click(update);
    await waitFor(() => expect(api.updateCatalogProxy)
      .toHaveBeenCalledWith('io.acme.updatable'));
  });

  it('renders three scroll anchors and sanitizes the continuous Catalog document', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByLabelText('View in Catalog'));
    const panel = await screen.findByTestId('proxy-detail-panel');
    for (const section of ['basic', 'tutorial', 'versions']) {
      expect(within(panel).getByTestId(`proxy-anchor-${section}`)).toBeTruthy();
    }
    // Overview doc loads and its unsafe link degrades to plain text.
    expect(await within(panel).findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    const doc = within(panel).getAllByTestId('catalog-doc')[0]!;
    const links = doc.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com/docs');
    expect(doc.textContent).toContain('bad');

    expect(await within(panel).findByText('Do the thing.')).toBeTruthy();
    expect(api.loadCatalogDocument).toHaveBeenCalledWith('/api/proxies/io.acme.ready/docs/usage');
  });

  it('Add Agent turns panel 1 into the Proxy list and a row opens the draft', async () => {
    mockApi([agent({ name: 'Writer' })]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('agent-draft-panel')).toBeNull();
    expect(await screen.findByTestId('catalog-item-io.acme.ready')).toBeTruthy();
    expect(screen.getByTestId('catalog-item-io.acme.installable')).toBeTruthy();

    fireEvent.click(screen.getByTestId('catalog-open-io.acme.ready'));
    const draft = await screen.findByTestId('agent-draft-panel');
    const nameInput = (await within(draft).findByLabelText('Name')) as HTMLInputElement;
    expect(nameInput.value).toBe('Acme Ready');
    expect(draft.textContent).toContain('io.acme.ready');
    // The pluginId stays immutable on the draft (no proxy switcher).
    expect(within(draft).queryByRole('combobox')).toBeNull();

    fireEvent.click(within(draft).getByTestId('agent-draft-save'));
    await waitFor(() => expect(api.createAgent).toHaveBeenCalledWith({
      name: 'Acme Ready',
      pluginId: 'io.acme.ready',
      home: { kind: 'managed' },
    }));
    await waitFor(() => expect(screen.queryByTestId('agent-draft-panel')).toBeNull());
  });

  it('a Proxy row starts the draft directly', async () => {
    mockApi([agent({ name: 'Writer' })]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    fireEvent.click(await screen.findByTestId('catalog-open-io.acme.ready'));
    const draft = await screen.findByTestId('agent-draft-panel');
    // Straight into the form — the picker step is skipped.
    const nameInput = (await within(draft).findByLabelText('Name')) as HTMLInputElement;
    expect(nameInput.value).toBe('Acme Ready');
    expect(screen.getByTestId('proxy-catalog-list')).toBeTruthy();
  });

  it('Add Agent on an empty catalog runs the sync that populates the picker', async () => {
    mockApi([], catalogList([]));
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    expect(await screen.findByText(/Choose a Proxy · 0/)).toBeTruthy();
    expect(screen.queryByTestId('agent-draft-panel')).toBeNull();
    await waitFor(() => expect(api.syncProxyCatalog).toHaveBeenCalled());
  });

  it('uses Host legacy metadata only as a GianDev fallback when Catalog is empty', async () => {
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'development' };
    mockApi([], catalogList([]));
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    expect(await screen.findByTestId('catalog-item-claude')).toBeTruthy();
    expect(screen.getByText('Claude kind')).toBeTruthy();
  });

  it('Add Agent on a populated catalog opens the Proxy list without a redundant sync', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    expect(await screen.findByTestId('catalog-item-io.acme.ready')).toBeTruthy();
    expect(screen.queryByTestId('agent-draft-panel')).toBeNull();
    expect(api.syncProxyCatalog).not.toHaveBeenCalled();
  });

  it('narrow windows keep the Proxy list until a draft opens, then Back returns', async () => {
    mockViewport({ narrow: true, phone: false });
    mockApi([]);
    const { container } = renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    await screen.findByTestId('catalog-item-io.acme.ready');
    expect(container.querySelector('main.main')).not.toBeNull();
    fireEvent.click(screen.getByTestId('catalog-open-io.acme.ready'));
    const picker = await screen.findByTestId('agent-draft-panel');
    // The list column is replaced, not squeezed.
    expect(container.querySelector('main.main')).toBeNull();
    fireEvent.click(within(picker).getByLabelText('Back'));
    await waitFor(() => expect(screen.queryByTestId('agent-draft-panel')).toBeNull());
    expect(container.querySelector('main.main')).not.toBeNull();
  });

  it('shows a draggable main | panel-2 seam while the detail is open', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByLabelText('View in Catalog'));
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

  it('rejects duplicate draft names before saving', async () => {
    mockApi([agent({ name: 'Acme Ready' })]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    fireEvent.click(await screen.findByTestId('catalog-open-io.acme.ready'));
    const draft = await screen.findByTestId('agent-draft-panel');
    // The prefilled name collides → numbered suggestion.
    const nameInput = within(draft).getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.value).toBe('Acme Ready 2');
    fireEvent.change(nameInput, { target: { value: 'acme ready' } });
    expect(within(draft).getByText(/already exists/)).toBeTruthy();
    expect((within(draft).getByTestId('agent-draft-save') as HTMLButtonElement).disabled).toBe(true);
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
    expect(panel.textContent).toContain('com.legacy.tool');
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
    fireEvent.click(await screen.findByTestId('agents-add'));
    expect(await screen.findByTestId('catalog-source-state')).toBeTruthy();
    expect(screen.getByText(/last synced Catalog/)).toBeTruthy();
    // Stale items stay usable (last-known-good).
    expect(screen.getByTestId('catalog-item-io.acme.ready')).toBeTruthy();
    fireEvent.click(screen.getByTestId('catalog-sync'));
    await waitFor(() => expect(api.syncProxyCatalog).toHaveBeenCalled());
  });

  it('shows an error state when the catalog fails to load but keeps My Agents', async () => {
    mockApi([agent({ name: 'Writer' })], new Error('boom'));
    renderAgents();
    expect(await screen.findByText(/My Agents · 1/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('agents-add'));
    expect(screen.getByText(/could not be loaded: boom/)).toBeTruthy();
  });

  it('does not render search in either Agents mode', async () => {
    mockApi([agent({ name: 'Writer' })]);
    renderAgents();
    await screen.findByText(/My Agents · 1/);
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByTestId('agents-add'));
    await screen.findByTestId('proxy-catalog-list');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('reserved official Catalog entries render no create affordance without the Host action', async () => {
    const official = catalogItem({
      pluginId: 'claude',
      displayName: 'Claude Code',
      // Milestone A projection: reserved official entries carry no catalog
      // actions. Web must not invent one — no card button, no detail action.
      availableActions: [],
    });
    mockApi([], catalogList([official]));
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const card = await screen.findByTestId('catalog-item-claude');
    expect((within(card).getByTestId('catalog-open-claude') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByLabelText('View in Catalog'));
    const panel = await screen.findByTestId('proxy-detail-panel');
    expect(within(panel).queryByTestId('proxy-action-create-agent')).toBeNull();
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

  // ── No-restart Agent management (WP7 semantics on the WP4 surface): Agent
  //  create/delete/path changes take effect immediately; no restart confirm,
  //  no restartApp, no restartRequired affordance anywhere. ────────────────

  it('saves a draft immediately on desktop without any restart', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    mockApi([]);
    renderAgents();

    fireEvent.click(await screen.findByTestId('agents-add'));
    fireEvent.click(await screen.findByTestId('catalog-open-io.acme.ready'));
    const draft = await screen.findByTestId('agent-draft-panel');
    fireEvent.click(within(draft).getByTestId('agent-draft-save'));

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

  it('keeps the CLI path read-only and writes a custom HOME without restart', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    const saved = agent({ id: 'a-path', name: 'Writer' });
    mockApi([saved]);
    renderAgents();

    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    expect(within(panel).queryByDisplayValue('/bin/claude')).toBeNull();
    expect(panel.textContent).toContain('/bin/claude');
    fireEvent.click(within(panel).getByLabelText('Use custom HOME'));
    const homeInput = within(panel).getByLabelText('Custom HOME');
    fireEvent.change(homeInput, { target: { value: '/Users/test/claude-mix' } });
    fireEvent.blur(homeInput);
    await waitFor(() => {
      expect(api.updateAgent).toHaveBeenCalledWith('a-path', {
        home: { kind: 'custom', path: '/Users/test/claude-mix' },
      });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(restartApp).not.toHaveBeenCalled();
  }, 10_000);

  it('shows a red consequence warning for an allowed unverified Runtime Profile', async () => {
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
    const warning = await within(panel).findByRole('alert');
    expect(warning.textContent).toContain('Unverified version');
    expect(warning.textContent).toContain('1.0.0');
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
    let overviewCalls = 0;
    vi.mocked(api.loadCatalogDocument).mockImplementation(async url => {
      if (url.includes('/docs/overview')) {
        overviewCalls += 1;
        return `# Overview v${overviewCalls}`;
      }
      return null;
    });
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    fireEvent.click(within(card).getByLabelText('View in Catalog'));
    const panel = await screen.findByTestId('proxy-detail-panel');
    expect(await within(panel).findByRole('heading', { level: 1, name: 'Overview v1' })).toBeTruthy();
    expect(overviewCalls).toBe(1);

    // Sync advances the Catalog generation: same doc URL, new content —
    // the cache key includes the generation, so this refetches.
    fireEvent.click(screen.getByTestId('catalog-sync'));
    expect(await within(panel).findByRole('heading', { level: 1, name: 'Overview v2' })).toBeTruthy();
    expect(overviewCalls).toBe(2);
  });

  it('a successful sync recovers the full projection after an initial load failure', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([agent({ name: 'Writer' })]);
    vi.mocked(api.loadProxies).mockResolvedValue(LEGACY_PROXIES);
    vi.mocked(api.loadProxyCatalog).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(api.syncProxyCatalog).mockResolvedValue(catalogList());
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    expect(await screen.findByText(/could not be loaded: boom/)).toBeTruthy();

    vi.mocked(api.loadProxyCatalog).mockResolvedValue({
      proxies: LEGACY_PROXIES,
      catalog: catalogList(),
    });
    await waitFor(() => expect(api.syncProxyCatalog).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/could not be loaded/)).toBeNull());
    expect(await screen.findByTestId('catalog-item-io.acme.ready')).toBeTruthy();
    // My Agents recovers its legacy display data too.
    fireEvent.click(screen.getByLabelText('Back to My Agents'));
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
    expect(screen.queryByTestId('catalog-sync')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('keyboard activation keeps Proxy selection and details as separate sibling buttons', async () => {
    mockApi([]);
    const user = userEvent.setup();
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const card = await screen.findByTestId('catalog-item-io.acme.ready');
    within(card).getByTestId('catalog-open-io.acme.ready').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('agent-draft-panel')).toBeTruthy();
    expect(screen.queryByTestId('proxy-detail-panel')).toBeNull();
    // Dismiss the draft, then activate the sibling info control.
    fireEvent.click(within(screen.getByTestId('agent-draft-panel')).getByLabelText('Close'));
    within(card).getByLabelText('View in Catalog').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('proxy-detail-panel')).toBeTruthy();
  });

  it('preserves a draft while opening Proxy details and returning', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    fireEvent.click(await screen.findByTestId('catalog-open-io.acme.ready'));
    let panel = await screen.findByTestId('agent-draft-panel');
    fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: 'My preserved draft' } });
    fireEvent.click(within(panel).getByLabelText('View in Catalog'));
    panel = await screen.findByTestId('proxy-detail-panel');
    fireEvent.click(within(panel).getByTestId('proxy-action-create-agent'));
    panel = await screen.findByTestId('agent-draft-panel');
    expect((within(panel).getByLabelText('Name') as HTMLInputElement).value).toBe('My preserved draft');
  });

  it('shows both-missing Runtime state without exposing an editable CLI path', async () => {
    mockApi([]);
    renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    fireEvent.click(await screen.findByTestId('catalog-open-io.acme.installable'));
    const panel = await screen.findByTestId('agent-draft-panel');
    expect(panel.textContent).toContain('Not installed');
    expect(panel.textContent).toContain('~/.gian/runtimes');
    expect(within(panel).queryByPlaceholderText('/absolute/path/to/cli')).toBeNull();
  });

  it('keeps status out of the Agent detail header', async () => {
    mockApi([agent({ name: 'Writer' })]);
    renderAgents();
    fireEvent.click(await screen.findByRole('button', { name: /Writer/ }));
    const panel = await screen.findByTestId('agents-detail-panel');
    expect(panel.querySelector('.p2-head .st')).toBeNull();
    expect(panel.querySelector('.p2-body .act-row')).toBeTruthy();
  });
});
