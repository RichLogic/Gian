import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  safeStorage,
  session,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import type { GianBrowserBounds, GianBrowserProjectTarget, GianBrowserState } from '@gian/shared';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  desktopRequestBoundaryUrls,
  isSafeExternalUrl,
  isTrustedDesktopUrl,
  resolveDesktopApplicationIdentity,
  resolveDesktopDisplayName,
  resolveDesktopTargets,
  resolveDesktopWindowChrome,
} from './config.js';
import { ensureHostAvailable } from './host-service.js';
import {
  FileGitHubCredentialStore,
  GitHubAuthService,
  resolveGitHubOAuthClientId,
} from './github-auth.js';
import {
  DESKTOP_TOKEN_HEADER,
  resolveManagedHostPaths,
  resolveUnpackedAppPath,
  startManagedHost,
} from './managed-host.js';
import { BrowserController, registerBrowserScheme } from './browser-controller.js';
import {
  DEFAULT_ZOOM_PERCENT,
  normalizeZoomPercent,
  stepZoomPercent,
} from './zoom.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const preloadPath = join(currentDir, 'preload.cjs');
const titlebarCss = readFileSync(
  join(app.getAppPath(), 'renderer', 'titlebar.css'),
  'utf8',
);

const applicationIdentity = resolveDesktopApplicationIdentity(
  app.isPackaged,
  app.getPath('appData'),
  process.env,
);
const applicationName = applicationIdentity.name;
const displayName = resolveDesktopDisplayName(applicationIdentity, process.env);

registerBrowserScheme();
app.setName(applicationName);
if (applicationIdentity.userDataPath) {
  // Keep the dev shell's Chromium profile and single-instance lock isolated
  // from the installed production app so both can run at the same time.
  app.setPath('userData', applicationIdentity.userDataPath);
}

const targets = resolveDesktopTargets({
  isPackaged: app.isPackaged,
  platform: process.platform,
});
// Packaged smoke has to follow a real app.relaunch() into a process that is no
// longer attached to Playwright. A harness-scoped stable token lets that test
// query the replacement Host directly. Production keeps a fresh random token;
// the override is accepted only alongside the existing packaged-smoke flag.
const smokeDesktopToken = process.env['GIAN_DESKTOP_SMOKE_MANAGE_HOST'] === '1'
  ? process.env['GIAN_DESKTOP_SMOKE_TOKEN']?.trim()
  : undefined;
const desktopToken = app.isPackaged
  ? smokeDesktopToken || randomBytes(32).toString('base64url')
  : null;
const desktopInstanceId = app.isPackaged ? randomUUID() : null;

let mainWindow: BrowserWindow | null = null;
let browserController: BrowserController | null = null;
let managedHost: ChildProcess | null = null;
let githubAuthService: GitHubAuthService | null = null;
let loadingSurface:
  | { window: BrowserWindow; promise: Promise<boolean> }
  | null = null;
let relaunchScheduled = false;

function dataDirectory(): string {
  return process.env['GIAN_DATA_DIR'] ?? join(homedir(), '.gian');
}

function logDirectory(): string {
  if (app.isPackaged) return join(dataDirectory(), 'logs');
  return join(
    process.env['GIAN_DATA_DIR'] ?? join(homedir(), '.gian-dev'),
    'logs',
  );
}

function getGitHubAuthService(): GitHubAuthService {
  if (githubAuthService) return githubAuthService;
  githubAuthService = new GitHubAuthService({
    clientId: resolveGitHubOAuthClientId({
      env: process.env,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    store: new FileGitHubCredentialStore({
      path: join(app.getPath('userData'), 'github-auth.json'),
      encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value),
    }),
    fetch: net.fetch,
  });
  return githubAuthService;
}

function isMainWindowSender(sender: WebContents): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents;
}

const ZOOM_CHANGED_CHANNEL = 'desktop:zoom-changed';

function currentMainWindowZoom(): number {
  if (!mainWindow || mainWindow.isDestroyed()) return DEFAULT_ZOOM_PERCENT;
  return normalizeZoomPercent(mainWindow.webContents.getZoomFactor() * 100);
}

