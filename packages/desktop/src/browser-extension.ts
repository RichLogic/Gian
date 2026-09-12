import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MAX_EXTENSION_STORE_BYTES = 1_048_576;
const MAX_EXTENSION_COUNT = 50;
const SUPPORTED_MANIFEST_KEYS = new Set([
  'name',
  'version',
  'author',
  'permissions',
  'content_scripts',
  'default_locale',
  'devtools_page',
  'short_name',
  'host_permissions',
  'manifest_version',
  'background',
  'minimum_chrome_version',
]);
const DECLARED_SUPPORTED_PERMISSIONS = new Set([
  'activeTab',
  'scripting',
  'storage',
  'tabs',
  'unlimitedStorage',
  'webRequest',
]);

export interface BrowserExtensionInstall {
  path: string;
  enabled: boolean;
}

export interface BrowserExtensionStoreState {
  version: 1;
  extensions: BrowserExtensionInstall[];
}

export interface BrowserExtensionStore {
  load(): Promise<BrowserExtensionStoreState>;
  save(state: BrowserExtensionStoreState): Promise<void>;
}

export interface BrowserExtensionManifest {
  path: string;
  key: string;
  sourceName: string;
  name: string;
  version: string;
  manifestVersion: 2 | 3;
  permissions: string[];
  warnings: string[];
}

export function browserExtensionKey(path: string): string {
  return `extension-${createHash('sha256').update(path).digest('hex').slice(0, 32)}`;
}

export function resolveBrowserSmokeExtensionDirectory(input: {
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

function sanitizedInstalls(value: unknown): BrowserExtensionStoreState {
  const candidate = value && typeof value === 'object'
    ? value as Partial<BrowserExtensionStoreState>
    : {};
  if (candidate.version !== 1 || !Array.isArray(candidate.extensions)) {
    return { version: 1, extensions: [] };
  }
  const seen = new Set<string>();
  const extensions: BrowserExtensionInstall[] = [];
  for (const item of candidate.extensions.slice(0, MAX_EXTENSION_COUNT)) {
    if (!item || typeof item !== 'object') continue;
    const install = item as Partial<BrowserExtensionInstall>;
    if (typeof install.path !== 'string'
      || !isAbsolute(install.path)
      || install.path.length > 16_384
      || seen.has(install.path)) continue;
    seen.add(install.path);
    extensions.push({ path: install.path, enabled: install.enabled !== false });
  }
  return { version: 1, extensions };
}

export class FileBrowserExtensionStore implements BrowserExtensionStore {
  constructor(private readonly path: string) {}

  async load(): Promise<BrowserExtensionStoreState> {
    try {
      const bytes = await readFile(this.path);
      if (bytes.byteLength > MAX_EXTENSION_STORE_BYTES) return { version: 1, extensions: [] };
      return sanitizedInstalls(JSON.parse(bytes.toString('utf8')));
    } catch {
      return { version: 1, extensions: [] };
    }
  }

  async save(state: BrowserExtensionStoreState): Promise<void> {
    const sanitized = sanitizedInstalls(state);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}

function manifestString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error(`Extension ${label} is invalid`);
  }
  return value.trim();
}

export async function inspectBrowserExtension(path: string): Promise<BrowserExtensionManifest> {
  if (!isAbsolute(path) || path.length > 16_384) throw new Error('Extension path is invalid');
  const canonicalPath = await realpath(path);
  const root = await lstat(canonicalPath);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Extension path must be a directory');
  const manifestPath = join(canonicalPath, 'manifest.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_EXTENSION_STORE_BYTES) {
    throw new Error('Extension manifest is invalid');
  }
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Extension manifest must be an object');
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) {
    throw new Error('Extension manifest version is unsupported');
  }
  const permissions = [...new Set([
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
  ].filter((value): value is string => typeof value === 'string').slice(0, 200))];
  const warnings = Object.keys(manifest)
    .filter(key => !SUPPORTED_MANIFEST_KEYS.has(key))
    .sort()
    .slice(0, 50)
    .map(key => `Electron does not declare manifest key "${key}" as supported`);
  for (const permission of Array.isArray(manifest.permissions) ? manifest.permissions : []) {
    if (typeof permission === 'string' && !DECLARED_SUPPORTED_PERMISSIONS.has(permission)) {
      warnings.push(`Electron does not declare permission "${permission}" as supported`);
    }
  }
  if (manifest.manifest_version === 3
    && manifest.background
    && typeof manifest.background === 'object'
    && !Array.isArray(manifest.background)
    && 'service_worker' in manifest.background) {
    warnings.unshift('Electron does not declare Manifest V3 background service workers as supported');
  }
  return {
    path: canonicalPath,
    key: browserExtensionKey(canonicalPath),
    sourceName: basename(canonicalPath).slice(0, 512),
    name: manifestString(manifest.name, 'name'),
    version: manifestString(manifest.version, 'version'),
    manifestVersion: manifest.manifest_version,
    permissions,
    warnings: [...new Set(warnings)].slice(0, 50),
  };
}
