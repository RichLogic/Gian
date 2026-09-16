import { z } from 'zod';

const component = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relativePath = z.string().min(1).max(512).refine(value => (
  !/[\\\\:\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
), 'Expected a canonical relative installation path.');
const absolutePath = z.string().min(1).max(4096).refine(value => (
  (value.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(value))
  && !/[\x00-\x1f\x7f]/.test(value)
  && !value.split(/[\\\\/]/).includes('..')
), 'Expected an absolute external application entry.');

export const runtimeInstallPlanParamsSchema = z.strictObject({
  installerVersion: z.literal(1),
  runtimeId: component,
  version: component,
  artifactSha256: digest,
  platform: z.enum(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']),
  distribution: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('managed'),
      format: z.enum(['raw', 'tar.gz']),
      entryRelativePath: relativePath,
    }),
    z.strictObject({ kind: z.literal('external-app'), entryPath: absolutePath }),
  ]),
});

export const runtimeInstallPlanResultSchema = z.strictObject({
  installerVersion: z.literal(1),
  runtimeId: component,
  version: component,
  artifactSha256: digest,
  operation: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('managed'),
      directory: relativePath,
      candidates: z.array(relativePath).max(8),
      format: z.enum(['raw', 'tar.gz']),
      entryRelativePath: relativePath,
    }),
    z.strictObject({ kind: z.literal('external-app'), entryPath: absolutePath }),
  ]),
});

export type RuntimeInstallPlanParams = z.infer<typeof runtimeInstallPlanParamsSchema>;
export type RuntimeInstallPlanResult = z.infer<typeof runtimeInstallPlanResultSchema>;

/** A closed installation recipe, versioned and bundled with its Proxy.
 * Host owns filesystem execution and checks every path and certified byte.
 * Recipes cannot contain shell commands, environment, credentials or URLs. */
export function createRuntimeInstallPlanner(recipe: {
  runtimeId: string;
  kind: 'managed' | 'external-app';
  format?: 'raw' | 'tar.gz';
  entryRelativePath?: string;
  legacyDirectories?: (version: string) => string[];
}): (input: RuntimeInstallPlanParams) => RuntimeInstallPlanResult {
  return input => {
    const params = runtimeInstallPlanParamsSchema.parse(input);
    if (params.runtimeId !== recipe.runtimeId || params.distribution.kind !== recipe.kind) {
      throw new Error('Runtime installation recipe does not match the certified distribution.');
    }
    const identity = {
      installerVersion: 1 as const,
      runtimeId: params.runtimeId,
      version: params.version,
      artifactSha256: params.artifactSha256,
    };
    if (params.distribution.kind === 'external-app') {
      return runtimeInstallPlanResultSchema.parse({ ...identity, operation: params.distribution });
    }
    if (params.distribution.format !== recipe.format
      || params.distribution.entryRelativePath !== recipe.entryRelativePath) {
      throw new Error('Runtime artifact layout is not supported by this Proxy version.');
    }
    return runtimeInstallPlanResultSchema.parse({
      ...identity,
      operation: {
        ...params.distribution,
        // Content-addressed directories never overwrite an old executable.
        // The flat legacy layout runtimes/{runtimeId}/{version} is the parent
        // of this directory, so it must never be an automatic reuse
        // candidate: inventorying it would recurse into the new tree.
        directory: `${params.runtimeId}/${params.version}/${params.artifactSha256}`,
        candidates: [...(recipe.legacyDirectories?.(params.version) ?? [])],
      },
    });
  };
}
