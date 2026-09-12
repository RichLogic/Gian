export const DEFAULT_CATALOG_TOTAL_BUDGET_MS = 45_000;
export const DEFAULT_CATALOG_PER_REQUEST_MS = 8_000;
/** Must stay strictly below the per-request budget so a hung broker can fall back. */
export const DEFAULT_CATALOG_BROKER_TIMEOUT_MS = 4_000;

if (DEFAULT_CATALOG_BROKER_TIMEOUT_MS >= DEFAULT_CATALOG_PER_REQUEST_MS) {
  throw new Error('Catalog broker timeout must leave per-request headroom for anonymous fallback.');
}
