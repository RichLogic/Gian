import type { CatalogProxyAction } from './proxy-catalog-projection.js';
import type { ProxyPluginId } from './plugin-id.js';
import type { OpenRuntimeProfile } from './session-proxy-binding.js';

export interface RuntimeDiscoverResponse {
  pluginId: ProxyPluginId;
  pluginVersion: string;
  runtime: {
    kind: 'none' | 'external';
    id?: string;
    displayName?: string;
    verifiedVersions?: string[];
  };
  candidates: Array<{
    path: string;
    source: 'configured' | 'official-user' | 'official-system' | 'path';
    label?: string;
  }>;
  setupActions: Array<
    | { id: string; kind: 'open_url'; label: string; url: string }
    | { id: string; kind: 'select_file'; label: string }
  >;
  availableActions: CatalogProxyAction[];
}

export interface RuntimeProbeRequest {
  path: string;
}

export interface RuntimeProbeResponse {
  pluginId: ProxyPluginId;
  pluginVersion: string;
  selectedPath: string;
  profile: OpenRuntimeProfile;
  readinessIssue?: { code: string; message: string; repairable: boolean };
  availableActions: CatalogProxyAction[];
}
