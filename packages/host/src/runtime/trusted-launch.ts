import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import { manifestSchema, type ProxyManifest } from '@gian/proxy-protocol';
import { isProxyPluginId, parseProxyPluginId } from '@gian/shared';

import type { PluginCurrentLaunch } from '../plugin-store/types.js';
import type { RuntimeKind } from './resolver.js';

export type TrustedLaunchSource = 'plugin-store' | 'official-managed' | 'official-development';

export interface TrustedRuntimeFacts {
  kind: RuntimeKind;
  id?: string;
  displayName?: string;
  verifiedVersions?: readonly string[];
}

export interface TrustedLaunch {
  pluginId: string;
  /** Manifest-owned Proxy product name, distinct from the user's Agent name. */
  displayName?: string;
  pluginVersion: string;
  manifestSha256: string;
  protocolRange: string;
  entryPath: string;
  processScope: 'shared' | 'session';
  schemaVersion: 2 | 3 | 4;
  runtime: TrustedRuntimeFacts;
  source: TrustedLaunchSource;
}

export interface OfficialPresence {
  pluginId: string;
  pluginVersion: string;
  entryPath: string;
  processScope: 'shared' | 'session';
  schemaVersion: 2 | 3 | 4;
  runtime: TrustedRuntimeFacts;
}

export class TrustedLaunchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TrustedLaunchError';
    this.code = code;
  }
}

function launchFromManifest(
  pluginId: string,
  manifest: ProxyManifest,
  entryPath: string,
  source: TrustedLaunchSource,
  manifestSha256: string,
): TrustedLaunch {
  if (manifest.schemaVersion === 4) {
    return {
      pluginId,
      displayName: manifest.displayName,
      pluginVersion: manifest.pluginVersion,
      manifestSha256,
      protocolRange: manifest.protocol.range,
      entryPath,
      processScope: manifest.process.scope,
      schemaVersion: 4,
      runtime: manifest.runtime.kind === 'none'
        ? { kind: 'none' }
        : {
          kind: 'external',
          id: manifest.runtime.id,
          displayName: manifest.runtime.displayName,
          verifiedVersions: manifest.runtime.verifiedVersions,
        },
      source,
    };
  }
  return {
    pluginId,
    displayName: manifest.displayName,
    pluginVersion: manifest.pluginVersion,
    manifestSha256,
    protocolRange: manifest.protocol.range,
    entryPath,
    processScope: manifest.process.scope,
    schemaVersion: manifest.schemaVersion,
    runtime: manifest.runtime
      ? {
        kind: 'external',
        id: manifest.runtime.id,
        displayName: manifest.runtime.displayName,
        ...(manifest.runtime.verifiedCliVersions
          ? { verifiedVersions: manifest.runtime.verifiedCliVersions }
          : {}),
      }
      : { kind: 'none' },
    source,
  };
}

const MAX_STATIC_LOGO_BYTES = 512 * 1024;
const MAX_STATIC_SKILL_BYTES = 512 * 1024;
const MAX_STATIC_ENTRY_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function assertContainedRegularFile(directory: string, relativePath: string): Promise<string> {
  const resolvedDirectory = await realpath(directory);
  const entry = join(resolvedDirectory, relativePath);
  const info = await lstat(entry);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_ENTRY', 'Proxy entry must be a contained regular file.');
  }
  const resolvedEntry = await realpath(entry);
  if (relative(resolvedDirectory, resolvedEntry) !== relativePath) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_ENTRY', 'Proxy entry escapes its package directory.');
  }
  return resolvedEntry;
}

async function assertContainedHashedAsset(input: {
  directory: string;
  relativePath: string;
  sha256: string;
  maxBytes: number;
  mediaType?: 'image/png' | 'image/webp';
}): Promise<void> {
  const resolved = await assertContainedRegularFile(input.directory, input.relativePath);
  const info = await lstat(resolved);
  if (info.size === 0 || info.size > input.maxBytes) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_ASSET', 'Proxy asset size is invalid.');
  }
  const bytes = await readFile(resolved);
  if (input.mediaType === 'image/png' && !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_ASSET', 'Proxy logo media type mismatch.');
  }
  if (
    input.mediaType === 'image/webp'
    && (
      bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
      || bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
    )
  ) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_ASSET', 'Proxy logo media type mismatch.');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== input.sha256) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_ASSET', 'Proxy asset checksum mismatch.');
  }
}