function setMainWindowZoom(value: unknown): number {
  const percent = normalizeZoomPercent(value);
  if (!mainWindow || mainWindow.isDestroyed()) return percent;
  mainWindow.webContents.setZoomFactor(percent / 100);
  mainWindow.webContents.send(ZOOM_CHANGED_CHANNEL, percent);
  return percent;
}

function changeMainWindowZoom(direction: -1 | 1): number {
  return setMainWindowZoom(stepZoomPercent(currentMainWindowZoom(), direction));
}

function startProductionHost(): void {
  if (!app.isPackaged || !desktopToken || !desktopInstanceId) return;
  if (managedHost && managedHost.exitCode === null && !managedHost.killed) return;

  const paths = resolveManagedHostPaths({
    hostEntry: resolveUnpackedAppPath(require.resolve('@gian/host')),
    resourcesPath: process.resourcesPath,
    dataDir: dataDirectory(),
  });
  const child = startManagedHost({
    electronExecutable: join(process.resourcesPath, 'runtime', 'node'),
    paths,
    host: new URL(targets.hostUrl).hostname,
    port: Number(new URL(targets.hostUrl).port),
    desktopToken,
    instanceId: desktopInstanceId,
    env: {
      ...process.env,
      GIAN_RELEASE_VERSION: app.getVersion(),
      GIAN_RELEASE_REPOSITORY:
        process.env['GIAN_RELEASE_REPOSITORY'] ?? 'RichLogic/Gian',
    },
  });
  managedHost = child;
  child.once('error', error => {
    console.error('[desktop] managed host failed to start', error);
  });
  child.once('exit', (code, signal) => {
    if (managedHost === child) managedHost = null;
    if (code !== 0 && signal !== 'SIGTERM') {
      console.error(`[desktop] managed host exited (${code ?? signal ?? 'unknown'})`);
    }
  });
}

function installDesktopRequestBoundary(): void {
  if (!desktopToken) return;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: desktopRequestBoundaryUrls(targets.hostUrl) },
    (details, callback) => {
      details.requestHeaders[DESKTOP_TOKEN_HEADER] = desktopToken;
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}

function stopManagedHost(): void {
  const child = managedHost;
  managedHost = null;
  if (!child || child.exitCode !== null) return;
  child.stdin?.end();
  child.kill('SIGTERM');
}

async function openExternal(candidate: string): Promise<void> {
  if (isSafeExternalUrl(candidate)) await shell.openExternal(candidate);
}

// Match the web shell's theme backgrounds (styles/tokens.css): light is
// #f7f7f5, dark is oklch(0.140 0.004 265) ≈ #08090b (Air-matched ramp). A
// hardcoded light background made dark-theme users see a bright flash on
// launch and reload before the renderer applied body[data-theme].
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#08090b' : '#f7f7f5';
}

function hardenWebContents(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (isTrustedDesktopUrl(url, targets)) return;
    event.preventDefault();
    void openExternal(url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (isTrustedDesktopUrl(url, targets)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          backgroundColor: windowBackground(),
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
        },
      };
    }
    void openExternal(url);
    return { action: 'deny' };
  });
}

function installDesktopTitlebar(contents: WebContents): void {
  contents.on('dom-ready', () => {
    void contents.insertCSS(titlebarCss).catch(error => {
      console.error('[desktop] failed to install titlebar styles', error);
    });
  });
}

async function showUnavailable(
  window: BrowserWindow,
  reason: 'host' | 'web',
): Promise<void> {
  const path = join(app.getAppPath(), 'renderer', 'unavailable.html');
  await window.loadFile(path, {
    query: {
      host: targets.hostUrl,
      reason,
      web: targets.webUrl,
    },
  });
}

