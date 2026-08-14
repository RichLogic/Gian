import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  net,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import type {
  GianBrowserBounds,
  GianBrowserProjectTarget,
  GianBrowserState,
  GianScreenshotCapture,
  GianScreenshotErrorCode,
  GianScreenshotTarget,
} from '@gian/shared';
import electronUpdater from 'electron-updater';
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
  GITHUB_RELEASE_BROKER_SOCKET_ENV,
  GitHubReleaseMetadataBroker,
  resolveGitHubReleaseBrokerSocketPath,
} from './github-request-broker.js';
import {
  DESKTOP_TOKEN_HEADER,
  resolveManagedHostPaths,
  resolveUnpackedAppPath,
  startManagedHost,
} from './managed-host.js';
import {
  ManagedHostDrainCoordinator,
  ManagedHostQuitGate,
  ManagedHostReplacementGate,
} from './managed-host-shutdown.js';
import { BrowserController, registerBrowserScheme } from './browser-controller.js';
import {
  AppUpdateController,
  type AppUpdateState,
} from './app-updater.js';
import {
  AttentionClient,
  type AttentionSocket,
} from './attention-client.js';
import {
  FileDesktopNotificationPreferenceStore,
  NativeNotificationService,
  type DesktopNotificationState,
  type DesktopNotificationTarget,
} from './native-notifications.js';
import {
  DEFAULT_ZOOM_PERCENT,
  normalizeZoomPercent,
  stepZoomPercent,
} from './zoom.js';
import {
  ScreenshotController,
  screenshotShortcutForPlatform,
  type ScreenPermissionStatus,
} from './screenshot/controller.js';

const { autoUpdater } = electronUpdater;
const currentDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const preloadPath = join(currentDir, 'preload.cjs');
const screenshotPreloadPath = join(currentDir, 'screenshot-preload.cjs');
const screenshotHtmlPath = join(app.getAppPath(), 'renderer', 'screenshot.html');
const titlebarCss = readFileSync(
  join(app.getAppPath(), 'renderer', 'titlebar.css'),
  'utf8',
);
const desktopPackageMetadata = JSON.parse(
  readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'),
) as { gianReleaseChannel?: unknown };
const signedProductionRelease = app.isPackaged
  && desktopPackageMetadata.gianReleaseChannel === 'stable';

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
let screenshotController: ScreenshotController | null = null;
let managedHost: ChildProcess | null = null;
let githubAuthService: GitHubAuthService | null = null;
let githubReleaseBroker: GitHubReleaseMetadataBroker | null = null;
let loadingSurface:
  | { window: BrowserWindow; promise: Promise<boolean> }
  | null = null;
let replacementOperation: Promise<boolean> | null = null;
let rendererReady = false;
let rendererDocumentReady = false;
let pendingNavigationTarget: DesktopNavigationTarget | null = null;
let notificationService: NativeNotificationService | null = null;
let attentionClient: AttentionClient | null = null;
let appUpdateController: AppUpdateController | null = null;
let updateReadyNotification: Notification | null = null;
let notifiedUpdateVersion: string | null = null;
let creatingMainWindow: Promise<BrowserWindow> | null = null;
const managedHostDrainCoordinator = new ManagedHostDrainCoordinator();
const managedHostQuitGate = new ManagedHostQuitGate(managedHostDrainCoordinator.stop);
const managedHostReplacementGate = new ManagedHostReplacementGate(
  managedHostDrainCoordinator.stop,
);

type DesktopNavigationTarget =
  | DesktopNotificationTarget
  | { type: 'settings'; section: 'updates' };

const DISABLED_UPDATE_STATE: AppUpdateState = {
  status: 'disabled',
  trigger: null,
  update: null,
  progress: null,
  error: null,
};

const DISABLED_NOTIFICATION_STATE: DesktopNotificationState = {
  supported: false,
  preferences: {
    desktop: false,
    sessionDone: true,
    approvalNeeded: true,
    errors: true,
    sound: false,
  },
  lastError: null,
};

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

