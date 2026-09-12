import type { ManifestV4 } from '@gian/proxy-protocol';
import type { ProxyPluginId } from '@gian/shared';

import type { PluginInstallReceipt } from './receipt.js';

export interface PluginArtifactNetwork {
  download(input: {
    repository: string;
    tag: string;
    asset: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<Buffer>;
}

export interface PluginInstallCoordinate {
  pluginId: ProxyPluginId | string;
  pluginVersion: string;
  platform: string;
  manifest: { url: string; sha256: string; size: number };
  archive: { url: string; sha256: string; size: number };
  sourceId: 'gian-official' | 'giandev';
  catalogSequence: number | null;
  protocolRange: string;
  processScope: 'shared' | 'session';
  runtime: ManifestV4['runtime'] | null;
}

export interface PluginBindingReference {
  pluginId: string;
  pluginVersion: string;
}

export interface PluginVersionReferenceReport {
  pluginId: string;
  pluginVersion: string;
  current: boolean;
  sessionBindings: number;
  inFlight: boolean;
}

export interface InstalledVersionView {
  version: string;
  state: 'valid' | 'quarantined' | 'legacy';
  receipt: PluginInstallReceipt | null;
}

export interface InstalledPackageView {
  pluginId: string;
  currentVersion: string | null;
  currentPointer: 'absent' | 'valid' | 'unmanaged';
  versions: InstalledVersionView[];
}

export interface PluginExactLaunch {
  pluginId: ProxyPluginId;
  displayName: string;
  pluginVersion: string;
  manifestSha256: string;
  entryPath: string;
  processScope: 'shared' | 'session';
  protocolVersion: string;
  schemaVersion: 4;
  runtime: ManifestV4['runtime'];
  protocolRange: string;
}

export interface PluginCurrentLaunch {
  pluginId: ProxyPluginId;
  displayName: string;
  pluginVersion: string;
  manifestSha256: string;
  entryPath: string;
  processScope: 'shared' | 'session';
  schemaVersion: 4;
  runtime: ManifestV4['runtime'];
  protocolRange: string;
}
