import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CATALOG_DOCUMENT_KEYS, MAX_CATALOG_DOCUMENT_BYTES, MAX_CATALOG_INDEX_BYTES,
  MAX_CATALOG_PLUGIN_COUNT, MAX_CATALOG_DISPLAY_NAME_CHARS, MAX_CATALOG_TAGLINE_CHARS } from './constants.js';
import { catalogAssetRefSchema, type CatalogIndexV1 } from './schemas.js';
import { assertCatalogMarkdown } from './catalog-markdown.js';

export const CATALOG_LOCALIZATIONS_FILE = 'catalog-localizations-v1.json';
export const CATALOG_LOCALES = ['en', 'zh-CN'] as const;
export type CatalogLocale = typeof CATALOG_LOCALES[number];
export interface CatalogLocalizedInput {
  displayName: string;
  tagline: string;
  documents: Record<typeof CATALOG_DOCUMENT_KEYS[number], string | Uint8Array>;
}
export type CatalogLocalizationInput = Record<string, Record<CatalogLocale, CatalogLocalizedInput>>;

const textSchema = z.strictObject({
  displayName: z.string().min(1).max(MAX_CATALOG_DISPLAY_NAME_CHARS),
  tagline: z.string().min(1).max(MAX_CATALOG_TAGLINE_CHARS),
  documentation: z.strictObject({ overview: catalogAssetRefSchema, setup: catalogAssetRefSchema,
    usage: catalogAssetRefSchema, troubleshooting: catalogAssetRefSchema }),
});
export const catalogLocalizationsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  plugins: z.array(z.strictObject({
    pluginId: z.string().min(1).max(128),
    locales: z.strictObject({ en: textSchema, 'zh-CN': textSchema }),
  })).max(MAX_CATALOG_PLUGIN_COUNT),
});
export type CatalogLocalizations = z.infer<typeof catalogLocalizationsSchema>;

/** The optional file and every translated document are part of the existing
 * signed asset inventory. The v1 Catalog index stays readable by old clients. */
export function readCatalogLocalizations(files: ReadonlyMap<string, Buffer>, index: CatalogIndexV1): CatalogLocalizations | null {
  const bytes = files.get(CATALOG_LOCALIZATIONS_FILE);
  if (!bytes) return null;
  if (bytes.byteLength > MAX_CATALOG_INDEX_BYTES) throw new Error('Catalog localizations exceed the size limit');
  const result = catalogLocalizationsSchema.parse(JSON.parse(bytes.toString('utf8')));
  const ids = new Set<string>();
  for (const plugin of result.plugins) {
    if (ids.has(plugin.pluginId) || !index.plugins.some(p => p.pluginId === plugin.pluginId)) {
      throw new Error('Unknown or duplicate localized Catalog plugin');
    }
    ids.add(plugin.pluginId);
    for (const locale of CATALOG_LOCALES) for (const key of CATALOG_DOCUMENT_KEYS) {
      const ref = plugin.locales[locale].documentation[key];
      if (ref.path !== `docs/${plugin.pluginId}/${locale}/${key}.md` || ref.size > MAX_CATALOG_DOCUMENT_BYTES) {
        throw new Error('Invalid localized Catalog document reference');
      }
      const document = files.get(ref.path);
      if (!document || document.byteLength !== ref.size
        || createHash('sha256').update(document).digest('hex') !== ref.sha256) {
        throw new Error('Localized Catalog document digest mismatch');
      }
      assertCatalogMarkdown(document.toString('utf8'), `${plugin.pluginId} ${locale} ${key}`);
    }
  }
  return result;
}
