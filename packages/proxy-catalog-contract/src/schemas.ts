import { Buffer } from 'node:buffer';

import { z } from 'zod';

import {
  CATALOG_ASSET_MANIFEST_FILE,
  CATALOG_DOCUMENT_KEYS,
  CATALOG_IDENTIFIER_PATTERN,
  CATALOG_IMAGE_MEDIA_TYPES,
  CATALOG_PROTOCOL_RANGE_PATTERN,
  CATALOG_RUNTIME_ID_PATTERN,
  CATALOG_SCHEMA_VERSION,
  CATALOG_SIGNATURE_ALGORITHM,
  CATALOG_SIGNATURE_FILE,
  CATALOG_SOURCE_ID_PATTERN,
  ED25519_SIGNATURE_BYTES,
  MAX_CATALOG_ASSET_FILE_COUNT,
  MAX_CATALOG_BUNDLE_BYTES,
  MAX_CATALOG_DISPLAY_NAME_CHARS,
  MAX_CATALOG_DOCUMENT_BYTES,
  MAX_CATALOG_FEATURED_ORDER,
  MAX_CATALOG_IMAGE_BYTES,
  MAX_CATALOG_KEY_ID_CHARS,
  MAX_CATALOG_PATH_CHARS,
  MAX_CATALOG_PLUGIN_COUNT,
  MAX_CATALOG_PLUGIN_ID_CHARS,
  MAX_CATALOG_PROTOCOL_RANGE_CHARS,
  MAX_CATALOG_RUNTIME_ID_CHARS,
  MAX_CATALOG_SOURCE_ID_CHARS,
  MAX_CATALOG_TAGLINE_CHARS,
  MAX_CATALOG_URL_CHARS,
  MAX_CATALOG_VERIFIED_VERSIONS,
  PLATFORM_IDS,
} from './constants.js';

const safeIntegerSchema = z.number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = safeIntegerSchema.min(1);
const nonNegativeSafeIntegerSchema = safeIntegerSchema.min(0);

const isoDateTimeSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'Expected an ISO-8601 timestamp.',
);

/**
 * Same identity rule as `@gian/proxy-protocol` pluginIdSchema. Duplicated so
 * Catalog distribution stays independent of the Host-Proxy wire package.
 */
export const catalogPluginIdSchema = z.string()
  .min(1)
  .max(MAX_CATALOG_PLUGIN_ID_CHARS)
  .regex(
    /^(?:claude|codex|kimi|grok|[a-z0-9]+(?:[.-][a-z0-9]+)+)$/,
    'Expected a reserved built-in ID or reverse-domain external plugin ID.',
  );

export const semverSchema = z.string().regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  'Expected a SemVer version.',
);

export const sha256Schema = z.string().regex(
  /^[0-9a-f]{64}$/,
  'Expected a lowercase SHA-256 digest.',
);

export const platformIdSchema = z.enum(PLATFORM_IDS);

export const catalogSourceIdSchema = z.string()
  .min(1)
  .max(MAX_CATALOG_SOURCE_ID_CHARS)
  .regex(CATALOG_SOURCE_ID_PATTERN, 'Expected a lowercase source id.');

export const catalogKeyIdSchema = z.string()
  .min(1)
  .max(MAX_CATALOG_KEY_ID_CHARS)
  .regex(CATALOG_IDENTIFIER_PATTERN, 'Expected a bounded keyId without control characters.');

export const catalogRuntimeIdSchema = z.string()
  .min(1)
  .max(MAX_CATALOG_RUNTIME_ID_CHARS)
  .regex(CATALOG_RUNTIME_ID_PATTERN, 'Expected a lowercase runtime id.');

/**
 * Catalog URLs are HTTPS, credential-free, and length-bounded.
 * Repository, DNS, redirect, private-network, and CDN allowlisting belong
 * to the future pinned CatalogSourceClient policy.
 */
export function isHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CATALOG_URL_CHARS) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:'
    && url.username === ''
    && url.password === ''
    && url.hostname.length > 0;
}

