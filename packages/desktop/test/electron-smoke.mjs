import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const electronPath = process.env.GIAN_DESKTOP_SMOKE_EXECUTABLE || require('electron');
const desktopVersion = require('../package.json').version;
const packagedSmoke = Boolean(process.env.GIAN_DESKTOP_SMOKE_EXECUTABLE);
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const smokeUserData = await mkdtemp(join(tmpdir(), 'gian-desktop-smoke-'));
const smokeDownloadDir = join(smokeUserData, 'downloads');
const smokeExtensionDir = join(smokeUserData, 'extensions', 'fixture');
const smokeBrowserSocket = join(tmpdir(), `gian-browser-smoke-${process.pid}.sock`);
await mkdir(smokeExtensionDir, { recursive: true });
await writeFile(join(smokeExtensionDir, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Gian Browser Smoke Extension',
  version: '1.0.0',
  permissions: ['storage'],
  content_scripts: [{
    matches: ['http://127.0.0.1/*'],
    js: ['content.js'],
    run_at: 'document_end',
  }],
}));
await writeFile(
  join(smokeExtensionDir, 'content.js'),
  "document.documentElement.dataset.gianExtensionSmoke = 'loaded';\n",
);
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIAN_')),
);

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function waitForBrowserState(window, tabId, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await window.evaluate(id => window.gianDesktop?.browser?.getState(id), tabId);
    if (lastState && predicate(lastState)) return lastState;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Browser tab ${tabId}: ${JSON.stringify(lastState)}`);
}

async function browserChildViewCount(application, page) {
  const browserWindow = await application.browserWindow(page);
  return browserWindow.evaluate(window => window.contentView.children.length);
}

async function captureBrowserPage(application, targetUrl, path) {
  const deadline = Date.now() + 15_000;
  let png = null;
  while (Date.now() < deadline && !png) {
    png = await application.evaluate(async ({ webContents }, url) => {
      const target = webContents.getAllWebContents().find(contents => contents.getURL() === url);
      if (!target) return null;
      const image = await target.capturePage();
      return image.toPNG().toString('base64');
    }, targetUrl);
    if (!png) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!png) throw new Error(`Browser WebContents not found: ${targetUrl}`);
  await writeFile(path, Buffer.from(png, 'base64'));
}

async function waitForBrowserTabs(window, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    lastSnapshot = await window.evaluate(() => window.gianDesktop?.browser?.listTabs());
    if (lastSnapshot && predicate(lastSnapshot.tabs)) return lastSnapshot;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Browser tabs: ${JSON.stringify(lastSnapshot)}`);
}

async function waitForElectronWindow(application, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = application.windows().find(predicate);
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Electron window');
}

async function callBrowserTool(method, params) {
  const encoded = Buffer.from(JSON.stringify({
    method,
    params,
    actor: { caller_id: 'internal-session:smoke', session_id: 'smoke' },
  }));
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: smokeBrowserSocket,
      path: '/v1/browser-use',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(encoded.byteLength) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end(encoded);
  });
}

async function findInBrowserPage(window, tabId, text, options = {}) {
  return window.evaluate(input => new Promise((resolve, reject) => {
    const browser = window.gianDesktop?.browser;
    if (!browser) {
      reject(new Error('Browser bridge unavailable'));
      return;
    }
    const timer = window.setTimeout(() => {
      off();
      reject(new Error('Timed out waiting for Browser find result'));
    }, 10_000);
    const off = browser.subscribeFind((changedTabId, result) => {
      if (changedTabId !== input.tabId) return;
      window.clearTimeout(timer);
      off();
      resolve(result);
    });
    browser.findInPage(input.tabId, input.text, input.options);
  }), { tabId, text, options });
}

