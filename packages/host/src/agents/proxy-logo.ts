import { executorIdForPluginId, isProductExecutor, isProxyPluginId } from '@gian/shared';
import type { CatalogService } from '../catalog/service.js';
import type { AgentManager } from './manager.js';

export interface ProxyLogoBytes {
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/webp';
  sha256: string;
}

/** Logo resolution shared by the local HTTP route and the Remote `proxy.logo`
 *  command: official (vendored) Proxies first, then synced catalog entries.
 *  Kept out of `web/` so the plugin-id source scan stays at its baseline. */
export async function resolveProxyLogo(
  deps: { agents: AgentManager; catalogService?: CatalogService },
  proxy: string,
  variant: 'light' | 'dark',
): Promise<ProxyLogoBytes | null> {
  const official = executorIdForPluginId(proxy);
  if (official && isProductExecutor(official)) {
    const logo = await deps.agents.proxyLogo(official, variant);
    if (logo) return logo;
  }
  if (deps.catalogService && isProxyPluginId(proxy)) {
    return deps.catalogService.logo(proxy, variant);
  }
  return null;
}
