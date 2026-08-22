import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
        body: '<!doctype html><html><head><link rel="stylesheet" href="./style.css"><script type="module" src="./app.js"></script></head><body><main id="browser-smoke">loading</main></body></html>',
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
    response.end('<!doctype html><title>Browser HTTP Ready</title><p>HTTP preview</p>');
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

let electronApp;
try {
  electronApp = await electron.launch({
    executablePath: electronPath,
    args: packagedSmoke ? [] : ['.'],
    cwd: packageDir,
    env: {
      ...cleanEnvironment,
      GIAN_DESKTOP_DISABLE_HOST_MANAGEMENT: '1',
      GIAN_DESKTOP_HOST_URL: host.origin,
      GIAN_DESKTOP_USER_DATA_DIR: smokeUserData,
      GIAN_DESKTOP_WEB_URL: web.origin,
    },
  });

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

  await window.evaluate(() => window.gianDesktop.browser.goBack('browser-smoke-primary'));
  await waitForBrowserState(
    window,
    'browser-smoke-primary',
    state => state.title === 'Browser Smoke Persisted'
      && state.url.startsWith('gian-browser://')
      && !state.loading,
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
  console.log(`Electron ${packagedSmoke ? 'packaged ' : ''}smoke passed: ${window.url()}`);
} finally {
  if (electronApp) await electronApp.close();
  await Promise.all([host.close(), web.close()]);
  await rm(smokeUserData, { recursive: true, force: true });
}
