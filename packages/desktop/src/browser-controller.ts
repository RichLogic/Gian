import {
  Menu,
  WebContentsView,
  clipboard,
  net,
  protocol,
  session,
  type BrowserWindow,
  type Event,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  GianBrowserBounds,
  GianBrowserCreateTabInput,
  GianBrowserElementCapture,
  GianBrowserFindOptions,
  GianBrowserFindResult,
  GianBrowserDownload,
  GianBrowserDownloadsSnapshot,
  GianBrowserExtension,
  GianBrowserExtensionsSnapshot,
  GianBrowserPageReference,
  GianBrowserPermissionDecision,
  GianBrowserPermissionKind,
  GianBrowserPermissionRequest,
  GianBrowserPermissionsSnapshot,
  GianBrowserPreferences,
  GianBrowserProjectTarget,
  GianBrowserState,
  GianBrowserTabSnapshot,
  GianBrowserTabsSnapshot,
} from '@gian/shared';
import {
  DEFAULT_BROWSER_ZOOM_FACTOR,
  normalizeBrowserZoomFactor,
  stepBrowserZoomFactor,
} from '@gian/shared';
import {
  BROWSER_PROJECT_CSP,
  browserProjectUrl,
  createBrowserAbsoluteSite,
  createBrowserProjectSite,
  isAbsoluteBrowserSite,
  resolveAbsoluteBrowserPath,
  resolveBrowserProjectPath,
  type BrowserPreviewSite,
} from './browser-project.js';
import { DESKTOP_TOKEN_HEADER } from './managed-host.js';
import {
  captureFromCdpNode,
  type CdpAxNode,
  type CdpDomNode,
} from './browser-element.js';
import {
  BrowserDomain,
  type BrowserControlLease,
} from './browser-domain.js';
import {
  DEFAULT_BROWSER_PREFERENCES,
  sanitizeBrowserPreferences,
  type BrowserStateStore,
} from './browser-state.js';
import {
  browserPermissionKinds,
  browserPermissionOrigin,
} from './browser-permissions.js';
import { transientBrowserPopupOptions } from './browser-popup.js';
import {
  browserExtensionKey,
  inspectBrowserExtension,
  type BrowserExtensionManifest,
  type BrowserExtensionStore,
} from './browser-extension.js';

export const GIAN_BROWSER_SCHEME = 'gian-browser';
const BROWSER_PARTITION = 'persist:gian-browser';
const EMPTY_BOUNDS: GianBrowserBounds = { x: 0, y: 0, width: 0, height: 0 };

export function registerBrowserScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: GIAN_BROWSER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  }]);
}

interface BrowserControllerOptions {
  window: BrowserWindow;
  hostUrl: string;
  desktopToken: string | null;
  stateStore: BrowserStateStore;
  extensionStore: BrowserExtensionStore;
  pickExtensionDirectory: () => Promise<string | null>;
  prepareDownload: (item: Electron.DownloadItem, filename: string) => void;
  revealPath: (path: string) => void;
  openExternalUrl: (url: string) => Promise<void>;
  onTabsChanged: (snapshot: GianBrowserTabsSnapshot) => void;
  onState: (tabId: string, state: GianBrowserState) => void;
  onFind: (tabId: string, result: GianBrowserFindResult) => void;
  onFindRequested: (tabId: string) => void;
  onAddressRequested: (tabId: string) => void;
  onDownloadsChanged: (snapshot: GianBrowserDownloadsSnapshot) => void;
  onPermissionsChanged: (snapshot: GianBrowserPermissionsSnapshot) => void;
  onExtensionsChanged: (snapshot: GianBrowserExtensionsSnapshot) => void;
  onPresentationRequested: (tabId: string) => void;
  onElement: (tabId: string, capture: GianBrowserElementCapture) => void;
}

interface BrowserTab {
  id: string;
  view: WebContentsView | null;
  attached: boolean;
  requestedVisible: boolean;
  bounds: GianBrowserBounds;
  lastError?: string;
  navigationCommand: number;
  inspectGeneration: number;
  inspecting: boolean;
  debuggerOwned: boolean;
  zoomFactor: number;
  backgroundColor: string | null;
  pendingUrl: string | null;
  lastKnownUrl: string;
  lastKnownTitle: string;
  findGeneration: number;
  startingFindGeneration: number | null;
  findRequestGenerations: Map<number, number>;
}

interface BrowserProjectRegistration {
  tabId: string;
  site: BrowserPreviewSite;
}

interface BrowserDownloadRecord {
  snapshot: GianBrowserDownload;
  item: Electron.DownloadItem | null;
  savePath: string | null;
}

interface BrowserPendingPermission {
  snapshot: GianBrowserPermissionRequest;
  contents: WebContents;
  callback: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BrowserTransientPopup {
  id: string;
  tabId: string;
  window: BrowserWindow;
  timer: ReturnType<typeof setTimeout>;
}

interface BrowserExtensionRecord {
  manifest: BrowserExtensionManifest;
  snapshot: GianBrowserExtension;
  generation: number;
}

export class BrowserController {
  private readonly browserSession: Session;
  private readonly domain = new BrowserDomain();
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly sites = new Map<string, BrowserProjectRegistration>();
  private readonly downloads = new Map<string, BrowserDownloadRecord>();
  private readonly permissionGrants = new Map<string, Set<GianBrowserPermissionKind>>();
  private permissionOnce = new WeakMap<WebContents, Map<string, Set<GianBrowserPermissionKind>>>();
  private readonly pendingPermissions = new Map<string, BrowserPendingPermission>();
  private readonly transientPopups = new Map<WebContents, BrowserTransientPopup>();
  private readonly popupReservations = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly extensions = new Map<string, BrowserExtensionRecord>();
  private readonly extensionReady: Promise<void>;
  private tabsRevision = 0;
  private downloadsRevision = 0;
  private permissionsRevision = 0;
  private extensionsRevision = 0;
  private preferences: GianBrowserPreferences = { ...DEFAULT_BROWSER_PREFERENCES };
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private readonly onWindowVisibility = () => this.applyAllVisibility();
  private readonly onDownload = (
    event: Event,
    item: Electron.DownloadItem,
    contents: WebContents,
  ) => {
    const tabId = this.managedTabId(contents);
    if (!tabId) return;
    if (!item.hasUserGesture()) {
      event.preventDefault();
      item.cancel();
      return;
    }
    const id = `browser-download-${randomUUID()}`;
    const filename = basename(item.getFilename()).slice(0, 512) || 'download';
    this.options.prepareDownload(item, filename);
    const record: BrowserDownloadRecord = {
      snapshot: {
        id,
        tabId,
        filename,
        mimeType: item.getMimeType().slice(0, 256),
        status: 'selecting',
        receivedBytes: 0,
        totalBytes: Math.max(0, item.getTotalBytes()),
        canCancel: true,
        canReveal: false,
      },
      item,
      savePath: null,
    };
    this.downloads.set(id, record);
    this.trimDownloads();
    this.emitDownloads();
    item.on('updated', (_updatedEvent, state) => {
      if (record.item !== item) return;
      record.snapshot = {
        ...record.snapshot,
        status: state,
        receivedBytes: Math.max(0, item.getReceivedBytes()),
        totalBytes: Math.max(0, item.getTotalBytes()),
        canCancel: true,
      };
      this.emitDownloads();
    });
    item.once('done', (_doneEvent, state) => {
      if (record.item !== item) return;
      record.savePath = state === 'completed' ? item.getSavePath() || null : null;
      record.item = null;
      record.snapshot = {
        ...record.snapshot,
        status: state,
        receivedBytes: Math.max(0, item.getReceivedBytes()),
        totalBytes: Math.max(0, item.getTotalBytes()),
        canCancel: false,
        canReveal: state === 'completed' && !!record.savePath,
      };
      this.trimDownloads();
      this.emitDownloads();
    });
  };

