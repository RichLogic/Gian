import { describe, expect, it } from 'vitest';
import type {
  ProductExecutor,
  ProxyCatalogEntry,
  ProxyCatalogItem,
  UserAgentStatus,
} from '@gian/shared';
import {
  agentProxyDisplay,
  canCreateAgent,
  catalogBadges,
  compatibilityMessage,
  draftNameError,
  isCatalogItemDisabled,
} from '../src/agents/catalog-model.js';

let seq = 0;

function item(overrides: {
  pluginId?: string;
  displayName?: string;
  tagline?: string;
  compatibility?: Partial<ProxyCatalogItem['compatibility']>;
  installation?: Partial<ProxyCatalogItem['installation']>;
  runtime?: Partial<ProxyCatalogItem['runtime']>;
  availableActions?: ProxyCatalogItem['availableActions'];
} = {}): ProxyCatalogItem {
  seq += 1;
  const pluginId = overrides.pluginId ?? `io.fixture.plugin-${seq}`;
  return {
    pluginId,
    displayName: overrides.displayName ?? `Plugin ${seq}`,
    tagline: overrides.tagline ?? `Tagline ${seq}`,
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

function agent(overrides: Partial<UserAgentStatus> & { pluginId: string }): UserAgentStatus {
  seq += 1;
  return {
    id: overrides.id ?? `agent-${seq}`,
    name: overrides.name ?? `Agent ${seq}`,
    pluginId: overrides.pluginId,
    proxy: overrides.proxy ?? null,
    cliPath: overrides.cliPath ?? null,
    defaults: overrides.defaults ?? { model: '', thinking: '', mode: '' },
    proxyName: overrides.proxyName ?? '',
    ready: overrides.ready ?? true,
    cli: overrides.cli ?? { state: 'ready', path: '/bin/x', version: '1.0.0', source: 'path' },
    plugin: overrides.plugin ?? {
      state: 'ready', path: '/proxy/x', version: '0.1.0', source: 'development',
      defaults: { model: '', thinking: '', mode: '' },
    },
    runtimeProfile: overrides.runtimeProfile ?? null,
    officialInstallUrl: overrides.officialInstallUrl ?? '',
  };
}

describe('catalogBadges', () => {
  it('marks a compatible not-installed item', () => {
    expect(catalogBadges(item())).toEqual(['not-installed']);
  });

  it('puts update-available first for an installed item with an update', () => {
    expect(catalogBadges(item({
      installation: { state: 'installed', installedVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true },
      availableActions: ['update_proxy'],
    }))).toEqual(['update-required']);
  });

  it('treats an installed Proxy without its Runtime as not installed', () => {
    expect(catalogBadges(item({
      installation: { state: 'installed', installedVersion: '1.0.0' },
      runtime: { state: 'setup_required', displayName: 'Fixture CLI' },
      availableActions: ['open_setup', 'select_runtime'],
    }))).toEqual(['not-installed']);
  });

  it('distinguishes app-too-old from proxy-too-old', () => {
    expect(catalogBadges(item({
      compatibility: { state: 'requires_app_update', reason: 'needs 2.2' },
      availableActions: [],
    }))).toEqual(['update-required']);
    expect(catalogBadges(item({
      compatibility: { state: 'requires_proxy_update', reason: 'range 2.0-only' },
      availableActions: [],
    }))).toEqual(['update-required']);
  });

  it('flags invalid compatibility and quarantined installs', () => {
    expect(catalogBadges(item({
      compatibility: { state: 'invalid', reason: 'bad manifest' },
      availableActions: [],
    }))).toEqual(['update-required']);
    expect(catalogBadges(item({
      installation: { state: 'quarantined', installedVersion: '0.9.0' },
      availableActions: [],
    }))).toEqual(['update-required']);
  });

  it('treats an untrusted Proxy without a complete Runtime generation as not installed', () => {
    expect(catalogBadges(item({
      installation: { state: 'quarantined', installedVersion: '0.9.0' },
      runtime: { state: 'setup_required', displayName: 'Fixture CLI' },
      availableActions: ['install_runtime'],
    }))).toEqual(['not-installed']);
  });
});

describe('compatibilityMessage', () => {
  it('maps each incompatible state to a distinct guidance key', () => {
    expect(compatibilityMessage(item({
      compatibility: { state: 'requires_app_update', reason: 'r1' },
    }))).toEqual({ key: 'agents.catalog.compat.appUpdate', reason: 'r1' });
    expect(compatibilityMessage(item({
      compatibility: { state: 'requires_proxy_update', reason: 'r2' },
    }))).toEqual({ key: 'agents.catalog.compat.proxyUpdate', reason: 'r2' });
    expect(compatibilityMessage(item({
      compatibility: { state: 'invalid', reason: null },
    }))).toEqual({ key: 'agents.catalog.compat.invalid', reason: null });
    expect(compatibilityMessage(item())).toBeNull();
  });
});

describe('action gating (Host-authoritative)', () => {
  it('create_agent follows the Host projection for open plugins', () => {
    expect(canCreateAgent(item({ availableActions: ['create_agent'] }))).toBe(true);
    expect(canCreateAgent(item())).toBe(false);
  });

  it('reserved official pluginIds get no create affordance without the Host action', () => {
    // Action authority is Host-only: an empty availableActions list renders
    // no create path, even for reserved official IDs (the missing projection
    // is a backend integration requirement, not a Web workaround).
    expect(canCreateAgent(item({ pluginId: 'claude', availableActions: [] }))).toBe(false);
    expect(canCreateAgent(item({ pluginId: 'io.acme.tool', availableActions: [] }))).toBe(false);
  });

  it('disabled items keep no usable affordance', () => {
    expect(isCatalogItemDisabled(item({
      compatibility: { state: 'requires_app_update' },
    }))).toBe(true);
    expect(isCatalogItemDisabled(item())).toBe(false);
  });
});

describe('agentProxyDisplay (legacy adapter)', () => {
  const legacyProxies: ProxyCatalogEntry[] = [
    { id: 'claude' as ProductExecutor, name: 'Claude Code', logo: { light: '/l.png', dark: '/d.png' }, tagline: 'Legacy kind', officialInstallUrl: 'https://example.invalid' },
  ];

  it('prefers the Catalog entry matching the open pluginId', () => {
    const catalogItem = item({ pluginId: 'io.acme.tool', displayName: 'Acme Tool' });
    const display = agentProxyDisplay(agent({ pluginId: 'io.acme.tool' }), [catalogItem], []);
    expect(display.name).toBe('Acme Tool');
    expect(display.logo).toEqual(catalogItem.logo);
  });

  it('falls back to legacy kind metadata for pre-migration Agents', () => {
    const display = agentProxyDisplay(
      agent({ pluginId: 'claude', proxy: 'claude' as ProductExecutor }),
      [],
      legacyProxies,
    );
    expect(display.name).toBe('Claude Code');
  });

  it('falls back to proxyName/pluginId when nothing else matches', () => {
    const display = agentProxyDisplay(
      agent({ pluginId: 'io.gone.proxy', proxyName: '' }),
      [],
      [],
    );
    expect(display).toEqual({ name: 'io.gone.proxy', tagline: '', logo: null });
  });
});

describe('draftNameError', () => {
  it('rejects empty and case-insensitively taken names', () => {
    const agents = [agent({ pluginId: 'io.a', name: 'Writer' })];
    expect(draftNameError('   ', agents)).toBe('empty');
    expect(draftNameError('writer', agents)).toBe('taken');
    expect(draftNameError('Writer 2', agents)).toBeNull();
  });
});
