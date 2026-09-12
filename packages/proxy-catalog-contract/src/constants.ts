export const CATALOG_SCHEMA_VERSION = 1 as const;
export const CATALOG_ASSET_MANIFEST_FILE = 'catalog-assets-v1.json' as const;
export const CATALOG_SIGNATURE_FILE = 'catalog-v1.sig' as const;
export const CATALOG_INDEX_FILE = 'catalog-v1.json' as const;

export const PLATFORM_IDS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
] as const;

export const CATALOG_DOCUMENT_KEYS = [
  'overview',
  'setup',
  'usage',
  'troubleshooting',
] as const;

export const CATALOG_SIGNATURE_ALGORITHM = 'Ed25519' as const;

export const MAX_CATALOG_PLUGIN_COUNT = 128;
export const MAX_CATALOG_INDEX_BYTES = 1 * 1024 * 1024;
export const MAX_CATALOG_DOCUMENT_BYTES = 256 * 1024;
export const MAX_CATALOG_IMAGE_BYTES = 512 * 1024;
export const MAX_CATALOG_BUNDLE_BYTES = 16 * 1024 * 1024;
export const MAX_CATALOG_ASSET_FILE_COUNT = 1024;

export const MAX_CATALOG_PLUGIN_ID_CHARS = 128;
export const MAX_CATALOG_DISPLAY_NAME_CHARS = 80;
export const MAX_CATALOG_TAGLINE_CHARS = 200;
export const MAX_CATALOG_PATH_CHARS = 256;
export const MAX_CATALOG_URL_CHARS = 1024;
export const MAX_CATALOG_KEY_ID_CHARS = 128;
export const MAX_CATALOG_SOURCE_ID_CHARS = 64;
export const MAX_CATALOG_PROTOCOL_RANGE_CHARS = 64;
/** Same token set as Manifest v4 / protocolRangeIncludes. Rejects controls. */
export const CATALOG_PROTOCOL_RANGE_PATTERN = /^[0-9.<>=|^~xX* ]+$/;
export const CATALOG_IMAGE_MEDIA_TYPES = ['image/png', 'image/webp'] as const;
export const MAX_CATALOG_RUNTIME_ID_CHARS = 64;
export const MAX_CATALOG_FEATURED_ORDER = 10_000;
export const MAX_CATALOG_VERIFIED_VERSIONS = 32;

export const CATALOG_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/;
export const CATALOG_SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const CATALOG_RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

export type PlatformId = typeof PLATFORM_IDS[number];
export type CatalogDocumentKey = typeof CATALOG_DOCUMENT_KEYS[number];
