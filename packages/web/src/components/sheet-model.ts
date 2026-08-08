import type { OpenAppPrefs, OpenFileCategory } from '@gian/shared';
import type { ChangeScope } from '../api.js';

export type SheetTabKind =
  | 'file'
  | 'term'
  | 'settings'
  | 'plan'
  | 'diff'
  | 'commit'
  | 'text'
  | 'workspace'
  | 'new-workspace'
  | 'browser';
export type FileViewMode = 'source' | 'preview';

export type RailId =
  | 'files'
  | 'diffs'
  | 'history'
  | 'terminal'
  | 'browser'
  | 'workspaces'
  | 'settings';

export type SheetGroup =
  | 'files'
  | 'diffs'
  | 'history'
  | 'term'
  | 'browser'
  | 'workspaces'
  | 'settings';

export const SHEET_GROUP_ORDER: readonly SheetGroup[] = [
  'files',
  'diffs',
  'history',
  'term',
  'browser',
  'workspaces',
  'settings',
];

export type SheetOpenWith =
  | { kind: 'system'; name: 'default' | 'finder' | 'browser' | 'gian-browser' | 'terminal' }
  | { kind: 'app'; app: string }
  | { kind: 'editor'; id: string };

export interface SheetTab {
  id: string;
  group: SheetGroup;
  name: string;
  kind: SheetTabKind;
  icoKind:
    | 'md'
    | 'ts'
    | 'tsx'
    | 'json'
    | 'css'
    | 'term'
    | 'browser'
    | 'gear'
    | 'plan'
    | 'diff'
    | 'commit'
    | 'img'
    | 'grid';
  ico: string;
  wsId?: string;
  sessionId?: string;
  preview?: boolean;
  lines?: Array<[string, string, string?, string?]>;
  viewMode?: FileViewMode;
  scrollLine?: number;
  fullPath?: string;
  workingTreeId?: string;
  /** Normalized query identity for a diff tab. Only `commit` keeps `sha`,
   *  only `branch` keeps `base`, and `lastturn` is session-scoped. */
  diffScope?: ChangeScope;
  diffSha?: string | null;
  diffBase?: string | null;
  /** Paths rendered by a stacked diff. Used to validate anchor reveals
   *  against the active tab before touching the DOM. */
  diffPaths?: string[];
  planBody?: string;
  diffText?: string;
  /** Commit tabs (history group): the FULL sha — selection identity is
   *  {workingTreeId, sha}; the 7-char short sha only ever appears in labels
   *  (git-history proposal §5). */
  commitSha?: string;
  /** Set when a fetch rewrote history and this commit is no longer reachable —
   *  the body shows the snapshot with a banner instead of silently closing. */
  orphaned?: boolean;
  /** Level-3 transcript detail body (P3): full command output / reasoning
   *  trace / long result list for `kind: 'text'` tabs. */
  text?: string;
  rawSrc?: string;
  fileTreePath?: string;
  loadError?: string;
  /** Query timing (proposal §4.5): the tab was created immediately with a
   *  loading body; its content fill is still in flight. */
  loading?: boolean;
  /** Error-state retry: re-runs the tab's content load (set by the loader
   *  alongside `loadError`). */
  retryLoad?: () => void;
}

export interface DiffQueryIdentity {
  workingTreeId: string;
  scope: ChangeScope;
  sha: string | null;
  base: string | null;
  sessionId: string | null;
}

export function normalizeDiffQueryIdentity(
  workingTreeId: string,
  scope: ChangeScope,
  sha?: string | null,
  base?: string | null,
  sessionId?: string | null,
): DiffQueryIdentity {
  return {
    workingTreeId,
    scope,
    sha: scope === 'commit' ? sha ?? null : null,
    base: scope === 'branch' ? base ?? null : null,
    sessionId: scope === 'lastturn' ? sessionId ?? null : null,
  };
}

export function tabMatchesDiffQuery(tab: SheetTab, query: DiffQueryIdentity): boolean {
  return tab.kind === 'diff'
    && tab.workingTreeId === query.workingTreeId
    && tab.diffScope === query.scope
    && (tab.diffSha ?? null) === query.sha
    && (tab.diffBase ?? null) === query.base
    && (tab.sessionId ?? null) === query.sessionId;
}

export interface SheetActions {
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  pinTab: (id: string) => void;
  setTabViewMode: (id: string, mode: FileViewMode) => void;
  setTabName: (id: string, name: string) => void;
}

/**
 * Append `tab` to `tabs`, evicting the group's current preview tab first
 * (preview semantics: at most one preview tab per group — opening the next
 * detail replaces the previous one in place; pinned tabs are never
 * evicted). Pure so the preview-replacement rule is unit-testable.
 */
export function insertGroupPreviewTab(
  tabs: SheetTab[],
  group: SheetGroup,
  tab: SheetTab,
): SheetTab[] {
  const preview = tabs.find(t => t.group === group && t.preview);
  const base = preview ? tabs.filter(t => t.id !== preview.id) : [...tabs];
  return [...base, tab];
}

export const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  'bmp',
  'ico',
]);

const IMAGE_PREVIEW_EXTS = new Set([...IMAGE_EXTS, 'tiff', 'tif', 'heic', 'heif']);
const TEXT_EXTS = new Set([
  'txt', 'text', 'log', 'csv', 'tsv', 'md', 'markdown', 'mdx', 'rst',
  'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml', 'plist',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'm', 'mm', 'swift',
  'php', 'pl', 'pm', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'lua', 'r', 'sql', 'graphql', 'gql', 'proto',
  'dockerfile', 'makefile', 'gitignore', 'gitattributes', 'editorconfig', 'lock',
]);

export function openCategoryFor(name: string): OpenFileCategory {
  const extension = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (extension === 'pdf') return 'pdf';
  if (IMAGE_PREVIEW_EXTS.has(extension)) return 'images';
  if (extension === 'html' || extension === 'htm') return 'web';
  if (TEXT_EXTS.has(extension)) return 'code';
  return 'other';
}

export const DEFAULT_OPEN_TARGET: Record<OpenFileCategory, string> = {
  code: 'TextEdit',
  web: '@browser',
  images: '@newtab',
  pdf: '@newtab',
  other: '@finder',
};

export function resolveOpenTarget(
  category: OpenFileCategory,
  openApps?: OpenAppPrefs,
): SheetOpenWith {
  const value = openApps?.[category] || DEFAULT_OPEN_TARGET[category];
  if (value === '@browser') return { kind: 'system', name: 'gian-browser' };
  if (value === '@newtab') return { kind: 'system', name: 'browser' };
  if (value === '@finder') return { kind: 'system', name: 'finder' };
  return { kind: 'app', app: value };
}