  constructor(private readonly options: BrowserControllerOptions) {
    this.browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true });
    this.installSessionBoundary();
    this.installProjectProtocol();
    options.window.on('show', this.onWindowVisibility);
    options.window.on('hide', this.onWindowVisibility);
    options.window.on('minimize', this.onWindowVisibility);
    options.window.on('restore', this.onWindowVisibility);
    const persisted = options.stateStore.load();
    this.preferences = persisted.preferences;
    for (const permission of persisted.permissions) {
      this.permissionGrants.set(permission.origin, new Set(permission.kinds));
    }
    if (persisted.preferences.restore_last_page) {
      for (const restored of persisted.tabs) {
        const tab = this.ensureTab(restored.id, restored.sourceSessionId);
        tab.pendingUrl = restored.url || null;
        tab.lastKnownUrl = restored.url;
        tab.lastKnownTitle = restored.title;
        tab.zoomFactor = restored.zoomFactor;
      }
    }
    this.extensionReady = this.restoreExtensions();
  }

  createTab(input: GianBrowserCreateTabInput = {}): GianBrowserTabSnapshot {
    const metadata = this.domain.createTab(input);
    const tab = this.ensureTab(metadata.id, input.sourceSessionId);
    const homePage = normalizeBrowserHomePage(this.preferences.home_page);
    if (!tab.pendingUrl && !tab.lastKnownUrl && homePage) {
      tab.pendingUrl = homePage;
      tab.lastKnownUrl = homePage;
    }
    const snapshot = this.tabSnapshot(metadata.id);
    this.emitTabs();
    this.persistSoon();
    if (input.activate) this.options.onPresentationRequested(metadata.id);
    return snapshot;
  }

  listTabs(): GianBrowserTabsSnapshot {
    return {
      revision: this.tabsRevision,
      tabs: this.domain.listTabs().map(tab => this.tabSnapshot(tab.id)),
    };
  }

  listDownloads(): GianBrowserDownloadsSnapshot {
    return {
      revision: this.downloadsRevision,
      downloads: [...this.downloads.values()].map(record => ({ ...record.snapshot })),
    };
  }

  listPermissionRequests(): GianBrowserPermissionsSnapshot {
    return {
      revision: this.permissionsRevision,
      requests: [...this.pendingPermissions.values()].map(request => ({
        ...request.snapshot,
        kinds: [...request.snapshot.kinds],
      })),
    };
  }

  listExtensions(): GianBrowserExtensionsSnapshot {
    return {
      revision: this.extensionsRevision,
      extensions: [...this.extensions.values()].map(record => ({
        ...record.snapshot,
        permissions: [...record.snapshot.permissions],
        warnings: [...record.snapshot.warnings],
      })),
    };
  }

  async installExtension(): Promise<GianBrowserExtension | null> {
    await this.extensionReady;
    const selected = await this.options.pickExtensionDirectory();
    if (!selected) return null;
    let manifest: BrowserExtensionManifest;
    let inspectionError: string | undefined;
    try {
      manifest = await inspectBrowserExtension(selected);
    } catch (error) {
      const key = browserExtensionKey(selected);
      inspectionError = (error instanceof Error ? error.message : String(error)).slice(0, 512);
      manifest = {
        path: selected,
        key,
        sourceName: basename(selected).slice(0, 512) || 'extension',
        name: basename(selected).slice(0, 512) || 'Extension',
        version: '',
        manifestVersion: 3,
        permissions: [],
        warnings: [],
      };
    }
    const existing = this.extensions.get(manifest.key);
    if (existing) return {
      ...existing.snapshot,
      permissions: [...existing.snapshot.permissions],
      warnings: [...existing.snapshot.warnings],
    };
    const record = this.extensionRecord(manifest, true, inspectionError);
    this.extensions.set(manifest.key, record);
    this.emitExtensions();
    await this.persistExtensions();
    if (!inspectionError) await this.loadExtension(record);
    return {
      ...record.snapshot,
      permissions: [...record.snapshot.permissions],
      warnings: [...record.snapshot.warnings],
    };
  }

  async setExtensionEnabled(extensionKey: string, enabled: boolean): Promise<boolean> {
    await this.extensionReady;
    const record = this.extensions.get(extensionKey);
    if (!record || record.snapshot.enabled === enabled) return !!record;
    record.generation += 1;
    if (!enabled) {
      if (record.snapshot.extensionId) {
        this.browserSession.extensions.removeExtension(record.snapshot.extensionId);
      }
      record.snapshot = {
        ...record.snapshot,
        extensionId: null,
        enabled: false,
        status: 'disabled',
        error: undefined,
      };
      this.emitExtensions();
      await this.persistExtensions();
      return true;
    }
    record.snapshot = { ...record.snapshot, enabled: true, status: 'loading', error: undefined };
    this.emitExtensions();
    await this.persistExtensions();
    await this.loadExtension(record);
    return record.snapshot.status === 'ready';
  }

  async removeExtension(extensionKey: string): Promise<boolean> {
    await this.extensionReady;
    const record = this.extensions.get(extensionKey);
    if (!record) return true;
    record.generation += 1;
    if (record.snapshot.extensionId) {
      this.browserSession.extensions.removeExtension(record.snapshot.extensionId);
    }
    this.extensions.delete(extensionKey);
    this.emitExtensions();
    await this.persistExtensions();
    return true;
  }

  respondPermission(requestId: string, decision: GianBrowserPermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    const granted = decision === 'allow_once' || decision === 'allow_always';
    if (decision === 'allow_always') {
      const saved = this.permissionGrants.get(pending.snapshot.origin)
        ?? new Set<GianBrowserPermissionKind>();
      for (const kind of pending.snapshot.kinds) saved.add(kind);
      this.permissionGrants.set(pending.snapshot.origin, saved);
      this.persistNow();
    } else if (decision === 'allow_once') {
      const byOrigin = this.permissionOnce.get(pending.contents) ?? new Map();
      const saved = byOrigin.get(pending.snapshot.origin) ?? new Set<GianBrowserPermissionKind>();
      for (const kind of pending.snapshot.kinds) saved.add(kind);
      byOrigin.set(pending.snapshot.origin, saved);
      this.permissionOnce.set(pending.contents, byOrigin);
    }
    this.settlePermission(requestId, granted);
    return true;
  }

  cancelDownload(downloadId: string): boolean {
    const record = this.downloads.get(downloadId);
    if (!record?.item || !record.snapshot.canCancel) return false;
    record.item.cancel();
    return true;
  }

  revealDownload(downloadId: string): boolean {
    const record = this.downloads.get(downloadId);
    if (!record?.snapshot.canReveal || !record.savePath) return false;
    this.options.revealPath(record.savePath);
    return true;
  }

  configure(preferences: GianBrowserPreferences): boolean {
    this.preferences = sanitizeBrowserPreferences(preferences, this.preferences);
    this.persistNow();
    return true;
  }

  /** Internal future-automation boundary. The renderer never receives the
   * lease owner or Electron WebContents handle. */
  acquireControl(tabId: string, ownerId: string): BrowserControlLease {
    this.ensureTab(tabId);
    const lease = this.domain.acquireControl(tabId, ownerId);
    this.emitTabs();
    return lease;
  }

  releaseControl(lease: Pick<BrowserControlLease, 'id' | 'tabId'>): boolean {
    const released = this.domain.releaseControl(lease);
    if (released) this.emitTabs();
    return released;
  }

  getPageReference(tabId: string): GianBrowserPageReference | null {
    return this.domain.getTab(tabId) ? this.domain.currentPage(tabId) : null;
  }

  resolvePage(reference: GianBrowserPageReference): WebContents | null {
    if (!this.domain.isCurrentPage(reference)) return null;
    const contents = this.tabs.get(reference.tabId)?.view?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  /** Main-only Browser Use seam. It materializes a restored/hidden tab but
   * never exposes WebContents through preload or renderer IPC. */
  automationPage(tabId: string): { reference: GianBrowserPageReference; contents: WebContents } {
    const tab = this.tabs.get(tabId);
    if (!tab || !this.domain.getTab(tabId)) throw new Error(`Unknown Browser tab: ${tabId}`);
    const contents = this.ensureView(tab).webContents;
    return { reference: this.domain.currentPage(tabId), contents };
  }

  getState(tabId: string): GianBrowserState {
    const tab = this.tabs.get(tabId);
    if (!tab) return emptyBrowserState();
    const contents = tab.view?.webContents;
    const nativeUrl = contents && !contents.isDestroyed() ? contents.getURL() : '';
    const url = nativeUrl && nativeUrl !== 'about:blank'
      ? nativeUrl
      : tab.pendingUrl ?? tab.lastKnownUrl;
    const nativeTitle = contents && !contents.isDestroyed() ? contents.getTitle() : '';
    return {
      url,
      title: nativeTitle || tab.lastKnownTitle,
      loading: !!contents && !contents.isDestroyed() && contents.isLoading(),
      canGoBack: !!contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !!contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      canOpenExternal: this.canOpenCurrentExternally(url),
      inspecting: tab.inspecting,
      zoomFactor: tab.zoomFactor,
      ...(tab.lastError && url ? { recoverable: true } : {}),
      ...(tab.lastError ? { error: tab.lastError } : {}),
    };
  }

  async navigate(tabId: string, candidate: string): Promise<GianBrowserState> {
    const tab = this.ensureTab(tabId);
    this.cancelInspect(tab);
    if (!isAllowedBrowserUrl(candidate)) {
      tab.lastError = 'Unsupported or invalid URL';
      this.emitState(tab);
      return this.getState(tabId);
    }
    await this.extensionReady;
    if (this.tabs.get(tab.id) !== tab) return emptyBrowserState();
    const command = ++tab.navigationCommand;
    tab.pendingUrl = candidate;
    tab.lastKnownUrl = candidate;
    const contents = this.ensureView(tab).webContents;
    await this.stopCurrentLoad(contents);
    if (command !== tab.navigationCommand || contents.isDestroyed()) return this.getState(tabId);
    tab.lastError = undefined;
    await contents.loadURL(candidate).catch(error => {
      if (command === tab.navigationCommand) {
        tab.pendingUrl = null;
        tab.lastError = error instanceof Error ? error.message : String(error);
      }
    });
    if (command === tab.navigationCommand) this.emitState(tab);
    return this.getState(tabId);
  }

  async openProject(tabId: string, target: GianBrowserProjectTarget): Promise<GianBrowserState> {
    const tab = this.ensureTab(tabId);
    const site = previewSiteFromTarget(target);
    if (!site) {
      tab.lastError = 'Invalid project path';
      this.emitState(tab);
      return this.getState(tabId);
    }
    const siteId = randomUUID().replaceAll('-', '');
    this.sites.set(siteId, { tabId, site });
    return this.navigate(tabId, browserProjectUrl(siteId, site.entry));
  }

  goBack(tabId: string): GianBrowserState {
    const tab = this.ensureTab(tabId);
    this.cancelInspect(tab);
    tab.navigationCommand += 1;
    const contents = this.ensureView(tab).webContents;
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    tab.lastError = undefined;
    this.emitState(tab);
    return this.getState(tabId);
  }

  goForward(tabId: string): GianBrowserState {
    const tab = this.ensureTab(tabId);
    this.cancelInspect(tab);
    tab.navigationCommand += 1;
    const contents = this.ensureView(tab).webContents;
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    tab.lastError = undefined;
    this.emitState(tab);
    return this.getState(tabId);
  }

  reload(tabId: string, ignoreCache = false): GianBrowserState {
    const tab = this.ensureTab(tabId);
    this.cancelInspect(tab);
    tab.navigationCommand += 1;
    const contents = this.ensureView(tab).webContents;
    tab.lastError = undefined;
    if (ignoreCache) contents.reloadIgnoringCache();
    else contents.reload();
    this.emitState(tab);
    return this.getState(tabId);
  }

  async recover(tabId: string): Promise<GianBrowserState> {
    const tab = this.tabs.get(tabId);
    if (!tab) return emptyBrowserState();
    const url = tab.pendingUrl ?? tab.lastKnownUrl;
    if (!url || !isAllowedBrowserUrl(url)) return this.getState(tabId);
    tab.navigationCommand += 1;
    this.destroyView(tab);
    tab.lastError = undefined;
    tab.pendingUrl = url;
    tab.navigationCommand = 0;
    this.domain.markLoading(tab.id);
    this.emitState(tab);
    if (tab.requestedVisible && tab.bounds.width > 0 && tab.bounds.height > 0) {
      this.ensureView(tab);
      return this.navigate(tab.id, url);
    }
    return this.getState(tabId);
  }

  /** Renderer-reported theme surface color. The native view paints above the
   * DOM, so the renderer sends its computed `--surface` (hex/rgb(a)) and we
   * repaint every (re)created view with it. */
  setBackground(tabId: string, color: string): boolean {
    const tab = this.ensureTab(tabId);
    tab.backgroundColor = color;
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.setBackgroundColor(color);
    return true;
  }

  setZoom(tabId: string, factor: number): GianBrowserState {
    const tab = this.ensureTab(tabId);
    tab.zoomFactor = normalizeBrowserZoomFactor(factor, tab.zoomFactor);
    const contents = tab.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.setZoomFactor(tab.zoomFactor);
    this.emitState(tab);
    return this.getState(tabId);
  }

  stop(tabId: string): GianBrowserState {
    const tab = this.tabs.get(tabId);
    if (!tab) return emptyBrowserState();
    this.cancelInspect(tab);
    tab.navigationCommand += 1;
    const contents = tab.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.stop();
    this.emitState(tab);
    return this.getState(tabId);
  }

  findInPage(
    tabId: string,
    text: string,
    options: GianBrowserFindOptions = {},
  ): boolean {
    if (!text.trim() || text.length > 2_048) return false;
    const tab = this.tabs.get(tabId);
    const contents = tab?.view?.webContents;
    if (!tab || !contents || contents.isDestroyed()) return false;
    const generation = ++tab.findGeneration;
    tab.findRequestGenerations.clear();
    tab.startingFindGeneration = generation;
    try {
      const requestId = contents.findInPage(text, {
        forward: options.forward !== false,
        findNext: options.findNext !== true,
        matchCase: options.matchCase === true,
      });
      tab.findRequestGenerations.set(requestId, generation);
    } finally {
      tab.startingFindGeneration = null;
    }
    return true;
  }

  stopFindInPage(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    const contents = tab?.view?.webContents;
    if (!tab || !contents || contents.isDestroyed()) return false;
    tab.findGeneration += 1;
    tab.startingFindGeneration = null;
    tab.findRequestGenerations.clear();
    contents.stopFindInPage('clearSelection');
    return true;
  }

  openDevTools(tabId: string): boolean {
    const contents = this.tabs.get(tabId)?.view?.webContents;
    if (!contents || contents.isDestroyed() || !contents.getURL()) return false;
    contents.openDevTools({ mode: 'detach', activate: true });
    return true;
  }

  setLayout(tabId: string, bounds: GianBrowserBounds, visible: boolean): boolean {
    // Layout cleanup is sent asynchronously when BrowserPanel unmounts. A
    // late cleanup for a tab that was just closed must not recreate it.
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (!visible) this.cancelInspect(tab);
    if (visible) {
      // Renderer layout messages are asynchronous and native views always sit
      // above the renderer DOM. Enforce the exclusivity invariant in the main
      // process as well: a newly visible Browser tab must detach every sibling
      // even if that sibling's `visible=false` message is still in flight.
      for (const sibling of this.tabs.values()) {
        if (sibling === tab) continue;
        this.cancelInspect(sibling);
        sibling.requestedVisible = false;
        this.applyVisibility(sibling);
      }
    }
    if (!validBounds(bounds, this.options.window)) {
      // Never leave a previously valid native view painted over a new,
      // transiently invalid DOM layout (panel animation/resize/window edge).
      tab.requestedVisible = false;
      this.cancelInspect(tab);
      this.applyVisibility(tab);
      return false;
    }
    tab.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    tab.requestedVisible = visible;
    if (visible) {
      const contents = this.ensureView(tab).webContents;
      const currentUrl = contents.getURL();
      if (tab.pendingUrl
        && tab.navigationCommand === 0
        && (!currentUrl || currentUrl === 'about:blank')) {
        void this.navigate(tab.id, tab.pendingUrl);
      }
    }
    if (tab.view) tab.view.setBounds(tab.bounds);
    this.applyVisibility(tab);
    return true;
  }

  /** Freeze-frame for HTML overlays that must float above the page (the ⋯
   *  menu): the renderer hides the native view and shows this image in its
   *  place, so the page never reflows. Resized to layout DIPs — the frame is
   *  transient, Retina pixels would only inflate the IPC payload. */
  async captureFrame(tabId: string): Promise<string | null> {
    const tab = this.tabs.get(tabId);
    const contents = tab?.view?.webContents;
    if (!tab?.view || !contents || contents.isDestroyed()) return null;
    let image = await contents.capturePage();
    if (image.isEmpty()) return null;
    const dipWidth = Math.max(1, Math.round(tab.bounds.width));
    if (image.getSize().width > dipWidth) {
      image = image.resize({ width: dipWidth, quality: 'good' });
    }
    return `data:image/png;base64,${image.toPNG().toString('base64')}`;
  }

  async openExternal(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    const url = tab?.view?.webContents.getURL() ?? '';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      await this.options.openExternalUrl(parsed.toString());
      return true;
    }
    if (parsed.protocol !== `${GIAN_BROWSER_SCHEME}:`) return false;

    const registration = this.sites.get(parsed.hostname);
    if (!registration) return false;
    const request = projectOpenRequest(registration.site, parsed.pathname);
    if (!request) return false;
    const response = await this.hostFetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    return response.ok;
  }

  closeTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return true;
    tab.navigationCommand += 1;
    tab.requestedVisible = false;
    this.destroyView(tab);
    this.tabs.delete(tabId);
    this.domain.closeTab(tabId);
    this.removeSitesForTab(tabId);
    this.emitTabs();
    this.persistSoon();
    return true;
  }

  async clearData(): Promise<boolean> {
    const destroyed: Array<Promise<void>> = [];
    for (const tab of this.tabs.values()) {
      tab.navigationCommand += 1;
      const contents = tab.view?.webContents;
      if (contents && !contents.isDestroyed()) {
        destroyed.push(new Promise<void>(resolve => contents.once('destroyed', resolve)));
      }
      this.destroyView(tab);
    }
    await Promise.all(destroyed);
    this.sites.clear();
    for (const id of [...this.pendingPermissions.keys()]) this.settlePermission(id, false);
    this.permissionGrants.clear();
    this.permissionOnce = new WeakMap();
    await Promise.all([
      this.browserSession.clearStorageData(),
      this.browserSession.clearCache(),
      this.browserSession.clearAuthCache(),
    ]);
    for (const tab of this.tabs.values()) {
      tab.pendingUrl = null;
      tab.lastKnownUrl = '';
      tab.lastKnownTitle = '';
      tab.lastError = undefined;
      if (tab.requestedVisible && tab.bounds.width > 0 && tab.bounds.height > 0) {
        this.ensureView(tab);
      }
      this.emitState(tab);
    }
    this.persistNow();
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persistNow();
    this.destroyed = true;
    this.options.window.off('show', this.onWindowVisibility);
    this.options.window.off('hide', this.onWindowVisibility);
    this.options.window.off('minimize', this.onWindowVisibility);
    this.options.window.off('restore', this.onWindowVisibility);
    this.browserSession.removeListener('will-download', this.onDownload);
    this.browserSession.setPermissionCheckHandler(null);
    this.browserSession.setPermissionRequestHandler(null);
    for (const record of this.downloads.values()) record.item?.cancel();
    for (const id of [...this.pendingPermissions.keys()]) this.settlePermission(id, false);
    for (const record of this.extensions.values()) {
      record.generation += 1;
      if (record.snapshot.extensionId) {
        this.browserSession.extensions.removeExtension(record.snapshot.extensionId);
      }
    }
    this.extensions.clear();
    for (const timer of this.popupReservations.values()) clearTimeout(timer);
    this.popupReservations.clear();
    if (this.browserSession.protocol.isProtocolHandled(GIAN_BROWSER_SCHEME)) {
      this.browserSession.protocol.unhandle(GIAN_BROWSER_SCHEME);
    }
    for (const tab of this.tabs.values()) {
      tab.navigationCommand += 1;
      tab.requestedVisible = false;
      this.destroyView(tab);
    }
    this.tabs.clear();
    this.sites.clear();
    this.downloads.clear();
  }

  private installSessionBoundary(): void {
    this.browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (!contents || !details.isMainFrame || !this.managedTabId(contents)) return false;
      const kinds = browserPermissionKinds(permission, details);
      const origin = browserPermissionOrigin(
        details.securityOrigin ?? details.requestingUrl ?? requestingOrigin,
      );
      return !!kinds && !!origin && this.hasPermission(contents, origin, kinds);
    });
    this.browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const tabId = this.managedTabId(contents);
      const kinds = browserPermissionKinds(permission, details);
      const origin = browserPermissionOrigin(
        'securityOrigin' in details && details.securityOrigin
          ? details.securityOrigin
          : details.requestingUrl,
      );
      if (!tabId || !details.isMainFrame || !kinds || !origin) {
        callback(false);
        return;
      }
      if (this.hasPermission(contents, origin, kinds)) {
        callback(true);
        return;
      }
      if (this.pendingPermissions.size >= 20) {
        callback(false);
        return;
      }
      const id = `browser-permission-${randomUUID()}`;
      const pending: BrowserPendingPermission = {
        snapshot: { id, tabId, origin, kinds },
        contents,
        callback,
        timer: setTimeout(() => this.settlePermission(id, false), 30_000),
      };
      this.pendingPermissions.set(id, pending);
      this.emitPermissions();
      this.options.onPresentationRequested(tabId);
    });
    this.browserSession.on('will-download', this.onDownload);
    this.browserSession.webRequest.onBeforeRequest({ urls: ['file:///*'] }, (_details, callback) => {
      callback({ cancel: true });
    });
  }

  private installProjectProtocol(): void {
    if (this.browserSession.protocol.isProtocolHandled(GIAN_BROWSER_SCHEME)) {
      this.browserSession.protocol.unhandle(GIAN_BROWSER_SCHEME);
    }
    this.browserSession.protocol.handle(GIAN_BROWSER_SCHEME, async request => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405 });
      }
      const url = new URL(request.url);
      const registration = this.sites.get(url.hostname);
      if (!registration) return new Response('Preview origin not found', { status: 404 });
      const fetchPath = projectRawPath(registration.site, url.pathname);
      if (!fetchPath) return new Response('Invalid preview path', { status: 400 });

      const upstream = await this.hostFetch(fetchPath, { method: request.method });
      const headers = new Headers(upstream.headers);
      headers.delete('content-security-policy');
      headers.delete('content-security-policy-report-only');
      headers.delete('x-frame-options');
      headers.delete('content-disposition');
      headers.set('content-security-policy', BROWSER_PROJECT_CSP);
      headers.set('referrer-policy', 'no-referrer');
      headers.set('x-content-type-options', 'nosniff');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    });
  }

  private ensureTab(tabId: string, sourceSessionId?: string | null): BrowserTab {
    if (this.destroyed) throw new Error('Browser controller destroyed');
    const registered = this.domain.getTab(tabId) !== null;
    const metadata = this.domain.ensureTab(tabId, sourceSessionId);
    const existing = this.tabs.get(metadata.id);
    if (existing) return existing;
    const tab: BrowserTab = {
      id: metadata.id,
      view: null,
      attached: false,
      requestedVisible: false,
      bounds: { ...EMPTY_BOUNDS },
      navigationCommand: 0,
      inspectGeneration: 0,
      inspecting: false,
      debuggerOwned: false,
      zoomFactor: DEFAULT_BROWSER_ZOOM_FACTOR,
      backgroundColor: null,
      pendingUrl: null,
      lastKnownUrl: '',
      lastKnownTitle: '',
      findGeneration: 0,
      startingFindGeneration: null,
      findRequestGenerations: new Map(),
    };
    this.tabs.set(metadata.id, tab);
    if (!registered) this.emitTabs();
    return tab;
  }

  private ensureView(tab: BrowserTab): WebContentsView {
    if (this.destroyed) throw new Error('Browser controller destroyed');
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;

    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: true,
        devTools: true,
        autoplayPolicy: 'user-gesture-required',
      },
    });
    tab.view = view;
    this.domain.replacePage(tab.id);
    view.setBounds(tab.bounds);
    if (tab.backgroundColor) view.setBackgroundColor(tab.backgroundColor);
    view.webContents.setZoomFactor(tab.zoomFactor);
    this.hardenView(tab, view.webContents);
    this.applyVisibility(tab);
    this.emitState(tab);
    return view;
  }

  private hardenView(tab: BrowserTab, contents: WebContents): void {
    const guardNavigation = (event: Event, url: string) => {
      if (isAllowedBrowserUrl(url) || url === 'about:blank') return;
      event.preventDefault();
      void this.options.openExternalUrl(url);
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.setWindowOpenHandler(details => {
      const transientPopup = transientBrowserPopupOptions(details);
      if (transientPopup && this.reserveTransientPopup(tab.id)) {
        return {
          action: 'allow',
          outlivesOpener: false,
          overrideBrowserWindowOptions: {
            parent: this.options.window,
            modal: false,
            show: false,
            width: transientPopup.width,
            height: transientPopup.height,
            minWidth: 320,
            minHeight: 240,
            autoHideMenuBar: true,
            title: 'Sign in',
            webPreferences: {
              session: this.browserSession,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webSecurity: true,
              spellcheck: true,
              devTools: false,
              autoplayPolicy: 'user-gesture-required',
            },
          },
        };
      }
      const { url } = details;
      if (isAllowedBrowserUrl(url)) {
        if (this.preferences.external_links === 'system' && /^https?:/i.test(url)) {
          void this.options.openExternalUrl(url);
        } else {
          this.openPageCreatedTab(tab, url);
        }
      } else {
        void this.options.openExternalUrl(url);
      }
      return { action: 'deny' };
    });
    contents.on('did-create-window', (popup, details) => {
      this.registerTransientPopup(tab, popup, details);
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('found-in-page', (_event, result) => {
      if (tab.view?.webContents !== contents) return;
      const generation = tab.findRequestGenerations.get(result.requestId)
        ?? tab.startingFindGeneration;
      if (generation === null || generation === undefined || generation !== tab.findGeneration) return;
      this.options.onFind(tab.id, {
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      });
      if (result.finalUpdate) tab.findRequestGenerations.delete(result.requestId);
    });
    contents.on('context-menu', (_event, params) => {
      if (tab.view?.webContents !== contents) return;
      const template: MenuItemConstructorOptions[] = [];
      const withCurrentPage = (action: () => void) => () => {
        if (tab.view?.webContents === contents && !contents.isDestroyed()) action();
      };
      const addSection = (items: MenuItemConstructorOptions[]) => {
        if (items.length === 0) return;
        if (template.length > 0) template.push({ type: 'separator' });
        template.push(...items);
      };

      if (params.misspelledWord && params.dictionarySuggestions.length > 0) {
        addSection(params.dictionarySuggestions.slice(0, 5).map(suggestion => ({
          label: suggestion,
          click: withCurrentPage(() => contents.replaceMisspelling(suggestion)),
        })));
      }
      if (params.isEditable) {
        addSection([
          { role: 'undo', enabled: params.editFlags.canUndo },
          { role: 'redo', enabled: params.editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll },
        ]);
      } else if (params.selectionText) {
        addSection([{ role: 'copy', enabled: params.editFlags.canCopy }]);
      }
      if (params.linkURL) {
        addSection([
          ...(isAllowedBrowserUrl(params.linkURL) ? [{
            label: 'Open Link in New Tab',
            click: withCurrentPage(() => this.openPageCreatedTab(tab, params.linkURL)),
          } satisfies MenuItemConstructorOptions] : []),
          {
            label: 'Copy Link',
            click: () => clipboard.writeText(params.linkURL),
          },
        ]);
      }
      addSection([
        { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: withCurrentPage(() => this.goBack(tab.id)) },
        { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: withCurrentPage(() => this.goForward(tab.id)) },
        { label: 'Reload', click: withCurrentPage(() => this.reload(tab.id)) },
      ]);
      addSection([{
        label: 'Inspect Element',
        click: withCurrentPage(() => contents.inspectElement(params.x, params.y)),
      }]);
      Menu.buildFromTemplate(template).popup({ window: this.options.window });
    });
    // The native view swallows renderer keymaps while focused, so page zoom
    // shortcuts must be intercepted per WebContents.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      if (input.alt && !input.meta && !input.control && key === 'arrowleft') {
        event.preventDefault();
        this.goBack(tab.id);
        return;
      }
      if (input.alt && !input.meta && !input.control && key === 'arrowright') {
        event.preventDefault();
        this.goForward(tab.id);
        return;
      }
      if ((input.meta || input.control) && !input.alt && key === 'f') {
        event.preventDefault();
        this.options.onFindRequested(tab.id);
        return;
      }
      if (((input.meta && input.alt) || (input.control && input.shift)) && key === 'i') {
        event.preventDefault();
        this.openDevTools(tab.id);
        return;
      }
      if (input.alt || (!input.meta && !input.control)) return;
      if (key === 'l') {
        event.preventDefault();
        this.options.onAddressRequested(tab.id);
      } else if (key === 't') {
        event.preventDefault();
        const sourceSessionId = this.domain.getTab(tab.id)?.sourceSessionId ?? null;
        this.createTab({ sourceSessionId, activate: true });
      } else if (key === 'w') {
        event.preventDefault();
        setImmediate(() => this.closeTab(tab.id));
      } else if (key === 'r') {
        event.preventDefault();
        if (input.shift) {
          this.cancelInspect(tab);
          tab.navigationCommand += 1;
          tab.lastError = undefined;
          contents.reloadIgnoringCache();
          this.emitState(tab);
        } else {
          this.reload(tab.id);
        }
      } else if (key === '[') {
        event.preventDefault();
        this.goBack(tab.id);
      } else if (key === ']') {
        event.preventDefault();
        this.goForward(tab.id);
      } else if (key === '=' || key === '+') {
        event.preventDefault();
        this.setZoom(tab.id, stepBrowserZoomFactor(tab.zoomFactor, 1));
      } else if (key === '-' || key === '_') {
        event.preventDefault();
        this.setZoom(tab.id, stepBrowserZoomFactor(tab.zoomFactor, -1));
      } else if (key === '0') {
        event.preventDefault();
        this.setZoom(tab.id, DEFAULT_BROWSER_ZOOM_FACTOR);
      }
    });
    contents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame || tab.view?.webContents !== contents) return;
      this.cancelInspect(tab);
      this.cancelPermissionsForContents(contents);
      tab.findGeneration += 1;
      tab.startingFindGeneration = null;
      tab.findRequestGenerations.clear();
      tab.pendingUrl = null;
      if (url && url !== 'about:blank') tab.lastKnownUrl = url;
      this.domain.beginNavigation(tab.id);
      this.emitState(tab);
    });
    contents.on('did-start-loading', () => {
      if (tab.view?.webContents !== contents) return;
      this.cancelInspect(tab);
      this.domain.markLoading(tab.id);
      tab.lastError = undefined;
      this.emitState(tab);
    });
    contents.on('did-stop-loading', () => {
      if (tab.view?.webContents !== contents) return;
      const url = contents.getURL();
      this.domain.finishLoading(tab.id, !!url && url !== 'about:blank');
      this.emitState(tab);
    });
    contents.on('did-navigate', () => {
      if (tab.view?.webContents === contents) this.emitState(tab);
    });
    contents.on('did-navigate-in-page', () => {
      if (tab.view?.webContents !== contents) return;
      this.cancelInspect(tab);
      this.emitState(tab);
    });
    contents.on('page-title-updated', () => {
      if (tab.view?.webContents === contents) this.emitState(tab);
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (tab.view?.webContents !== contents) return;
      if (isMainFrame && errorCode !== -3) {
        tab.lastError = errorDescription;
        this.domain.markError(tab.id);
      }
      this.emitState(tab);
    });
    contents.on('render-process-gone', (_event, details) => {
      if (tab.view?.webContents !== contents) return;
      this.cancelInspect(tab);
      this.domain.markCrashed(tab.id);
      tab.lastError = `Browser renderer stopped: ${details.reason}`;
      this.emitState(tab);
    });
    contents.on('unresponsive', () => {
      if (tab.view?.webContents !== contents) return;
      tab.lastError = 'Browser page is not responding';
      this.emitState(tab);
    });
    contents.on('responsive', () => {
      if (tab.view?.webContents !== contents || tab.lastError !== 'Browser page is not responding') return;
      tab.lastError = undefined;
      this.emitState(tab);
    });
    contents.debugger.on('message', (_event, method, params, sessionId) => {
      if (method === 'Overlay.inspectNodeRequested') {
        const backendNodeId = readBackendNodeId(params);
        if (backendNodeId === null) return;
        if (sessionId) {
          tab.lastError = 'Elements inside cross-origin frames cannot be captured';
          this.cancelInspect(tab);
          return;
        }
        void this.captureInspectedNode(tab, contents, backendNodeId);
      } else if (method === 'Overlay.inspectModeCanceled') {
        this.cancelInspect(tab);
      }
    });
    contents.debugger.on('detach', () => {
      if (!tab.debuggerOwned && !tab.inspecting) return;
      tab.debuggerOwned = false;
      tab.inspecting = false;
      tab.inspectGeneration += 1;
      this.emitState(tab);
    });
  }

  private destroyView(tab: BrowserTab): void {
    this.cancelInspect(tab);
    this.closeTransientPopupsForTab(tab.id);
    tab.findGeneration += 1;
    tab.startingFindGeneration = null;
    tab.findRequestGenerations.clear();
    const view = tab.view;
    tab.view = null;
    if (!view) return;
    this.cancelPermissionsForContents(view.webContents);
    this.permissionOnce.delete(view.webContents);
    this.domain.replacePage(tab.id);
    if (tab.attached && !this.options.window.isDestroyed()) {
      this.options.window.contentView.removeChildView(view);
    }
    tab.attached = false;
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  private async stopCurrentLoad(contents: WebContents): Promise<void> {
    if (!contents.isLoading()) return;
    await new Promise<void>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        contents.removeListener('did-stop-loading', finish);
        contents.removeListener('destroyed', finish);
        resolve();
      };
      contents.once('did-stop-loading', finish);
      contents.once('destroyed', finish);
      timer = setTimeout(finish, 1_000);
      contents.stop();
      if (!contents.isLoading()) queueMicrotask(finish);
    });
  }

  private applyVisibility(tab: BrowserTab): void {
    const windowVisible = !this.options.window.isDestroyed()
      && this.options.window.isVisible()
      && !this.options.window.isMinimized();
    const visible = tab.requestedVisible
      && !!tab.view
      && windowVisible
      && tab.bounds.width > 0
      && tab.bounds.height > 0;
    this.domain.setVisibility(tab.id, tab.requestedVisible, visible);
    if (!tab.view) return;

    if (visible) {
      if (!tab.attached) {
        this.options.window.contentView.addChildView(tab.view);
        tab.attached = true;
      }
      tab.view.setBounds(tab.bounds);
      tab.view.setVisible(true);
      return;
    }

    this.cancelInspect(tab);
    // setVisible(false) alone has proved insufficient on macOS during rapid
    // Sheet/Tab transitions: a stale native surface can keep painting and
    // intercepting input above the new renderer UI. Detaching preserves the
    // WebContents/session/history while making overlay impossible.
    tab.view.setVisible(false);
    if (tab.attached && !this.options.window.isDestroyed()) {
      this.options.window.contentView.removeChildView(tab.view);
      tab.attached = false;
    }
  }

  private applyAllVisibility(): void {
    for (const tab of this.tabs.values()) this.applyVisibility(tab);
  }

  private emitState(tab: BrowserTab): void {
    if (this.tabs.get(tab.id) !== tab) return;
    const state = this.getState(tab.id);
    if (state.url) tab.lastKnownUrl = state.url;
    if (state.title) tab.lastKnownTitle = state.title;
    this.options.onState(tab.id, state);
    this.emitTabs();
    this.persistSoon();
  }

  private emitTabs(): void {
    this.tabsRevision += 1;
    this.options.onTabsChanged(this.listTabs());
  }

  private openPageCreatedTab(source: BrowserTab, url: string): void {
    const sourceSessionId = this.domain.getTab(source.id)?.sourceSessionId ?? null;
    const created = this.createTab({ sourceSessionId, activate: true });
    void this.navigate(created.id, url);
  }

  private persistSoon(): void {
    if (this.destroyed || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 100);
  }

  private persistNow(): void {
    try {
      this.options.stateStore.save({
        version: 1,
        preferences: this.preferences,
        permissions: [...this.permissionGrants].map(([origin, kinds]) => ({
          origin,
          kinds: [...kinds],
        })),
        tabs: this.domain.listTabs().flatMap(metadata => {
          const tab = this.tabs.get(metadata.id);
          if (!tab) return [];
          const state = this.getState(tab.id);
          return [{
            id: tab.id,
            sourceSessionId: metadata.sourceSessionId,
            url: state.url,
            title: state.title,
            zoomFactor: tab.zoomFactor,
          }];
        }),
      });
    } catch (error) {
      console.warn('[browser] failed to persist Browser state', error);
    }
  }

  private tabSnapshot(tabId: string): GianBrowserTabSnapshot {
    const metadata = this.domain.getTab(tabId);
    if (!metadata) throw new Error(`Unknown Browser tab: ${tabId}`);
    return { ...metadata, state: this.getState(tabId) };
  }

  async setInspectMode(tabId: string, enabled: boolean): Promise<GianBrowserState> {
    const tab = this.ensureTab(tabId);
    if (!enabled) {
      this.cancelInspect(tab);
      return this.getState(tabId);
    }
    const contents = this.ensureView(tab).webContents;
    if (!contents.getURL() || contents.getURL() === 'about:blank') {
      tab.lastError = 'Open a page before selecting an element';
      this.emitState(tab);
      return this.getState(tabId);
    }
    for (const sibling of this.tabs.values()) {
      if (sibling !== tab) this.cancelInspect(sibling);
    }
    if (contents.debugger.isAttached() && !tab.debuggerOwned) {
      tab.lastError = 'Browser inspection is already in use';
      this.emitState(tab);
      return this.getState(tabId);
    }
    const generation = ++tab.inspectGeneration;
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach();
      tab.debuggerOwned = true;
      await contents.debugger.sendCommand('DOM.enable', { includeWhitespace: 'none' });
      await contents.debugger.sendCommand('Overlay.enable');
      if (generation !== tab.inspectGeneration || contents.isDestroyed()) {
        this.cancelInspect(tab);
        return this.getState(tabId);
      }
      await contents.debugger.sendCommand('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: {
          showInfo: true,
          showStyles: false,
          showAccessibilityInfo: true,
          contentColor: { r: 91, g: 155, b: 255, a: 0.22 },
          paddingColor: { r: 122, g: 214, b: 170, a: 0.18 },
          borderColor: { r: 255, g: 196, b: 92, a: 0.7 },
          marginColor: { r: 244, g: 126, b: 126, a: 0.14 },
        },
      });
      if (generation !== tab.inspectGeneration || contents.isDestroyed()) {
        this.cancelInspect(tab);
        return this.getState(tabId);
      }
      tab.lastError = undefined;
      tab.inspecting = true;
      this.emitState(tab);
    } catch (error) {
      if (generation === tab.inspectGeneration) {
        tab.lastError = error instanceof Error ? error.message : String(error);
        this.cancelInspect(tab);
      }
    }
    return this.getState(tabId);
  }

  private cancelInspect(tab: BrowserTab): void {
    if (!tab.inspecting && !tab.debuggerOwned) return;
    tab.inspectGeneration += 1;
    tab.inspecting = false;
    const contents = tab.view?.webContents;
    if (contents && !contents.isDestroyed() && contents.debugger.isAttached() && tab.debuggerOwned) {
      void contents.debugger.sendCommand('Overlay.setInspectMode', { mode: 'none' }).catch(() => {});
      try {
        contents.debugger.detach();
      } catch {
        // The renderer may have disappeared between isAttached and detach.
      }
    }
    tab.debuggerOwned = false;
    this.emitState(tab);
  }

  private async captureInspectedNode(
    tab: BrowserTab,
    contents: WebContents,
    backendNodeId: number,
  ): Promise<void> {
    if (!tab.inspecting || !tab.debuggerOwned || !contents.debugger.isAttached()) return;
    const generation = tab.inspectGeneration;
    tab.inspecting = false;
    this.emitState(tab);
    try {
      const described = await contents.debugger.sendCommand('DOM.describeNode', {
        backendNodeId,
        depth: 0,
        pierce: false,
      }) as { node?: CdpDomNode };
      const accessibility = await contents.debugger.sendCommand('Accessibility.getPartialAXTree', {
        backendNodeId,
        fetchRelatives: false,
      }) as { nodes?: CdpAxNode[] };
      if (generation !== tab.inspectGeneration || contents.isDestroyed()) return;
      const capture = described.node
        ? captureFromCdpNode({
            pageUrl: contents.getURL(),
            pageTitle: contents.getTitle(),
            node: described.node,
            axNodes: accessibility.nodes,
          })
        : null;
      this.cancelInspect(tab);
      if (capture) this.options.onElement(tab.id, capture);
      else {
        tab.lastError = 'The selected element could not be captured safely';
        this.emitState(tab);
      }
    } catch (error) {
      if (generation !== tab.inspectGeneration) return;
      tab.lastError = error instanceof Error ? error.message : String(error);
      this.cancelInspect(tab);
    }
  }

  private managedTabId(contents: WebContents): string | null {
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents === contents) return tab.id;
    }
    return this.transientPopups.get(contents)?.tabId ?? null;
  }

  private reserveTransientPopup(tabId: string): boolean {
    if (this.popupReservations.has(tabId)) return false;
    if ([...this.transientPopups.values()].some(popup => popup.tabId === tabId)) return false;
    if (this.popupReservations.size + this.transientPopups.size >= 3) return false;
    const timer = setTimeout(() => this.popupReservations.delete(tabId), 5_000);
    this.popupReservations.set(tabId, timer);
    return true;
  }

  private registerTransientPopup(
    source: BrowserTab,
    popup: BrowserWindow,
    details: Electron.DidCreateWindowDetails,
  ): void {
    const reservation = this.popupReservations.get(source.id);
    if (reservation) clearTimeout(reservation);
    this.popupReservations.delete(source.id);
    if (this.destroyed
      || !this.tabs.has(source.id)
      || !browserPermissionOrigin(details.url)
      || this.transientPopups.size >= 3) {
      popup.close();
      return;
    }
    const contents = popup.webContents;
    const record: BrowserTransientPopup = {
      id: `browser-popup-${randomUUID()}`,
      tabId: source.id,
      window: popup,
      timer: setTimeout(() => {
        if (!popup.isDestroyed()) popup.close();
      }, 10 * 60_000),
    };
    this.transientPopups.set(contents, record);
    popup.setMenuBarVisibility(false);
    const showPopup = () => {
      if (!popup.isDestroyed()) popup.show();
    };
    popup.once('ready-to-show', showPopup);
    contents.once('dom-ready', showPopup);
    const guardNavigation = (event: Event, url: string) => {
      if (/^https?:/i.test(url)) return;
      event.preventDefault();
      void this.options.openExternalUrl(url);
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void contents.loadURL(url);
      else void this.options.openExternalUrl(url);
      return { action: 'deny' };
    });
    contents.on('render-process-gone', () => {
      if (!popup.isDestroyed()) popup.close();
    });
    popup.once('closed', () => {
      clearTimeout(record.timer);
      this.cancelPermissionsForContents(contents);
      this.permissionOnce.delete(contents);
      this.transientPopups.delete(contents);
    });
  }

  private closeTransientPopupsForTab(tabId: string): void {
    const reservation = this.popupReservations.get(tabId);
    if (reservation) clearTimeout(reservation);
    this.popupReservations.delete(tabId);
    for (const popup of this.transientPopups.values()) {
      if (popup.tabId === tabId && !popup.window.isDestroyed()) popup.window.close();
    }
  }

  private hasPermission(
    contents: WebContents,
    origin: string,
    kinds: readonly GianBrowserPermissionKind[],
  ): boolean {
    const persistent = this.permissionGrants.get(origin);
    const once = this.permissionOnce.get(contents)?.get(origin);
    return kinds.every(kind => persistent?.has(kind) || once?.has(kind));
  }

  private settlePermission(requestId: string, granted: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);
    try {
      pending.callback(granted);
    } finally {
      this.emitPermissions();
    }
  }

  private cancelPermissionsForContents(contents: WebContents): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.contents === contents) this.settlePermission(id, false);
    }
  }

  private emitDownloads(): void {
    if (this.destroyed) return;
    this.downloadsRevision += 1;
    this.options.onDownloadsChanged(this.listDownloads());
  }

  private emitPermissions(): void {
    if (this.destroyed) return;
    this.permissionsRevision += 1;
    this.options.onPermissionsChanged(this.listPermissionRequests());
  }

  private emitExtensions(): void {
    if (this.destroyed) return;
    this.extensionsRevision += 1;
    this.options.onExtensionsChanged(this.listExtensions());
  }

  private extensionRecord(
    manifest: BrowserExtensionManifest,
    enabled: boolean,
    error?: string,
  ): BrowserExtensionRecord {
    return {
      manifest,
      generation: 0,
      snapshot: {
        key: manifest.key,
        extensionId: null,
        sourceName: manifest.sourceName,
        name: manifest.name,
        version: manifest.version,
        manifestVersion: manifest.manifestVersion,
        enabled,
        status: error ? 'error' : enabled ? 'loading' : 'disabled',
        permissions: [...manifest.permissions],
        warnings: [...manifest.warnings],
        ...(error ? { error } : {}),
      },
    };
  }

  private async restoreExtensions(): Promise<void> {
    const stored = await this.options.extensionStore.load();
    for (const install of stored.extensions) {
      try {
        const manifest = await inspectBrowserExtension(install.path);
        this.extensions.set(manifest.key, this.extensionRecord(manifest, install.enabled));
      } catch (error) {
        const key = browserExtensionKey(install.path);
        const message = error instanceof Error ? error.message : String(error);
        this.extensions.set(key, this.extensionRecord({
          path: install.path,
          key,
          sourceName: basename(install.path).slice(0, 512) || 'extension',
          name: basename(install.path).slice(0, 512) || 'Extension',
          version: '',
          manifestVersion: 3,
          permissions: [],
          warnings: [],
        }, install.enabled, message.slice(0, 512)));
      }
    }
    this.emitExtensions();
    await Promise.all([...this.extensions.values()]
      .filter(record => record.snapshot.enabled && record.snapshot.status !== 'error')
      .map(record => this.loadExtension(record)));
  }

  private async loadExtension(record: BrowserExtensionRecord): Promise<void> {
    const generation = record.generation;
    try {
      const loaded = await this.browserSession.extensions.loadExtension(
        record.manifest.path,
        { allowFileAccess: false },
      );
      if (this.extensions.get(record.manifest.key) !== record
        || record.generation !== generation
        || !record.snapshot.enabled) {
        this.browserSession.extensions.removeExtension(loaded.id);
        return;
      }
      record.snapshot = {
        ...record.snapshot,
        extensionId: loaded.id,
        name: loaded.name.slice(0, 512),
        version: loaded.version.slice(0, 512),
        status: 'ready',
        error: undefined,
      };
    } catch (error) {
      if (this.extensions.get(record.manifest.key) !== record || record.generation !== generation) return;
      record.snapshot = {
        ...record.snapshot,
        extensionId: null,
        status: 'error',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 512),
      };
    }
    this.emitExtensions();
  }

  private async persistExtensions(): Promise<void> {
    try {
      await this.options.extensionStore.save({
        version: 1,
        extensions: [...this.extensions.values()].map(record => ({
          path: record.manifest.path,
          enabled: record.snapshot.enabled,
        })),
      });
    } catch (error) {
      console.warn('[browser] failed to persist Browser extensions', error);
    }
  }

  private trimDownloads(): void {
    if (this.downloads.size <= 50) return;
    for (const [id, record] of this.downloads) {
      if (record.item) continue;
      this.downloads.delete(id);
      if (this.downloads.size <= 50) return;
    }
  }

  private removeSitesForTab(tabId: string): void {
    for (const [siteId, registration] of this.sites) {
      if (registration.tabId === tabId) this.sites.delete(siteId);
    }
  }

  private canOpenCurrentExternally(url: string): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:'
        || parsed.protocol === 'https:'
        || (parsed.protocol === `${GIAN_BROWSER_SCHEME}:` && this.sites.has(parsed.hostname));
    } catch {
      return false;
    }
  }

  private hostFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.options.hostUrl);
    const headers = new Headers(init.headers);
    if (this.options.desktopToken) headers.set(DESKTOP_TOKEN_HEADER, this.options.desktopToken);
    return net.fetch(url.toString(), { ...init, headers });
  }
}

