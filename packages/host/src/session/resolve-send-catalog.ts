import { ProxyProtocolError } from '@gian/proxy-protocol';
import type { ConfigValue, ProxyCatalog, ResolvedProxyCatalog } from '@gian/shared';

/** The send path only needs these catalog methods. ProxyClient satisfies this. */
export interface SendCatalogClient {
  resolveCatalog?(params: {
    catalogRevision: string;
    sessionConfig: Record<string, ConfigValue>;
    turnConfig: Record<string, ConfigValue>;
  }): Promise<ResolvedProxyCatalog>;
  /** Proxy fence of the attached session. Absent before session.create. */
  sessionCatalogRevision?(): string | undefined;
  /** Drop the frozen process catalog and list the canonical catalog once. */
  reloadCatalog?(): Promise<ProxyCatalog>;
}

function isCatalogChangedConflict(error: unknown): boolean {
  return error instanceof ProxyProtocolError
    && error.code === 'CONFLICT'
    && error.message.includes('Catalog changed');
}

/**
 * Resolve the next turn's catalog before turn.start.
 *
 * Prefer the catalog fence reported by the client. client.catalog() can
 * still be the process catalog cached before session.create. The protocol
 * does not make every turnConfigRevision that fence; the client reports one
 * only for a producer that publishes the session catalog fingerprint.
 * Antigravity rejects the cached process fence once its cold catalog is
 * cleared or replaced. One explicit Catalog-changed CONFLICT reloads the
 * canonical catalog and resolves once more. A second conflict, or any other
 * error, is returned to the caller.
 * This function does not start a turn or replay a prompt.
 */
export async function resolveSendCatalog(
  client: SendCatalogClient,
  draft: {
    sessionConfig: Record<string, ConfigValue>;
    turnConfig: Record<string, ConfigValue>;
  },
  cachedRevision: string,
): Promise<ResolvedProxyCatalog> {
  if (!client.resolveCatalog) throw new Error('catalog.resolve is not available');
  const resolve = client.resolveCatalog.bind(client);
  const attached = client.sessionCatalogRevision?.();
  const firstRevision = attached || cachedRevision;
  try {
    return await resolve({
      catalogRevision: firstRevision,
      sessionConfig: draft.sessionConfig,
      turnConfig: draft.turnConfig,
    });
  } catch (error) {
    if (!isCatalogChangedConflict(error) || !client.reloadCatalog) throw error;
    const refreshed = await client.reloadCatalog();
    const moved = client.sessionCatalogRevision?.();
    const secondRevision = moved && moved !== firstRevision ? moved : refreshed.catalogRevision;
    return resolve({
      catalogRevision: secondRevision,
      sessionConfig: draft.sessionConfig,
      turnConfig: draft.turnConfig,
    });
  }
}
