import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function sameFile(
  left: Awaited<ReturnType<typeof stat>>,
  right: Awaited<ReturnType<typeof stat>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function fileContentIdentity(path: string): Promise<string> {
  const resolved = await realpath(path);
  const before = await stat(resolved);
  if (!before.isFile()) throw new Error(`CLI runtime content is not a file: ${resolved}`);

  const hash = createHash('sha256');
  for await (const chunk of createReadStream(resolved)) hash.update(chunk as Buffer);

  const after = await stat(resolved);
  if (!sameFile(before, after)) {
    throw new Error(`CLI runtime content changed while it was being inspected: ${resolved}`);
  }
  return [
    resolved,
    String(after.dev),
    String(after.ino),
    String(after.size),
    String(after.mtimeMs),
    String(after.ctimeMs),
    hash.digest('hex'),
  ].join('\u0000');
}

/**
 * Capture the executable bytes selected by a provider. Command providers also
 * include a launcher-adjacent runtime such as npm's `node`, because replacing
 * that companion changes what the preserved launcher path will execute even
 * when the launcher itself is untouched.
 */
export async function runtimeContentSnapshot(
  binaryPath: string,
  companionNames: readonly string[] = [],
): Promise<string> {
  const launcher = await lstat(binaryPath);
  const parts = [
    `launcher:${binaryPath}`,
    `launcher-mode:${launcher.mode}`,
    `launcher-size:${launcher.size}`,
    `launcher-mtime:${launcher.mtimeMs}`,
    `launcher-ctime:${launcher.ctimeMs}`,
  ];
  if (launcher.isSymbolicLink()) parts.push(`launcher-target:${await readlink(binaryPath)}`);
  parts.push(`binary:${await fileContentIdentity(binaryPath)}`);

  for (const name of companionNames) {
    const path = join(dirname(binaryPath), name);
    try {
      parts.push(`companion:${name}:${await fileContentIdentity(path)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      parts.push(`companion:${name}:missing`);
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
