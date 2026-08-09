import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import { sanitizedTestEnv } from './run-tests.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromHost = createRequire(join(rootDir, 'packages', 'host', 'package.json'));
const Database = requireFromHost('better-sqlite3');
const defaultAppPath = join(rootDir, 'packages', 'desktop', 'release', 'mac-arm64', 'Gian.app');
const PACKAGED_SMOKE_PROXY_VERSION = '0.4.0';

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

async function writeFakeClaude(path, version, probePidPath) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    '#!/bin/sh',
    `printf '%s\\n' "$PPID" > ${JSON.stringify(probePidPath)}`,
    `printf '%s\\n' 'claude ${version}'`,
    '',
  ].join('\n'));
  await chmod(path, 0o700);
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
    [join(unpacked, 'node_modules', '@gian', 'host', 'dist', 'cli', 'event-storage-v3.js'), false],
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

  const bundledNode = join(resources, 'runtime', 'node');
  const migrationCli = join(
    unpacked,
    'node_modules',
    '@gian',
    'host',
    'dist',
    'cli',
    'event-storage-v3.js',
  );
  const help = spawnSync(bundledNode, [migrationCli, '--help'], {
    encoding: 'utf8',
    env: sanitizedTestEnv(process.env),
  });
  assert.equal(help.status, 0, `packaged migration CLI --help failed: ${help.stderr}`);
  assert.match(help.stdout, /event-storage-v3 migrate/);

  return { executable, resources, migrationCli };
}

export function createPackagedSmokeEnvironment(source, {
  dataDir,
  desktopToken,
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
    GIAN_DESKTOP_SMOKE_RELEASE_VERSION: PACKAGED_SMOKE_PROXY_VERSION,
    GIAN_DESKTOP_SMOKE_TOKEN: desktopToken,
    GIAN_DESKTOP_USER_DATA_DIR: userDataDir,
    GIAN_GITHUB_CLIENT_ID: 'gian-packaged-smoke-client',
    GIAN_SKIP_PROXY_WARMUP: '1',
    HOME: homeDir,
    NO_COLOR: '1',
    // A fresh packaged profile must not inherit CLIs from the developer's
    // nvm/Homebrew PATH; the test configures exactly one isolated fake CLI.
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    XDG_CONFIG_HOME: join(homeDir, '.config'),
  };
}