export const httpsUrlSchema = z.string()
  .min(1)
  .max(MAX_CATALOG_URL_CHARS)
  .refine(isHttpsUrl, 'Expected an HTTPS URL without credentials.');

export function isCanonicalRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CATALOG_PATH_CHARS) return false;
  if (value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  return !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function relativePathSchema(label: string) {
  return z.string()
    .min(1)
    .max(MAX_CATALOG_PATH_CHARS)
    .refine(isCanonicalRelativePath, `${label} must be a canonical forward-slash relative path.`);
}

export const downloadAssetSchema = z.strictObject({
  url: httpsUrlSchema,
  sha256: sha256Schema,
  size: positiveSafeIntegerSchema,
});

const runtimeComponentIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(CATALOG_IDENTIFIER_PATTERN, 'Expected a bounded Runtime component id.');

export const managedRuntimeNativeBinarySchema = z.strictObject({
  kind: z.literal('native-binary'),
  runtimeId: catalogRuntimeIdSchema,
  version: semverSchema,
  asset: downloadAssetSchema,
  format: z.enum(['raw', 'tar.gz']),
  entryRelativePath: relativePathSchema('Runtime entry'),
});

export const managedRuntimeDistributionSchema = z.discriminatedUnion('kind', [
  managedRuntimeNativeBinarySchema,
  z.strictObject({
    kind: z.literal('external-app'),
    runtimeId: catalogRuntimeIdSchema,
    version: semverSchema,
    artifactSha256: sha256Schema,
  }),
]);

export const certifiedRuntimeCombinationSchema = z.strictObject({
  generationId: runtimeComponentIdSchema,
  certificate: z.strictObject({
    id: runtimeComponentIdSchema,
    sha256: sha256Schema,
  }),
  runtime: managedRuntimeDistributionSchema.nullable(),
  companions: z.array(z.strictObject({
    id: runtimeComponentIdSchema,
    distribution: managedRuntimeNativeBinarySchema,
  })).max(16),
});

const sourceDocumentationSchema = z.strictObject({
  overview: relativePathSchema('overview'),
  setup: relativePathSchema('setup'),
  usage: relativePathSchema('usage'),
  troubleshooting: relativePathSchema('troubleshooting'),
});

export const catalogImageMediaTypeSchema = z.enum(CATALOG_IMAGE_MEDIA_TYPES);

const sourceImageRefSchema = z.strictObject({
  path: relativePathSchema('logo path'),
  mediaType: catalogImageMediaTypeSchema,
});

const sourceBrandingSchema = z.strictObject({
  logoLight: sourceImageRefSchema,
  logoDark: sourceImageRefSchema,
});

const platformArtifactMapSchema = z.strictObject({
  'darwin-arm64': downloadAssetSchema.optional(),
  'darwin-x64': downloadAssetSchema.optional(),
  'linux-x64': downloadAssetSchema.optional(),
  'linux-arm64': downloadAssetSchema.optional(),
  'win32-x64': downloadAssetSchema.optional(),
});

const catalogChannelSchema = z.strictObject({
  pluginVersion: semverSchema,
  manifest: downloadAssetSchema.optional(),
  artifacts: platformArtifactMapSchema.optional(),
  combination: certifiedRuntimeCombinationSchema.optional(),
}).superRefine((value, context) => {
  const artifacts = value.artifacts ?? {};
  const hasArtifact = Object.values(artifacts).some((asset) => asset !== undefined);
  if (hasArtifact && !value.manifest) {
    context.addIssue({
      code: 'custom',
      path: ['manifest'],
      message: 'Installable channels must declare a Manifest coordinate.',
    });
  }
  if (!hasArtifact && value.manifest) {
    context.addIssue({
      code: 'custom',
      path: ['manifest'],
      message: 'Documentation-only channels must not declare a downloadable Manifest coordinate.',
    });
  }
  if (!hasArtifact && value.combination) {
    context.addIssue({
      code: 'custom',
      path: ['combination'],
      message: 'A certified Runtime combination requires an installable Proxy artifact.',
    });
  }
});

export const catalogEntryV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  pluginId: catalogPluginIdSchema,
  displayName: z.string().min(1).max(MAX_CATALOG_DISPLAY_NAME_CHARS),
  tagline: z.string().min(1).max(MAX_CATALOG_TAGLINE_CHARS),
  featuredOrder: nonNegativeSafeIntegerSchema.max(MAX_CATALOG_FEATURED_ORDER),
  documentation: sourceDocumentationSchema,
  branding: sourceBrandingSchema,
  channels: z.strictObject({
    stable: catalogChannelSchema,
  }),
});