function previewSiteFromTarget(target: GianBrowserProjectTarget): BrowserPreviewSite | null {
  if ('absolutePath' in target) {
    if (!target.absolutePath || target.absolutePath.length > 16_384) return null;
    return createBrowserAbsoluteSite(target.absolutePath);
  }
  if (!target.workingTreeId || target.workingTreeId.length > 512 || target.path.length > 16_384) {
    return null;
  }
  return createBrowserProjectSite(target.workingTreeId, target.path);
}

function projectRawPath(site: BrowserPreviewSite, pathname: string): string | null {
  if (isAbsoluteBrowserSite(site)) {
    const abs = resolveAbsoluteBrowserPath(site.absoluteRoot, pathname);
    if (!abs) return null;
    return `/api/files/raw?path=${encodeURIComponent(abs)}`;
  }
  const path = resolveBrowserProjectPath(site.root, pathname);
  if (!path) return null;
  return `/api/working_trees/${encodeURIComponent(site.workingTreeId)}/raw?path=${encodeURIComponent(path)}`;
}

function projectOpenRequest(
  site: BrowserPreviewSite,
  pathname: string,
): { url: string; body: { path: string; builtin: 'default' } } | null {
  if (isAbsoluteBrowserSite(site)) {
    const abs = resolveAbsoluteBrowserPath(site.absoluteRoot, pathname);
    if (!abs) return null;
    return { url: '/api/files/open', body: { path: abs, builtin: 'default' } };
  }
  const path = resolveBrowserProjectPath(site.root, pathname);
  if (!path) return null;
  return {
    url: `/api/working_trees/${encodeURIComponent(site.workingTreeId)}/open`,
    body: { path, builtin: 'default' },
  };
}

