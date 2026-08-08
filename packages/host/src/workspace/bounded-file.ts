import { open } from 'node:fs/promises';

const READ_CHUNK_BYTES = 64 * 1024;

export type FileReadFailure = {
  error: string;
  status: 400 | 403 | 404 | 413 | 500;
};

class FileContractError extends Error {
  constructor(readonly kind: 'not-file' | 'too-large') {
    super(kind);
  }
}

/**
 * Read one regular file through a single descriptor, never retaining more
 * than maxBytes. The descriptor-level stat and bounded loop close the
 * stat→read TOCTOU gap: a file that grows after stat is rejected as soon as
 * the read crosses the cap, and callers build Content-Length from real bytes.
 */
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FileContractError('not-file');
    if (info.size > maxBytes) throw new FileContractError('too-large');

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw new FileContractError('too-large');
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new FileContractError('too-large');
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export function isLikelyBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0);
}

export function fileReadFailure(error: unknown): FileReadFailure {
  if (error instanceof FileContractError) {
    return error.kind === 'not-file'
      ? { error: 'not a file', status: 400 }
      : { error: 'file too large', status: 413 };
  }
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return { error: 'file not found', status: 404 };
  if (code === 'EACCES' || code === 'EPERM') return { error: 'file not readable', status: 403 };
  return { error: 'file read failed', status: 500 };
}
