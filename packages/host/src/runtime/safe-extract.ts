import { gunzipSync } from 'node:zlib';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ManagedRuntimeInstallError } from './errors.js';

const BLOCK = 512;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_FILE_COUNT = 65_536;
const MAX_TOTAL_BYTES = 768 * 1024 * 1024;

function octal(value: Buffer, label: string): number {
  const text = value.toString('utf8').replace(/\0/g, '').trim();
  if (!text) return 0;
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_INVALID', `${label} is invalid.`);
  }
  return parsed;
}

function headerName(header: Buffer): string {
  const raw = header.subarray(0, 100).toString('utf8').replace(/\0/g, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0/g, '');
  return (prefix ? `${prefix}/${raw}` : raw).replace(/^\.\//, '').replace(/\/$/, '');
}

function canonicalRelativePath(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('\\')
    && !/[\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function zeroBlock(block: Buffer): boolean {
  return block.every(byte => byte === 0);
}

function paxPath(bytes: Buffer): string | null {
  let offset = 0;
  let path: string | null = null;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space <= offset) throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_ENTRY', 'Runtime PAX record is invalid.');
    const length = Number(bytes.subarray(offset, space).toString('ascii'));
    const end = offset + length;
    if (!Number.isSafeInteger(length) || length <= 0 || end > bytes.length || bytes[end - 1] !== 0x0a) {
      throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_ENTRY', 'Runtime PAX record is invalid.');
    }
    const record = bytes.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_ENTRY', 'Runtime PAX record is invalid.');
    const key = record.subarray(0, equals).toString('utf8');
    if (key === 'linkpath' || key === 'size') {
      throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_ENTRY', 'Runtime PAX cannot override links or size.');
    }
    if (key === 'path') {
      const candidate = record.subarray(equals + 1).toString('utf8').replace(/^\.\//, '').replace(/\/$/, '');
      if (!canonicalRelativePath(candidate)) {
        throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_ENTRY', 'Runtime PAX path is invalid.');
      }
      path = candidate;
    }
    offset = end;
  }
  return path;
}

/** Extract a bounded Runtime tree without accepting links, devices, FIFOs,
 * sparse members, PAX extensions, or paths outside the staging directory. */
export async function extractManagedRuntimeArchive(
  archive: Buffer,
  destination: string,
): Promise<void> {
  if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_SIZE', 'Runtime archive size is invalid.');
  }
  let unpacked: Buffer;
  try {
    unpacked = gunzipSync(archive, {
      maxOutputLength: MAX_TOTAL_BYTES + (MAX_FILE_COUNT + 2) * BLOCK,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/maxOutputLength|too large|memory/i.test(message)) {
      throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_SIZE', 'Runtime archive exceeds extract limits.');
    }
    throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_INVALID', 'Runtime archive is not valid gzip.');
  }
  if (unpacked.byteLength < BLOCK * 2) {
    throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_INVALID', 'Runtime archive is truncated.');
  }

  let offset = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const paths = new Set<string>();
  let pendingPaxPath: string | null = null;
  while (offset + BLOCK <= unpacked.byteLength) {
    const header = unpacked.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (zeroBlock(header)) break;
    const type = header[156] ?? 0;
    if (type !== 0 && type !== 0x30 && type !== 0x35 && type !== 0x78) {
      throw new ManagedRuntimeInstallError(
        'RUNTIME_ARCHIVE_ENTRY',
        'Runtime archive contains a link, special file, or extended header.',
      );
    }
    const size = octal(header.subarray(124, 136), 'Runtime archive member size');
    // Local PAX headers carry timestamps and xattrs in standard vendor
    // archives. Gian deliberately ignores their contents (including any path
    // override) and trusts only the following ustar header's canonical name.
    if (type === 0x78) {
      if (size <= 0 || size > 1024 * 1024 || offset + size > unpacked.byteLength) {
        throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_ENTRY', 'Runtime PAX header is invalid.');
      }
      pendingPaxPath = paxPath(Buffer.from(unpacked.subarray(offset, offset + size)));
      offset += Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    const name = pendingPaxPath ?? headerName(header);
    pendingPaxPath = null;
    if (type === 0x35 && name === '') continue;
    if (name === '.gian-runtime-artifact.json' || !canonicalRelativePath(name)) {
      const safeName = name.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 200);
      throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_ENTRY', `Runtime archive path is invalid: ${safeName}`);
    }
    if (paths.has(name)) {
      throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_ENTRY', `Runtime archive path is duplicated: ${name}`);
    }
    paths.add(name);
    const target = join(destination, ...name.split('/'));
    if (type === 0x35) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    const mode = octal(header.subarray(100, 108), 'Runtime archive member mode');
    if (size < 0 || size > MAX_FILE_BYTES || offset + size > unpacked.byteLength) {
      throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_ENTRY', 'Runtime archive member is invalid.');
    }
    fileCount += 1;
    totalBytes += size;
    if (fileCount > MAX_FILE_COUNT || totalBytes > MAX_TOTAL_BYTES) {
      throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_SIZE', 'Runtime archive exceeds extract limits.');
    }
    const bytes = Buffer.from(unpacked.subarray(offset, offset + size));
    offset += Math.ceil(size / BLOCK) * BLOCK;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: mode & 0o111 ? 0o700 : 0o600 });
    if (mode & 0o111) await chmod(target, 0o700);
  }
  if (fileCount === 0) {
    throw new ManagedRuntimeInstallError('RUNTIME_ARCHIVE_EMPTY', 'Runtime archive contains no files.');
  }
}
