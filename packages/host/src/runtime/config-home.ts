import { homedir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

import { isCanonicalAbsolutePath } from '@gian/shared';

const FORBIDDEN_PREFIXES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/private',
  '/System',
  '/root',
];

export class ConfigHomeIdentityError extends Error {
  readonly code = 'RUNTIME_CONFIG_HOME_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigHomeIdentityError';
  }
}

function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !relativePath.startsWith('..'));
}

function macosVarPrivateAliases(path: string): string[] {
  if (path === '/var' || path.startsWith('/var/')) return [path, `/private${path}`];
  if (path === '/private/var' || path.startsWith('/private/var/')) {
    return [path, path.slice('/private'.length)];
  }
  return [path];
}

function isContainedUnderAny(roots: readonly string[], candidate: string): boolean {
  const candidates = macosVarPrivateAliases(candidate);
  return roots.some((root) => candidates.some((path) => isContained(root, path)));
}

export function isForbiddenSystemPath(path: string, homeDir?: string): boolean {
  if (path === '/') return true;
  if (homeDir) {
    const homes = macosVarPrivateAliases(resolve(homeDir)).filter((home) => (
      home !== '/' && !FORBIDDEN_PREFIXES.includes(home)
    ));
    if (isContainedUnderAny(homes, path)) return false;
  }
  return FORBIDDEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isDotConfigUnderHome(path: string, homeDir: string): boolean {
  const home = resolve(homeDir);
  if (path === home || !isContained(home, path)) return false;
  const first = relative(home, path).split(sep)[0] ?? '';
  return first.startsWith('.');
}

function isUserConfigLocation(path: string, homeDir: string): boolean {
  const home = resolve(homeDir);
  if (path === home) return false;
  const appSupport = resolve(home, 'Library', 'Application Support');
  if (path === appSupport || isContained(appSupport, path)) return true;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isCanonicalAbsolutePath(xdg)) {
    const xdgRoot = resolve(xdg);
    if (path === xdgRoot || isContained(xdgRoot, path)) return true;
  }
  return isDotConfigUnderHome(path, homeDir);
}

function isCompanionOfSelected(path: string, selectedPath: string): boolean {
  const companion = dirname(selectedPath);
  return path === companion || isContained(companion, path);
}

export function authorizedConfigHomeDir(): string {
  return process.env.HOME && isCanonicalAbsolutePath(process.env.HOME)
    ? process.env.HOME
    : homedir();
}

/**
 * Lexical Host authorization for configHome.
 * Forbidden system/private prefixes win before a launcher companion.
 * A system launcher cannot authorize its directory or sibling roots.
 */
export function isAuthorizedConfigHome(
  configHome: string,
  selectedPath: string,
  homeDir = authorizedConfigHomeDir(),
): boolean {
  if (!isCanonicalAbsolutePath(configHome) || !isCanonicalAbsolutePath(selectedPath)) {
    return false;
  }
  if (isForbiddenSystemPath(configHome, homeDir)) return false;
  if (isUserConfigLocation(configHome, homeDir)) return true;
  if (
    isCompanionOfSelected(configHome, selectedPath)
    && !isForbiddenSystemPath(dirname(resolve(selectedPath)), homeDir)
  ) {
    return true;
  }
  return false;
}

export function authorizedIdentityAnchors(
  selectedPath: string,
  homeDir = authorizedConfigHomeDir(),
): string[] {
  const anchors = [resolve(homeDir, 'Library', 'Application Support')];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isCanonicalAbsolutePath(xdg)) {
    anchors.push(resolve(xdg));
  } else {
    anchors.push(resolve(homeDir, '.config'));
  }
  const companion = dirname(resolve(selectedPath));
  if (!isForbiddenSystemPath(companion, homeDir)) {
    anchors.push(companion);
  }
  return anchors;
}

function isMacosVarPrivateAlias(lexical: string, real: string): boolean {
  return real === `/private${lexical}` || lexical === `/private${real}`;
}

/**
 * Walk every path component. A symlink may only resolve inside an
 * authorized config / Application Support / XDG / safe companion root.
 * The entire HOME is not an allowed destination. The macOS lexical
 * `/var` -> `/private/var` alias is the only filesystem alias exception.
 */
export async function assertAuthorizedFilesystemIdentity(
  targetPath: string,
  selectedPath: string,
  homeDir = authorizedConfigHomeDir(),
): Promise<void> {
  if (!isCanonicalAbsolutePath(targetPath)) {
    throw new ConfigHomeIdentityError(`${targetPath} is not a canonical absolute path.`);
  }
  const allowed = authorizedIdentityAnchors(selectedPath, homeDir);
  const resolvedAllowed: string[] = [];
  for (const anchor of allowed) {
    try {
      resolvedAllowed.push(await realpath(anchor));
    } catch {
      // Missing anchors are not usable as identity roots.
    }
  }
  const parts = targetPath.split(sep).filter(Boolean);
  let current = targetPath.startsWith(sep) ? sep : '';
  for (const part of parts) {
    current = current === sep ? `${sep}${part}` : `${current}${sep}${part}`;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw new ConfigHomeIdentityError(`configHome path is not reachable: ${current}`);
    }
    if (!info.isSymbolicLink()) continue;
    let real;
    try {
      real = await realpath(current);
    } catch {
      throw new ConfigHomeIdentityError(`configHome symlink cannot be resolved: ${current}`);
    }
    if (isForbiddenSystemPath(real, homeDir) && !isMacosVarPrivateAlias(current, real)) {
      throw new ConfigHomeIdentityError(
        `configHome path escaped its authorized identity roots: ${current}`,
      );
    }
    const contained = resolvedAllowed.some((root) => (
      real === root || isContainedUnderAny(macosVarPrivateAliases(root), real)
    ));
    if (!contained && !isMacosVarPrivateAlias(current, real)) {
      throw new ConfigHomeIdentityError(
        `configHome path escaped its authorized identity roots: ${current}`,
      );
    }
  }
}
