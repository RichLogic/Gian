import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PluginStoreError } from './errors.js';
import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_FILE_BYTES,
  MAX_PLUGIN_FILE_COUNT,
  MAX_PLUGIN_TOTAL_BYTES,
} from './limits.js';
import { assertCanonicalRelativePath, readPackageInventory } from './containment.js';

const BLOCK = 512;

function octal(value: Buffer): number {
  const text = value.toString('utf8').replace(/\0/g, '').trim();
  if (!text) return 0;
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PluginStoreError('PLUGIN_ARCHIVE_INVALID', 'Archive header size is invalid.');
  }
  return parsed;
}

function headerName(header: Buffer): string {
  const raw = header.subarray(0, 100).toString('utf8').replace(/\0/g, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0/g, '');
  const name = prefix ? `${prefix}/${raw}` : raw;
  return name.replace(/^\.\//, '').replace(/\/$/, '');
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

export async function extractGzipUstar(
  archive: Buffer,
  destination: string,
): Promise<Map<string, Buffer>> {
  if (archive.byteLength === 0 || archive.byteLength > MAX_PLUGIN_ARCHIVE_BYTES) {
    throw new PluginStoreError('PLUGIN_ARCHIVE_SIZE', 'Archive size is invalid.');
  }
  let unpacked: Buffer;
  try {
    unpacked = gunzipSync(archive, {
      maxOutputLength: MAX_PLUGIN_TOTAL_BYTES + (MAX_PLUGIN_FILE_COUNT + 2) * BLOCK,
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large|memory/i.test(message)) {
      throw new PluginStoreError('PLUGIN_PACKAGE_SIZE', 'Archive exceeds extract limits.');
    }
    throw new PluginStoreError('PLUGIN_ARCHIVE_INVALID', 'Archive is not a valid gzip payload.');
  }
  if (unpacked.byteLength < BLOCK * 2) {
    throw new PluginStoreError('PLUGIN_ARCHIVE_INVALID', 'Archive is truncated.');
  }

  let offset = 0;
  let files = 0;
  let entries = 0;
  let total = 0;
  const written = new Set<string>();
  while (offset + BLOCK <= unpacked.byteLength) {
    const header = unpacked.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (isZeroBlock(header)) break;
    const typeflag = header[156] ?? 0;
    if (typeflag !== 0 && typeflag !== 0x30 && typeflag !== 0x35) {
      throw new PluginStoreError(
        'PLUGIN_ARCHIVE_ENTRY',
        'Archive contains a symlink, hard link, or special file.',
      );
    }
    const name = headerName(header);
    const size = octal(header.subarray(124, 136));
    entries += 1;
    if (entries > MAX_PLUGIN_FILE_COUNT) {
      throw new PluginStoreError('PLUGIN_FILE_COUNT', 'Archive exceeds entry count.');
    }
    if (typeflag === 0x35 && name === '' && size === 0) continue;
    assertCanonicalRelativePath(name, 'archive member');
    if (written.has(name)) {
      throw new PluginStoreError('PLUGIN_ARCHIVE_ENTRY', `Archive contains a duplicate path: ${name}`);
    }
    written.add(name);
    if (typeflag === 0x35) {
      if (size !== 0) {
        throw new PluginStoreError('PLUGIN_ARCHIVE_ENTRY', `Archive directory has content: ${name}`);
      }
      await mkdir(join(destination, ...name.split('/')), { recursive: true, mode: 0o700 });
      continue;
    }
    if (size === 0 || size > MAX_PLUGIN_FILE_BYTES) {
      throw new PluginStoreError('PLUGIN_FILE_INVALID', `Archive member size is invalid: ${name}`);
    }
    files += 1;
    total += size;
    if (files > MAX_PLUGIN_FILE_COUNT || total > MAX_PLUGIN_TOTAL_BYTES) {
      throw new PluginStoreError('PLUGIN_PACKAGE_SIZE', 'Archive exceeds extract limits.');
    }
    if (offset + size > unpacked.byteLength) {
      throw new PluginStoreError('PLUGIN_ARCHIVE_INVALID', 'Archive member is truncated.');
    }
    const bytes = Buffer.from(unpacked.subarray(offset, offset + size));
    offset += Math.ceil(size / BLOCK) * BLOCK;
    const target = join(destination, ...name.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
  }
  if (files === 0) {
    throw new PluginStoreError('PLUGIN_ARCHIVE_EMPTY', 'Archive contains no regular files.');
  }
  return readPackageInventory(destination);
}