export async function validateStaticProxyPackage(input: {
  directory: string;
  expectedId?: string;
  expectedVersion?: string;
  entryOverride?: string;
  source: TrustedLaunchSource;
}): Promise<TrustedLaunch> {
  const manifestBytes = await readFile(join(input.directory, 'manifest.json'));
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const parsed = manifestSchema.safeParse(JSON.parse(manifestBytes.toString('utf8')) as unknown);
  if (!parsed.success) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_MANIFEST', 'Proxy Manifest failed schema validation.');
  }
  const manifest = parsed.data;
  if (input.expectedId && manifest.id !== input.expectedId) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_IDENTITY', 'Proxy Manifest id does not match the trusted pluginId.');
  }
  if (input.expectedVersion && manifest.pluginVersion !== input.expectedVersion) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_IDENTITY', 'Proxy Manifest version does not match.');
  }
  if (!isProxyPluginId(manifest.id)) {
    throw new TrustedLaunchError('TRUSTED_LAUNCH_IDENTITY', 'Proxy Manifest id is not a valid pluginId.');
  }
  let entryPath: string;
  if (input.entryOverride) {
    if (!isAbsolute(input.entryOverride)) {
      throw new TrustedLaunchError('TRUSTED_LAUNCH_ENTRY', 'Development entry must be absolute.');
    }
    const info = await lstat(input.entryOverride);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new TrustedLaunchError('TRUSTED_LAUNCH_ENTRY', 'Development entry must be a regular file.');
    }
    entryPath = await realpath(input.entryOverride);
  } else {
    entryPath = await assertContainedRegularFile(input.directory, manifest.entry);
  }
  if (input.source === 'official-managed') {
    const versionName = basename(await realpath(input.directory));
    if (versionName !== manifest.pluginVersion) {
      throw new TrustedLaunchError(
        'TRUSTED_LAUNCH_IDENTITY',
        'Official-managed current target name must match Manifest pluginVersion.',
      );
    }
    const entryInfo = await lstat(entryPath);
    if (entryInfo.size === 0 || entryInfo.size > MAX_STATIC_ENTRY_BYTES) {
      throw new TrustedLaunchError('TRUSTED_LAUNCH_ENTRY', 'Official-managed entry size is invalid.');
    }
    try {
      await readFile(entryPath);
    } catch {
      throw new TrustedLaunchError('TRUSTED_LAUNCH_ENTRY', 'Official-managed entry is not readable.');
    }
    if (manifest.schemaVersion === 3 || manifest.schemaVersion === 4) {
      await assertContainedHashedAsset({
        directory: input.directory,
        relativePath: manifest.branding.logo.light.path,
        sha256: manifest.branding.logo.light.sha256,
        maxBytes: MAX_STATIC_LOGO_BYTES,
        mediaType: manifest.branding.logo.light.mediaType,
      });
      if (manifest.branding.logo.dark) {
        await assertContainedHashedAsset({
          directory: input.directory,
          relativePath: manifest.branding.logo.dark.path,
          sha256: manifest.branding.logo.dark.sha256,
          maxBytes: MAX_STATIC_LOGO_BYTES,
          mediaType: manifest.branding.logo.dark.mediaType,
        });
      }
    }
    if (manifest.skills) {
      for (const skill of manifest.skills) {
        await assertContainedHashedAsset({
          directory: input.directory,
          relativePath: skill.path,
          sha256: skill.sha256,
          maxBytes: MAX_STATIC_SKILL_BYTES,
        });
      }
    }
  }
  return launchFromManifest(
    parseProxyPluginId(manifest.id),
    manifest,
    entryPath,
    input.source,
    manifestSha256,
  );
}

export async function loadDevelopmentTrustedLaunch(
  entryPath: string,
  expectedId?: string,
): Promise<TrustedLaunch> {
  const directory = await packageDirectoryFromEntry(entryPath);
  return validateStaticProxyPackage({
    directory,
    ...(expectedId ? { expectedId } : {}),
    entryOverride: entryPath,
    source: 'official-development',
  });
}

export async function packageDirectoryFromEntry(entryPath: string): Promise<string> {
  let dir = dirname(entryPath);
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (
        typeof pkg.name === 'string'
        && pkg.name.startsWith('@gian/')
        && pkg.name.endsWith('-proxy')
      ) {
        return dir;
      }
    } catch {
      // Keep walking toward the package root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new TrustedLaunchError('TRUSTED_LAUNCH_PACKAGE', `Could not resolve Proxy package from ${entryPath}`);
}

export function launchFromPluginStore(launch: PluginCurrentLaunch): TrustedLaunch {
  return {
    pluginId: launch.pluginId,
    displayName: launch.displayName,
    pluginVersion: launch.pluginVersion,
    manifestSha256: launch.manifestSha256,
    protocolRange: launch.protocolRange,
    entryPath: launch.entryPath,
    processScope: launch.processScope,
    schemaVersion: 4,
    runtime: launch.runtime.kind === 'none'
      ? { kind: 'none' }
      : {
        kind: 'external',
        id: launch.runtime.id,
        displayName: launch.runtime.displayName,
        verifiedVersions: launch.runtime.verifiedVersions,
      },
    source: 'plugin-store',
  };
}

export function toOfficialPresence(launch: TrustedLaunch): OfficialPresence {
  return {
    pluginId: launch.pluginId,
    pluginVersion: launch.pluginVersion,
    entryPath: launch.entryPath,
    processScope: launch.processScope,
    schemaVersion: launch.schemaVersion,
    runtime: launch.runtime,
  };
}
