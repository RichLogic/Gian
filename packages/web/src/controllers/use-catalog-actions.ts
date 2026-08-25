/**
 * Catalog `actions` view for the standard Side Chat / Fork controls
 * (gian.proxy/2.0 proposal §9.4). Thin reactive wrapper over the composer's
 * executor-keyed catalog cache: returns the cached declarations immediately
 * and re-fetches once per executor on a cold cache. `undefined` means "no
 * declarations known" — gating treats it as catalog-missing (greyed, §9.4).
 */
import { useEffect, useState } from 'react';
import type { Executor } from '@gian/shared';

import {
  fetchCatalogCached,
  getCatalogCached,
  type CatalogActionDescriptor,
} from '../components/composer/capabilities.js';

export function useCatalogActions(
  executor: Executor | null,
  agentId?: string | null,
): CatalogActionDescriptor[] | undefined {
  const [actions, setActions] = useState<CatalogActionDescriptor[] | undefined>(
    () => (executor ? getCatalogCached(executor, agentId)?.actions : undefined),
  );

  useEffect(() => {
    if (!executor) {
      setActions(undefined);
      return;
    }
    const cached = getCatalogCached(executor, agentId);
    if (cached) {
      setActions(cached.actions);
      return;
    }
    let alive = true;
    void fetchCatalogCached(executor, agentId)
      .then(catalog => { if (alive) setActions(catalog.actions); })
      .catch(() => {
        // Catalog fetch failure = no declarations → controls stay greyed with
        // the generic reason (§9.4/§15). The next mount retries the fetch.
        if (alive) setActions(undefined);
      });
    return () => { alive = false; };
  }, [executor, agentId]);

  return actions;
}
