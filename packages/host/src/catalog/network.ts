import type { OfficialCatalogSourcePolicy } from '@gian/shared';

import { createCatalogAnonymousNetwork } from './anonymous-client.js';
import { CatalogBrokerUnavailableError, createCatalogBrokerNetwork } from './broker-client.js';
import { DEFAULT_CATALOG_BROKER_TIMEOUT_MS } from './timeouts.js';
import type { CatalogNetwork } from './types.js';

export function createCatalogNetwork(options: {
  policy: OfficialCatalogSourcePolicy;
  socketPath?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CatalogNetwork {
  const anonymous = createCatalogAnonymousNetwork({
    policy: options.policy,
    fetchImpl: options.fetchImpl,
  });
  const socketPath = options.socketPath?.trim();
  if (!socketPath) return anonymous;
  const broker = createCatalogBrokerNetwork({
    socketPath,
    policy: options.policy,
    timeoutMs: options.timeoutMs ?? DEFAULT_CATALOG_BROKER_TIMEOUT_MS,
  });
  return {
    async latest(input) {
      try {
        return await broker.latest(input);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        if (error instanceof CatalogBrokerUnavailableError) return anonymous.latest(input);
        throw error;
      }
    },
    async download(input) {
      try {
        return await broker.download(input);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        if (error instanceof CatalogBrokerUnavailableError) return anonymous.download(input);
        throw error;
      }
    },
  };
}
