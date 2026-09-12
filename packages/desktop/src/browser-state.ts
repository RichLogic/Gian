import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  normalizeBrowserZoomFactor,
  type GianBrowserPermissionKind,
  type GianBrowserPreferences,
} from '@gian/shared';
import {
  BROWSER_PERMISSION_KINDS,
  browserPermissionOrigin,
} from './browser-permissions.js';

export const DEFAULT_BROWSER_PREFERENCES: GianBrowserPreferences = {
  home_page: '',
  restore_last_page: true,
  external_links: 'gian',
};

export interface PersistedBrowserTab {
  id: string;
  sourceSessionId: string | null;
  url: string;
  title: string;
  zoomFactor: number;
}

export interface PersistedBrowserState {
  version: 1;
  preferences: GianBrowserPreferences;
  tabs: PersistedBrowserTab[];
  permissions: Array<{
    origin: string;
    kinds: GianBrowserPermissionKind[];
  }>;
}

export interface BrowserStateStore {
  load(): PersistedBrowserState;
  save(state: PersistedBrowserState): void;
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= 256;
}

function restorableUrl(value: unknown): string {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 16_384) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function sanitizeBrowserPreferences(
  value: unknown,
  fallback: GianBrowserPreferences = DEFAULT_BROWSER_PREFERENCES,
): GianBrowserPreferences {
  const candidate = value && typeof value === 'object'
    ? value as Partial<GianBrowserPreferences>
    : {};
  return {
    home_page: typeof candidate.home_page === 'string' && candidate.home_page.length <= 4_096
      ? candidate.home_page
      : fallback.home_page,
    restore_last_page: typeof candidate.restore_last_page === 'boolean'
      ? candidate.restore_last_page
      : fallback.restore_last_page,
    external_links: candidate.external_links === 'gian' || candidate.external_links === 'system'
      ? candidate.external_links
      : fallback.external_links,
  };
}

export function sanitizeBrowserState(value: unknown): PersistedBrowserState {
  const candidate = value && typeof value === 'object'
    ? value as Partial<PersistedBrowserState>
    : {};
  if (candidate.version !== 1) {
    return {
      version: 1,
      preferences: { ...DEFAULT_BROWSER_PREFERENCES },
      tabs: [],
      permissions: [],
    };
  }
  const seen = new Set<string>();
  const tabs: PersistedBrowserTab[] = [];
  if (Array.isArray(candidate.tabs)) {
    for (const item of candidate.tabs.slice(0, 50)) {
      if (!item || typeof item !== 'object') continue;
      const tab = item as Partial<PersistedBrowserTab>;
      if (!validId(tab.id) || seen.has(tab.id)) continue;
      seen.add(tab.id);
      const url = restorableUrl(tab.url);
      tabs.push({
        id: tab.id,
        sourceSessionId: tab.sourceSessionId === null || validId(tab.sourceSessionId)
          ? tab.sourceSessionId
          : null,
        url,
        title: url && typeof tab.title === 'string' ? tab.title.slice(0, 512) : '',
        zoomFactor: normalizeBrowserZoomFactor(tab.zoomFactor),
      });
    }
  }
  const permissionMap = new Map<string, Set<GianBrowserPermissionKind>>();
  if (Array.isArray(candidate.permissions)) {
    for (const item of candidate.permissions.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue;
      const permission = item as { origin?: unknown; kinds?: unknown };
      const origin = browserPermissionOrigin(permission.origin);
      if (!origin || !Array.isArray(permission.kinds)) continue;
      const kinds = permission.kinds.filter(
        (kind): kind is GianBrowserPermissionKind =>
          typeof kind === 'string'
          && BROWSER_PERMISSION_KINDS.includes(kind as GianBrowserPermissionKind),
      );
      if (kinds.length === 0) continue;
      const saved = permissionMap.get(origin) ?? new Set<GianBrowserPermissionKind>();
      for (const kind of kinds) saved.add(kind);
      permissionMap.set(origin, saved);
    }
  }
  return {
    version: 1,
    preferences: sanitizeBrowserPreferences(candidate.preferences),
    tabs,
    permissions: [...permissionMap].map(([origin, kinds]) => ({
      origin,
      kinds: [...kinds],
    })),
  };
}

export class FileBrowserStateStore implements BrowserStateStore {
  constructor(private readonly path: string) {}

  load(): PersistedBrowserState {
    try {
      if (statSync(this.path).size > 1_048_576) return sanitizeBrowserState(null);
      return sanitizeBrowserState(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      return sanitizeBrowserState(null);
    }
  }

  save(state: PersistedBrowserState): void {
    const sanitized = sanitizeBrowserState(state);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }
}
