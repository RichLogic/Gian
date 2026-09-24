import type { GianBrowserElementCapture } from './browser-context.js';

export interface GianBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GianBrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canOpenExternal: boolean;
  inspecting: boolean;
  zoomFactor: number;
  recoverable?: boolean;
  error?: string;
}

export const DEFAULT_BROWSER_PROFILE_ID = 'default';

export type GianBrowserLifecycle =
  | 'empty'
  | 'loading'
  | 'ready'
  | 'error'
  | 'crashed';

export interface GianBrowserCreateTabInput {
  /** The renderer may reserve an id before the IPC round trip so the panel can
   * render immediately. Other callers omit it and receive a main-owned id. */
  tabId?: string;
  /** Ask panel 2 to foreground this tab after the main process registers it. */
  activate?: boolean;
  /** Audit context only. Browser tabs have Browser lifetime and are not owned
   * or destroyed by the Session that first opened them. */
  sourceSessionId?: string | null;
}

export interface GianBrowserPageReference {
  tabId: string;
  pageGeneration: number;
}

export interface GianBrowserTabSnapshot {
  id: string;
  profileId: string;
  sourceSessionId: string | null;
  pageGeneration: number;
  lifecycle: GianBrowserLifecycle;
  requestedVisible: boolean;
  presented: boolean;
  control: 'idle' | 'controlled';
  state: GianBrowserState;
}

export interface GianBrowserTabsSnapshot {
  revision: number;
  tabs: GianBrowserTabSnapshot[];
}

export interface GianBrowserFindOptions {
  forward?: boolean;
  /** Gian semantic: true means move within the existing results. Electron's
   * same-named flag means "begin a new session" and is inverted in main. */
  findNext?: boolean;
  matchCase?: boolean;
}

export interface GianBrowserFindResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

export interface GianBrowserPreferences {
  home_page: string;
  restore_last_page: boolean;
  external_links: 'gian' | 'system';
}

export type GianBrowserDownloadStatus =
  | 'selecting'
  | 'progressing'
  | 'completed'
  | 'cancelled'
  | 'interrupted';

export interface GianBrowserDownload {
  id: string;
  tabId: string;
  filename: string;
  mimeType: string;
  status: GianBrowserDownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  canCancel: boolean;
  canReveal: boolean;
}

export interface GianBrowserDownloadsSnapshot {
  revision: number;
  downloads: GianBrowserDownload[];
}

export type GianBrowserPermissionKind =
  | 'camera'
  | 'microphone'
  | 'geolocation'
  | 'notifications'
  | 'clipboard';

export type GianBrowserPermissionDecision = 'allow_once' | 'allow_always' | 'deny';

export interface GianBrowserPermissionRequest {
  id: string;
  tabId: string;
  origin: string;
  kinds: GianBrowserPermissionKind[];
}

export interface GianBrowserPermissionsSnapshot {
  revision: number;
  requests: GianBrowserPermissionRequest[];
}

export type GianBrowserExtensionStatus = 'loading' | 'ready' | 'disabled' | 'error';

export interface GianBrowserExtension {
  key: string;
  extensionId: string | null;
  sourceName: string;
  name: string;
  version: string;
  manifestVersion: 2 | 3;
  enabled: boolean;
  status: GianBrowserExtensionStatus;
  permissions: string[];
  warnings: string[];
  error?: string;
}

export interface GianBrowserExtensionsSnapshot {
  revision: number;
  extensions: GianBrowserExtension[];
}

export const MIN_BROWSER_ZOOM_FACTOR = 0.25;
export const MAX_BROWSER_ZOOM_FACTOR = 5;
export const DEFAULT_BROWSER_ZOOM_FACTOR = 1;
const BROWSER_ZOOM_STEP = 0.1;

/** Clamp an arbitrary zoom factor onto the bounded 10% scale shared by the
 * toolbar, keyboard shortcuts, and the native WebContentsView. */
export function normalizeBrowserZoomFactor(
  value: unknown,
  fallback = DEFAULT_BROWSER_ZOOM_FACTOR,
): number {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  const stepped = Math.round(safe / BROWSER_ZOOM_STEP) * BROWSER_ZOOM_STEP;
  const clamped = Math.min(MAX_BROWSER_ZOOM_FACTOR, Math.max(MIN_BROWSER_ZOOM_FACTOR, stepped));
  return Math.round(clamped * 100) / 100;
}

export function stepBrowserZoomFactor(current: unknown, direction: -1 | 1): number {
  return normalizeBrowserZoomFactor(
    normalizeBrowserZoomFactor(current) + direction * BROWSER_ZOOM_STEP,
  );
}

export type GianBrowserProjectTarget =
  | { workingTreeId: string; path: string }
  | { absolutePath: string };

