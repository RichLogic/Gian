import {
  WebContentsView,
  net,
  protocol,
  session,
  type BrowserWindow,
  type Event,
  type Session,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import type {
  GianBrowserBounds,
  GianBrowserProjectTarget,
  GianBrowserState,
} from '@gian/shared';
import {
  BROWSER_PROJECT_CSP,
  browserProjectUrl,
  createBrowserProjectSite,
  resolveBrowserProjectPath,
  type BrowserProjectSite,
} from './browser-project.js';
import { DESKTOP_TOKEN_HEADER } from './managed-host.js';

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
  openExternalUrl: (url: string) => Promise<void>;
  onState: (tabId: string, state: GianBrowserState) => void;
}

interface BrowserTab {
  id: string;
  view: WebContentsView | null;
  requestedVisible: boolean;
  bounds: GianBrowserBounds;
  lastError?: string;
  navigationCommand: number;
}

interface BrowserProjectRegistration {
  tabId: string;
  site: BrowserProjectSite;
}

export class BrowserController {
  private readonly browserSession: Session;
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly sites = new Map<string, BrowserProjectRegistration>();
  private destroyed = false;

  private readonly onWindowVisibility = () => this.applyAllVisibility();
  private readonly onDownload = (
    event: Event,
    item: Electron.DownloadItem,
    contents: WebContents,
  ) => {
    if (!this.isManagedContents(contents)) return;
    event.preventDefault();
    item.cancel();
  };

