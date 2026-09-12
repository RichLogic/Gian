import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { manifestSchema } from '@gian/proxy-protocol';
import { parseProxyPluginId } from '@gian/shared';

import { loadDevelopmentTrustedLaunch } from './trusted-launch.js';

export class DevelopmentProxySourceError extends Error {
  readonly code = 'DEVELOPMENT_PROXY_SOURCE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'DevelopmentProxySourceError';
  }
}

function parseOverrides(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DevelopmentProxySourceError('GIAN_DEV_PROXY_ENTRIES must be a JSON object.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DevelopmentProxySourceError('GIAN_DEV_PROXY_ENTRIES must be a JSON object.');
  }
  const result: Record<string, string> = {};
  for (const [rawPluginId, entry] of Object.entries(value)) {
    const pluginId = parseProxyPluginId(rawPluginId);
    if (typeof entry !== 'string' || !isAbsolute(entry)) {
      throw new DevelopmentProxySourceError(`${pluginId} development entry must be absolute.`);
    }
    result[pluginId] = entry;
  }
  return result;
}

/**
 * Discover GianDev Proxy packages from their own Manifests. Adding another
 * package directory needs no Host registry edit. Explicit test overrides use
 * one generic pluginId-to-entry JSON map rather than Provider-named env vars.
 */
export async function discoverDevelopmentProxyEntries(input: {
  proxiesDir: string;
  overridesJson?: string;
  /** Isolated tests can opt out of the repository scan and trust only their
   * explicit generic pluginId-to-entry map. */
  overridesOnly?: boolean;
}): Promise<Readonly<Record<string, string>>> {
  const entries: Record<string, string> = {};
  let children: string[];
  if (input.overridesOnly) {
    children = [];
  } else {
    try {
      children = await readdir(input.proxiesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries;
      throw error;
    }
  }
  for (const child of children.sort()) {
    const directory = join(input.proxiesDir, child);
    try {
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue;
      const manifestPath = join(directory, 'manifest.json');
      const manifestInfo = await lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) continue;
      const parsed = manifestSchema.safeParse(JSON.parse(await readFile(manifestPath, 'utf8')));
      if (!parsed.success) {
        throw new DevelopmentProxySourceError(`${child} has an invalid Proxy Manifest.`);
      }
      const packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        main?: unknown;
      };
      if (
        typeof packageJson.name !== 'string'
        || !packageJson.name.startsWith('@gian/')
        || !packageJson.name.endsWith('-proxy')
        || typeof packageJson.main !== 'string'
      ) {
        throw new DevelopmentProxySourceError(`${child} has invalid Proxy package metadata.`);
      }
      const entry = join(directory, packageJson.main);
      const trusted = await loadDevelopmentTrustedLaunch(entry, parsed.data.id);
      entries[trusted.pluginId] = trusted.entryPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }

  for (const [pluginId, entry] of Object.entries(parseOverrides(input.overridesJson))) {
    const trusted = await loadDevelopmentTrustedLaunch(entry, pluginId);
    entries[pluginId] = await realpath(trusted.entryPath);
  }
  return Object.freeze(entries);
}