function emptyBrowserState(): GianBrowserState {
  return {
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    canOpenExternal: false,
    inspecting: false,
    zoomFactor: DEFAULT_BROWSER_ZOOM_FACTOR,
  };
}

function readBackendNodeId(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as { backendNodeId?: unknown }).backendNodeId;
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0
    ? candidate
    : null;
}

function isAllowedBrowserUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:'
      || url.protocol === 'https:'
      || url.protocol === `${GIAN_BROWSER_SCHEME}:`;
  } catch {
    return false;
  }
}

function normalizeBrowserHomePage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i.test(trimmed)) {
    candidate = `http://${trimmed}`;
  } else if (/^\[::1\](?::\d+)?(?:[/?#]|$)/i.test(trimmed)) {
    candidate = `http://${trimmed}`;
  } else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    candidate = `https://${trimmed}`;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function validBounds(bounds: GianBrowserBounds, window: BrowserWindow): boolean {
  if (
    !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.x < 0
    || bounds.y < 0
    || bounds.width < 0
    || bounds.height < 0
  ) return false;
  const content = window.getContentBounds();
  return bounds.x <= content.width
    && bounds.y <= content.height
    && bounds.x + bounds.width <= content.width + 2
    && bounds.y + bounds.height <= content.height + 2;
}