export const catalogAssetRefSchema = z.strictObject({
  path: relativePathSchema('asset path'),
  sha256: sha256Schema,
  size: positiveSafeIntegerSchema,
});

export const catalogImageRefSchema = catalogAssetRefSchema.extend({
  mediaType: catalogImageMediaTypeSchema,
});

const uniqueSemverListSchema = z.array(semverSchema)
  .min(1)
  .max(MAX_CATALOG_VERIFIED_VERSIONS)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom',
        message: 'verifiedVersions must be unique.',
      });
    }
  });

export const compiledRuntimeSummarySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('none'),
  }),
  z.strictObject({
    kind: z.literal('external'),
    id: catalogRuntimeIdSchema,
    displayName: z.string().min(1).max(MAX_CATALOG_DISPLAY_NAME_CHARS),
    verifiedVersions: uniqueSemverListSchema,
  }),
]);

const compiledDocumentationSchema = z.strictObject({
  overview: catalogAssetRefSchema,
  setup: catalogAssetRefSchema,
  usage: catalogAssetRefSchema,
  troubleshooting: catalogAssetRefSchema,
});

const compiledBrandingSchema = z.strictObject({
  light: catalogImageRefSchema,
  dark: catalogImageRefSchema,
});

export const compiledCatalogEntryV1Schema = z.strictObject({
  pluginId: catalogPluginIdSchema,
  displayName: z.string().min(1).max(MAX_CATALOG_DISPLAY_NAME_CHARS),
  tagline: z.string().min(1).max(MAX_CATALOG_TAGLINE_CHARS),
  featuredOrder: nonNegativeSafeIntegerSchema.max(MAX_CATALOG_FEATURED_ORDER),
  documentation: compiledDocumentationSchema,
  branding: compiledBrandingSchema,
  stable: z.strictObject({
    pluginVersion: semverSchema,
    protocolRange: z.string()
      .min(1)
      .max(MAX_CATALOG_PROTOCOL_RANGE_CHARS)
      .regex(CATALOG_PROTOCOL_RANGE_PATTERN, 'Expected a bounded ASCII protocol range.'),
    processScope: z.enum(['shared', 'session']),
    runtime: compiledRuntimeSummarySchema.nullable(),
    manifest: downloadAssetSchema.optional(),
    artifacts: platformArtifactMapSchema,
    combination: certifiedRuntimeCombinationSchema.optional(),
  }).superRefine((value, context) => {
    const hasArtifact = Object.values(value.artifacts).some((asset) => asset !== undefined);
    if (hasArtifact && !value.manifest) {
      context.addIssue({
        code: 'custom',
        path: ['manifest'],
        message: 'Installable channels must declare a Manifest coordinate.',
      });
    }
    if (!hasArtifact && value.manifest) {
      context.addIssue({
        code: 'custom',
        path: ['manifest'],
        message: 'Documentation-only channels must not declare a downloadable Manifest coordinate.',
      });
    }
    if (!hasArtifact && value.combination) {
      context.addIssue({
        code: 'custom',
        path: ['combination'],
        message: 'A certified Runtime combination requires an installable Proxy artifact.',
      });
    }
  }),
});