/** Bounded accessibility-tree text of a Browser page, produced main-side by
 * the Browser automation service (the same sanitized artifact the agent's
 * browser.snapshot tool receives — never raw HTML). `snapshotId` references
 * the main-owned ref table, so the chip's `@eN` markers stay actionable until
 * the next snapshot on the tab. */
export interface GianBrowserPageSnapshotCapture {
  url: string;
  title: string;
  tree: string;
  truncated: boolean;
  snapshotId: string;
}

/** Bounded viewport screenshot of a Browser page (PNG, at most 1600 px wide
 * and 4 MiB — sized for model consumption, matching the agent's
 * browser.screenshot tool). */
export interface GianBrowserPageScreenshotCapture {
  mimeType: 'image/png';
  base64: string;
  width: number;
  height: number;
}

/** Node-free API exposed only to Gian's trusted renderer. Previewed pages use
 * a separate WebContentsView with no preload, so they can never call this. */
export interface GianBrowserApi {
  createTab(input?: GianBrowserCreateTabInput): Promise<GianBrowserTabSnapshot | null>;
  listTabs(): Promise<GianBrowserTabsSnapshot>;
  configure(preferences: GianBrowserPreferences): Promise<boolean>;
  getState(tabId: string): Promise<GianBrowserState>;
  navigate(tabId: string, url: string): Promise<GianBrowserState>;
  openProject(tabId: string, target: GianBrowserProjectTarget): Promise<GianBrowserState>;
  goBack(tabId: string): Promise<GianBrowserState>;
  goForward(tabId: string): Promise<GianBrowserState>;
  reload(tabId: string): Promise<GianBrowserState>;
  recover(tabId: string): Promise<GianBrowserState>;
  stop(tabId: string): Promise<GianBrowserState>;
  setLayout(tabId: string, bounds: GianBrowserBounds, visible: boolean): Promise<boolean>;
  /** Freeze-frame of the live page (PNG data URL) so an HTML overlay can sit
   *  where the native view was — null when the tab has no paintable view. */
  captureFrame(tabId: string): Promise<string | null>;
  /** Composer-context captures, produced by the main-owned Browser automation
   *  service under the ADR-0039 boundary. Null when the capture cannot run
   *  (no open page, DevTools or element inspection holding the page, ...). */
  capturePageSnapshot(tabId: string): Promise<GianBrowserPageSnapshotCapture | null>;
  capturePageScreenshot(tabId: string): Promise<GianBrowserPageScreenshotCapture | null>;
  setBackground(tabId: string, cssColor: string): Promise<boolean>;
  setZoom(tabId: string, factor: number): Promise<GianBrowserState>;
  openExternal(tabId: string): Promise<boolean>;
  closeTab(tabId: string): Promise<boolean>;
  clearData(): Promise<boolean>;
  setInspectMode(tabId: string, enabled: boolean): Promise<GianBrowserState>;
  findInPage(tabId: string, text: string, options?: GianBrowserFindOptions): void;
  stopFindInPage(tabId: string): Promise<boolean>;
  openDevTools(tabId: string): Promise<boolean>;
  listDownloads(): Promise<GianBrowserDownloadsSnapshot>;
  cancelDownload(downloadId: string): Promise<boolean>;
  revealDownload(downloadId: string): Promise<boolean>;
  listPermissionRequests(): Promise<GianBrowserPermissionsSnapshot>;
  respondPermission(requestId: string, decision: GianBrowserPermissionDecision): Promise<boolean>;
  listExtensions(): Promise<GianBrowserExtensionsSnapshot>;
  installExtension(): Promise<GianBrowserExtension | null>;
  setExtensionEnabled(extensionKey: string, enabled: boolean): Promise<boolean>;
  removeExtension(extensionKey: string): Promise<boolean>;
  subscribeTabs(listener: (snapshot: GianBrowserTabsSnapshot) => void): () => void;
  subscribePresentationRequested(listener: (tabId: string) => void): () => void;
  subscribe(listener: (tabId: string, state: GianBrowserState) => void): () => void;
  subscribeFind(listener: (tabId: string, result: GianBrowserFindResult) => void): () => void;
  subscribeFindRequested(listener: (tabId: string) => void): () => void;
  subscribeAddressRequested(listener: (tabId: string) => void): () => void;
  subscribeDownloads(listener: (snapshot: GianBrowserDownloadsSnapshot) => void): () => void;
  subscribePermissions(listener: (snapshot: GianBrowserPermissionsSnapshot) => void): () => void;
  subscribeExtensions(listener: (snapshot: GianBrowserExtensionsSnapshot) => void): () => void;
  subscribeElement(listener: (tabId: string, capture: GianBrowserElementCapture) => void): () => void;
}