async function loadGianSurface(window: BrowserWindow): Promise<boolean> {
  if (loadingSurface?.window === window) return loadingSurface.promise;

  const promise = (async () => {
    const readiness = await ensureHostAvailable({
      healthUrl: targets.healthUrl,
      manageHost: targets.manageHost,
      startHost: startProductionHost,
      ...(desktopToken
        ? { requestHeaders: { [DESKTOP_TOKEN_HEADER]: desktopToken } }
        : {}),
      ...(desktopInstanceId ? { expectedInstanceId: desktopInstanceId } : {}),
      expectedVersion: app.getVersion(),
    });
    if (window.isDestroyed()) return false;

    if (!readiness.ready) {
      await showUnavailable(window, 'host');
      return false;
    }

    try {
      await window.loadURL(targets.webUrl);
      return true;
    } catch {
      await showUnavailable(window, 'web');
      return false;
    }
  })();
  loadingSurface = { window, promise };

  try {
    return await promise;
  } finally {
    if (loadingSurface?.promise === promise) loadingSurface = null;
  }
}

function buildApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: applicationName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Reconnect',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow) void loadGianSurface(mainWindow);
          },
        },
        {
          label: 'Open Logs',
          click: () => {
            void shell.openPath(logDirectory());
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => { setMainWindowZoom(DEFAULT_ZOOM_PERCENT); },
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => { changeMainWindowZoom(1); },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => { changeMainWindowZoom(-1); },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged
          ? ([
              { type: 'separator' },
              { role: 'toggleDevTools' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    ...resolveDesktopWindowChrome(process.platform),
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: displayName,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: preloadPath,
      additionalArguments: [`--gian-desktop-variant=${applicationIdentity.variant}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  window.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle(displayName);
  });
  mainWindow = window;
  const controller = new BrowserController({
    window,
    hostUrl: targets.hostUrl,
    desktopToken,
    openExternalUrl: openExternal,
    onState: (tabId, state) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('desktop:browser:state', tabId, state);
      }
    },
  });
  browserController = controller;

  hardenWebContents(window.webContents);
  installDesktopTitlebar(window.webContents);
  window.webContents.on('did-create-window', child => {
    hardenWebContents(child.webContents);
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    controller.destroy();
    if (browserController === controller) browserController = null;
    if (mainWindow === window) mainWindow = null;
  });

  await loadGianSurface(window);
  if (!window.isVisible()) window.show();
  return window;
}

ipcMain.handle('desktop:retry-connection', async event => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  return loadGianSurface(mainWindow);
});

ipcMain.handle('desktop:open-logs', async event => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return 'denied';
  return shell.openPath(logDirectory());
});

ipcMain.handle('desktop:restart-app', event => {
  if (!isMainWindowSender(event.sender)) return false;
  if (relaunchScheduled) return true;
  relaunchScheduled = true;

  // Reply to the renderer before quitting. `before-quit` stops the managed
  // Host in a packaged app, so its next runtime is cold. GianDev's Host is
  // externally owned; only its Electron shell relaunches for UI parity.
  setTimeout(() => {
    app.relaunch();
    app.quit();
  }, 100);
  return true;
});

ipcMain.handle('desktop:zoom:get', event => {
  if (!isMainWindowSender(event.sender)) return null;
  return currentMainWindowZoom();
});

ipcMain.handle('desktop:zoom:set', (event, percent: unknown) => {
  if (!isMainWindowSender(event.sender)) return null;
  return setMainWindowZoom(percent);
});

ipcMain.handle('desktop:set-dock-icon', (event, dataUrl: unknown) => {
  const dock = app.dock;
  if (
    process.platform !== 'darwin'
    || !dock
    || !mainWindow
    || event.sender !== mainWindow.webContents
    || typeof dataUrl !== 'string'
    || dataUrl.length > 4_000_000
    || !dataUrl.startsWith('data:image/png;base64,')
  ) {
    return false;
  }

  const icon = nativeImage.createFromDataURL(dataUrl);
  if (icon.isEmpty()) return false;
  dock.setIcon(icon);
  return true;
});

const EMPTY_BROWSER_STATE: GianBrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  canOpenExternal: false,
};

ipcMain.handle('desktop:browser:get-state', (event, tabId: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId)) return EMPTY_BROWSER_STATE;
  return browserController?.getState(tabId) ?? EMPTY_BROWSER_STATE;
});

ipcMain.handle('desktop:browser:navigate', async (event, tabId: unknown, url: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId) || typeof url !== 'string' || url.length > 16_384) {
    return EMPTY_BROWSER_STATE;
  }
  return browserController?.navigate(tabId, url) ?? EMPTY_BROWSER_STATE;
});

ipcMain.handle('desktop:browser:open-project', async (event, tabId: unknown, target: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId) || !isBrowserProjectTarget(target)) {
    return EMPTY_BROWSER_STATE;
  }
  return browserController?.openProject(tabId, target) ?? EMPTY_BROWSER_STATE;
});

ipcMain.handle('desktop:browser:back', (event, tabId: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId)) return EMPTY_BROWSER_STATE;
  return browserController?.goBack(tabId) ?? EMPTY_BROWSER_STATE;
});

ipcMain.handle('desktop:browser:forward', (event, tabId: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId)) return EMPTY_BROWSER_STATE;
  return browserController?.goForward(tabId) ?? EMPTY_BROWSER_STATE;
});

ipcMain.handle('desktop:browser:reload', (event, tabId: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId)) return EMPTY_BROWSER_STATE;
  return browserController?.reload(tabId) ?? EMPTY_BROWSER_STATE;
});

ipcMain.handle('desktop:browser:stop', (event, tabId: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId)) return EMPTY_BROWSER_STATE;
  return browserController?.stop(tabId) ?? EMPTY_BROWSER_STATE;
});

ipcMain.handle('desktop:browser:set-layout', (event, tabId: unknown, bounds: unknown, visible: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId) || !isBrowserBounds(bounds) || typeof visible !== 'boolean') {
    return false;
  }
  return browserController?.setLayout(tabId, bounds, visible) ?? false;
});

ipcMain.handle('desktop:browser:open-external', async (event, tabId: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId)) return false;
  return browserController?.openExternal(tabId) ?? false;
});

ipcMain.handle('desktop:browser:close-tab', (event, tabId: unknown) => {
  if (!isMainWindowSender(event.sender) || !isBrowserTabId(tabId)) return false;
  return browserController?.closeTab(tabId) ?? false;
});

ipcMain.handle('desktop:browser:clear-data', async event => {
  if (!isMainWindowSender(event.sender)) return false;
  return browserController?.clearData() ?? false;
});

ipcMain.handle('desktop:github-auth:get-state', async event => {
  if (!isMainWindowSender(event.sender)) {
    return { status: 'unavailable', reason: 'not_configured' };
  }
  return getGitHubAuthService().getState();
});

ipcMain.handle('desktop:github-auth:start', async event => {
  if (!isMainWindowSender(event.sender)) {
    return { ok: false, error: 'not_configured' };
  }
  const result = await getGitHubAuthService().start();
  if (result.ok) {
    await shell.openExternal(result.authorization.verificationUri);
  }
  return result;
});

ipcMain.handle('desktop:github-auth:finish', event => {
  if (!isMainWindowSender(event.sender)) {
    return { ok: false, error: 'not_started' };
  }
  return getGitHubAuthService().finish();
});

ipcMain.handle('desktop:github-auth:cancel', event => {
  if (isMainWindowSender(event.sender)) getGitHubAuthService().cancel();
});

ipcMain.handle('desktop:github-auth:sign-out', async event => {
  if (isMainWindowSender(event.sender)) await getGitHubAuthService().signOut();
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      void createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    installDesktopRequestBoundary();
    buildApplicationMenu();
    await createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
    });
  }).catch(error => {
    console.error('[desktop] failed to start', error);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  githubAuthService?.cancel();
  stopManagedHost();
});

function isBrowserBounds(value: unknown): value is GianBrowserBounds {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GianBrowserBounds>;
  return typeof candidate.x === 'number'
    && typeof candidate.y === 'number'
    && typeof candidate.width === 'number'
    && typeof candidate.height === 'number';
}

function isBrowserTabId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isBrowserProjectTarget(value: unknown): value is GianBrowserProjectTarget {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GianBrowserProjectTarget>;
  return typeof candidate.workingTreeId === 'string'
    && candidate.workingTreeId.length > 0
    && candidate.workingTreeId.length <= 512
    && typeof candidate.path === 'string'
    && candidate.path.length > 0
    && candidate.path.length <= 16_384;
}