function releaseRepository(): string {
  return process.env['GIAN_RELEASE_REPOSITORY']?.trim() || 'RichLogic/Gian';
}

function githubReleaseBrokerSocketPath(): string {
  const developmentSocket = !app.isPackaged
    ? process.env[GITHUB_RELEASE_BROKER_SOCKET_ENV]?.trim()
    : undefined;
  return developmentSocket || resolveGitHubReleaseBrokerSocketPath(
    desktopInstanceId ?? applicationIdentity.userDataPath ?? app.getPath('userData'),
  );
}

async function startGitHubReleaseBroker(): Promise<void> {
  if (githubReleaseBroker) return;
  const service = getGitHubAuthService();
  const broker = new GitHubReleaseMetadataBroker({
    socketPath: githubReleaseBrokerSocketPath(),
    allowedRepository: releaseRepository(),
    fetchReleaseMetadata: (request, signal) => service.fetchReleaseMetadata(request, signal),
  });
  await broker.start();
  githubReleaseBroker = broker;
}

async function ensureGitHubReleaseBroker(): Promise<void> {
  try {
    await startGitHubReleaseBroker();
  } catch (error) {
    // The app remains usable offline and the Host retains its anonymous
    // GitHub fallback when the local credential broker cannot start.
    console.error('[desktop] GitHub release broker failed to start', error);
  }
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
    githubBrokerSocket: githubReleaseBrokerSocketPath(),
    env: {
      ...process.env,
      GIAN_RELEASE_VERSION: app.getVersion(),
      GIAN_RELEASE_REPOSITORY: releaseRepository(),
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

function rendererCanNavigate(): boolean {
  return !!mainWindow
    && !mainWindow.isDestroyed()
    && !mainWindow.webContents.isDestroyed()
    && rendererReady;
}

async function ensureMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (creatingMainWindow) return creatingMainWindow;
  const creation = createMainWindow();
  creatingMainWindow = creation;
  try {
    return await creation;
  } finally {
    if (creatingMainWindow === creation) creatingMainWindow = null;
  }
}

async function activateDesktopNavigation(target: DesktopNavigationTarget): Promise<void> {
  pendingNavigationTarget = target;
  const window = await ensureMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  // A cold renderer may already have claimed this target through
  // `desktop:navigation:ready` while createMainWindow was awaiting loadURL.
  if (!rendererCanNavigate() || pendingNavigationTarget !== target) return;
  window.webContents.send('desktop:navigation', target);
}

function createNativeNotificationDelivery() {
  return {
    show(
      payload: { title: string; body: string; silent: boolean },
      callbacks: { onClick: () => void; onClose: () => void; onFailed: () => void },
    ) {
      const notification = new Notification(payload);
      notification.once('click', callbacks.onClick);
      notification.once('close', callbacks.onClose);
      notification.once('failed', callbacks.onFailed);
      notification.show();
      return { close: () => notification.close() };
    },
  };
}

function showUpdateReadyNotification(state: AppUpdateState): void {
  const version = state.update?.version;
  if (
    state.status !== 'downloaded'
    || !version
    || version === notifiedUpdateVersion
    || !app.isPackaged
    || process.platform !== 'darwin'
    || !Notification.isSupported()
    || notificationService?.getState().preferences.desktop !== true
  ) {
    return;
  }
  notifiedUpdateVersion = version;
  updateReadyNotification?.close();
  const notification = new Notification({
    title: `Gian ${version} is ready`,
    body: 'Open Updates when you are ready to restart and install.',
    silent: notificationService?.getState().preferences.sound !== true,
  });
  updateReadyNotification = notification;
  notification.once('click', () => {
    void activateDesktopNavigation({ type: 'settings', section: 'updates' });
  });
  notification.once('close', () => {
    if (updateReadyNotification === notification) updateReadyNotification = null;
  });
  notification.once('failed', () => {
    if (updateReadyNotification === notification) updateReadyNotification = null;
    console.warn('[desktop-updater] update-ready notification was not delivered');
  });
  notification.show();
}

function initializeDesktopServices(): void {
  const nativeNotificationSupported = app.isPackaged
    && signedProductionRelease
    && process.platform === 'darwin'
    && process.env['GIAN_DESKTOP_SMOKE_MANAGE_HOST'] !== '1'
    && Notification.isSupported();
  notificationService = new NativeNotificationService({
    supported: nativeNotificationSupported,
    store: new FileDesktopNotificationPreferenceStore(
      join(app.getPath('userData'), 'notification-preferences.json'),
    ),
    delivery: createNativeNotificationDelivery(),
    onActivate: target => { void activateDesktopNavigation(target); },
  });
  notificationService.subscribe(state => {
    if (rendererCanNavigate()) mainWindow?.webContents.send('desktop:notifications-state', state);
  });

  appUpdateController = new AppUpdateController({
    updater: autoUpdater,
    isPackaged: app.isPackaged,
    signedRelease: signedProductionRelease,
    platform: process.platform,
    variant: applicationIdentity.variant,
    disabled: process.env['GIAN_DISABLE_AUTO_UPDATE'] === '1'
      || process.env['GIAN_DESKTOP_SMOKE_MANAGE_HOST'] === '1',
    logger: {
      warn: message => { console.warn(message); },
    },
  });
  appUpdateController.subscribe(state => {
    if (rendererCanNavigate()) mainWindow?.webContents.send('desktop:updater-state', state);
    showUpdateReadyNotification(state);
  });
  appUpdateController.start();

  if (nativeNotificationSupported && desktopToken) {
    attentionClient = new AttentionClient({
      hostUrl: targets.hostUrl,
      token: desktopToken,
      tokenHeader: DESKTOP_TOKEN_HEADER,
      socketFactory: (url, init) => (
        new WebSocket(url, init) as unknown as AttentionSocket
      ),
      onAttention: message => { notificationService?.handleAttention(message); },
    });
  }
}

function stopDesktopServicesForExit(): void {
  attentionClient?.stop();
  appUpdateController?.stop();
  githubAuthService?.cancel();
}

function resumeDesktopServicesAfterCancelledExit(restartManagedHost: boolean): void {
  if (restartManagedHost) startProductionHost();
  attentionClient?.start();
  appUpdateController?.start();
}

function showUnsafeExitBlocked(): void {
  console.error('[desktop] managed Host did not exit; cancelling unsafe replacement');
  dialog.showErrorBox(
    'Gian could not restart safely',
    'The managed Host and CLI processes did not finish shutting down. Gian did not start a replacement or install the update. Wait a moment, then try again.',
  );
}

/**
 * A replacement must never be armed before the managed Host has actually
 * exited. Electron's relaunch helper and Squirrel updater both remember their
 * launch intent even when a later before-quit event is prevented.
 */
function runAfterManagedHostExit(startReplacement: () => boolean): Promise<boolean> {
  if (managedHostReplacementGate.isArmed()) return Promise.resolve(true);
  if (replacementOperation) return replacementOperation;
  // A normal OS quit owns the existing drain attempt. Do not attach a second
  // replacement continuation to the same process exit.
  if (managedHostQuitGate.isDraining()) return Promise.resolve(false);

  stopDesktopServicesForExit();
  const child = managedHost;
  const hadLiveManagedHost = !!child
    && child.exitCode === null
    && child.signalCode === null;

  let operation!: Promise<boolean>;
  operation = managedHostReplacementGate.run(child, startReplacement).then(result => {
    if (result === 'started') return true;
    if (result === 'blocked') {
      resumeDesktopServicesAfterCancelledExit(false);
      showUnsafeExitBlocked();
      return false;
    }
    // The Host was confirmed gone, but the updater/relauncher itself failed.
    // Restore a packaged Host so the current window does not become stranded.
    resumeDesktopServicesAfterCancelledExit(hadLiveManagedHost);
    return false;
  }).finally(() => {
    if (replacementOperation === operation) replacementOperation = null;
  });
  replacementOperation = operation;
  return operation;
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

interface MainWindowCaptureState {
  window: BrowserWindow;
  wasVisible: boolean;
  wasMinimized: boolean;
  wasFocused: boolean;
}

function revealMainWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
}

async function showScreenPermissionHelp(): Promise<void> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Screen Recording Permission Required',
    message: 'Allow Gian to record the screen before taking a screenshot.',
    detail: 'Open System Settings, enable Gian under Privacy & Security → Screen Recording, then try again.',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0 && process.platform === 'darwin') {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  }
}

