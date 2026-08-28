import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type {
  PickComposerResourcesResult,
  PickedComposerResource,
} from '@gian/shared';

export const MAX_PICKED_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PICKED_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_PICKED_RESOURCES = 32;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
};

export function mimeForPickedFile(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Classify native-panel selections without ever enumerating a directory. */
export function readPickedComposerResources(paths: string[]): PickComposerResourcesResult {
  const resources: PickedComposerResource[] = [];
  const rejectedFiles: string[] = [];
  let totalFileBytes = 0;
  for (const selectedPath of paths.slice(0, MAX_PICKED_RESOURCES)) {
    let path: string;
    try {
      path = realpathSync.native(selectedPath);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        resources.push({ type: 'folder', path, name: basename(path) || path });
        continue;
      }
      const name = basename(path);
      if (
        !stat.isFile()
        || stat.size > MAX_PICKED_FILE_BYTES
        || totalFileBytes + stat.size > MAX_PICKED_TOTAL_BYTES
      ) {
        rejectedFiles.push(name);
        continue;
      }
      const bytes = readFileSync(path);
      totalFileBytes += bytes.byteLength;
      resources.push({
        type: 'file',
        name,
        mime: mimeForPickedFile(path),
        size: bytes.byteLength,
        data: new Uint8Array(bytes),
      });
    } catch {
      rejectedFiles.push(basename(selectedPath) || selectedPath);
    }
  }
  return { resources, rejectedFiles };
}
