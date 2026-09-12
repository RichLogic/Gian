import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir, readFile, realpath, access } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { assertCatalogImageMagic } from '@gian/proxy-catalog-contract';

import { PluginStoreError } from './errors.js';
import {
  MAX_PLUGIN_FILE_BYTES,
  MAX_PLUGIN_FILE_COUNT,
  MAX_PLUGIN_LOGO_BYTES,
  MAX_PLUGIN_SKILL_BYTES,
  MAX_PLUGIN_TOTAL_BYTES,
} from './limits.js';

export function assertCanonicalRelativePath(value: string, label: string): void {
  if (
    value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new PluginStoreError('PLUGIN_PATH_UNSAFE', `Unsafe ${label}: ${value}`);
  }
}

export async function readContainedRegularFile(
  directory: string,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer> {
  assertCanonicalRelativePath(relativePath, 'package path');
  const resolvedDirectory = await realpath(directory);
  const candidate = join(resolvedDirectory, ...relativePath.split('/'));
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > maxBytes) {
    throw new PluginStoreError('PLUGIN_FILE_INVALID', `Invalid package file: ${relativePath}`);
  }
  const resolved = await realpath(candidate);
  if (relative(resolvedDirectory, resolved).split(sep).join('/') !== relativePath) {
    throw new PluginStoreError('PLUGIN_PATH_UNSAFE', `Unsafe package file: ${relativePath}`);
  }
  await access(resolved, constants.R_OK);
  const bytes = await readFile(resolved);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new PluginStoreError('PLUGIN_FILE_INVALID', `Invalid package file size: ${relativePath}`);
  }
  return bytes;
}

export async function readContainedLogo(
  directory: string,
  descriptor: { path: string; mediaType: 'image/png' | 'image/webp'; sha256: string },
): Promise<{ bytes: Buffer; mediaType: 'image/png' | 'image/webp'; sha256: string }> {
  const bytes = await readContainedRegularFile(directory, descriptor.path, MAX_PLUGIN_LOGO_BYTES);
  assertCatalogImageMagic(bytes, descriptor.mediaType);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== descriptor.sha256) {
    throw new PluginStoreError('PLUGIN_LOGO_DIGEST', 'Proxy logo checksum mismatch.');
  }
  return { bytes, mediaType: descriptor.mediaType, sha256 };
}

export async function assertContainedSkill(
  directory: string,
  skill: { path: string; sha256: string },
): Promise<void> {
  const bytes = await readContainedRegularFile(directory, skill.path, MAX_PLUGIN_SKILL_BYTES);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== skill.sha256) {
    throw new PluginStoreError('PLUGIN_SKILL_DIGEST', 'Proxy Skill checksum mismatch.');
  }
}

export async function readPackageInventory(directory: string): Promise<Map<string, Buffer>> {
  const resolved = await realpath(directory);
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        throw new PluginStoreError('PLUGIN_SYMLINK', 'Package contains a symlink.');
      }
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!info.isFile()) {
        throw new PluginStoreError('PLUGIN_SPECIAL_FILE', 'Package contains a special file.');
      }
      const relativePath = relative(resolved, full).split(sep).join('/');
      assertCanonicalRelativePath(relativePath, 'package path');
      if (files.size >= MAX_PLUGIN_FILE_COUNT) {
        throw new PluginStoreError('PLUGIN_FILE_COUNT', 'Package exceeds file count.');
      }
      if (info.size > MAX_PLUGIN_FILE_BYTES || total + info.size > MAX_PLUGIN_TOTAL_BYTES) {
        throw new PluginStoreError('PLUGIN_PACKAGE_SIZE', 'Package exceeds size limits.');
      }
      const bytes = await readFile(full);
      total += bytes.byteLength;
      files.set(relativePath, bytes);
    }
  };
  await walk(resolved);
  if (files.size === 0) {
    throw new PluginStoreError('PLUGIN_PACKAGE_EMPTY', 'Package contains no files.');
  }
  return files;
}
