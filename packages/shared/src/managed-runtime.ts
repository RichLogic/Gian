import type { ProxyPluginId } from './plugin-id.js';

export type ManagedRuntimePlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-x64';

export interface AgentHomeBinding {
  kind: 'managed' | 'custom';
  /** Canonical absolute Provider state/configuration directory. */
  path: string;
}

export interface RuntimeGenerationProxyRef {
  pluginVersion: string;
  manifestSha256: string;
  artifactSha256: string;
  entryPath: string;
  processScope: 'shared' | 'session';
  protocolRange: string;
}

export interface RuntimeGenerationRuntimeRef {
  runtimeId: string;
  version: string;
  artifactSha256: string;
  entryPath: string;
  ownership: 'managed' | 'external-app';
}

export interface RuntimeGenerationCompanionRef {
  id: string;
  version: string;
  artifactSha256: string;
  entryPath: string;
}

export interface RuntimeGenerationCertificateRef {
  id: string;
  sha256: string;
}

/** Exact, release-certified executable tuple shared by every Agent of one
 * pluginId. HOME deliberately does not belong to this identity. */
export interface ManagedRuntimeGeneration {
  schemaVersion: 1;
  generationId: string;
  pluginId: ProxyPluginId;
  platform: ManagedRuntimePlatform;
  proxy: RuntimeGenerationProxyRef;
  runtime: RuntimeGenerationRuntimeRef | null;
  companions: RuntimeGenerationCompanionRef[];
  certificate: RuntimeGenerationCertificateRef;
  state: 'staged' | 'active' | 'retired' | 'failed';
  installedAt: string;
  activatedAt: string | null;
}

export interface ManagedRuntimeActivePointer {
  schemaVersion: 1;
  pluginId: ProxyPluginId;
  generationId: string;
  activatedAt: string;
}

export interface ManagedRuntimeStatus {
  pluginId: ProxyPluginId;
  active: ManagedRuntimeGeneration | null;
  staged: ManagedRuntimeGeneration[];
}

export interface ManagedRuntimeDownloadAsset {
  url: string;
  sha256: string;
  size: number;
}

export type ManagedRuntimeDistribution =
  | {
    kind: 'native-binary';
    runtimeId: string;
    version: string;
    asset: ManagedRuntimeDownloadAsset;
    /** Raw executable or a gzip-compressed ustar Runtime tree. */
    format: 'raw' | 'tar.gz';
    entryRelativePath: string;
  }
  | {
    kind: 'external-app';
    runtimeId: string;
    version: string;
    entryPath: string;
    artifactSha256: string;
  };

/** Trusted input compiled from a signed Catalog coordinate. It contains data,
 * never a shell command or user-provided executable path. */
export interface ManagedRuntimeInstallPlan {
  generationId: string;
  pluginId: ProxyPluginId;
  platform: ManagedRuntimePlatform;
  proxy: RuntimeGenerationProxyRef;
  runtime: ManagedRuntimeDistribution | null;
  companions: Array<{
    id: string;
    distribution: Extract<ManagedRuntimeDistribution, { kind: 'native-binary' }>;
  }>;
  certificate: RuntimeGenerationCertificateRef;
}

/** User-visible progress emitted by the Host while it installs one complete
 * certified Agent Integration. These are operation facts, not shell output:
 * the Web renderer presents them in a read-only installation terminal. */
export type ManagedRuntimeInstallProgressStage =
  | 'catalog'
  | 'proxy'
  | 'runtime-discovery'
  | 'runtime-plan'
  | 'runtime-download'
  | 'runtime-verify'
  | 'combination-verify'
  | 'activation';

export interface ManagedRuntimeInstallProgress {
  stage: ManagedRuntimeInstallProgressStage;
  status: 'started' | 'progress' | 'completed';
  componentId?: string;
  version?: string;
  receivedBytes?: number;
  totalBytes?: number;
}

/** NDJSON frames used only when the Runtime install endpoint is requested as
 * a progress stream. Ordinary callers keep the existing JSON response. */
export type ManagedRuntimeInstallStreamFrame =
  | { type: 'progress'; progress: ManagedRuntimeInstallProgress }
  | { type: 'result'; generation: ManagedRuntimeGeneration }
  | { type: 'error'; error: { code?: string; message: string } };
