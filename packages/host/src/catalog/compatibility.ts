import {
  KNOWN_PROTOCOL_VERSIONS,
  PROTOCOL_V22,
  protocolRangeIncludes,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@gian/proxy-protocol';
import type { CatalogCompatibilityState } from '@gian/shared';

/**
 * Catalog classification includes 2.2 because this Host can pin an exact
 * v4 launch. The global session offer (`SUPPORTED_PROTOCOL_VERSIONS`) stays
 * [2.1, 2.0].
 */
export function catalogCompatibilityHostVersions(
  hostVersions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS,
): readonly string[] {
  return hostVersions.includes(PROTOCOL_V22)
    ? hostVersions
    : [...hostVersions, PROTOCOL_V22];
}

export function hostProtocolVersions(): string[] {
  return [...catalogCompatibilityHostVersions()];
}

export function classifyCatalogCompatibility(
  range: string,
  hostVersions: readonly string[] = hostProtocolVersions(),
): { state: CatalogCompatibilityState; reason: string | null } {
  if (typeof range !== 'string' || range.length === 0) {
    return { state: 'invalid', reason: 'Protocol range is missing.' };
  }
  if (hostVersions.some((version) => protocolRangeIncludes(range, version))) {
    return { state: 'compatible', reason: null };
  }
  const known = KNOWN_PROTOCOL_VERSIONS.filter((version) => protocolRangeIncludes(range, version));
  if (known.length === 0) {
    return { state: 'invalid', reason: 'Protocol range matches no known gian.proxy version.' };
  }
  if (protocolRangeIncludes(range, PROTOCOL_V22) && !hostVersions.includes(PROTOCOL_V22)) {
    return {
      state: 'requires_app_update',
      reason: 'This Proxy requires gian.proxy/2.2, which the Host does not offer yet.',
    };
  }
  return {
    state: 'requires_proxy_update',
    reason: 'This Proxy does not support the Host protocol set.',
  };
}
