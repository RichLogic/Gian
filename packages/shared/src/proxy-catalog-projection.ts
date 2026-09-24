/**
 * Host-authoritative Proxy Catalog list projection.
 * Catalog bytes never decide actions; Host computes them after
 * signature/cache/install validation.
 */

export type CatalogCompatibilityState =
  | 'compatible'
  | 'requires_app_update'
  | 'requires_proxy_update'
  | 'invalid';

export type CatalogInstallationState =
  | 'not_installed'
  | 'installed'
  | 'invalid'
  | 'quarantined';

export type CatalogRuntimeState =
  | 'not_required'
  | 'setup_required'
  | 'ready'
  | 'unverified'
  | 'invalid';

export type CatalogProxyAction =
  | 'install_runtime'
  | 'install_proxy'
  | 'update_proxy'
  | 'rollback_proxy'
  | 'open_setup'
  | 'select_runtime'
  | 'create_agent';

export interface ProxyCatalogItem {
  localizations?: Partial<Record<'en' | 'zh-CN', {
    displayName: string;
    tagline: string;
    documentation: ProxyCatalogItem['documentation'];
  }>>;
  pluginId: string;
  displayName: string;
  tagline: string;
  logo: { light: string; dark: string };
  documentation: {
    overview: string;
    setup: string;
    usage: string;
    troubleshooting: string;
  };
  compatibility: {
    state: CatalogCompatibilityState;
    hostVersions: string[];
    protocolRange: string;
    reason: string | null;
  };
  installation: {
    state: CatalogInstallationState;
    installedVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    source: 'gian-official' | 'giandev' | null;
  };
  runtime: {
    state: CatalogRuntimeState;
    displayName: string | null;
    readinessIssue?: { code: string; message: string; repairable: boolean };
  };
  availableActions: CatalogProxyAction[];
}

export interface ProxyCatalogSourceState {
  id: string | null;
  sequence: number | null;
  state: 'empty' | 'ready' | 'stale' | 'error';
  error: { code: string; message: string } | null;
}

export interface ProxyCatalogList {
  source: ProxyCatalogSourceState;
  items: ProxyCatalogItem[];
}
