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
const packagedSmoke = Boolean(process.env.GIAN_DESKTOP_SMOKE_EXECUTABLE);
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const smokeUserData = await mkdtemp(join(tmpdir(), 'gian-desktop-smoke-'));

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

let hostHealthy = false;
const host = await listen((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: hostHealthy }));
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
    args: packagedSmoke
      ? [`--user-data-dir=${smokeUserData}`]
      : [`--user-data-dir=${smokeUserData}`, '.'],
    cwd: packageDir,
    env: {
      ...process.env,
      GIAN_DESKTOP_DISABLE_HOST_MANAGEMENT: '1',
      GIAN_DESKTOP_HOST_URL: host.origin,
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

  hostHealthy = true;
  await retry.click();
  await window.getByTestId('ready').waitFor();
  assert.equal(new URL(window.url()).origin, web.origin);
  assert.equal(await window.title(), 'Gian Desktop Smoke');
  assert.equal(
    await window.evaluate(() => typeof window.gianDesktop?.retryConnection),
    'function',
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
