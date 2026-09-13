import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProductExecutor,
  ProxyCatalogEntry,
  ProxyCatalogItem,
  ProxyCatalogList,
  RuntimeDiscoverResponse,
  RuntimeProbeResponse,
  UserAgentStatus,
} from '@gian/shared';
import { AgentsView } from '../src/views/AgentsView.js';
import { __resetCatalogDocCache } from '../src/agents/ProxyDetailPanel.js';
import { ProxyRuntimeSetup } from '../src/agents/ProxyRuntimeSetup.js';
import { renderWithOperations } from './operation-test-utils.js';
import { Toaster } from '../src/components/Toaster.js';
import { __resetFeedback } from '../src/feedback.js';
import * as api from '../src/api.js';

// WP6 Runtime control plane on the WP4 Agents surface (issue #150): the
// Setup tab runs real runtime.discover / runtime.probe operations; every
// action comes from the Host response, never from Web-side guesses.

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
    syncProxyCatalog: vi.fn(),
    installCatalogProxy: vi.fn(),
    updateCatalogProxy: vi.fn(),
    rollbackCatalogProxy: vi.fn(),
    discoverProxyRuntime: vi.fn(),
    probeProxyRuntime: vi.fn(),
  };
});

let seq = 0;
let runtimeItem: ProxyCatalogItem;
const runtimeSelected = vi.fn();
const projectionChanged = vi.fn(async () => undefined);

const PLUGIN_ID = 'io.acme.external';

function catalogItem(overrides: {
  pluginId: string;
  displayName?: string;
  compatibility?: Partial<ProxyCatalogItem['compatibility']>;
  installation?: Partial<ProxyCatalogItem['installation']>;
  runtime?: Partial<ProxyCatalogItem['runtime']>;
  availableActions?: ProxyCatalogItem['availableActions'];
}): ProxyCatalogItem {
  const pluginId = overrides.pluginId;
  return {
    pluginId,
    displayName: overrides.displayName ?? pluginId,
    tagline: `${pluginId} tagline`,
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
      state: 'installed',
      installedVersion: '1.0.0',
      latestVersion: '1.0.0',
      updateAvailable: false,
      source: 'gian-official',
      ...overrides.installation,
    },
    runtime: {
      state: 'setup_required',
      displayName: 'Acme CLI',
      ...overrides.runtime,
    },
    availableActions: overrides.availableActions ?? ['select_runtime', 'create_agent'],
  };
}

/** The Runtime-requiring Catalog entry used by most specs. */
const EXTERNAL = catalogItem({ pluginId: PLUGIN_ID, displayName: 'Acme External' });

