import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  isSafeExternalUrl,
  isTrustedDesktopUrl,
  resolveDesktopTargets,
  resolveDesktopWindowChrome,
} from './config.js';
import { ensureHostAvailable } from './host-service.js';

const execFileAsync = promisify(execFile);
const currentDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(currentDir, 'preload.cjs');
const titlebarCss = readFileSync(
  join(app.getAppPath(), 'renderer', 'titlebar.css'),
  'utf8',
);

app.setName('Gian');

const targets = resolveDesktopTargets({
  isPackaged: app.isPackaged,
  platform: process.platform,
});

let mainWindow: BrowserWindow | null = null;
let loadingSurface:
  | { window: BrowserWindow; promise: Promise<boolean> }
  | null = null;

async function kickstartProductionHost(): Promise<void> {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    throw new Error('launchd is only available on macOS');
  }

  const uid = process.getuid();
  const domain = `gui/${uid}`;
  const service = `${domain}/com.gian.host`;
  try {
    await execFileAsync('/bin/launchctl', ['kickstart', service]);
    return;
  } catch {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.gian.host.plist');
    if (!existsSync(plist)) throw new Error('Gian host is not installed');

    try {
      await execFileAsync('/bin/launchctl', ['bootstrap', domain, plist]);
    } catch {
      // It may already be bootstrapped. The second kickstart is authoritative.
    }
    await execFileAsync('/bin/launchctl', ['kickstart', service]);
  }
}

function logDirectory(): string {
  const configured = process.env['GIAN_DATA_DIR'];
  if (configured) return join(configured, 'logs');
  return join(homedir(), '.config', app.isPackaged ? 'gian' : 'gian-dev', 'logs');
}

async function openExternal(candidate: string): Promise<void> {
  if (isSafeExternalUrl(candidate)) await shell.openExternal(candidate);
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
          backgroundColor: '#f7f7f5',
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
      manageLaunchAgent: targets.manageLaunchAgent,
      kickstart: kickstartProductionHost,
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
      label: 'Gian',
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
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
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
    title: 'Gian',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  mainWindow = window;

  hardenWebContents(window.webContents);
  installDesktopTitlebar(window.webContents);
  window.webContents.on('did-create-window', child => {
    hardenWebContents(child.webContents);
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
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