function createScreenshotController(): ScreenshotController {
  return new ScreenshotController({
    platform: process.platform,
    overlayHtmlPath: screenshotHtmlPath,
    overlayPreloadPath: screenshotPreloadPath,
    listDisplays: () => screen.getAllDisplays().map(display => ({
      id: display.id,
      bounds: { ...display.bounds },
      scaleFactor: display.scaleFactor,
    })),
    getCursorPoint: () => screen.getCursorScreenPoint(),
    captureScreens: thumbnailSize => desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
      fetchWindowIcons: false,
    }),
    createOverlayWindow: options => {
      const overlay = new BrowserWindow(options);
      overlay.webContents.on('will-navigate', event => event.preventDefault());
      overlay.webContents.on('will-attach-webview', event => event.preventDefault());
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      overlay.webContents.session.setPermissionCheckHandler(() => false);
      overlay.webContents.session.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      return overlay;
    },
    getScreenPermissionStatus: () => {
      if (process.platform !== 'darwin') return 'granted';
      return systemPreferences.getMediaAccessStatus('screen') as ScreenPermissionStatus;
    },
    showScreenPermissionHelp,
    prepareMainWindow: async () => {
      const window = mainWindow;
      if (!window || window.isDestroyed()) return null;
      const state: MainWindowCaptureState = {
        window,
        wasVisible: window.isVisible(),
        wasMinimized: window.isMinimized(),
        wasFocused: window.isFocused(),
      };
      if (state.wasVisible) window.hide();
      return state;
    },
    restoreMainWindow: async (token, outcome) => {
      const state = token as MainWindowCaptureState | null;
      if (!state || state.window.isDestroyed()) return;
      if (outcome === 'success') {
        revealMainWindow(state.window);
        return;
      }
      if (!state.wasVisible) return;
      if (state.wasMinimized) {
        state.window.minimize();
        return;
      }
      if (state.wasFocused) revealMainWindow(state.window);
      else state.window.showInactive();
    },
    waitForDesktopToSettle: token => {
      const state = token as MainWindowCaptureState | null;
      return state?.wasVisible
        ? new Promise(resolve => setTimeout(resolve, 100))
        : Promise.resolve();
    },
    watchDisplayChanges: listener => {
      screen.on('display-added', listener);
      screen.on('display-removed', listener);
      screen.on('display-metrics-changed', listener);
      return () => {
        screen.removeListener('display-added', listener);
        screen.removeListener('display-removed', listener);
        screen.removeListener('display-metrics-changed', listener);
      };
    },
    registerGlobalShortcut: (accelerator, listener) =>
      globalShortcut.register(accelerator, listener),
    unregisterGlobalShortcut: accelerator => globalShortcut.unregister(accelerator),
    randomId: randomUUID,
    now: () => new Date(),
    writePngToClipboard: bytes => {
      const clipboardImage = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (clipboardImage.isEmpty()) return false;
      clipboard.writeImage(clipboardImage);
      return true;
    },
    onCaptured: (capture: GianScreenshotCapture) => {
      const window = mainWindow;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      revealMainWindow(window);
      window.webContents.send('desktop:screenshot:captured', capture);
    },
    onError: (error: GianScreenshotErrorCode) => {
      const window = mainWindow;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      if (error === 'no-target' || error === 'capture-failed') revealMainWindow(window);
      window.webContents.send('desktop:screenshot:error', error);
    },
  });
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
  // No Gian renderer will perform the visibility handshake on this local
  // error page. Treat every Session as background so attention is not queued
  // indefinitely while the Host/Web surface is unavailable.
  if (mainWindow === window) {
    notificationService?.setContext({
      windowFocused: false,
      visibleSessionId: null,
    });
  }
}

