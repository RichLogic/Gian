import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

export async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    await handle.sync();
  } catch (error) {
    if (
      process.platform === 'win32'
      && ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
