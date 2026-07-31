import type { OpenAppPrefs, OpenFileCategory } from '@gian/shared';

export type SheetTabKind =
  | 'file'
  | 'term'
  | 'settings'
  | 'plan'
  | 'diff'
  | 'workspace'
  | 'new-workspace'
  | 'chat'
  | 'browser';
export type FileViewMode = 'source' | 'preview';

export type RailId =
  | 'files'
  | 'diffs'
  | 'manager'
  | 'sidechat'
  | 'terminal'
  | 'browser'
  | 'workspaces'
  | 'settings';

export type SheetGroup =
  | 'files'
  | 'diffs'
  | 'sidechat'
  | 'term'
  | 'browser'
  | 'workspaces'
  | 'settings';

export const SHEET_GROUP_ORDER: readonly SheetGroup[] = [
  'files',
  'diffs',
  'sidechat',
  'term',
  'browser',
  'workspaces',
  'settings',
];

export type SheetOpenWith =
  | { kind: 'system'; name: 'default' | 'finder' | 'browser' | 'terminal' }
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
    | 'gear'
    | 'plan'
    | 'diff'
    | 'img'
    | 'grid'
    | 'chat'
    | 'browser';
  ico: string;
  wsId?: string;
  sessionId?: string;
  url?: string;
  preview?: boolean;
  lines?: Array<[string, string, string?, string?]>;
  viewMode?: FileViewMode;
  scrollLine?: number;
  fullPath?: string;
  workingTreeId?: string;
  planBody?: string;
  diffText?: string;
  rawSrc?: string;
  fileTreePath?: string;
  loadError?: string;
}

export interface SheetActions {
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  pinTab: (id: string) => void;
  setTabViewMode: (id: string, mode: FileViewMode) => void;
  setTabName: (id: string, name: string) => void;
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
  web: '@newtab',
  images: '@newtab',
  pdf: '@newtab',
  other: '@finder',
};

export function resolveOpenTarget(
  category: OpenFileCategory,
  openApps?: OpenAppPrefs,
): SheetOpenWith {
  const value = openApps?.[category] || DEFAULT_OPEN_TARGET[category];
  if (value === '@newtab') return { kind: 'system', name: 'browser' };
  if (value === '@finder') return { kind: 'system', name: 'finder' };
  return { kind: 'app', app: value };
}