async function desktopFetch(origin, desktopToken, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Gian-Desktop-Token', desktopToken);
  return fetch(`${origin}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(2_000),
  });
}

async function currentHostInstance(origin, desktopToken) {
  const response = await desktopFetch(origin, desktopToken, '/health');
  if (!response.ok) throw new Error(`packaged Host health failed: ${response.status}`);
  const payload = await response.json();
  assert.equal(typeof payload.instanceId, 'string');
  assert.ok(payload.instanceId.length > 0);
  return payload.instanceId;
}

async function waitForReplacementHost(origin, desktopToken, previousInstanceId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const instanceId = await currentHostInstance(origin, desktopToken);
      if (instanceId !== previousInstanceId) return instanceId;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
  }
  throw new Error(
    `packaged relaunch did not publish a replacement Host${lastError ? `: ${lastError}` : ''}`,
  );
}

function processValue(pid, field) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `could not inspect packaged smoke process ${pid}: ${result.stderr}`);
  return result.stdout.trim();
}

async function stopRelaunchedDesktop(executable, probePidPath) {
  const hostPid = Number((await readFile(probePidPath, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(hostPid) && hostPid > 0, 'fake CLI did not record its Host PID');
  const desktopPid = Number(processValue(hostPid, 'ppid'));
  assert.ok(Number.isSafeInteger(desktopPid) && desktopPid > 0, 'replacement Host has no desktop parent');
  const command = processValue(desktopPid, 'command');
  assert.ok(
    command.includes(executable),
    `refusing to stop unexpected packaged smoke parent: ${command}`,
  );
  process.kill(desktopPid, 'SIGTERM');
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
    assert.equal(
      await window.evaluate(() => typeof window.gianDesktop?.zoom?.set),
      'function',
    );
    await window.screenshot({ path: screenshotPath, fullPage: true });
    return { electronApp, window };
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

function terminalGroup(window) {
  return window.locator('.sheet-group').filter({
    has: window.getByTestId('sheet-tab-term').first(),
  });
}

async function activeTerminalId(window) {
  const id = await terminalGroup(window).getAttribute('data-active-tab-id');
  assert.ok(id, 'packaged terminal group has no active tab id');
  return id;
}

function terminalSlot(window, termId) {
  return window.locator(`.sheet-tab-slot[data-tab-id="${termId}"]`);
}

async function sendTerminalCommand(slot, command) {
  const input = slot.locator('.xterm-helper-textarea');
  await input.click();
  await input.pressSequentially(command);
  await input.press('Enter');
}

async function terminalText(slot) {
  return slot.locator('.xterm-rows').innerText();
}

async function fileText(path) {
  return readFile(path, 'utf8').catch(() => '');
}

async function closeTerminalTab(window, index) {
  const tabs = window.getByTestId('sheet-tab-term');
  const before = await tabs.count();
  const tab = tabs.nth(index);
  await tab.hover();
  await tab.locator('.tab-close').click();
  await expect(tabs).toHaveCount(before - 1);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  await expect.poll(() => processIsAlive(pid), { timeout: timeoutMs }).toBe(false);
}

async function installPackagedWebSocketCloseHook(window) {
  await window.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets = [];
    const TrackingWebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        sockets.push(socket);
        return socket;
      },
    });
    Object.defineProperty(window, 'WebSocket', {
      value: TrackingWebSocket,
      configurable: true,
    });
    Object.defineProperty(window, '__gianCloseLatestPackagedWs', {
      value: () => sockets.at(-1)?.close(4000, 'packaged terminal replay gap'),
      configurable: true,
    });
  });
}

async function createPackagedTerminalWorkspace({ desktopToken, origin, workspacePath }) {
  await mkdir(workspacePath, { recursive: true });
  const response = await desktopFetch(origin, desktopToken, '/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'packaged-terminal', path: workspacePath }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    throw new Error(`packaged terminal workspace failed (${response.status}): ${await response.text()}`);
  }
  const payload = await response.json();
  assert.equal(typeof payload.workspace?.path, 'string');
  assert.equal(await realpath(payload.workspace.path), await realpath(workspacePath));
  return payload.workspace.path;
}

async function runPackagedTerminalJourney({
  desktopToken,
  electronApp,
  homeDir,
  origin,
  screenshotPath,
  window,
  workspacePath,
}) {
  workspacePath = await createPackagedTerminalWorkspace({ desktopToken, origin, workspacePath });
  await installPackagedWebSocketCloseHook(window);
  await window.reload();
  await expect(window.getByTestId('app-shell')).toHaveAttribute('data-connection', 'ready', {
    timeout: 30_000,
  });

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
  });
  await window.getByTestId('dock-terminal').click();
  await expect(window.getByTestId('sheet-tab-term')).toHaveCount(1);
  await expect(terminalGroup(window)).toBeVisible();
  await expect(window.getByTestId('sheet-tab-term').first()).toContainText('terminal-workspace');

  const firstId = await activeTerminalId(window);
  const first = terminalSlot(window, firstId);
  await expect(first.locator('.xterm-screen')).toBeVisible();
  await sendTerminalCommand(first, 'stty -echo');
  await sendTerminalCommand(first, [
    `printf 'PACKAGED_SHELL:%s\\n' "\${0##*/}"`,
    `printf '%s' "$$" > .packaged-one-pid`,
    `pwd > .packaged-cwd`,
    `mkdir -p "$HOME/.cache/gian-terminal-smoke"`,
    `printf 'cache-ok' > "$HOME/.cache/gian-terminal-smoke/write.txt"`,
    `printf 'history-ok\\n' > "$HOME/.zsh_history"`,
    `id -u > "$HOME/.cache/gian-terminal-smoke/uid"`,
    `stty size > size-before.txt`,
  ].join('; '));
  await expect.poll(() => terminalText(first)).toMatch(/PACKAGED_SHELL:.*(?:zsh|bash|sh)/);
  await expect.poll(() => fileText(join(workspacePath, '.packaged-one-pid'))).toMatch(/^\d+$/);
  await expect.poll(() => fileText(join(workspacePath, '.packaged-cwd'))).toBe(`${workspacePath}\n`);
  await expect.poll(() => fileText(join(homeDir, '.cache', 'gian-terminal-smoke', 'write.txt')))
    .toBe('cache-ok');
  await expect.poll(() => fileText(join(homeDir, '.zsh_history'))).toBe('history-ok\n');
  if (typeof process.getuid === 'function') {
    await expect.poll(() => fileText(join(homeDir, '.cache', 'gian-terminal-smoke', 'uid')))
      .toBe(`${process.getuid()}\n`);
  }

  await window.locator('.tab-add').click();
  await expect(window.getByTestId('sheet-tab-term')).toHaveCount(2);
  const secondId = await activeTerminalId(window);
  assert.notEqual(secondId, firstId);
  const second = terminalSlot(window, secondId);
  await expect(second.locator('.xterm-screen')).toBeVisible();
  await sendTerminalCommand(second, 'stty -echo');
  await sendTerminalCommand(second, [
    `printf '%s' "$$" > .packaged-two-pid`,
    `trap 'printf closed > .packaged-two-closed; exit 0' TERM HUP`,
    `printf 'PACKAGED_TWO_READY\\n'`,
  ].join('; '));
  await expect.poll(() => terminalText(second)).toContain('PACKAGED_TWO_READY');
  const firstPid = Number(await fileText(join(workspacePath, '.packaged-one-pid')));
  const secondPid = Number(await fileText(join(workspacePath, '.packaged-two-pid')));
  assert.ok(Number.isSafeInteger(firstPid) && firstPid > 0);
  assert.ok(Number.isSafeInteger(secondPid) && secondPid > 0);
  assert.notEqual(secondPid, firstPid, 'packaged terminal tabs must own distinct shells');

  await window.getByTestId('sheet-tab-term').first().click();
  await expect(first).toBeVisible();
  await sendTerminalCommand(first,
    `test "$$" = "$(cat .packaged-one-pid)" && printf 'PACKAGED_TAB_KEPT\\n'`);
  await expect.poll(() => terminalText(first)).toContain('PACKAGED_TAB_KEPT');
  await window.getByTestId('dock-settings').click();
  await expect(window.getByTestId('settings-body')).toBeVisible();
  await expect(first).not.toBeVisible();
  await window.getByTestId('dock-terminal').click();
  await expect(first).toBeVisible();
  await sendTerminalCommand(first,
    `test "$$" = "$(cat .packaged-one-pid)" && printf 'PACKAGED_RAIL_KEPT\\n'`);
  await expect.poll(() => terminalText(first)).toContain('PACKAGED_RAIL_KEPT');

  const beforeSize = await fileText(join(workspacePath, 'size-before.txt'));
  assert.match(beforeSize, /^\d+ \d+\n?$/);
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 620);
  });
  await expect(first.locator('.xterm-screen')).toBeVisible();
  await sendTerminalCommand(first, `stty size > size-after.txt; printf 'PACKAGED_RESIZED\\n'`);
  await expect.poll(async () => {
    const afterSize = await fileText(join(workspacePath, 'size-after.txt'));
    return /^\d+ \d+\n?$/.test(afterSize) && afterSize !== beforeSize;
  }).toBe(true);
  await expect.poll(() => terminalText(first)).toContain('PACKAGED_RESIZED');

  await window.getByTestId('sheet-tab-term').nth(1).click();
  await closeTerminalTab(window, 1);
  await expect.poll(() => fileText(join(workspacePath, '.packaged-two-closed'))).toBe('closed');
  await waitForProcessExit(secondPid);

  await sendTerminalCommand(first, [
    `printf started > .packaged-offline-started`,
    `sleep 0.25`,
    `printf 'PACKAGED_OFFLINE_REPLAY\\n'`,
    `printf done > .packaged-offline-done`,
    `exit 7`,
  ].join('; '));
  await expect.poll(() => fileText(join(workspacePath, '.packaged-offline-started')))
    .toBe('started');
  await window.evaluate(() => {
    const close = window.__gianCloseLatestPackagedWs;
    if (!close) throw new Error('packaged WebSocket close hook was not installed');
    close();
  });
  await expect.poll(() => fileText(join(workspacePath, '.packaged-offline-done')), {
    timeout: 10_000,
  }).toBe('done');
  await expect(window.getByTestId('app-shell')).toHaveAttribute('data-connection', 'ready', {
    timeout: 15_000,
  });
  await expect.poll(() => terminalText(first), { timeout: 15_000 })
    .toContain('PACKAGED_OFFLINE_REPLAY');
  await expect.poll(() => terminalText(first), { timeout: 15_000 })
    .toContain('[terminal exit 7]');
  await waitForProcessExit(firstPid);
  await window.screenshot({ path: screenshotPath, fullPage: true });
  await closeTerminalTab(window, 0);
  await expect(window.getByTestId('sheet-tab-term')).toHaveCount(0);
}

async function seedPackagedGitHubCredential(electronApp) {
  const user = {
    id: 1,
    login: 'gian-release-smoke',
    name: 'Gian Release Smoke',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    profileUrl: 'https://github.com/gian-release-smoke',
  };
  const result = await electronApp.evaluate(({ app, safeStorage }, input) => {
    if (!safeStorage.isEncryptionAvailable()) return { available: false };
    const fs = process.getBuiltinModule('fs');
    const path = process.getBuiltinModule('path');
    const credentialPath = path.join(app.getPath('userData'), 'github-auth.json');
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(credentialPath, `${JSON.stringify({
      version: 1,
      encryptedToken: safeStorage.encryptString(input.token).toString('base64'),
      user: input.user,
      savedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    return { available: true, credentialPath };
  }, { token: 'gian-packaged-smoke-token', user });
  assert.equal(result.available, true, 'packaged smoke secure storage is unavailable');
  await assertFile(result.credentialPath);
  return user;
}

async function completePackagedOnboarding({
  dataDir,
  electronApp,
  fakeClaude,
  projectRoot,
  screenshotPath,
  window,
}) {
  const user = await seedPackagedGitHubCredential(electronApp);
  await window.reload();
  const onboarding = window.getByTestId('onboarding-shell');
  await onboarding.waitFor({ timeout: 30_000 });
  assert.match(await onboarding.innerText(), new RegExp(`@${user.login}`));

  // Step 1 remains explicit even for an already connected account.
  await onboarding.locator('.onboarding-actions .btn.primary').click();
  const claude = onboarding.locator('.onboarding-agent:has(.exec-dot.claude)');
  const cliPath = claude.locator('.onboarding-cli-path input');
  await cliPath.fill(fakeClaude);
  await claude.locator('.onboarding-cli-path button').click();
  await claude.locator('.onboarding-agent-components .ready', { hasText: fakeClaude })
    .waitFor({ timeout: 30_000 });
  assert.match(await claude.innerText(), /9\.8\.7/);

  // This is intentionally the previous public GitHub Release, not a routed
  // fixture. AgentManager verifies API asset digests, the exact .sha256 file,
  // archive bytes, self-test and compatibility before the atomic activation.
  await claude.locator('.onboarding-agent-summary button').click();
  await claude.locator('.onboarding-agent-components .ready', { hasText: 'Proxy' })
    .waitFor({ timeout: 120_000 });
  await claude.locator('.onboarding-agent-summary button').waitFor({ state: 'detached' });
  assert.match(await claude.innerText(), /0\.4\.0.*GitHub|GitHub.*0\.4\.0/s);

  const activatedProxy = await realpath(join(dataDir, 'plugins', 'claude', 'current'));
  assert.equal(
    activatedProxy,
    await realpath(join(dataDir, 'plugins', 'claude', PACKAGED_SMOKE_PROXY_VERSION)),
  );
  await Promise.all([
    assertFile(join(activatedProxy, 'manifest.json')),
    assertFile(join(activatedProxy, 'proxy.mjs')),
  ]);

  // Any one ready Agent unlocks directory setup; Codex/Kimi stay installable
  // later and must not block completion.
  await onboarding.locator('.onboarding-actions .btn.primary').click();
  const rootInput = onboarding.locator('#onboarding-root');
  await rootInput.fill(projectRoot);
  assert.match(await onboarding.innerText(), new RegExp(
    `${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/worktrees`,
  ));
  await onboarding.locator('.onboarding-actions .btn.primary').click();
  await window.getByTestId('app-shell').waitFor({ timeout: 30_000 });
  await window.screenshot({ path: screenshotPath, fullPage: true });

  const finalState = await window.evaluate(async () => {
    const response = await fetch('/api/onboarding');
    if (!response.ok) throw new Error(`Onboarding state failed: ${response.status}`);
    return await response.json();
  });
  assert.equal(finalState.completed, true);
  assert.equal(finalState.projectRoot, projectRoot);
  assert.equal(finalState.agents.find(agent => agent.id === 'claude')?.ready, true);
  assert.equal(finalState.agents.find(agent => agent.id === 'codex')?.ready, false);
  assert.equal(finalState.agents.find(agent => agent.id === 'kimi')?.ready, false);
}

function seedPriorVersionFixture(databasePath) {
  const db = new Database(databasePath);
  try {
    db.exec(`
      INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
      VALUES('migration-ws','Migration Fixture','/tmp/gian-migration-fixture',0,0,datetime('now'),datetime('now'));
      INSERT INTO sessions(
        id,name,type,workspace_id,executor,approval_mode,status,archived,unread,
        native_session_id,created_at,updated_at
      ) VALUES(
        'migration-session','Migration Fixture','primary','migration-ws','kimi',
        'default','done',0,0,'migration-native',datetime('now'),datetime('now')
      );
      INSERT INTO turns(id,session_id,turn_number,status,completed_at)
      VALUES('migration-turn','migration-session',1,'completed',datetime('now'));
    `);
    const insert = db.prepare(`
      INSERT INTO events(id,session_id,turn_id,call_id,type,data)
      VALUES(?,?,?,?,?,?)
    `);
    db.transaction(() => {
      for (let index = 0; index < 300; index++) {
        insert.run(
          `migration-event-${index}`,
          'migration-session',
          'migration-turn',
          `legacy-call-${index}`,
          'acp.sessionUpdate',
          JSON.stringify({
            __gian_event: 2,
            provider: 'kimi',
            raw: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'fixture-tool', index } },
            display: {
              type: 'activity.tool',
              data: { itemId: 'fixture-tool', title: 'Fixture', status: index === 299 ? 'success' : 'running' },
            },
          }),
        );
      }
    })();
  } finally {
    db.close();
  }
}