let hostVersion = '0.0.0-mismatch';
const host = await listen((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, version: hostVersion }));
    return;
  }
  if (url.pathname.startsWith('/api/working_trees/') && url.pathname.endsWith('/raw')) {
    const path = url.searchParams.get('path');
    const resources = {
      'site/index.html': {
        type: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><link rel="stylesheet" href="./style.css"><script type="module" src="./app.js"></script></head><body><button id="browser-smoke">loading</button><p>Ready secondary match</p></body></html>',
      },
      'site/style.css': { type: 'text/css; charset=utf-8', body: 'body { background: rgb(12, 34, 56); }' },
      'site/app.js': {
        type: 'text/javascript; charset=utf-8',
        body: "const data = await fetch('./data.json').then(r => r.json()); const previous = localStorage.getItem('browser-smoke'); document.querySelector('#browser-smoke').textContent = data.marker; document.title = `Browser Smoke ${previous ?? data.marker}`; localStorage.setItem('browser-smoke', 'Persisted');",
      },
      'site/data.json': { type: 'application/json; charset=utf-8', body: JSON.stringify({ marker: 'Ready' }) },
    };
    const resource = resources[path];
    if (resource) {
      response.writeHead(200, { 'content-type': resource.type });
      response.end(resource.body);
      return;
    }
  }
  if (url.pathname === '/browser-http') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Browser HTTP Ready</title>
      <p>HTTP preview</p>
      <label>Name <input aria-label="Name"></label>
      <button id="browser-greet" onclick="document.querySelector('#browser-result').textContent='Hello '+document.querySelector('input').value">Set greeting</button>
      <output id="browser-result"></output>
      <a id="browser-download" href="/browser-download">Download</a>`);
    return;
  }
  if (url.pathname === '/browser-download') {
    const body = 'Browser download smoke';
    response.writeHead(200, {
      'content-disposition': 'attachment; filename="browser-smoke.txt"',
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end(body);
    return;
  }
  if (url.pathname === '/browser-oauth') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Browser OAuth Popup</title><p>OAuth popup ready</p>');
    return;
  }
  response.writeHead(404);
  response.end();
});

const web = await listen((_request, response) => {
  response.writeHead(200, {
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(`<!doctype html>
    <html>
      <head>
        <title>Gian Desktop Smoke</title>
        <style>
          html, body { height: 100%; margin: 0; font-family: system-ui; }
          .app { min-height: 100%; background: #f6f3eb; }
          .topbar {
            box-sizing: border-box;
            display: flex;
            align-items: center;
            height: 44px;
            padding: 0 12px 0 8px;
            background: #f6f3eb;
            border-bottom: 1px solid #ded9ce;
          }
          .topbar button { border: 0; background: transparent; font-weight: 650; }
          main { padding: 32px; }
        </style>
      </head>
      <body>
        <div class="app">
          <header class="topbar" data-testid="desktop-topbar">
            <button data-testid="topbar-action">Gian</button>
          </header>
          <main><h1 data-testid="ready">Gian Desktop Smoke</h1></main>
        </div>
      </body>
    </html>`);
});

async function launchElectron() {
  return electron.launch({
    executablePath: electronPath,
    args: packagedSmoke ? [] : ['.'],
    cwd: packageDir,
    env: {
      ...cleanEnvironment,
      GIAN_DESKTOP_DISABLE_HOST_MANAGEMENT: '1',
      GIAN_DESKTOP_HOST_URL: host.origin,
      GIAN_DESKTOP_SMOKE_DOWNLOAD_DIR: smokeDownloadDir,
      GIAN_DESKTOP_SMOKE_EXTENSION_DIR: smokeExtensionDir,
      GIAN_DESKTOP_BROWSER_BROKER_SOCKET: smokeBrowserSocket,
      GIAN_DESKTOP_USER_DATA_DIR: smokeUserData,
      GIAN_DESKTOP_WEB_URL: web.origin,
    },
  });
}

let electronApp;
try {
  electronApp = await launchElectron();

  const window = await electronApp.firstWindow();
  const retry = window.getByRole('button', { name: 'Retry' });
  await retry.waitFor({ timeout: 15_000 });
  assert.match(await window.locator('h1').textContent(), /host is unavailable/i);

  const screenshotDir = join(packageDir, '..', '..', 'output', 'playwright');
  await mkdir(screenshotDir, { recursive: true });
  await window.screenshot({
    path: join(screenshotDir, 'gian-desktop-unavailable.png'),
    fullPage: true,
  });

  hostVersion = desktopVersion;
  await retry.click();
  await window.getByTestId('ready').waitFor();
  assert.equal(new URL(window.url()).origin, web.origin);
  assert.equal(await window.title(), 'Gian Desktop Smoke');
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.retryConnection),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.setDockIcon),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.restartApp),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.browser?.openProject),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.browser?.setInspectMode),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.browser?.subscribeElement),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.browser?.findInPage),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.browser?.openDevTools),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.browser?.listTabs),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.browser?.recover),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.browser?.subscribeAddressRequested),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.browser?.installExtension),
    'function',
  );
  const installedExtension = await window.evaluate(() =>
    window.gianDesktop.browser.installExtension());
  assert.equal(installedExtension?.name, 'Gian Browser Smoke Extension');
  assert.equal(installedExtension?.status, 'ready');
  assert.deepEqual(installedExtension?.warnings, []);
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.zoom?.set),
    'function',
  );
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.zoom?.onChanged),
    'function',
  );
  assert.equal(
    await window.evaluate(() => window.gianDesktop?.appVariant),
    packagedSmoke ? 'production' : 'development',
  );
  assert.equal(
    await window.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext('2d');
      if (!context || !window.gianDesktop?.setDockIcon) return false;
      context.fillStyle = 'oklch(0.7 0.18 230)';
      context.fillRect(0, 0, 32, 32);
      return window.gianDesktop.setDockIcon(canvas.toDataURL('image/png'));
    }),
    true,
  );
  const titlebarChrome = await window.getByTestId('desktop-topbar').evaluate(element => {
    const topbarStyle = getComputedStyle(element);
    const actionStyle = getComputedStyle(element.querySelector('button'));
    return {
      paddingLeft: Number.parseFloat(topbarStyle.paddingLeft),
      topbarRegion: topbarStyle.getPropertyValue('-webkit-app-region'),
      actionRegion: actionStyle.getPropertyValue('-webkit-app-region'),
    };
  });
  assert.ok(titlebarChrome.paddingLeft >= 82);
  assert.equal(titlebarChrome.topbarRegion, 'drag');
  assert.equal(titlebarChrome.actionRegion, 'no-drag');

  const browserProjectState = await window.evaluate(async () => {
    const browser = window.gianDesktop?.browser;
    if (!browser) throw new Error('Browser bridge unavailable');
    await browser.createTab({ tabId: 'browser-smoke-primary', sourceSessionId: 'session-smoke' });
    await browser.createTab({ tabId: 'browser-smoke-secondary', sourceSessionId: 'session-smoke' });
    await browser.setLayout('browser-smoke-primary', { x: 100, y: 100, width: 640, height: 420 }, true);
    return browser.openProject('browser-smoke-primary', { workingTreeId: 'ws:smoke', path: 'site/index.html' });
  });
  assert.match(browserProjectState.url, /^gian-browser:\/\/[a-f0-9]+\/site\/index\.html$/);
  const loadedProjectState = await waitForBrowserState(
    window,
    'browser-smoke-primary',
    state => state.title === 'Browser Smoke Ready',
  );
  assert.equal(loadedProjectState.title, 'Browser Smoke Ready');
  assert.equal(loadedProjectState.canOpenExternal, true);
  assert.equal(await browserChildViewCount(electronApp, window), 1);
  await captureBrowserPage(
    electronApp,
    loadedProjectState.url,
    join(screenshotDir, 'gian-browser-native-visible.png'),
  );

  const nativeFindShortcut = window.evaluate(() => new Promise((resolve, reject) => {
    const browser = window.gianDesktop?.browser;
    if (!browser) {
      reject(new Error('Browser bridge unavailable'));
      return;
    }
    const timer = window.setTimeout(() => {
      off();
      reject(new Error('Timed out waiting for native Browser find shortcut'));
    }, 10_000);
    const off = browser.subscribeFindRequested(tabId => {
      window.clearTimeout(timer);
      off();
      resolve(tabId);
    });
  }));
  await electronApp.evaluate(({ webContents }, targetUrl) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${targetUrl}`);
    target.focus();
    target.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['meta'] });
    target.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['meta'] });
  }, loadedProjectState.url);
  assert.equal(await nativeFindShortcut, 'browser-smoke-primary');

  const nativeAddressShortcut = window.evaluate(() => new Promise((resolve, reject) => {
    const browser = window.gianDesktop?.browser;
    if (!browser) {
      reject(new Error('Browser bridge unavailable'));
      return;
    }
    const timer = window.setTimeout(() => {
      off();
      reject(new Error('Timed out waiting for native Browser address shortcut'));
    }, 10_000);
    const off = browser.subscribeAddressRequested(tabId => {
      window.clearTimeout(timer);
      off();
      resolve(tabId);
    });
  }));
  await electronApp.evaluate(({ webContents }, targetUrl) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${targetUrl}`);
    target.focus();
    target.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['meta'] });
    target.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['meta'] });
  }, loadedProjectState.url);
  assert.equal(await nativeAddressShortcut, 'browser-smoke-primary');

  const tabsBeforeNewShortcut = await window.evaluate(() => window.gianDesktop.browser.listTabs());
  await electronApp.evaluate(({ webContents }, targetUrl) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${targetUrl}`);
    target.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['meta'] });
    target.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['meta'] });
  }, loadedProjectState.url);
  const shortcutTabSnapshot = await waitForBrowserTabs(
    window,
    tabs => tabs.length === tabsBeforeNewShortcut.tabs.length + 1,
  );
  const shortcutTab = shortcutTabSnapshot.tabs.find(tab =>
    !tabsBeforeNewShortcut.tabs.some(existing => existing.id === tab.id));
  assert.ok(shortcutTab);
  assert.equal(await window.evaluate(
    tabId => window.gianDesktop.browser.closeTab(tabId),
    shortcutTab.id,
  ), true);

  const findResult = await findInBrowserPage(window, 'browser-smoke-primary', 'Ready');
  assert.equal(findResult.matches, 2);
  assert.equal(findResult.activeMatchOrdinal, 1);
  const nextFindResult = await findInBrowserPage(
    window,
    'browser-smoke-primary',
    'Ready',
    { forward: true, findNext: true },
  );
  assert.equal(nextFindResult.matches, 2);
  assert.equal(nextFindResult.activeMatchOrdinal, 2);
  assert.equal(
    await window.evaluate(() => window.gianDesktop.browser.stopFindInPage('browser-smoke-primary')),
    true,
  );

  const tabsBeforeOAuth = await window.evaluate(() => window.gianDesktop.browser.listTabs());
  const windowsBeforeOAuth = (await electronApp.windows()).length;
  await electronApp.evaluate(async ({ webContents }, input) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === input.sourceUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${input.sourceUrl}`);
    await target.executeJavaScript(
      `(() => { window.open(${JSON.stringify(input.popupUrl)}, 'oauth', 'popup=yes,width=480,height=640'); return true; })()`,
      true,
    );
    return true;
  }, { sourceUrl: loadedProjectState.url, popupUrl: `${host.origin}/browser-oauth` });
  const oauthPopup = await waitForElectronWindow(
    electronApp,
    page => page.url() === `${host.origin}/browser-oauth`,
  );
  assert.equal(await oauthPopup.title(), 'Browser OAuth Popup');
  assert.equal(await oauthPopup.evaluate(() => Boolean(window.opener)), true);
  assert.equal(await oauthPopup.evaluate(() => typeof window.gianDesktop), 'undefined');
  assert.deepEqual(
    (await window.evaluate(() => window.gianDesktop.browser.listTabs())).tabs.map(tab => tab.id),
    tabsBeforeOAuth.tabs.map(tab => tab.id),
    'transient OAuth popups must not become panel 2 tabs',
  );
  assert.equal((await electronApp.windows()).length, windowsBeforeOAuth + 1);
  const oauthClosed = oauthPopup.waitForEvent('close');
  await oauthPopup.evaluate(() => window.close());
  await oauthClosed;

  assert.equal(
    await window.evaluate(() => window.gianDesktop.browser.openDevTools('browser-smoke-primary')),
    true,
  );
  {
    const deadline = Date.now() + 10_000;
    let opened = false;
    while (Date.now() < deadline && !opened) {
      opened = await electronApp.evaluate(({ webContents }, targetUrl) => {
        const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
        return target?.isDevToolsOpened() ?? false;
      }, loadedProjectState.url);
      if (!opened) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(opened, true, 'detached Browser DevTools must open for the managed page');
  }
  const tabsBeforePageOpen = await window.evaluate(() => window.gianDesktop.browser.listTabs());
  const windowsBeforePageOpen = (await electronApp.windows()).length;
  await electronApp.evaluate(({ webContents }, input) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === input.sourceUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${input.sourceUrl}`);
    return target.executeJavaScript(`window.open(${JSON.stringify(input.popupUrl)}, '_blank')`, true);
  }, { sourceUrl: loadedProjectState.url, popupUrl: `${host.origin}/browser-http` });
  const pageCreatedSnapshot = await waitForBrowserTabs(window, tabs => tabs.some(tab =>
    !tabsBeforePageOpen.tabs.some(existing => existing.id === tab.id)
      && tab.state.url === `${host.origin}/browser-http`));
  const pageCreatedTab = pageCreatedSnapshot.tabs.find(tab =>
    !tabsBeforePageOpen.tabs.some(existing => existing.id === tab.id));
  assert.ok(pageCreatedTab);
  await waitForBrowserState(
    window,
    pageCreatedTab.id,
    state => state.title === 'Browser HTTP Ready' && !state.loading,
  );
  assert.equal(
    (await window.evaluate(() => window.gianDesktop.browser.getState('browser-smoke-primary'))).url,
    loadedProjectState.url,
    'page-created tabs must not replace the source page',
  );
  assert.equal(await window.evaluate(
    tabId => window.gianDesktop.browser.closeTab(tabId),
    pageCreatedTab.id,
  ), true);
  assert.equal(
    (await electronApp.windows()).length,
    windowsBeforePageOpen,
    'page-created Browser tabs must not create unmanaged Electron windows',
  );

  const elementCapturePromise = window.evaluate(() => new Promise((resolve, reject) => {
    const browser = window.gianDesktop?.browser;
    if (!browser) {
      reject(new Error('Browser bridge unavailable'));
      return;
    }
    const timer = window.setTimeout(() => {
      off();
      reject(new Error('Timed out waiting for Browser element capture'));
    }, 10_000);
    const off = browser.subscribeElement((tabId, capture) => {
      if (tabId !== 'browser-smoke-primary') return;
      window.clearTimeout(timer);
      off();
      resolve(capture);
    });
    void browser.setInspectMode('browser-smoke-primary', true).catch(error => {
      window.clearTimeout(timer);
      off();
      reject(error);
    });
  }));
  await waitForBrowserState(
    window,
    'browser-smoke-primary',
    state => state.inspecting === true,
  );
  await electronApp.evaluate(({ webContents }, targetUrl) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${targetUrl}`);
    target.sendInputEvent({ type: 'mouseMove', x: 20, y: 20, movementX: 0, movementY: 0 });
    target.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
    target.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
  }, loadedProjectState.url);
  const elementCapture = await elementCapturePromise;
  assert.deepEqual(elementCapture, {
    pageUrl: 'gian-browser://project/site/index.html',
    pageTitle: 'Browser Smoke Ready',
    tagName: 'button',
    selector: 'button[id="browser-smoke"]',
    role: 'button',
    name: 'Ready',
    attributes: { id: 'browser-smoke' },
    contentOmitted: false,
    snippet: '<button id="browser-smoke">Ready</button>',
  });
  assert.equal(
    (await window.evaluate(() => window.gianDesktop.browser.getState('browser-smoke-primary'))).inspecting,
    false,
  );

  await window.evaluate(() => window.gianDesktop.browser.setInspectMode('browser-smoke-primary', true));
  await waitForBrowserState(window, 'browser-smoke-primary', state => state.inspecting === true);
  await window.evaluate(() => window.gianDesktop.browser.setLayout(
    'browser-smoke-primary',
    { x: 100, y: 100, width: 640, height: 420 },
    false,
  ));
  assert.equal(
    (await window.evaluate(() => window.gianDesktop.browser.getState('browser-smoke-primary'))).inspecting,
    false,
    'hiding a Browser tab must cancel CDP inspect mode',
  );
  await window.evaluate(() => window.gianDesktop.browser.setLayout(
    'browser-smoke-primary',
    { x: 100, y: 100, width: 640, height: 420 },
    true,
  ));

  await window.evaluate(() => window.gianDesktop.browser.reload('browser-smoke-primary'));
  await waitForBrowserState(
    window,
    'browser-smoke-primary',
    state => state.title === 'Browser Smoke Persisted',
  );

  await window.evaluate(url => window.gianDesktop.browser.navigate('browser-smoke-primary', url), `${host.origin}/browser-http`);
  await waitForBrowserState(
    window,
    'browser-smoke-primary',
    state => state.title === 'Browser HTTP Ready'
      && state.url === `${host.origin}/browser-http`
      && !state.loading,
  );
  const httpState = await window.evaluate(() => window.gianDesktop.browser.getState('browser-smoke-primary'));
  assert.equal(httpState.url, `${host.origin}/browser-http`);
  assert.equal(httpState.canGoBack, true);
  assert.equal(await electronApp.evaluate(({ webContents }, targetUrl) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${targetUrl}`);
    return target.executeJavaScript('document.documentElement.dataset.gianExtensionSmoke');
  }, `${host.origin}/browser-http`), 'loaded');

  const browserTabs = await callBrowserTool('browser.tabs', {});
  assert.equal(browserTabs.ok, true);
  assert.equal(browserTabs.data.tabs.some(tab => tab.id === 'browser-smoke-primary'), true);
  const toolOpened = await callBrowserTool('browser.open', {
    url: `${host.origin}/browser-http`,
    activate: true,
  });
  assert.equal(toolOpened.ok, true);
  assert.equal(toolOpened.data.tab.sourceSessionId, 'smoke');
  assert.equal(toolOpened.data.tab.state.url, `${host.origin}/browser-http`);
  assert.equal((await callBrowserTool('browser.close', {
    tab_id: toolOpened.data.tab.id,
  })).ok, true);
  const browserSnapshot = await callBrowserTool('browser.snapshot', {
    tab_id: 'browser-smoke-primary',
  });
  assert.equal(browserSnapshot.ok, true);
  assert.match(browserSnapshot.data.tree, /textbox "Name" \[ref=@e\d+\]/);
  assert.match(browserSnapshot.data.tree, /button "Set greeting" \[ref=@e\d+\]/);
  const inputRef = browserSnapshot.data.tree.match(/textbox "Name" \[ref=(@e\d+)\]/)?.[1];
  const buttonRef = browserSnapshot.data.tree.match(/button "Set greeting" \[ref=(@e\d+)\]/)?.[1];
  assert.ok(inputRef);
  assert.ok(buttonRef);
  assert.equal((await callBrowserTool('browser.fill', {
    tab_id: 'browser-smoke-primary',
    snapshot_id: browserSnapshot.data.snapshot_id,
    ref: inputRef,
    text: 'Ada',
  })).ok, true);
  assert.equal((await callBrowserTool('browser.click', {
    tab_id: 'browser-smoke-primary',
    snapshot_id: browserSnapshot.data.snapshot_id,
    ref: buttonRef,
  })).ok, true);
  assert.equal((await callBrowserTool('browser.wait', {
    tab_id: 'browser-smoke-primary',
    condition: 'text',
    text: 'Hello Ada',
    timeout_ms: 5_000,
  })).ok, true);
  const nextSnapshot = await callBrowserTool('browser.snapshot', {
    tab_id: 'browser-smoke-primary',
  });
  const nextInputRef = nextSnapshot.data.tree.match(/textbox "Name" \[ref=(@e\d+)\]/)?.[1];
  const nextButtonRef = nextSnapshot.data.tree.match(/button "Set greeting" \[ref=(@e\d+)\]/)?.[1];
  assert.ok(nextInputRef);
  assert.ok(nextButtonRef);
  await callBrowserTool('browser.fill', {
    tab_id: 'browser-smoke-primary', snapshot_id: nextSnapshot.data.snapshot_id,
    ref: nextInputRef, text: 'Grace',
  });
  assert.equal((await callBrowserTool('browser.press', {
    tab_id: 'browser-smoke-primary', snapshot_id: nextSnapshot.data.snapshot_id,
    ref: nextButtonRef, key: 'Enter',
  })).ok, true);
  assert.equal((await callBrowserTool('browser.wait', {
    tab_id: 'browser-smoke-primary', condition: 'text', text: 'Hello Grace', timeout_ms: 5_000,
  })).ok, true);
  const evaluated = await callBrowserTool('browser.evaluate', {
    tab_id: 'browser-smoke-primary',
    expression: 'document.querySelector("#browser-result").textContent',
  });
  assert.deepEqual(evaluated.data, { tab_id: 'browser-smoke-primary', value: 'Hello Grace' });
  assert.equal((await callBrowserTool('browser.reload', {
    tab_id: 'browser-smoke-primary', ignore_cache: true,
  })).ok, true);
  await waitForBrowserState(window, 'browser-smoke-primary', state => !state.loading);
  const staleClick = await callBrowserTool('browser.click', {
    tab_id: 'browser-smoke-primary',
    snapshot_id: nextSnapshot.data.snapshot_id,
    ref: nextButtonRef,
  });
  assert.equal(staleClick.ok, false);
  assert.equal(staleClick.error.code, 'PRECONDITION_FAILED');

  const permissionRequestPromise = window.evaluate(() => new Promise((resolve, reject) => {
    const browser = window.gianDesktop?.browser;
    if (!browser) {
      reject(new Error('Browser bridge unavailable'));
      return;
    }
    const timer = window.setTimeout(() => {
      off();
      reject(new Error('Timed out waiting for Browser permission request'));
    }, 10_000);
    const off = browser.subscribePermissions(snapshot => {
      const request = snapshot.requests.find(item => item.tabId === 'browser-smoke-primary');
      if (!request) return;
      window.clearTimeout(timer);
      off();
      resolve(request);
    });
  }));
  const pagePermissionPromise = electronApp.evaluate(({ webContents }, targetUrl) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${targetUrl}`);
    return target.executeJavaScript('Notification.requestPermission()', true);
  }, `${host.origin}/browser-http`);
  const permissionRequest = await permissionRequestPromise;
  assert.equal(permissionRequest.origin, host.origin);
  assert.deepEqual(permissionRequest.kinds, ['notifications']);
  assert.equal(await window.evaluate(
    requestId => window.gianDesktop.browser.respondPermission(requestId, 'allow_once'),
    permissionRequest.id,
  ), true);
  assert.equal(await pagePermissionPromise, 'granted');
  assert.equal(
    (await window.evaluate(() => window.gianDesktop.browser.listPermissionRequests())).requests.length,
    0,
  );

  const completedDownload = window.evaluate(() => new Promise((resolve, reject) => {
    const browser = window.gianDesktop?.browser;
    if (!browser) {
      reject(new Error('Browser bridge unavailable'));
      return;
    }
    const timer = window.setTimeout(() => {
      off();
      reject(new Error('Timed out waiting for Browser download'));
    }, 15_000);
    const off = browser.subscribeDownloads(snapshot => {
      const download = snapshot.downloads.find(item => item.filename === 'browser-smoke.txt');
      if (!download || download.status !== 'completed') return;
      window.clearTimeout(timer);
      off();
      resolve(download);
    });
  }));
  await electronApp.evaluate(({ webContents }, targetUrl) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${targetUrl}`);
    return target.executeJavaScript('document.querySelector("#browser-download").click()', true);
  }, `${host.origin}/browser-http`);
  const download = await completedDownload;
  assert.equal(download.receivedBytes, Buffer.byteLength('Browser download smoke'));
  assert.equal(download.canReveal, true);
  assert.equal(
    await readFile(join(smokeDownloadDir, 'browser-smoke.txt'), 'utf8'),
    'Browser download smoke',
  );

  await window.evaluate(() => window.gianDesktop.browser.goBack('browser-smoke-primary'));
  await waitForBrowserState(
    window,
    'browser-smoke-primary',
    state => state.title === 'Browser Smoke Persisted'
      && state.url.startsWith('gian-browser://')
      && !state.loading,
  );

  const projectBeforeCrash = await window.evaluate(() =>
    window.gianDesktop.browser.getState('browser-smoke-primary'));
  await electronApp.evaluate(({ webContents }, targetUrl) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${targetUrl}`);
    target.forcefullyCrashRenderer();
  }, projectBeforeCrash.url);
  const crashedState = await waitForBrowserState(
    window,
    'browser-smoke-primary',
    state => state.recoverable === true && /renderer stopped/i.test(state.error ?? ''),
  );
  assert.equal(crashedState.url, projectBeforeCrash.url);
  await window.evaluate(() => window.gianDesktop.browser.recover('browser-smoke-primary'));
  await waitForBrowserState(
    window,
    'browser-smoke-primary',
    state => state.title === 'Browser Smoke Persisted' && !state.loading && !state.error,
  );

  await window.evaluate(async url => {
    const browser = window.gianDesktop.browser;
    await browser.setLayout('browser-smoke-primary', { x: 100, y: 100, width: 640, height: 420 }, false);
    await browser.setLayout('browser-smoke-secondary', { x: 100, y: 100, width: 640, height: 420 }, true);
    await browser.navigate('browser-smoke-secondary', url);
  }, `${host.origin}/browser-http`);
  await waitForBrowserState(
    window,
    'browser-smoke-secondary',
    state => state.title === 'Browser HTTP Ready'
      && state.url === `${host.origin}/browser-http`
      && !state.loading,
  );
  const independentTabs = await window.evaluate(async () => Promise.all([
    window.gianDesktop.browser.getState('browser-smoke-primary'),
    window.gianDesktop.browser.getState('browser-smoke-secondary'),
  ]));
  assert.equal(independentTabs[0].title, 'Browser Smoke Persisted');
  assert.match(independentTabs[0].url, /^gian-browser:\/\//);
  assert.equal(independentTabs[1].title, 'Browser HTTP Ready');
  assert.equal(independentTabs[1].url, `${host.origin}/browser-http`);
  assert.equal(
    await browserChildViewCount(electronApp, window),
    1,
    'switching Browser tabs must leave exactly one native view attached',
  );
  assert.equal(await window.evaluate(() => window.gianDesktop.browser.closeTab('browser-smoke-secondary')), true);
  assert.equal(await window.evaluate(() => window.gianDesktop.browser.setLayout(
    'browser-smoke-secondary',
    { x: 100, y: 100, width: 640, height: 420 },
    false,
  )), false, 'late BrowserPanel cleanup must not recreate a closed tab');
  assert.equal(
    (await window.evaluate(() => window.gianDesktop.browser.listTabs())).tabs
      .some(tab => tab.id === 'browser-smoke-secondary'),
    false,
  );
  assert.equal(
    (await window.evaluate(() => window.gianDesktop.browser.getState('browser-smoke-secondary'))).url,
    '',
  );
  await window.evaluate(() => window.gianDesktop.browser.setLayout(
    'browser-smoke-primary',
    { x: 100, y: 100, width: 640, height: 420 },
    true,
  ));

  assert.equal(await window.evaluate(() => window.gianDesktop.browser.clearData()), true);
  const clearedBrowserState = await window.evaluate(() => window.gianDesktop.browser.getState('browser-smoke-primary'));
  assert.equal(clearedBrowserState.url, '');
  assert.equal(clearedBrowserState.canGoBack, false);
  await window.evaluate(() => window.gianDesktop.browser.openProject('browser-smoke-primary', {
    workingTreeId: 'ws:smoke',
    path: 'site/index.html',
  }));
  await waitForBrowserState(
    window,
    'browser-smoke-primary',
    state => state.title === 'Browser Smoke Ready',
  );
  await window.evaluate(() => window.gianDesktop.browser.setLayout(
    'browser-smoke-primary',
    { x: 100, y: 100, width: 640, height: 420 },
    false,
  ));
  assert.equal(
    await browserChildViewCount(electronApp, window),
    0,
    'hiding Browser must detach its native view so renderer UI cannot be covered',
  );

  await window.screenshot({
    path: join(screenshotDir, 'gian-desktop-smoke.png'),
    fullPage: true,
  });

  const persistedTab = await window.evaluate(async url => {
    const browser = window.gianDesktop.browser;
    await browser.configure({
      home_page: url,
      restore_last_page: true,
      external_links: 'gian',
    });
    const created = await browser.createTab({ sourceSessionId: 'session-persist' });
    if (!created) throw new Error('Could not create persistent Browser tab');
    await browser.setLayout(created.id, { x: 100, y: 100, width: 640, height: 420 }, true);
    return created;
  }, `${host.origin}/browser-http`);
  await waitForBrowserState(
    window,
    persistedTab.id,
    state => state.title === 'Browser HTTP Ready' && !state.loading,
  );
  await window.evaluate(tabId => window.gianDesktop.browser.setLayout(
    tabId,
    { x: 100, y: 100, width: 640, height: 420 },
    false,
  ), persistedTab.id);

  await electronApp.close();
  electronApp = null;
  electronApp = await launchElectron();
  const restoredWindow = await electronApp.firstWindow();
  await restoredWindow.getByTestId('ready').waitFor({ timeout: 15_000 });
  const restoredSnapshot = await waitForBrowserTabs(restoredWindow, tabs =>
    tabs.some(tab => tab.id === persistedTab.id));
  const restoredTab = restoredSnapshot.tabs.find(tab => tab.id === persistedTab.id);
  assert.equal(restoredTab?.profileId, 'default');
  assert.equal(restoredTab?.sourceSessionId, 'session-persist');
  assert.equal(restoredTab?.state.url, `${host.origin}/browser-http`);
  await restoredWindow.evaluate(tabId => window.gianDesktop.browser.setLayout(
    tabId,
    { x: 100, y: 100, width: 640, height: 420 },
    true,
  ), persistedTab.id);
  await waitForBrowserState(
    restoredWindow,
    persistedTab.id,
    state => state.title === 'Browser HTTP Ready' && !state.loading,
  );
  await captureBrowserPage(
    electronApp,
    `${host.origin}/browser-http`,
    join(screenshotDir, 'gian-browser-restored-visible.png'),
  );
  assert.equal(await electronApp.evaluate(({ webContents }, targetUrl) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl);
    if (!target) throw new Error(`Browser WebContents not found: ${targetUrl}`);
    return target.executeJavaScript('document.documentElement.dataset.gianExtensionSmoke');
  }, `${host.origin}/browser-http`), 'loaded');
  console.log(`Electron ${packagedSmoke ? 'packaged ' : ''}smoke passed: ${restoredWindow.url()}`);
} finally {
  if (electronApp) await electronApp.close();
  await Promise.all([host.close(), web.close()]);
  await rm(smokeUserData, { recursive: true, force: true });
  await rm(smokeBrowserSocket, { force: true });
}