function catalogList(items: ProxyCatalogItem[]): ProxyCatalogList {
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

function discoverResponse(
  overrides: Partial<RuntimeDiscoverResponse> = {},
): RuntimeDiscoverResponse {
  return {
    pluginId: PLUGIN_ID,
    pluginVersion: '1.0.0',
    runtime: {
      kind: 'external',
      id: 'acme-cli',
      displayName: 'Acme CLI',
      verifiedVersions: ['1.0.0'],
    },
    candidates: [
      { path: '/usr/local/bin/acme', source: 'path', label: 'PATH' },
      { path: '/opt/acme/bin/acme', source: 'official-system' },
    ],
    setupActions: [
      { id: 'download', kind: 'open_url', label: 'Download Acme CLI', url: 'https://acme.example/install' },
      { id: 'pick', kind: 'select_file', label: 'Choose executable' },
    ],
    availableActions: ['select_runtime', 'create_agent'],
    ...overrides,
  };
}

function probeResponse(
  path: string,
  overrides: Partial<RuntimeProbeResponse> = {},
): RuntimeProbeResponse {
  return {
    pluginId: PLUGIN_ID,
    pluginVersion: '1.0.0',
    selectedPath: path,
    profile: {
      id: 'rp-1',
      agentId: 'draft',
      pluginId: PLUGIN_ID,
      runtimeId: 'acme-cli',
      path,
      version: '1.0.0',
      configHome: null,
      contentFingerprint: null,
      verifiedVersions: ['1.0.0'],
      verification: 'verified',
    },
    availableActions: ['create_agent'],
    ...overrides,
  };
}

function mockApi(
  agents: UserAgentStatus[],
  items: ProxyCatalogItem[] = [EXTERNAL],
) {
  runtimeItem = items[0] ?? EXTERNAL;
  vi.mocked(api.loadAgents).mockResolvedValue(agents);
  vi.mocked(api.loadProxies).mockResolvedValue(LEGACY_PROXIES);
  vi.mocked(api.loadProxyCatalog).mockResolvedValue({
    proxies: LEGACY_PROXIES,
    catalog: catalogList(items),
  });
  vi.mocked(api.loadCatalogDocument).mockImplementation(async url => {
    if (url.includes('/docs/setup')) return '## Setup\n\nInstall it.';
    return null;
  });
  vi.mocked(api.loadAgentDraftDefaults).mockResolvedValue({ name: 'Acme External', cliPath: null });
  vi.mocked(api.loadManagedRuntimeStatus).mockImplementation(async pluginId => ({
    pluginId,
    active: null,
    staged: [],
  }));
  vi.mocked(api.createAgent).mockImplementation(async input => agent({
    name: input.name,
    pluginId: input.pluginId ?? 'claude',
    proxy: null,
    cliPath: input.cliPath ?? null,
  }));
  vi.mocked(api.deleteAgent).mockResolvedValue(undefined);
  vi.mocked(api.syncProxyCatalog).mockResolvedValue(catalogList(items));
  vi.mocked(api.discoverProxyRuntime).mockResolvedValue(discoverResponse());
  vi.mocked(api.probeProxyRuntime).mockImplementation(async (_pluginId, path) => probeResponse(path));
}

async function renderAgents() {
  const rendered = renderWithOperations(
    <>
      <Toaster />
      <AgentsView />
      <div data-testid="runtime-harness">
        <ProxyRuntimeSetup
          item={runtimeItem}
          onRuntimeSelected={runtimeSelected}
          onProjectionChanged={projectionChanged}
        />
      </div>
    </>,
  );
  await waitFor(() => expect(screen.getByTestId('agents-view').getAttribute('data-loading')).toBe('false'));
  return rendered;
}

/** Return the retained lower-level Runtime control-plane harness. Managed
 * Agents no longer renders this legacy path selector in the product UI. */
async function openSetupTab(pluginId: string = PLUGIN_ID) {
  expect(runtimeItem.pluginId).toBe(pluginId);
  return screen.findByTestId('runtime-harness');
}

describe('Proxy Runtime setup (WP6 discover/probe on the WP4 page)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seq = 0;
    __resetFeedback();
    __resetCatalogDocCache();
    delete (window as { gianDesktop?: unknown }).gianDesktop;
    runtimeSelected.mockReset();
    projectionChanged.mockReset();
    projectionChanged.mockResolvedValue(undefined);
  });

  it('discovers on entering Setup and renders the Manifest runtime, candidates and setup actions', async () => {
    mockApi([]);
    await renderAgents();
    const panel = await openSetupTab();

    await waitFor(() => expect(api.discoverProxyRuntime).toHaveBeenCalledWith(PLUGIN_ID));
    const setup = await within(panel).findByTestId('runtime-setup');
    await within(setup).findByTestId('runtime-candidates');
    // Manifest runtime name, not the pluginId.
    expect(setup.textContent).toContain('Acme CLI');
    const group = within(setup).getByRole('radiogroup', { name: 'Detected Runtime candidates' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(group.textContent).toContain('/usr/local/bin/acme');
    expect(group.textContent).toContain('path · PATH');
    expect(group.textContent).toContain('/opt/acme/bin/acme');
    expect(group.textContent).toContain('official-system');
    // Host-projected setup actions render verbatim.
    expect(within(setup).getByTestId('runtime-action-download').textContent).toBe('Download Acme CLI');
    expect(within(setup).getByTestId('runtime-action-pick').textContent).toBe('Choose executable');
  });

  it('does not expose the legacy Runtime path selector in the managed Proxy detail', async () => {
    mockApi([]);
    await renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const card = await screen.findByTestId(`catalog-item-${PLUGIN_ID}`);
    fireEvent.click(within(card).getByLabelText('View Integration'));
    const panel = await screen.findByTestId('proxy-detail-panel');
    expect(within(panel).queryByTestId('proxy-action-setup')).toBeNull();
    expect(within(panel).queryByTestId('runtime-path-input')).toBeNull();
  });

  it('shows the loading state while discover is in flight', async () => {
    mockApi([]);
    let resolveDiscover: (value: RuntimeDiscoverResponse) => void = () => undefined;
    vi.mocked(api.discoverProxyRuntime).mockImplementation(
      () => new Promise<RuntimeDiscoverResponse>(resolve => { resolveDiscover = resolve; }),
    );
    await renderAgents();
    const panel = await openSetupTab();
    // The pending discover operation drives the loading state.
    expect(await within(panel).findByTestId('runtime-discover-loading')).toBeTruthy();
    expect(within(panel).queryByTestId('runtime-candidates')).toBeNull();

    await act(async () => resolveDiscover(discoverResponse()));
    expect(await within(panel).findByTestId('runtime-candidates')).toBeTruthy();
  });

  it('surfaces a discover failure with the Host message and recovers on Retry', async () => {
    mockApi([]);
    vi.mocked(api.discoverProxyRuntime).mockRejectedValueOnce(new Error('catalog offline'));
    await renderAgents();
    const panel = await openSetupTab();
    const error = await within(panel).findByTestId('runtime-discover-error');
    expect(error.textContent).toContain('catalog offline');

    fireEvent.click(within(error).getByTestId('runtime-discover-retry'));
    expect(await within(panel).findByTestId('runtime-candidates')).toBeTruthy();
    expect(api.discoverProxyRuntime).toHaveBeenCalledTimes(2);
  });

  it('shows the empty state when the Host returns no candidates', async () => {
    mockApi([]);
    vi.mocked(api.discoverProxyRuntime).mockResolvedValue(discoverResponse({ candidates: [] }));
    await renderAgents();
    const panel = await openSetupTab();
    expect(await within(panel).findByTestId('runtime-candidates-empty')).toBeTruthy();
    // The manual path form is still available.
    expect(within(panel).getByTestId('runtime-path-input')).toBeTruthy();
  });

  it('selecting a candidate fills the path input and probe submits exactly that path', async () => {
    mockApi([]);
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');

    fireEvent.click(within(panel).getByTestId('runtime-candidate-0'));
    const input = within(panel).getByTestId('runtime-path-input') as HTMLInputElement;
    expect(input.value).toBe('/usr/local/bin/acme');

    fireEvent.click(within(panel).getByTestId('runtime-probe'));
    await waitFor(() => expect(api.probeProxyRuntime)
      .toHaveBeenCalledWith(PLUGIN_ID, '/usr/local/bin/acme'));
    const result = await within(panel).findByTestId('runtime-probe-result');
    expect(result.textContent).toContain('ready');
    expect(result.textContent).toContain('1.0.0');
    expect(result.textContent).toContain('/usr/local/bin/acme');
    await waitFor(() => expect(projectionChanged).toHaveBeenCalledTimes(1));
    expect(runtimeSelected).toHaveBeenCalledWith(PLUGIN_ID, '1.0.0', '/usr/local/bin/acme');
  });

  it('probes a manually typed absolute path verbatim (Host canonicalizes)', async () => {
    mockApi([]);
    vi.mocked(api.probeProxyRuntime).mockImplementation(async (_pluginId, path) => probeResponse(path, {
      profile: { ...probeResponse(path).profile, verification: 'unverified' },
      readinessIssue: { code: 'RUNTIME_UNVERIFIED', message: 'not a verified build', repairable: true },
    }));
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');

    const input = within(panel).getByTestId('runtime-path-input');
    fireEvent.change(input, { target: { value: '  /opt/custom/bin/acme  ' } });
    fireEvent.click(within(panel).getByTestId('runtime-probe'));
    // Web submits the raw path only — trimming, never resolving.
    await waitFor(() => expect(api.probeProxyRuntime)
      .toHaveBeenCalledWith(PLUGIN_ID, '/opt/custom/bin/acme'));
    const result = await within(panel).findByTestId('runtime-probe-result');
    expect(result.textContent).toContain('unverified');
    expect(within(panel).getByTestId('runtime-readiness-issue').textContent)
      .toContain('not a verified build');
    // A readinessIssue means the path is NOT offered to the managed Agent flow.
    expect(runtimeSelected).not.toHaveBeenCalled();
  });

  it('surfaces a probe failure as an inline error without touching projections', async () => {
    mockApi([]);
    vi.mocked(api.probeProxyRuntime).mockRejectedValue(new Error('path must be a canonical absolute path.'));
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');

    fireEvent.change(within(panel).getByTestId('runtime-path-input'), { target: { value: 'relative/path' } });
    fireEvent.click(within(panel).getByTestId('runtime-probe'));
    const error = await within(panel).findByTestId('runtime-probe-error');
    expect(error.textContent).toContain('canonical absolute path');
    expect(within(panel).queryByTestId('runtime-probe-result')).toBeNull();
    // No projection reload on failure: only the initial load happened.
    expect(vi.mocked(api.loadProxyCatalog).mock.calls.length).toBe(1);
  });

  it('open_url renders the Host-verified https link; select_file only focuses the manual input', async () => {
    mockApi([]);
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');

    const link = within(panel).getByTestId('runtime-action-download') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.href).toBe('https://acme.example/install');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');

    const input = within(panel).getByTestId('runtime-path-input') as HTMLInputElement;
    fireEvent.click(within(panel).getByTestId('runtime-action-pick'));
    expect(document.activeElement).toBe(input);
    // The composer resource picker / native CLI picker is never involved.
    expect(api.pickAgentCliPath).not.toHaveBeenCalled();
  });

  it('never renders a non-https setup URL as a link', async () => {
    mockApi([]);
    vi.mocked(api.discoverProxyRuntime).mockResolvedValue(discoverResponse({
      setupActions: [
        { id: 'bad', kind: 'open_url', label: 'Definitely safe', url: 'javascript:alert(1)' },
      ],
    }));
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');
    expect(within(panel).queryByTestId('runtime-action-bad')).toBeNull();
  });

  it('a none-runtime Manifest renders the self-contained note and no path form', async () => {
    mockApi([]);
    vi.mocked(api.discoverProxyRuntime).mockResolvedValue(discoverResponse({
      runtime: { kind: 'none' },
      candidates: [],
      setupActions: [],
    }));
    await renderAgents();
    const panel = await openSetupTab();
    await waitFor(() => expect(api.discoverProxyRuntime).toHaveBeenCalled());
    expect((await within(panel).findByTestId('runtime-setup')).textContent)
      .toContain('no external Runtime required');
    expect(within(panel).queryByTestId('runtime-path-input')).toBeNull();
  });

  it('a not_required projection never triggers discover at all', async () => {
    const selfContained = catalogItem({
      pluginId: 'io.acme.selfcontained',
      runtime: { state: 'not_required', displayName: null },
      availableActions: ['create_agent'],
    });
    mockApi([], [selfContained]);
    await renderAgents();
    const panel = await openSetupTab('io.acme.selfcontained');
    expect(await within(panel).findByTestId('runtime-none')).toBeTruthy();
    expect(api.discoverProxyRuntime).not.toHaveBeenCalled();
    expect(api.probeProxyRuntime).not.toHaveBeenCalled();
  });

  it('items without a Host setup action stay documentation-only (no discover/probe)', async () => {
    const incompatible = catalogItem({
      pluginId: 'io.acme.needs-app',
      compatibility: { state: 'requires_app_update', reason: 'requires gian.proxy/2.2', protocolRange: '^2.2' },
      availableActions: [],
    });
    mockApi([], [incompatible]);
    await renderAgents();
    const panel = await openSetupTab('io.acme.needs-app');
    expect(await within(panel).findByTestId('runtime-unavailable')).toBeTruthy();
    expect(api.discoverProxyRuntime).not.toHaveBeenCalled();
    // The product detail remains documentation-only.
    fireEvent.click(screen.getByTestId('agents-add'));
    const card = await screen.findByTestId('catalog-item-io.acme.needs-app');
    fireEvent.click(within(card).getByLabelText('View Integration'));
    const detail = await screen.findByTestId('proxy-detail-panel');
    expect(within(detail).queryByTestId('runtime-path-input')).toBeNull();
    await waitFor(() => expect(api.loadCatalogDocument)
      .toHaveBeenCalledWith('/api/proxies/io.acme.needs-app/docs/setup'));
  });

  it('keeps open_setup and select_runtime out of the managed product surface', async () => {
    const both = catalogItem({
      pluginId: PLUGIN_ID,
      availableActions: ['open_setup', 'select_runtime', 'create_agent'],
    });
    mockApi([], [both]);
    await renderAgents();
    fireEvent.click(await screen.findByTestId('agents-add'));
    const card = await screen.findByTestId(`catalog-item-${PLUGIN_ID}`);
    fireEvent.click(within(card).getByLabelText('View Integration'));
    const panel = await screen.findByTestId('proxy-detail-panel');
    expect(within(panel).queryByTestId('proxy-action-setup')).toBeNull();
    expect(within(panel).queryByTestId('runtime-path-input')).toBeNull();
  });

  it('treats the discover response as the action authority: revoked setup hides the form and never probes', async () => {
    mockApi([]);
    // The list projection still carries select_runtime, but the fresh
    // discover response revoked both setup actions (install/compatibility
    // changed mid-session). The discover response wins.
    vi.mocked(api.discoverProxyRuntime).mockResolvedValue(discoverResponse({
      availableActions: ['create_agent'],
    }));
    await renderAgents();
    const panel = await openSetupTab();
    await waitFor(() => expect(api.discoverProxyRuntime).toHaveBeenCalledWith(PLUGIN_ID));
    expect(await within(panel).findByTestId('runtime-revoked')).toBeTruthy();
    expect(within(panel).queryByTestId('runtime-candidates')).toBeNull();
    expect(within(panel).queryByTestId('runtime-path-input')).toBeNull();
    expect(within(panel).queryByTestId('runtime-probe')).toBeNull();
    expect(within(panel).queryByTestId('runtime-action-download')).toBeNull();
    expect(api.probeProxyRuntime).not.toHaveBeenCalled();
  });

  it('an incompatible probe result is shown with its reason but never recorded for the draft', async () => {
    mockApi([]);
    vi.mocked(api.probeProxyRuntime).mockImplementation(async (_pluginId, path) => probeResponse(path, {
      profile: { ...probeResponse(path).profile, verification: 'incompatible' },
      readinessIssue: { code: 'RUNTIME_INCOMPATIBLE', message: 'below the supported range', repairable: false },
    }));
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');
    fireEvent.click(within(panel).getByTestId('runtime-candidate-0'));
    fireEvent.click(within(panel).getByTestId('runtime-probe'));
    const result = await within(panel).findByTestId('runtime-probe-result');
    expect(result.textContent).toContain('invalid');
    expect(within(panel).getByTestId('runtime-readiness-issue').textContent)
      .toContain('below the supported range');

    expect(runtimeSelected).not.toHaveBeenCalled();
  });

  it('a probe result with a readinessIssue is shown but never recorded for the draft', async () => {
    mockApi([]);
    vi.mocked(api.probeProxyRuntime).mockImplementation(async (_pluginId, path) => probeResponse(path, {
      readinessIssue: { code: 'RUNTIME_QUIRK', message: 'config home is read-only', repairable: true },
    }));
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');
    fireEvent.click(within(panel).getByTestId('runtime-candidate-1'));
    fireEvent.click(within(panel).getByTestId('runtime-probe'));
    const result = await within(panel).findByTestId('runtime-probe-result');
    // Still displayed (verified status + issue)…
    expect(result.textContent).toContain('ready');
    expect(within(panel).getByTestId('runtime-readiness-issue').textContent)
      .toContain('config home is read-only');
    // …but never recorded as a selected path.
    expect(runtimeSelected).not.toHaveBeenCalled();
  });

  it('drops a probe result that belongs to an older plugin generation', async () => {
    mockApi([]);
    vi.mocked(api.probeProxyRuntime).mockImplementation(async (_pluginId, path) => (
      probeResponse(path, { pluginVersion: '0.9.0' })
    ));
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');
    fireEvent.click(within(panel).getByTestId('runtime-candidate-0'));
    fireEvent.click(within(panel).getByTestId('runtime-probe'));
    await waitFor(() => expect(api.probeProxyRuntime).toHaveBeenCalled());
    expect(within(panel).queryByTestId('runtime-probe-result')).toBeNull();
    expect(runtimeSelected).not.toHaveBeenCalled();
  });

  it('keeps a Proxy update in the document action row without exposing path selection', async () => {
    const updatable = catalogItem({
      pluginId: PLUGIN_ID,
      installation: { installedVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true },
      availableActions: ['select_runtime', 'update_proxy', 'create_agent'],
    });
    mockApi([], [updatable]);
    vi.mocked(api.updateCatalogProxy).mockResolvedValue({ pluginId: PLUGIN_ID, pluginVersion: '1.1.0' });
    await renderAgents();
    fireEvent.click(screen.getByTestId('agents-add'));
    const card = await screen.findByTestId(`catalog-item-${PLUGIN_ID}`);
    fireEvent.click(within(card).getByLabelText('View Integration'));
    const panel = await screen.findByTestId('proxy-detail-panel');
    const updated = catalogItem({
      pluginId: PLUGIN_ID,
      installation: { installedVersion: '1.1.0', latestVersion: '1.1.0', updateAvailable: false },
      availableActions: ['select_runtime', 'create_agent'],
    });
    vi.mocked(api.loadProxyCatalog).mockResolvedValue({
      proxies: LEGACY_PROXIES,
      catalog: catalogList([updated]),
    });
    fireEvent.click(within(panel).getByTestId('proxy-action-update'));
    await waitFor(() => expect(api.updateCatalogProxy).toHaveBeenCalledWith(PLUGIN_ID));
    expect(within(panel).queryByTestId('runtime-path-input')).toBeNull();
  });

  it('keeps a lower-level probe result out of the managed Agent draft payload', async () => {
    mockApi([]);
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');
    fireEvent.click(within(panel).getByTestId('runtime-candidate-0'));
    fireEvent.click(within(panel).getByTestId('runtime-probe'));
    await within(panel).findByTestId('runtime-probe-result');
    expect(runtimeSelected).toHaveBeenCalledWith(PLUGIN_ID, '1.0.0', '/usr/local/bin/acme');

    fireEvent.click(screen.getByTestId('agents-add'));
    fireEvent.click(await screen.findByTestId(`catalog-open-${PLUGIN_ID}`));
    const draft = await screen.findByTestId('agent-draft-panel');
    expect(within(draft).queryByLabelText('Path')).toBeNull();

    fireEvent.click(within(draft).getByTestId('agent-draft-save'));
    await waitFor(() => expect(api.createAgent).toHaveBeenCalledWith({
      name: 'Acme External',
      pluginId: PLUGIN_ID,
      home: { kind: 'managed' },
    }));
  });

  it('never records a stale lower-level path for managed Agent creation', async () => {
    mockApi([]);
    vi.mocked(api.probeProxyRuntime).mockImplementation(async (_pluginId, path) => (
      probeResponse(path, { pluginVersion: '0.9.0' })
    ));
    await renderAgents();
    const panel = await openSetupTab();
    await within(panel).findByTestId('runtime-candidates');
    fireEvent.click(within(panel).getByTestId('runtime-candidate-0'));
    fireEvent.click(within(panel).getByTestId('runtime-probe'));
    await waitFor(() => expect(api.probeProxyRuntime).toHaveBeenCalled());
    expect(runtimeSelected).not.toHaveBeenCalled();
    expect(within(panel).queryByTestId('runtime-probe-result')).toBeNull();
  });
});