export const catalogIndexV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  sourceId: catalogSourceIdSchema,
  sequence: positiveSafeIntegerSchema,
  issuedAt: isoDateTimeSchema,
  plugins: z.array(compiledCatalogEntryV1Schema)
    .min(1)
    .max(MAX_CATALOG_PLUGIN_COUNT),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, plugin] of value.plugins.entries()) {
    if (seen.has(plugin.pluginId)) {
      context.addIssue({
        code: 'custom',
        path: ['plugins', index, 'pluginId'],
        message: `Duplicate pluginId ${plugin.pluginId}.`,
      });
    }
    seen.add(plugin.pluginId);
    for (const key of CATALOG_DOCUMENT_KEYS) {
      if (plugin.documentation[key].size > MAX_CATALOG_DOCUMENT_BYTES) {
        context.addIssue({
          code: 'custom',
          path: ['plugins', index, 'documentation', key, 'size'],
          message: `${key} exceeds MAX_CATALOG_DOCUMENT_BYTES.`,
        });
      }
    }
    for (const variant of ['light', 'dark'] as const) {
      if (plugin.branding[variant].size > MAX_CATALOG_IMAGE_BYTES) {
        context.addIssue({
          code: 'custom',
          path: ['plugins', index, 'branding', variant, 'size'],
          message: `${variant} logo exceeds MAX_CATALOG_IMAGE_BYTES.`,
        });
      }
    }
  }
});

const catalogAssetManifestFileSchema = z.strictObject({
  path: relativePathSchema('payload path'),
  sha256: sha256Schema,
  size: positiveSafeIntegerSchema,
});

export const catalogAssetManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  files: z.array(catalogAssetManifestFileSchema)
    .min(1)
    .max(MAX_CATALOG_ASSET_FILE_COUNT),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  let totalSize = 0;
  let exceededBundle = false;
  for (const [index, file] of value.files.entries()) {
    if (file.path === CATALOG_ASSET_MANIFEST_FILE || file.path === CATALOG_SIGNATURE_FILE) {
      context.addIssue({
        code: 'custom',
        path: ['files', index, 'path'],
        message: 'Asset manifest must exclude itself and the detached signature.',
      });
    }
    if (seen.has(file.path)) {
      context.addIssue({
        code: 'custom',
        path: ['files', index, 'path'],
        message: `Duplicate payload path ${file.path}.`,
      });
    }
    seen.add(file.path);
    if (!exceededBundle && totalSize > MAX_CATALOG_BUNDLE_BYTES - file.size) {
      exceededBundle = true;
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Declared payload sizes exceed MAX_CATALOG_BUNDLE_BYTES.',
      });
    } else if (!exceededBundle) {
      totalSize += file.size;
    }
  }
});

const strictBase64Schema = z.string().regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  'Expected standard base64.',
).refine((value) => {
  try {
    return Buffer.from(value, 'base64').byteLength === ED25519_SIGNATURE_BYTES;
  } catch {
    return false;
  }
}, 'Expected a 64-byte Ed25519 signature.');

export const catalogSignatureEnvelopeV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  algorithm: z.literal(CATALOG_SIGNATURE_ALGORITHM),
  keyId: catalogKeyIdSchema,
  signedAsset: z.literal(CATALOG_ASSET_MANIFEST_FILE),
  signature: strictBase64Schema,
});

export type CatalogPluginId = z.infer<typeof catalogPluginIdSchema>;
export type DownloadAsset = z.infer<typeof downloadAssetSchema>;
export type CatalogManagedRuntimeDistribution = z.infer<typeof managedRuntimeDistributionSchema>;
export type CertifiedRuntimeCombination = z.infer<typeof certifiedRuntimeCombinationSchema>;
export type CatalogEntryV1 = z.infer<typeof catalogEntryV1Schema>;
export type CatalogAssetRef = z.infer<typeof catalogAssetRefSchema>;
export type CatalogImageRef = z.infer<typeof catalogImageRefSchema>;
export type CompiledRuntimeSummary = z.infer<typeof compiledRuntimeSummarySchema>;
export type CompiledCatalogEntryV1 = z.infer<typeof compiledCatalogEntryV1Schema>;
export type CatalogIndexV1 = z.infer<typeof catalogIndexV1Schema>;
export type CatalogAssetManifestV1 = z.infer<typeof catalogAssetManifestV1Schema>;
export type CatalogSignatureEnvelopeV1 = z.infer<typeof catalogSignatureEnvelopeV1Schema>;
