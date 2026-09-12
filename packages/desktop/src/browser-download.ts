import { isAbsolute, relative, resolve } from 'node:path';

export function resolveBrowserSmokeDownloadDirectory(input: {
  packaged: boolean;
  userDataPath: string;
  candidate: string | undefined;
}): string | null {
  if (input.packaged || !input.candidate || !isAbsolute(input.candidate)) return null;
  const root = resolve(input.userDataPath);
  const target = resolve(input.candidate);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '..'
    || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(pathFromRoot)) return null;
  return target;
}
