import { executorIdForPluginId, isProductExecutor, isProxyPluginId } from '@gian/shared';
import type { CatalogService } from '../catalog/service.js';
import type { AgentManager } from './manager.js';

export interface ProxyLogoBytes {
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/webp';
  sha256: string;
}

/** Logo resolution shared by the local HTTP route and the Remote `proxy.logo`
 *  command: the signed Catalog sequence is the brand source of truth; the
 *  installed (vendored) Proxy package is only the local fallback. Kept out of
 *  `web/` so the plugin-id source scan stays at its baseline. */
export async function resolveProxyLogo(
  deps: { agents: AgentManager; catalogService?: CatalogService },
  proxy: string,
  variant: 'light' | 'dark',
): Promise<ProxyLogoBytes | null> {
  if (deps.catalogService && isProxyPluginId(proxy)) {
    const catalogLogo = await deps.catalogService.logo(proxy, variant);
    if (catalogLogo) return catalogLogo;
  }
  const official = executorIdForPluginId(proxy);
  if (official && isProductExecutor(official)) {
    return deps.agents.proxyLogo(official, variant);
  }
  return null;
}