async function loadGianSurface(window: BrowserWindow): Promise<boolean> {
  if (loadingSurface?.window === window) return loadingSurface.promise;
  if (mainWindow === window) screenshotController?.invalidateTarget();

  const promise = (async () => {
    await ensureGitHubReleaseBroker();
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
          label: 'Screenshot',
          accelerator: screenshotShortcutForPlatform(process.platform),
          registerAccelerator: false,
          click: () => { void screenshotController?.start(); },
        },
        {
          label: 'Open Logs',
          click: () => {
            void shell.openPath(logDirectory());
          },
        },
        {
          label: 'Check for Updates…',
          enabled: appUpdateController?.isEnabled() ?? false,
          click: () => {
            void activateDesktopNavigation({ type: 'settings', section: 'updates' });
            void appUpdateController?.checkForUpdates('manual');
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
  rendererReady = false;
  rendererDocumentReady = false;
  notificationService?.resetContext();
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
      additionalArguments: [
        `--gian-desktop-variant=${applicationIdentity.variant}`,
        `--gian-desktop-signed-release=${signedProductionRelease ? 'true' : 'false'}`,
        `--gian-desktop-version=${app.getVersion()}`,
      ],
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
  window.webContents.on(
    'did-start-navigation',
    (_event, url, _isInPlace, isMainFrame) => {
      if (
        isMainFrame
        && (isTrustedDesktopUrl(url, targets) || url.startsWith('file:'))
      ) {
        screenshotController?.invalidateTarget();
      }
      if (mainWindow === window && isMainFrame) {
        rendererReady = false;
        rendererDocumentReady = false;
        notificationService?.resetContext();
      }
    },
  );
  window.webContents.on('dom-ready', () => {
    if (mainWindow === window) rendererDocumentReady = true;
  });
  window.webContents.on('render-process-gone', () => {
    screenshotController?.invalidateTarget();
    if (mainWindow !== window) return;
    rendererReady = false;
    rendererDocumentReady = false;
    notificationService?.setContext({ windowFocused: false, visibleSessionId: null });
  });
  window.on('unresponsive', () => {
    if (mainWindow !== window) return;
    notificationService?.setContext({ windowFocused: false, visibleSessionId: null });
  });
  window.webContents.on('did-create-window', child => {
    hardenWebContents(child.webContents);
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    screenshotController?.invalidateTarget();
    controller.destroy();
    if (browserController === controller) browserController = null;
    if (mainWindow === window) mainWindow = null;
    if (mainWindow === null) {
      rendererReady = false;
      rendererDocumentReady = false;
    }
    notificationService?.setContext({ windowFocused: false, visibleSessionId: null });
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

ipcMain.handle('desktop:restart-app', async event => {
  if (!isMainWindowSender(event.sender)) return false;
  return runAfterManagedHostExit(() => {
    // Reply to the renderer before quitting. GianDev's Host is externally
    // owned, so the drain above is an immediate no-op in development.
    app.relaunch();
    setTimeout(() => { app.quit(); }, 100);
    return true;
  });
});

ipcMain.handle('desktop:zoom:get', event => {
  if (!isMainWindowSender(event.sender)) return null;
  return currentMainWindowZoom();
});

ipcMain.handle('desktop:zoom:set', (event, percent: unknown) => {
  if (!isMainWindowSender(event.sender)) return null;
  return setMainWindowZoom(percent);
});

ipcMain.handle('desktop:screenshot:set-target', (event, value: unknown) => {
  if (!isMainWindowSender(event.sender) || !screenshotController) return false;
  if (value === null) {
    screenshotController.setTarget(null);
    return true;
  }
  const target = normalizeScreenshotTarget(value);
  if (!target) return false;
  screenshotController.setTarget(target);
  return true;
});

ipcMain.handle('desktop:screenshot:start', event => {
  if (!isMainWindowSender(event.sender) || !screenshotController) {
    return { ok: false, error: 'capture-failed' };
  }
  return screenshotController.start();
});

ipcMain.handle('desktop:screenshot:get-state', event => {
  if (!isMainWindowSender(event.sender)) return null;
  return screenshotController?.getState() ?? {
    shortcut: screenshotShortcutForPlatform(process.platform),
    shortcutRegistered: false,
    capturing: false,
  };
});

ipcMain.handle('desktop:screenshot-overlay:get-capture', event =>
  screenshotController?.getOverlayCapture(event.sender.id) ?? null);

ipcMain.handle('desktop:screenshot-overlay:claim', (event, captureId: unknown) =>
  screenshotController?.claimFromOverlay(event.sender.id, captureId) ?? false);

ipcMain.handle('desktop:screenshot-overlay:cancel', event =>
  screenshotController?.cancelFromOverlay(event.sender.id) ?? false);

ipcMain.handle(
  'desktop:screenshot-overlay:complete',
  (event, captureId: unknown, bytes: unknown) =>
    screenshotController?.completeFromOverlay(event.sender.id, captureId, bytes) ?? false,
);

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

ipcMain.handle('desktop:navigation:ready', event => {
  if (!isMainWindowSender(event.sender) || !rendererDocumentReady) return null;
  rendererReady = true;
  return pendingNavigationTarget;
});

ipcMain.handle('desktop:navigation:ack', (event, target: unknown) => {
  if (!isMainWindowSender(event.sender)) return false;
  if (navigationTargetsEqual(pendingNavigationTarget, target)) {
    pendingNavigationTarget = null;
    return true;
  }
  return false;
});

ipcMain.handle('desktop:notifications:get-state', event => {
  if (!isMainWindowSender(event.sender)) return DISABLED_NOTIFICATION_STATE;
  return notificationService?.getState() ?? DISABLED_NOTIFICATION_STATE;
});

ipcMain.handle('desktop:notifications:update-preferences', (event, value: unknown) => {
  if (!isMainWindowSender(event.sender)) return DISABLED_NOTIFICATION_STATE;
  try {
    return notificationService?.updatePreferences(value) ?? DISABLED_NOTIFICATION_STATE;
  } catch {
    console.warn('[desktop] failed to persist notification preferences');
    return notificationService?.getState() ?? DISABLED_NOTIFICATION_STATE;
  }
});

ipcMain.handle('desktop:notifications:set-context', (event, value: unknown) => {
  if (
    !isMainWindowSender(event.sender)
    || !rendererReady
    || !value
    || typeof value !== 'object'
  ) return false;
  notificationService?.setContext({
    ...(value as Record<string, unknown>),
    windowFocused: mainWindow?.isFocused() ?? false,
  });
  return true;
});

ipcMain.handle('desktop:notifications:open-settings', async event => {
  if (!isMainWindowSender(event.sender) || process.platform !== 'darwin') return false;
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  );
  return true;
});

ipcMain.handle('desktop:updater:get-state', event => {
  if (!isMainWindowSender(event.sender)) return DISABLED_UPDATE_STATE;
  return appUpdateController?.getState() ?? DISABLED_UPDATE_STATE;
});

ipcMain.handle('desktop:updater:check', async event => {
  if (!isMainWindowSender(event.sender)) {
    return { trigger: 'manual', state: DISABLED_UPDATE_STATE };
  }
  return appUpdateController?.checkForUpdates('manual')
    ?? { trigger: 'manual', state: DISABLED_UPDATE_STATE };
});

ipcMain.handle('desktop:updater:install', async event => {
  if (!isMainWindowSender(event.sender)) return false;
  const controller = appUpdateController;
  if (!controller || controller.getState().status !== 'downloaded') return false;
  return runAfterManagedHostExit(() => controller.install());
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
    if (screenshotController?.getState().capturing) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
      void ensureMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    installDesktopRequestBoundary();
    initializeDesktopServices();
    screenshotController = createScreenshotController();
    buildApplicationMenu();
    await ensureMainWindow();
    screenshotController.registerShortcut();
    void screenshotController.warmUp().catch(error => {
      console.warn('[desktop] screenshot overlay warm-up failed', error);
    });
    attentionClient?.start();

    app.on('activate', () => {
      if (screenshotController?.getState().capturing) return;
      if (!mainWindow || mainWindow.isDestroyed()) void ensureMainWindow();
    });
  }).catch(error => {
    console.error('[desktop] failed to start', error);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', event => {
  // An OS quit arriving while a restart/update preflight is draining must not
  // start a second shutdown path. Once armed, the Host is already confirmed
  // gone and the replacement-triggered quit may proceed normally.
  if (managedHostReplacementGate.isDraining()) {
    event.preventDefault();
    return;
  }
  stopDesktopServicesForExit();
  const disposeDesktopResources = () => {
    screenshotController?.dispose();
    screenshotController = null;
    const broker = githubReleaseBroker;
    githubReleaseBroker = null;
    if (broker) void broker.close();
  };
  const preventQuit = managedHostQuitGate.intercept(managedHost, {
    onReleased: () => {
      disposeDesktopResources();
      app.quit();
    },
    onBlocked: () => {
      console.error('[desktop] managed Host did not exit; cancelling unsafe quit');
      attentionClient?.start();
      appUpdateController?.start();
      dialog.showErrorBox(
        'Gian could not quit safely',
        'The managed Host and CLI processes did not finish shutting down. Gian cancelled the quit to avoid starting a replacement against the same data and port. Wait a moment, then quit again.',
      );
    },
  });
  if (preventQuit) event.preventDefault();
  else disposeDesktopResources();
});

function isBrowserBounds(value: unknown): value is GianBrowserBounds {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GianBrowserBounds>;
  return typeof candidate.x === 'number'
    && typeof candidate.y === 'number'
    && typeof candidate.width === 'number'
    && typeof candidate.height === 'number';
}

function navigationTargetsEqual(
  expected: DesktopNavigationTarget | null,
  actual: unknown,
): boolean {
  if (!expected || !actual || typeof actual !== 'object') return false;
  const candidate = actual as Record<string, unknown>;
  if (expected.type !== candidate.type) return false;
  if (expected.type === 'settings') return candidate.section === expected.section;
  return candidate.type === 'session'
    && candidate.sessionId === expected.sessionId
    && candidate.turn === expected.turn
    && candidate.kind === expected.kind;
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

function isScreenshotText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength;
}

function normalizeScreenshotTarget(value: unknown): GianScreenshotTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!isScreenshotText(candidate['label'], 256)) return null;

  if (candidate['kind'] === 'session') {
    if (!isScreenshotText(candidate['sessionId'], 512)) return null;
    return {
      kind: 'session',
      sessionId: candidate['sessionId'],
      label: candidate['label'],
    };
  }

  if (
    candidate['kind'] !== 'new-session'
    || !candidate['scope']
    || typeof candidate['scope'] !== 'object'
    || Array.isArray(candidate['scope'])
  ) return null;
  const scope = candidate['scope'] as Record<string, unknown>;
  if (
    (scope['kind'] !== 'workspace' && scope['kind'] !== 'task')
    || !isScreenshotText(scope['id'], 512)
  ) return null;
  return {
    kind: 'new-session',
    scope: { kind: scope['kind'], id: scope['id'] },
    label: candidate['label'],
  };
}