  constructor(private readonly options: BrowserControllerOptions) {
    this.browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true });
    this.installSessionBoundary();
    this.installProjectProtocol();
    options.window.on('show', this.onWindowVisibility);
    options.window.on('hide', this.onWindowVisibility);
    options.window.on('minimize', this.onWindowVisibility);
    options.window.on('restore', this.onWindowVisibility);
  }

  getState(tabId: string): GianBrowserState {
    const tab = this.tabs.get(tabId);
    if (!tab) return emptyBrowserState();
    const contents = tab.view?.webContents;
    const url = contents && !contents.isDestroyed() ? contents.getURL() : '';
    return {
      url: url === 'about:blank' ? '' : url,
      title: contents && !contents.isDestroyed() ? contents.getTitle() : '',
      loading: !!contents && !contents.isDestroyed() && contents.isLoading(),
      canGoBack: !!contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !!contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      canOpenExternal: this.canOpenCurrentExternally(url),
      ...(tab.lastError ? { error: tab.lastError } : {}),
    };
  }

  async navigate(tabId: string, candidate: string): Promise<GianBrowserState> {
    const tab = this.ensureTab(tabId);
    if (!isAllowedBrowserUrl(candidate)) {
      tab.lastError = 'Unsupported or invalid URL';
      this.emitState(tab);
      return this.getState(tabId);
    }
    const command = ++tab.navigationCommand;
    const contents = this.ensureView(tab).webContents;
    await this.stopCurrentLoad(contents);
    if (command !== tab.navigationCommand || contents.isDestroyed()) return this.getState(tabId);
    tab.lastError = undefined;
    await contents.loadURL(candidate).catch(error => {
      if (command === tab.navigationCommand) {
        tab.lastError = error instanceof Error ? error.message : String(error);
      }
    });
    if (command === tab.navigationCommand) this.emitState(tab);
    return this.getState(tabId);
  }

  async openProject(tabId: string, target: GianBrowserProjectTarget): Promise<GianBrowserState> {
    const tab = this.ensureTab(tabId);
    if (!target.workingTreeId || target.workingTreeId.length > 512 || target.path.length > 16_384) {
      tab.lastError = 'Invalid project path';
      this.emitState(tab);
      return this.getState(tabId);
    }
    const site = createBrowserProjectSite(target.workingTreeId, target.path);
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
    tab.navigationCommand += 1;
    const contents = this.ensureView(tab).webContents;
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    tab.lastError = undefined;
    this.emitState(tab);
    return this.getState(tabId);
  }

  goForward(tabId: string): GianBrowserState {
    const tab = this.ensureTab(tabId);
    tab.navigationCommand += 1;
    const contents = this.ensureView(tab).webContents;
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    tab.lastError = undefined;
    this.emitState(tab);
    return this.getState(tabId);
  }

  reload(tabId: string): GianBrowserState {
    const tab = this.ensureTab(tabId);
    tab.navigationCommand += 1;
    const contents = this.ensureView(tab).webContents;
    tab.lastError = undefined;
    contents.reload();
    this.emitState(tab);
    return this.getState(tabId);
  }

  stop(tabId: string): GianBrowserState {
    const tab = this.tabs.get(tabId);
    if (!tab) return emptyBrowserState();
    tab.navigationCommand += 1;
    const contents = tab.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.stop();
    this.emitState(tab);
    return this.getState(tabId);
  }

  setLayout(tabId: string, bounds: GianBrowserBounds, visible: boolean): boolean {
    const tab = this.ensureTab(tabId);
    if (!validBounds(bounds, this.options.window)) {
      // Never leave a previously valid native view painted over a new,
      // transiently invalid DOM layout (panel animation/resize/window edge).
      tab.requestedVisible = false;
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
    if (visible) this.ensureView(tab);
    if (tab.view) tab.view.setBounds(tab.bounds);
    this.applyVisibility(tab);
    return true;
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
    const path = resolveBrowserProjectPath(registration.site.root, parsed.pathname);
    if (!path) return false;
    const response = await this.hostFetch(
      `/api/working_trees/${encodeURIComponent(registration.site.workingTreeId)}/open`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, builtin: 'default' }),
      },
    );
    return response.ok;
  }

  closeTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return true;
    tab.navigationCommand += 1;
    tab.requestedVisible = false;
    this.destroyView(tab);
    this.tabs.delete(tabId);
    this.removeSitesForTab(tabId);
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
    await Promise.all([
      this.browserSession.clearStorageData(),
      this.browserSession.clearCache(),
      this.browserSession.clearAuthCache(),
    ]);
    for (const tab of this.tabs.values()) {
      tab.lastError = undefined;
      if (tab.requestedVisible && tab.bounds.width > 0 && tab.bounds.height > 0) {
        this.ensureView(tab);
      }
      this.emitState(tab);
    }
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.options.window.off('show', this.onWindowVisibility);
    this.options.window.off('hide', this.onWindowVisibility);
    this.options.window.off('minimize', this.onWindowVisibility);
    this.options.window.off('restore', this.onWindowVisibility);
    this.browserSession.removeListener('will-download', this.onDownload);
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
  }

  private installSessionBoundary(): void {
    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
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
      const path = resolveBrowserProjectPath(registration.site.root, url.pathname);
      if (!path) return new Response('Invalid preview path', { status: 400 });

      const upstream = await this.hostFetch(
        `/api/working_trees/${encodeURIComponent(registration.site.workingTreeId)}/raw?path=${encodeURIComponent(path)}`,
        { method: request.method },
      );
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

  private ensureTab(tabId: string): BrowserTab {
    if (this.destroyed) throw new Error('Browser controller destroyed');
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    const tab: BrowserTab = {
      id: tabId,
      view: null,
      requestedVisible: false,
      bounds: { ...EMPTY_BOUNDS },
      navigationCommand: 0,
    };
    this.tabs.set(tabId, tab);
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
        devTools: false,
        autoplayPolicy: 'user-gesture-required',
      },
    });
    tab.view = view;
    view.setBounds(tab.bounds);
    this.options.window.contentView.addChildView(view);
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
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) void this.navigate(tab.id, url);
      else void this.options.openExternalUrl(url);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('devtools-opened', () => contents.closeDevTools());
    contents.on('did-start-loading', () => {
      tab.lastError = undefined;
      this.emitState(tab);
    });
    contents.on('did-stop-loading', () => this.emitState(tab));
    contents.on('did-navigate', () => this.emitState(tab));
    contents.on('did-navigate-in-page', () => this.emitState(tab));
    contents.on('page-title-updated', () => this.emitState(tab));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) tab.lastError = errorDescription;
      this.emitState(tab);
    });
    contents.on('render-process-gone', (_event, details) => {
      tab.lastError = `Browser renderer stopped: ${details.reason}`;
      this.emitState(tab);
    });
  }

  private destroyView(tab: BrowserTab): void {
    const view = tab.view;
    tab.view = null;
    if (!view) return;
    if (!this.options.window.isDestroyed()) {
      this.options.window.contentView.removeChildView(view);
    }
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
    if (!tab.view) return;
    const windowVisible = !this.options.window.isDestroyed()
      && this.options.window.isVisible()
      && !this.options.window.isMinimized();
    tab.view.setVisible(
      tab.requestedVisible
      && windowVisible
      && tab.bounds.width > 0
      && tab.bounds.height > 0,
    );
  }

  private applyAllVisibility(): void {
    for (const tab of this.tabs.values()) this.applyVisibility(tab);
  }

  private emitState(tab: BrowserTab): void {
    if (this.tabs.get(tab.id) !== tab) return;
    this.options.onState(tab.id, this.getState(tab.id));
  }

  private isManagedContents(contents: WebContents): boolean {
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents === contents) return true;
    }
    return false;
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

function emptyBrowserState(): GianBrowserState {
  return {
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    canOpenExternal: false,
  };
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
