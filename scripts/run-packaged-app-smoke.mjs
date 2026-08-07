import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { sanitizedTestEnv } from './run-tests.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultAppPath = join(rootDir, 'packages', 'desktop', 'release', 'mac-arm64', 'Gian.app');

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('could not reserve a packaged smoke port');
  }
  await new Promise((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
  return address.port;
}

async function assertFile(path, executable = false) {
  await access(path);
  const metadata = await stat(path);
  assert.equal(metadata.isFile(), true, `expected a file: ${path}`);
  if (executable) {
    assert.notEqual(metadata.mode & 0o111, 0, `expected an executable file: ${path}`);
  }
}

export async function validatePackagedApp(appPath) {
  const contents = join(appPath, 'Contents');
  const resources = join(contents, 'Resources');
  const unpacked = join(resources, 'app.asar.unpacked');
  const executable = join(contents, 'MacOS', 'Gian');
  const required = [
    [executable, true],
    [join(resources, 'app.asar'), false],
    [join(resources, 'runtime', 'node'), true],
    [join(resources, 'runtime', 'NODE-LICENSE'), false],
    [join(resources, 'runtime', 'github-auth.json'), false],
    [join(resources, 'web', 'index.html'), false],
    [join(unpacked, 'node_modules', '@gian', 'host', 'dist', 'index.js'), false],
    [join(unpacked, 'node_modules', '@gian', 'host', 'migrations', '001_initial.sql'), false],
  ];
  for (const [path, executableFile] of required) {
    await assertFile(path, executableFile);
  }

  const unpackedFiles = (await readdir(unpacked, { recursive: true }))
    .map(path => String(path).replaceAll('\\', '/'));
  for (const nativeFile of ['better_sqlite3.node', 'pty.node', 'spawn-helper']) {
    assert.equal(
      unpackedFiles.some(path => path.endsWith(`/${nativeFile}`) || path === nativeFile),
      true,
      `packaged native runtime is missing ${nativeFile}`,
    );
  }

  return { executable, resources };
}

export function createPackagedSmokeEnvironment(source, {
  dataDir,
  homeDir,
  hostPort,
  userDataDir,
}) {
  const clean = sanitizedTestEnv(source);
  delete clean.ELECTRON_RUN_AS_NODE;
  delete clean.FORCE_COLOR;
  return {
    ...clean,
    GIAN_DATA_DIR: dataDir,
    GIAN_DESKTOP_HOST_URL: `http://127.0.0.1:${hostPort}`,
    GIAN_DESKTOP_SMOKE_MANAGE_HOST: '1',
    GIAN_DESKTOP_USER_DATA_DIR: userDataDir,
    GIAN_SKIP_PROXY_WARMUP: '1',
    HOME: homeDir,
    NO_COLOR: '1',
    XDG_CONFIG_HOME: join(homeDir, '.config'),
  };
}

async function responds(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(300) });
    return true;
  } catch {
    return false;
  }
}

async function waitForHostExit(origin, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await responds(`${origin}/health`))) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
  }
  throw new Error(`packaged Host still responds after App exit: ${origin}`);
}

async function launchPackagedApp({ executable, env, hostLogPath, origin, screenshotPath }) {
  const electronApp = await electron.launch({
    executablePath: executable,
    args: ['--use-mock-keychain'],
    env,
  });
  const window = await electronApp.firstWindow();
  const rendererMessages = [];
  window.on('console', message => {
    rendererMessages.push(`console.${message.type()}: ${message.text()}`);
  });
  window.on('pageerror', error => {
    rendererMessages.push(`pageerror: ${error.stack ?? error.message}`);
  });
  try {
    await window.locator('.login-shell').waitFor({ timeout: 30_000 });
    assert.equal(new URL(window.url()).origin, origin);
    assert.equal(
      await window.evaluate(() => window.gianDesktop?.appVariant),
      'production',
    );
    assert.equal(
      await window.evaluate(() => typeof window.gianDesktop?.restartApp),
      'function',
    );
    await window.screenshot({ path: screenshotPath, fullPage: true });
    return electronApp;
  } catch (error) {
    await window.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    const diagnostics = await window.evaluate(() => ({
      body: document.body.innerText,
      html: document.documentElement.outerHTML.slice(0, 4_000),
      readyState: document.readyState,
      scripts: Array.from(document.scripts, script => script.src),
      title: document.title,
      url: location.href,
    })).catch(() => ({
      body: '<unavailable>',
      html: '<unavailable>',
      readyState: '<unavailable>',
      scripts: [],
      title: '<unavailable>',
      url: window.url(),
    }));
    console.error('[packaged-smoke] window diagnostics', {
      ...diagnostics,
      rendererMessages: rendererMessages.slice(-100),
      screenshotPath,
    });
    const hostLog = await readFile(hostLogPath, 'utf8').catch(() => '<unavailable>');
    console.error('[packaged-smoke] host log tail', hostLog.slice(-8_000));
    await electronApp.close().catch(() => undefined);
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1) throw new Error('usage: node scripts/run-packaged-app-smoke.mjs [Gian.app]');
  if (process.platform !== 'darwin') throw new Error('packaged Gian smoke requires macOS');

  const appPath = resolve(args[0] ?? process.env.GIAN_PACKAGED_APP_PATH ?? defaultAppPath);
  const { executable } = await validatePackagedApp(appPath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'gian-packaged-smoke-'));
  const dataDir = join(temporaryRoot, 'data');
  const homeDir = join(temporaryRoot, 'home');
  const userDataDir = join(temporaryRoot, 'profile');
  const screenshotDir = join(rootDir, 'output', 'playwright');
  const hostPort = await reservePort();
  const origin = `http://127.0.0.1:${hostPort}`;
  let electronApp;

  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
    mkdir(screenshotDir, { recursive: true }),
  ]);
  const env = createPackagedSmokeEnvironment(process.env, {
    dataDir,
    homeDir,
    hostPort,
    userDataDir,
  });

  try {
    electronApp = await launchPackagedApp({
      executable,
      env,
      hostLogPath: join(dataDir, 'logs', 'desktop-host.log'),
      origin,
      screenshotPath: join(screenshotDir, 'gian-packaged-first-run.png'),
    });
    await assertFile(join(dataDir, 'gian.db'));
    await assertFile(join(dataDir, 'logs', 'desktop-host.log'));
    await electronApp.close();
    electronApp = undefined;
    await waitForHostExit(origin);

    electronApp = await launchPackagedApp({
      executable,
      env,
      hostLogPath: join(dataDir, 'logs', 'desktop-host.log'),
      origin,
      screenshotPath: join(screenshotDir, 'gian-packaged-reopen.png'),
    });
    await electronApp.close();
    electronApp = undefined;
    await waitForHostExit(origin);

    console.log(`Packaged app smoke passed: ${appPath}`);
    return 0;
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined);
    await waitForHostExit(origin).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error('[packaged-smoke] failed', error);
    process.exitCode = 1;
  }
}
