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
  GianBrowserElementCapture,
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
import {
  captureFromCdpNode,
  type CdpAxNode,
  type CdpDomNode,
} from './browser-element.js';

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
      inspecting: tab.inspecting,
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

  reload(tabId: string): GianBrowserState {
    const tab = this.ensureTab(tabId);
    this.cancelInspect(tab);
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
    this.cancelInspect(tab);
    tab.navigationCommand += 1;
    const contents = tab.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.stop();
    this.emitState(tab);
    return this.getState(tabId);
  }

  setLayout(tabId: string, bounds: GianBrowserBounds, visible: boolean): boolean {
    const tab = this.ensureTab(tabId);
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
      attached: false,
      requestedVisible: false,
      bounds: { ...EMPTY_BOUNDS },
      navigationCommand: 0,
      inspectGeneration: 0,
      inspecting: false,
      debuggerOwned: false,
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
      this.cancelInspect(tab);
      tab.lastError = undefined;
      this.emitState(tab);
    });
    contents.on('did-stop-loading', () => this.emitState(tab));
    contents.on('did-navigate', () => this.emitState(tab));
    contents.on('did-navigate-in-page', () => {
      this.cancelInspect(tab);
      this.emitState(tab);
    });
    contents.on('page-title-updated', () => this.emitState(tab));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) tab.lastError = errorDescription;
      this.emitState(tab);
    });
    contents.on('render-process-gone', (_event, details) => {
      this.cancelInspect(tab);
      tab.lastError = `Browser renderer stopped: ${details.reason}`;
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
    const view = tab.view;
    tab.view = null;
    if (!view) return;
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
    if (!tab.view) return;
    const windowVisible = !this.options.window.isDestroyed()
      && this.options.window.isVisible()
      && !this.options.window.isMinimized();
    const visible = tab.requestedVisible
      && windowVisible
      && tab.bounds.width > 0
      && tab.bounds.height > 0;

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
    this.options.onState(tab.id, this.getState(tab.id));
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
    inspecting: false,
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
