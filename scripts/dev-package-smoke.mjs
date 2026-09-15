import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { assertExecutionAllowed } from './execution-policy.mjs';
import { assertDevOAuthConfiguration, assertDevSigningEntitlements, requireDevOAuthClientId } from './dev-package-config.mjs';

assertExecutionAllowed('desktop');
const expectedClientId = requireDevOAuthClientId(process.env.GIAN_GITHUB_CLIENT_ID);
const require = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const { _electron } = require('playwright');
const root = await mkdtemp(join(tmpdir(), 'gian-dev-smoke-'));
const release = resolve('packages/desktop/release');
const archive = resolve(process.argv[2] ?? join(release, (await readdir(release)).find(name => /^GianDev-.*\.zip$/.test(name)) ?? 'missing.zip'));
const desktopToken = randomBytes(32).toString('base64url');
const logs = [];
await mkdir('output/dev-package', { recursive: true });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIAN_')));
try {
  execFileSync('ditto', ['-x', '-k', archive, join(root, 'unpacked')]);
  const appPath = join(root, 'unpacked', 'GianDev.app');
  const bundledNode = join(appPath, 'Contents', 'Resources', 'runtime', 'node');
  const authConfig = JSON.parse(await readFile(join(appPath, 'Contents', 'Resources', 'runtime', 'github-auth.json'), 'utf8'));
  assertDevOAuthConfiguration(authConfig, expectedClientId);
  logs.push('Verified embedded OAuth client configuration.\n');
  const frameworks = join(appPath, 'Contents', 'Frameworks');
  const helpers = (await readdir(frameworks)).filter(name => name.endsWith('.app'));
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
  // A build-runner launch alone does not prove cross-machine ad-hoc loading.
  // Check the effective signed entitlements in the extracted ZIP as well.
  for (const target of [appPath, bundledNode, ...helpers.map(name => join(frameworks, name))]) {
    const xml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', target]);
    const entitlements = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' }));
    assertDevSigningEntitlements(entitlements);
  }
  const nativeModules = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
  const nativeCheck = `
    const Database = require(process.argv[1]);
    const db = new Database(':memory:');
    if (db.prepare('select 1 as ok').get().ok !== 1) throw new Error('SQLite check failed');
    db.close();
    require(process.argv[2]);
  `;
  execFileSync(bundledNode, ['-e', nativeCheck, join(nativeModules, 'better-sqlite3'), join(nativeModules, 'node-pty')], {
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root },
    timeout: 15_000,
  });
  logs.push(`Verified Dev signing for App, bundled Node and ${helpers.length} helpers; native module loading passed.\n`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const app = await _electron.launch({
      executablePath: join(root, 'unpacked', 'GianDev.app/Contents/MacOS/GianDev'),
      env: { ...clean, GIAN_DATA_DIR: join(root, 'data'), GIAN_DESKTOP_USER_DATA_DIR: join(root, 'profile'), GIAN_DESKTOP_SMOKE_MANAGE_HOST: '1', GIAN_DESKTOP_SMOKE_TOKEN: desktopToken, GIAN_DESKTOP_HOST_URL: `http://127.0.0.1:${port}`, GIAN_DESKTOP_WEB_URL: `http://127.0.0.1:${port}` },
    });
    app.process().stdout?.on('data', data => logs.push(data.toString()));
    app.process().stderr?.on('data', data => logs.push(data.toString()));
    try {
      const page = await app.firstWindow();
      await page.waitForURL(`http://127.0.0.1:${port}/**`, { timeout: 60000 });
      await page.locator('#root').waitFor();
      await page.waitForFunction(() => (document.querySelector('#root')?.textContent ?? '').trim().length > 0);
      assert.ok((await page.locator('#root').innerText()).trim().length > 0);
      const authState = await page.evaluate(() => window.gianDesktop.githubAuth.getState());
      assert.notEqual(authState.reason, 'not_configured', 'Packaged OAuth service ignored its embedded client id');
      logs.push(`Packaged OAuth service: ${authState.status}.\n`);
      const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'X-Gian-Desktop-Token': desktopToken }, signal: AbortSignal.timeout(2000) });
      assert.equal(health.status, 200);
    } finally { await app.close(); }
    // A closed shell must not leave its managed Host holding the port.
    let stopped = false;
    for (let poll = 0; poll < 50; poll++) {
      try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); }
      catch { stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(stopped, 'Managed Host did not stop after App exit');
  }
} catch (error) {
  logs.push(`${error instanceof Error ? error.message : String(error)}\n`);
  throw error;
} finally {
  await writeFile('output/dev-package/lifecycle.log', logs.join(''));
  await rm(root, { recursive: true, force: true });
}
