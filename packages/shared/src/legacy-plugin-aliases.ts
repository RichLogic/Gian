/**
 * Bounded migration vocabulary for data written before Agent.pluginId and
 * Session.proxy_binding existed. New Catalog, Runtime, Session, Web, and
 * Desktop behavior must not enumerate this map.
 */
import { isProxyPluginId, parseProxyPluginId, type ProxyPluginId } from './plugin-id.js';

export const LEGACY_EXECUTOR_IDS = ['claude', 'codex', 'kimi', 'grok', 'dsh', 'zcode'] as const;
export type LegacyExecutorId = (typeof LEGACY_EXECUTOR_IDS)[number];
export type ExecutorId = LegacyExecutorId;

export const LEGACY_PRODUCT_EXECUTOR_IDS = ['claude', 'codex', 'kimi', 'dsh', 'zcode'] as const;
export type LegacyProductExecutorId = (typeof LEGACY_PRODUCT_EXECUTOR_IDS)[number];
export type ProductExecutorId = LegacyProductExecutorId;

export const LEGACY_PLUGIN_ID_BY_EXECUTOR: Readonly<Record<LegacyExecutorId, string>> = {
  claude: 'claude',
  codex: 'codex',
  kimi: 'kimi',
  grok: 'grok',
  dsh: 'ai.deepseek.harness',
  zcode: 'com.zhipu.zcode',
};

const LEGACY_FEATURES: Readonly<Record<LegacyExecutorId, {
  productVisible: boolean;
  cliCapabilitySurface: boolean;
  nativeExecutorConfig: boolean;
  nativeSessions: boolean;
}>> = {
  claude: { productVisible: true, cliCapabilitySurface: true, nativeExecutorConfig: false, nativeSessions: true },
  codex: { productVisible: true, cliCapabilitySurface: true, nativeExecutorConfig: false, nativeSessions: true },
  kimi: { productVisible: true, cliCapabilitySurface: false, nativeExecutorConfig: true, nativeSessions: true },
  grok: { productVisible: false, cliCapabilitySurface: false, nativeExecutorConfig: true, nativeSessions: true },
  dsh: { productVisible: true, cliCapabilitySurface: false, nativeExecutorConfig: true, nativeSessions: false },
  zcode: { productVisible: true, cliCapabilitySurface: false, nativeExecutorConfig: false, nativeSessions: true },
};

/** Deprecated names are exported only so legacy migrations/read adapters can
 * remain source-compatible while callers move to pluginId. */
export const EXECUTOR_IDS = LEGACY_EXECUTOR_IDS;
export const PRODUCT_EXECUTOR_IDS = LEGACY_PRODUCT_EXECUTOR_IDS;

export function isExecutorId(value: unknown): value is LegacyExecutorId {
  return typeof value === 'string'
    && (LEGACY_EXECUTOR_IDS as readonly string[]).includes(value);
}

export function legacyExecutorFeatures(value: string) {
  return isExecutorId(value) ? LEGACY_FEATURES[value] : null;
}

export function pluginIdForExecutorId(id: LegacyExecutorId): ProxyPluginId {
  return parseProxyPluginId(LEGACY_PLUGIN_ID_BY_EXECUTOR[id]);
}

export function executorIdForPluginId(pluginId: string): LegacyExecutorId | null {
  if (isExecutorId(pluginId)) return pluginId;
  for (const id of LEGACY_EXECUTOR_IDS) {
    if (LEGACY_PLUGIN_ID_BY_EXECUTOR[id] === pluginId) return id;
  }
  return null;
}

export function productExecutorForPluginId(pluginId: string): LegacyProductExecutorId | null {
  const id = executorIdForPluginId(pluginId);
  if (!id) return null;
  return (LEGACY_PRODUCT_EXECUTOR_IDS as readonly string[]).includes(id)
    ? id as LegacyProductExecutorId
    : null;
}

export function resolvePluginIdInput(value: unknown): ProxyPluginId | null {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return null;
  if (isProxyPluginId(value)) return value;
  return isExecutorId(value) ? pluginIdForExecutorId(value) : null;
}
