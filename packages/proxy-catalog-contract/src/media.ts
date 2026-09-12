import { CATALOG_IMAGE_MEDIA_TYPES } from './constants.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_RIFF = Buffer.from('RIFF');
const WEBP_WEBP = Buffer.from('WEBP');

export type CatalogImageMediaType = typeof CATALOG_IMAGE_MEDIA_TYPES[number];

export function detectCatalogImageMediaType(bytes: Uint8Array): CatalogImageMediaType | null {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'image/png';
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).equals(WEBP_RIFF)
    && buffer.subarray(8, 12).equals(WEBP_WEBP)
  ) {
    return 'image/webp';
  }
  return null;
}

export function assertCatalogImageMagic(
  bytes: Uint8Array,
  declared: CatalogImageMediaType,
): void {
  const detected = detectCatalogImageMediaType(bytes);
  if (detected !== declared) {
    throw new Error(`Catalog image media type ${declared} does not match magic bytes.`);
  }
}
