export interface RuntimeLaunchProtocol {
  schemaVersion?: number;
  runtimeBootstrap?: boolean;
}

/**
 * Choose the production Runtime path from trusted package facts, never by
 * catching a generic resolver failure. v4 / explicit bootstrap packages are
 * generic-only. Retained v2/v3 packages stay on the isolated legacy adapter.
 */
export function isGenericRuntimeProtocol(
  protocol?: RuntimeLaunchProtocol | null,
): boolean {
  if (!protocol) return false;
  return protocol.runtimeBootstrap === true || protocol.schemaVersion === 4;
}