function runMigrationCli(nodePath, cliPath, args, env) {
  const result = spawnSync(nodePath, [cliPath, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, `packaged migration CLI failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1) throw new Error('usage: node scripts/run-packaged-app-smoke.mjs [Gian.app]');
  if (process.platform !== 'darwin') throw new Error('packaged Gian smoke requires macOS');

  const appPath = resolve(args[0] ?? process.env.GIAN_PACKAGED_APP_PATH ?? defaultAppPath);
  const { executable, resources, migrationCli } = await validatePackagedApp(appPath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'gian-packaged-smoke-'));
  const dataDir = join(temporaryRoot, 'data');
  const homeDir = join(temporaryRoot, 'home');
  const userDataDir = join(temporaryRoot, 'profile');
  const screenshotDir = join(rootDir, 'output', 'playwright');
  const hostPort = await reservePort();
  const origin = `http://127.0.0.1:${hostPort}`;
  const desktopToken = randomBytes(32).toString('base64url');
  let electronApp;

  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
    mkdir(screenshotDir, { recursive: true }),
  ]);
  const env = createPackagedSmokeEnvironment(process.env, {
    dataDir,
    desktopToken,
    homeDir,
    hostPort,
    userDataDir,
  });
  const fakeClaude = join(temporaryRoot, 'bin', 'claude');
  const fakeClaudeProbePid = join(temporaryRoot, 'fake-claude-host-pid');
  const projectRoot = join(temporaryRoot, 'projects');
  const terminalWorkspace = join(projectRoot, 'terminal-workspace');
  await writeFakeClaude(fakeClaude, '9.8.7', fakeClaudeProbePid);

  try {
    const firstLaunch = await launchPackagedApp({
      executable,
      env,
      hostLogPath: join(dataDir, 'logs', 'desktop-host.log'),
      origin,
      screenshotPath: join(screenshotDir, 'gian-packaged-first-run.png'),
    });
    electronApp = firstLaunch.electronApp;
    const firstHostInstance = await currentHostInstance(origin, desktopToken);
    await assertFile(join(dataDir, 'gian.db'));
    await assertFile(join(dataDir, 'logs', 'desktop-host.log'));
    await completePackagedOnboarding({
      dataDir,
      electronApp,
      fakeClaude,
      projectRoot,
      screenshotPath: join(screenshotDir, 'gian-packaged-onboarding-complete.png'),
      window: firstLaunch.window,
    });
    await runPackagedTerminalJourney({
      desktopToken,
      electronApp,
      homeDir,
      origin,
      screenshotPath: join(screenshotDir, 'gian-packaged-terminal.png'),
      window: firstLaunch.window,
      workspacePath: terminalWorkspace,
    });

    // Change the executable in place immediately before the real packaged
    // restart. The replacement Host must not reuse the old RuntimeManager or
    // its version result.
    const firstHostPid = Number((await readFile(fakeClaudeProbePid, 'utf8')).trim());
    await writeFakeClaude(fakeClaude, '9.8.8', fakeClaudeProbePid);
    const firstDesktopExit = new Promise(resolveExit => {
      electronApp.process().once('exit', resolveExit);
    });
    assert.equal(
      await firstLaunch.window.evaluate(() => window.gianDesktop?.restartApp()),
      true,
    );
    await firstDesktopExit;
    electronApp = undefined;
    const replacementHostInstance = await waitForReplacementHost(
      origin,
      desktopToken,
      firstHostInstance,
    );
    assert.notEqual(replacementHostInstance, firstHostInstance);
    const relaunchedResponse = await desktopFetch(
      origin,
      desktopToken,
      '/api/agents/claude?refresh=1',
    );
    assert.equal(relaunchedResponse.status, 200);
    const relaunched = await relaunchedResponse.json();
    assert.equal(relaunched.cli.path, fakeClaude);
    assert.equal(relaunched.cli.version, '9.8.8');
    assert.equal(relaunched.cli.source, 'override');
    const replacementHostPid = Number((await readFile(fakeClaudeProbePid, 'utf8')).trim());
    assert.notEqual(replacementHostPid, firstHostPid, 'app relaunch must replace the Host process');

    const databasePath = join(dataDir, 'gian.db');
    seedPriorVersionFixture(databasePath);
    const migrationReportPath = join(dataDir, 'event-v3-inspect.json');
    const migrationBackupDirectory = join(dataDir, 'migrations');
    await mkdir(migrationBackupDirectory, { recursive: true });
    const bundledNode = join(resources, 'runtime', 'node');
    const inspection = runMigrationCli(
      bundledNode,
      migrationCli,
      ['inspect', '--db', databasePath, '--report', migrationReportPath],
      env,
    );
    assert.equal(inspection.events, 300);
    const migration = runMigrationCli(
      bundledNode,
      migrationCli,
      [
        'migrate',
        '--db',
        databasePath,
        '--backup-dir',
        migrationBackupDirectory,
        '--confirm',
        inspection.confirmationToken,
      ],
      env,
    );
    assert.equal(migration.state, 'active');
    const migrated = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(
        migrated.prepare(`SELECT state FROM event_storage_meta WHERE singleton = 1`).pluck().get(),
        'active',
      );
      assert.equal(migrated.prepare('SELECT COUNT(*) FROM events').pluck().get(), 1);
    } finally {
      migrated.close();
    }

    await stopRelaunchedDesktop(executable, fakeClaudeProbePid);
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
