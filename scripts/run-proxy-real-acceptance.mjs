import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  HostProtocolValidator,
  SUPPORTED_PROTOCOL_VERSIONS,
  parseProxyNotification,
} from '../packages/proxy-protocol/dist/src/index.js';
import {
  activateDefaultKimiStore,
  resolveProviderBinary,
} from './run-provider-attachment-canary.mjs';
import {
  loadProxyRealAcceptanceCatalog,
  validateProxyRealAcceptanceCatalog,
} from './proxy-real-acceptance-catalog.mjs';
import { proxyDefinitions, shippingProxyIds } from './build-proxy-artifacts.mjs';
import {
  finalizeProviderScenarioResults,
  realScenarioRequirement,
} from './proxy-certification-policy.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const allowRealTurnEnvironment = 'GIAN_ALLOW_REAL_AGENT_TURN';
const defaultTimeoutMs = 180_000;
const protocolOffers = [...SUPPORTED_PROTOCOL_VERSIONS];
const providerIds = proxyDefinitions.map(definition => definition.id);
const definitionByProvider = new Map(proxyDefinitions.map(definition => [definition.id, definition]));
const proxyPaths = Object.fromEntries(proxyDefinitions.map(definition => [
  definition.id,
  join(rootDir, 'packages', 'proxies', definition.directory, 'dist/src/cli/spawn.js'),
]));
const binaryEnvironment = Object.fromEntries(proxyDefinitions.map(definition => [
  definition.id,
  definition.environment.runtimeBinary,
]));

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function timestampSlug() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
}

function parseArgs(argv) {
  const options = {
    providers: [],
    scenarios: [],
    configOverrides: {},
    catalogOnly: false,
    artifactDir: null,
    allowUnverifiedCli: false,
    output: `output/proxy-real-acceptance/run-${timestampSlug()}`,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') options.providers.push(argv[++index]);
    else if (arg === '--scenario') options.scenarios.push(argv[++index]);
    else if (arg === '--catalog-only') options.catalogOnly = true;
    else if (arg === '--artifact-dir') {
      options.artifactDir = argv[++index];
      if (!options.artifactDir) throw new Error('--artifact-dir requires a value.');
    }
    else if (arg === '--allow-unverified-cli') options.allowUnverifiedCli = true;
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--config') {
      const assignment = argv[++index] ?? '';
      const separator = assignment.indexOf('=');
      if (separator < 1) throw new Error('--config requires optionId=value.');
      const key = assignment.slice(0, separator);
      const raw = assignment.slice(separator + 1);
      try {
        options.configOverrides[key] = JSON.parse(raw);
      } catch {
        options.configOverrides[key] = raw;
      }
    }
    else throw new Error(`Unknown argument ${arg}.`);
  }
  if (options.providers.length === 0) options.providers = [...shippingProxyIds];
  if (options.providers.includes('all')) options.providers = [...shippingProxyIds];
  for (const provider of options.providers) {
    if (!providerIds.includes(provider)) throw new Error(`Unsupported provider ${provider}.`);
  }
  return options;
}

function redact(text) {
  return String(text)
    .replace(/(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password)(["'\s:=]+)([^\s,"'}]+)/giu, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [redacted]');
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for process ${child.pid}.`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

function stopProcessTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // It may have exited between the liveness check and signal.
  }
}

function processGroupAlive(pgid) {
  if (process.platform === 'win32' || !pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForProcessGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pgid)) return true;
    await delay(25);
  }
  return !processGroupAlive(pgid);
}

function killProcessGroup(pgid, signal) {
  if (process.platform === 'win32' || !pgid) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group may exit between the liveness check and signal.
  }
}

class ValidatedProxyClient extends EventEmitter {
  constructor({ provider, providerConfig, proxyPath, binaryPath, dataDir, outputDir, timeoutMs, environment = {} }) {
    super();
    this.provider = provider;
    this.providerConfig = providerConfig;
    this.proxyPath = proxyPath;
    this.binaryPath = binaryPath;
    this.dataDir = dataDir;
    this.outputDir = outputDir;
    this.timeoutMs = timeoutMs;
    this.environment = environment;
    this.validator = new HostProtocolValidator({
      pluginId: providerConfig.pluginId ?? provider,
      pluginVersion: providerConfig.pluginVersion,
      processScope: providerConfig.processScope,
    });
    this.nextId = 1;
    this.pending = new Map();
    this.requests = [];
    this.outputs = [];
    this.notifications = [];
    this.stderr = '';
    this.protocolFailure = null;
    this.child = null;
    this.cleanupEvidence = null;
  }

  async start() {
    if (this.child) return;
    const binaryArgument = definitionByProvider.get(this.provider)?.qualification.binaryArgument;
    const args = [
      this.proxyPath,
      ...(binaryArgument ? [binaryArgument, this.binaryPath] : []),
    ];
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [binaryEnvironment[this.provider]]: this.binaryPath,
        GIAN_RUNTIME_BIN: this.binaryPath,
        GIAN_PLUGIN_DATA_DIR: this.dataDir,
        ...this.environment,
        ...(this.provider === 'kimi' ? { KIMI_CODE_NO_AUTO_UPDATE: '1' } : {}),
        ...(this.provider === 'grok'
          ? {
              GROK_DISABLE_AUTOUPDATER: '1',
              GIAN_PROTOCOL_VERSIONS: protocolOffers.join(','),
            }
          : {}),
      },
    });
    this.child = child;
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      if (!line.trim()) return;
      this.outputs.push({ at: new Date().toISOString(), line });
      let accepted;
      try {
        accepted = this.validator.acceptLine(line);
      } catch (error) {
        this.failProtocol(error);
        return;
      }
      if (!accepted) return;
      if ('method' in accepted) {
        const notification = parseProxyNotification(accepted);
        this.notifications.push(notification);
        this.emit('notification', notification);
        return;
      }
      const pending = this.pending.get(String(accepted.id));
      if (!pending) {
        this.failProtocol(new Error(`Response ${String(accepted.id)} has no Harness request.`));
        return;
      }
      this.pending.delete(String(accepted.id));
      clearTimeout(pending.timer);
      if ('error' in accepted) pending.reject(Object.assign(new Error(accepted.error?.message ?? 'Proxy error'), {
        envelope: accepted,
      }));
      else pending.resolve(accepted.result);
    });
    child.stderr.on('data', chunk => {
      if (this.stderr.length < 256 * 1024) this.stderr += chunk.toString();
    });
    child.once('error', error => this.failProtocol(error));
    child.once('exit', (code, signal) => {
      if (this.pending.size > 0) {
        this.failProtocol(new Error(`Proxy exited with pending requests (code=${code}, signal=${signal}).`));
      }
      this.emit('exit', { code, signal });
    });
    await delay(50);
  }

  failProtocol(error) {
    if (!this.protocolFailure) this.protocolFailure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    await this.start();
    if (this.protocolFailure) throw this.protocolFailure;
    const id = `accept-${this.nextId++}`;
    const message = { jsonrpc: '2.0', id, method, params };
    this.validator.registerRequest(message);
    this.requests.push({ at: new Date().toISOString(), message });
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  async requestUnchecked(method, params, validationParams, timeoutMs = this.timeoutMs) {
    await this.start();
    if (this.protocolFailure) throw this.protocolFailure;
    const id = `accept-${this.nextId++}`;
    const validationMessage = { jsonrpc: '2.0', id, method, params: validationParams };
    this.validator.registerRequest(validationMessage);
    const message = { jsonrpc: '2.0', id, method, params };
    this.requests.push({ at: new Date().toISOString(), message, unchecked: true });
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for unchecked ${method} after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  notificationIndex() {
    return this.notifications.length;
  }

  notificationsSince(index) {
    return this.notifications.slice(index);
  }

  async waitForNotification(predicate, from, label, timeoutMs = this.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.protocolFailure) throw this.protocolFailure;
      const match = this.notifications.slice(from).find(predicate);
      if (match) return match;
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  async stop() {
    const child = this.child;
    if (!child) return { pid: null, lingeringAfterGraceful: false, cleanupSucceeded: true };
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await this.request('shutdown', {}, 5_000);
        await waitForExit(child, 5_000);
      } catch {
        stopProcessTree(child, 'SIGTERM');
        await waitForExit(child, 2_000).catch(() => {
          stopProcessTree(child, 'SIGKILL');
        });
      }
    }
    if (!this.cleanupEvidence) {
      const pid = child.pid ?? null;
      const lingeringAfterGraceful = !await waitForProcessGroupExit(pid, 500);
      if (lingeringAfterGraceful) {
        killProcessGroup(pid, 'SIGTERM');
        if (!await waitForProcessGroupExit(pid, 2_000)) {
          killProcessGroup(pid, 'SIGKILL');
          await waitForProcessGroupExit(pid, 2_000);
        }
      }
      this.cleanupEvidence = {
        pid,
        lingeringAfterGraceful,
        cleanupSucceeded: !processGroupAlive(pid),
      };
    }
    await mkdir(this.outputDir, { recursive: true });
    await Promise.all([
      writeFile(
        join(this.outputDir, 'host-requests.ndjson'),
        this.requests.map(entry => JSON.stringify(entry)).join('\n') + '\n',
        'utf8',
      ),
      writeFile(
        join(this.outputDir, 'proxy-output.ndjson'),
        this.outputs.map(entry => JSON.stringify(entry)).join('\n') + '\n',
        'utf8',
      ),
      writeFile(join(this.outputDir, 'proxy-stderr.log'), redact(this.stderr), 'utf8'),
    ]);
    return this.cleanupEvidence;
  }
}

async function resolveBinary(provider, providerConfig) {
  const setup = definitionByProvider.get(provider)?.qualification.setup;
  const configured = configuredProviderBinary(provider, providerConfig);
  if (configured && isAbsolute(configured)) return resolveProviderBinary(provider, configured);
  if (setup === 'dsh-profile' && configured) {
    return resolveProviderBinary(provider, resolve(rootDir, configured));
  }
  if (setup === 'kimi-store') {
    return resolveProviderBinary(provider, process.env.KIMI_BIN ?? join(homedir(), '.kimi-code/bin/kimi'));
  }
  return resolveProviderBinary(provider, configured);
}

export function configuredProviderBinary(provider, providerConfig, environment = process.env) {
  const environmentName = binaryEnvironment[provider];
  const environmentPath = typeof environmentName === 'string'
    ? environment[environmentName]?.trim()
    : '';
  const configured = environmentPath || (
    typeof providerConfig.binary === 'string' ? providerConfig.binary.trim() : ''
  );
  return configured ? configured.replace(/^~(?=\/)/, homedir()) : undefined;
}

export async function verifyWorkspaceToolOutcome(workspace) {
  const finalText = await readFile(join(workspace, 'final.txt'), 'utf8').catch(() => null);
  const obsoleteMissing = await access(join(workspace, 'obsolete.txt')).then(
    () => false,
    () => true,
  );
  return {
    ok: finalText?.trim() === 'TOOL_FLOW_OK' && obsoleteMissing,
    finalMarker: finalText?.trim() ?? null,
    obsoleteMissing,
  };
}

export function concurrencyHoldStrategy(providerConfig) {
  return providerConfig.capabilities.includes('interaction')
    ? 'interaction'
    : 'running_activity';
}

export function reasoningExpectedFor(runtimeCatalog, turnConfig) {
  const thinkingOption = runtimeCatalog.specialCatalogs?.thinking;
  return typeof thinkingOption === 'string' && turnConfig[thinkingOption] !== 'off';
}

async function inspectCliCandidate(provider, binaryPath, allowUnverifiedCli) {
  const definition = definitionByProvider.get(provider);
  const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  const rawVersion = `${stdout}\n${stderr}`.trim();
  const version = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/u.exec(rawVersion)?.[1];
  if (!version) throw new Error(`${provider} CLI --version did not expose a SemVer: ${rawVersion}`);
  const verified = definition?.runtime.verifiedCliVersions.includes(version) ?? false;
  if (!verified && !allowUnverifiedCli) {
    throw new Error(
      `${provider} CLI ${version} is not in runtime.verifiedCliVersions; use --allow-unverified-cli only for focused candidate diagnosis.`,
    );
  }
  return { path: binaryPath, version, verified, rawVersion };
}

async function prepareProxyCandidate(provider, providerConfig, artifactDir, tempRoot) {
  if (!artifactDir) {
    return {
      source: 'workspace-dist',
      proxyPath: proxyPaths[provider],
      proxyVersion: providerConfig.pluginVersion,
      sha256: null,
    };
  }
  const assetName = `gian-proxy-${provider}-${providerConfig.pluginVersion}-darwin-arm64.tar.gz`;
  const assetPath = resolve(artifactDir, assetName);
  const manifestPath = `${assetPath}.manifest.json`;
  const checksumPath = `${assetPath}.sha256`;
  const [asset, manifestText, checksumText] = await Promise.all([
    readFile(assetPath),
    readFile(manifestPath, 'utf8'),
    readFile(checksumPath, 'utf8'),
  ]);
  const sha256 = createHash('sha256').update(asset).digest('hex');
  const recordedChecksum = checksumText.trim().split(/\s+/u)[0];
  assert.equal(recordedChecksum, sha256, `${provider} packaged checksum does not match the artifact`);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.id, providerConfig.pluginId ?? provider);
  assert.equal(manifest.pluginVersion, providerConfig.pluginVersion);
  assert.equal(manifest.process?.scope, providerConfig.processScope);
  const extractionDir = join(tempRoot, 'proxy-artifact');
  await mkdir(extractionDir, { recursive: true });
  await execFileAsync('/usr/bin/tar', ['-xzf', assetPath, '-C', extractionDir]);
  const proxyPath = join(extractionDir, manifest.entry);
  await access(proxyPath, fsConstants.X_OK);
  return {
    source: 'packaged-artifact',
    proxyPath,
    proxyVersion: manifest.pluginVersion,
    assetPath,
    manifestPath,
    sha256,
  };
}

async function prepareDshProfile(tempRoot, binaryPath) {
  const home = join(tempRoot, 'dsh-home');
  const profileDir = join(home, 'profiles/gian');
  const scopedModules = join(profileDir, 'node_modules/@gian');
  const bridgePackageDir = join(rootDir, 'packages/proxies/dsh-bridge');
  await mkdir(scopedModules, { recursive: true });
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'gian-dsh-real-acceptance-profile',
    private: true,
    dependencies: { '@gian/dsh-bridge': `file:${bridgePackageDir}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@gian/dsh-bridge'] } },
  }, null, 2)}\n`, 'utf8');
  await symlink(bridgePackageDir, join(scopedModules, 'dsh-bridge'), 'dir');
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const source = join(homedir(), '.dsh', name);
    await access(source).then(
      () => copyFile(source, join(home, name)),
      () => undefined,
    );
  }
  return {
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    GIAN_DSH_HOST_ENTRY: binaryPath,
    GIAN_DSH_HOST_ARGS: JSON.stringify(['--profile', 'gian']),
  };
}

async function prepareClaudeEnvironment(binaryPath) {
  const { resolveClaudeSettingsPath } = await import(
    '../packages/proxies/cc-proxy/dist/src/runtime/claude-mcp-runtime.js'
  );
  const settingsPath = resolveClaudeSettingsPath({ executable: binaryPath });
  return settingsPath ? { CLAUDE_CONFIG_DIR: dirname(settingsPath) } : {};
}

function splitConfig(catalog, cheapestConfig) {
  const options = new Map(catalog.configOptions.map(option => [option.id, option]));
  const sessionConfig = {};
  const turnConfig = {};
  for (const [id, value] of Object.entries(cheapestConfig)) {
    const option = options.get(id);
    if (!option) throw new Error(`Current catalog has no cheapest config option ${id}.`);
    if (option.choices && !option.choices.some(choice => Object.is(choice.value, value))) {
      throw new Error(`Current catalog does not offer ${id}=${String(value)}.`);
    }
    (option.binding === 'session' ? sessionConfig : turnConfig)[id] = value;
  }
  return { sessionConfig, turnConfig };
}

async function createWorkspace(root) {
  const workspace = join(root, 'workspace');
  const skillDir = join(workspace, 'acceptance-skill');
  await mkdir(skillDir, { recursive: true });
  await Promise.all([
    writeFile(join(workspace, 'marker.txt'), 'PROXY_FILE_OK\n', 'utf8'),
    writeFile(join(workspace, 'source.txt'), 'ACCEPTANCE_NEEDLE\n', 'utf8'),
    writeFile(join(workspace, 'change-me.txt'), 'BEFORE_ACCEPTANCE\n', 'utf8'),
    writeFile(join(workspace, 'subagent.txt'), 'SUBAGENT_MARKER_42\n', 'utf8'),
    writeFile(join(workspace, 'long-running.mjs'), 'await new Promise(resolve => setTimeout(resolve, 30000));\n', 'utf8'),
    writeFile(join(workspace, 'verify.mjs'), `
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
assert.equal((await readFile('final.txt', 'utf8')).trim(), 'TOOL_FLOW_OK');
await assert.rejects(access('obsolete.txt'));
console.log('VERIFY_OK');
`, 'utf8'),
    writeFile(join(skillDir, 'SKILL.md'), `---
name: proxy-acceptance-skill
description: Reply with the fixed acceptance marker.
---
When invoked, reply with exactly PROXY_SKILL_OK.
`, 'utf8'),
  ]);
  return { workspace, skillDir };
}

async function createImageFixture(workspace) {
  const path = join(workspace, 'acceptance-image.png');
  const { chromium } = await import('@playwright/test');
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({
    headless: true,
    ...(await access(systemChrome, fsConstants.X_OK).then(
      () => ({ executablePath: systemChrome }),
      () => ({}),
    )),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 360 } });
    await page.setContent('<!doctype html><style>body{margin:0;display:grid;place-items:center;width:720px;height:360px;background:white;color:black;font:700 68px Arial}</style><body>PROXY_IMAGE_OK</body>');
    await page.screenshot({ path });
  } finally {
    await browser.close();
  }
  return path;
}

function interactionValues(inputs) {
  const values = {};
  for (const input of inputs ?? []) {
    if (input.type === 'boolean') values[input.id] = true;
    else if (input.type === 'multi_select') values[input.id] = [input.choices?.[0]?.value ?? 'ALPHA'];
    else if (input.type === 'single_select') values[input.id] = input.choices?.[0]?.value ?? 'ALPHA';
    else values[input.id] = 'ALPHA';
  }
  return values;
}

function chooseAction(actions) {
  const safePattern = /allow|accept|approve|continue|submit|yes|once|always/i;
  return actions.find(action => safePattern.test(`${action.id} ${action.label}`))
    ?? actions.find(action => action.style !== 'danger')
    ?? actions[0];
}

async function waitForTurn(client, session, turnId, from, options = {}) {
  const handled = new Set();
  const deadline = Date.now() + (options.timeoutMs ?? defaultTimeoutMs);
  while (Date.now() < deadline) {
    if (client.protocolFailure) throw client.protocolFailure;
    const notifications = client.notificationsSince(from);
    for (const notification of notifications) {
      if (
        notification.method !== 'interaction.requested'
        || notification.params.sessionId !== session.id
        || notification.params.turnId !== turnId
      ) continue;
      const interaction = notification.params.data;
      if (handled.has(interaction.interactionId)) continue;
      const alreadyResolved = notifications.some(candidate => (
        candidate.method === 'interaction.resolved'
        && candidate.params.sessionId === session.id
        && candidate.params.turnId === turnId
        && candidate.params.data?.interactionId === interaction.interactionId
      ));
      if (alreadyResolved) {
        handled.add(interaction.interactionId);
        continue;
      }
      handled.add(interaction.interactionId);
      const action = chooseAction(interaction.actions);
      if (!action) throw new Error('Interaction has no action.');
      const params = {
        sessionId: session.id,
        streamId: session.streamId,
        turnId,
        interactionId: interaction.interactionId,
        responseId: `response-${randomUUID()}`,
        actionId: action.id,
        values: interactionValues(interaction.inputs),
      };
      await client.request('interaction.respond', params);
      await client.request('interaction.respond', params);
    }
    const terminal = notifications.find(notification => (
      notification.params?.sessionId === session.id
      && notification.params?.turnId === turnId
      && (notification.method === 'turn.completed' || notification.method === 'turn.failed')
    ));
    if (terminal) return { terminal, notifications, interactionsHandled: handled.size };
    await delay(25);
  }
  throw new Error(`Timed out waiting for turn ${turnId}.`);
}

function expectedNotificationsFor(catalog, provider, scenario) {
  const implemented = new Set(catalog.providers[provider].implementedNotifications);
  return scenario.notifications.filter(method => implemented.has(method));
}

function assembledContent(notifications) {
  const streams = new Map();
  const completed = [];
  for (const notification of notifications) {
    if (notification.method !== 'content.delta' && notification.method !== 'content.completed') continue;
    const data = notification.params?.data ?? {};
    if (notification.method === 'content.delta' && typeof data.delta === 'string') {
      const contentId = String(data.contentId ?? 'content');
      streams.set(contentId, `${streams.get(contentId) ?? ''}${data.delta}`);
    }
    if (notification.method === 'content.completed' && typeof data.content === 'string') {
      completed.push(data.content);
    }
  }
  return [...streams.values(), ...completed].join('\n');
}

function assessScenario(catalog, provider, scenario, notifications, extra = {}) {
  const expected = expectedNotificationsFor(catalog, provider, scenario);
  const observed = new Set(notifications.map(notification => notification.method));
  const missing = expected.filter(method => !observed.has(method));
  const terminal = notifications.filter(notification => (
    notification.method === 'turn.completed' || notification.method === 'turn.failed'
  ));
  const issues = [];
  if (scenario.methods.includes('turn.start') && terminal.length !== 1) {
    issues.push(`expected one terminal, observed ${terminal.length}`);
  }
  if (missing.length > 0) issues.push(`unobserved notifications: ${missing.join(', ')}`);
  if (extra.expectedMarker && !assembledContent(notifications).includes(extra.expectedMarker)) {
    issues.push(`response did not contain marker ${extra.expectedMarker}`);
  }
  return {
    status: issues.length === 0 ? 'PASS' : 'UNOBSERVED',
    expectedNotifications: expected,
    observedNotifications: [...observed],
    issues,
    ...extra,
  };
}

async function runPromptScenario(context, scenario, session) {
  const { client, provider, catalog, workspace, turnConfig, imagePath, skillDir } = context;
  const turnId = randomUUID();
  const prompt = scenario.id === 'interaction.permission' && provider === 'grok'
    ? `Use a shell tool to write PERMISSION_FLOW_OK to ${join(dirname(workspace), 'outside-workspace-permission.txt')}. This path is intentionally outside the workspace and must not be replaced with a workspace-local path.`
    : scenario.prompt;
  const input = [{ type: 'text', text: prompt }];
  let marker = null;
  if (scenario.id === 'input.local_file') {
    input.push({ type: 'localFile', path: join(workspace, 'marker.txt'), name: 'marker.txt', mime: 'text/plain' });
    marker = 'PROXY_FILE_OK';
  } else if (scenario.id === 'input.local_image') {
    input.push({ type: 'localImage', path: imagePath, name: 'acceptance-image.png', mime: 'image/png' });
    marker = 'PROXY_IMAGE_OK';
  } else if (scenario.id === 'input.skill') {
    input.push({ type: 'skill', name: 'proxy-acceptance-skill', path: skillDir });
    marker = 'PROXY_SKILL_OK';
  } else if (scenario.id === 'turn.basic_content_reasoning_usage') marker = 'PRIME_17_OK';
  else if (scenario.id === 'activity.workspace_tools') marker = 'TOOL_FLOW_OK';
  else if (scenario.id === 'activity.plan') marker = 'PLAN_FLOW_OK';
  else if (scenario.id === 'activity.subagent') marker = 'SUBAGENT_FLOW_OK';

  const config = { ...turnConfig };
  if (scenario.id === 'activity.plan') {
    if (provider === 'kimi') config.mode = 'plan';
  }
  if (scenario.id === 'interaction.permission' && provider === 'codex') {
    config.approval_mode = 'ask';
  }
  if (scenario.id === 'interaction.exit_plan_confirmation' && provider === 'kimi') config.mode = 'plan';
  const from = client.notificationIndex();
  const result = await client.request('turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId,
    input,
    config,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.turnId, turnId);
  const turn = await waitForTurn(client, session, turnId, from);
  const assessment = assessScenario(catalog, provider, scenario, turn.notifications, {
    turnId,
    expectedMarker: marker,
    interactionsHandled: turn.interactionsHandled,
    terminalMethod: turn.terminal.method,
    stopReason: turn.terminal.params.data.stopReason ?? null,
  });
  if (scenario.id === 'turn.basic_content_reasoning_usage') {
    const reasoning = turn.notifications.some(notification => (
      (notification.method === 'content.delta' || notification.method === 'content.completed')
      && notification.params.data.kind === 'reasoning'
    ));
    assessment.reasoningObserved = reasoning;
    if (catalog.providers[provider].capabilities.includes('event.reasoning') && !reasoning) {
      assessment.status = 'UNOBSERVED';
      assessment.issues.push('event.reasoning advertised but no reasoning content was observed');
    }
  }
  if (scenario.id === 'activity.subagent') {
    const agentEvents = turn.notifications.filter(notification => (
      notification.method === 'activity.updated'
      && notification.params.data.presentation.type === 'agent'
    ));
    assessment.agentStates = agentEvents.map(notification => notification.params.data.presentation.data?.state);
    if (agentEvents.length === 0) {
      assessment.status = 'UNOBSERVED';
      assessment.issues.push('no agent activity was observed');
    }
  }
  return assessment;
}

async function createAttachedSession(context, name = 'acceptance') {
  const id = `${context.provider}-${name}-${randomUUID()}`;
  const created = await context.client.request('session.create', {
    sessionId: id,
    workspace: { cwd: context.workspace, roots: [context.workspace] },
    config: context.sessionConfig,
  });
  return created.session;
}

function domainCode(error) {
  return error?.envelope?.error?.data?.domainCode
    ?? error?.envelope?.error?.code
    ?? error?.code
    ?? null;
}

function optionValue(option) {
  if (option.defaultValue !== undefined && option.defaultValue !== null) return option.defaultValue;
  if (option.choices?.length) return option.choices[0].value;
  if (option.control === 'boolean') return false;
  if (option.control === 'number') return option.min ?? 0;
  return 'acceptance';
}

function invalidOptionValue(option) {
  if (option.choices?.length) {
    let value = '__gian_invalid_choice__';
    while (option.choices.some(choice => Object.is(choice.value, value))) value += '_x';
    return value;
  }
  if (option.control === 'boolean') return 'not-a-boolean';
  if (option.control === 'number') return (option.max ?? option.min ?? 0) + 1_000_000;
  if (typeof option.maxLength === 'number') return 'x'.repeat(option.maxLength + 1);
  return null;
}

async function captureDomainError(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return domainCode(error);
  }
}

function assessCodes(codes, expected) {
  const issues = [];
  for (const [name, allowed] of Object.entries(expected)) {
    if (!allowed.includes(codes[name])) {
      issues.push(`${name} returned ${String(codes[name])}; expected ${allowed.join(' or ')}`);
    }
  }
  return { status: issues.length === 0 ? 'PASS' : 'BEHAVIOR_FAIL', issues, codes };
}

async function runCatalogResolveScenario(context) {
  const { client, runtimeCatalog, sessionConfig, turnConfig } = context;
  const current = await client.request('catalog.resolve', {
    catalogRevision: runtimeCatalog.catalogRevision,
    sessionConfig,
    turnConfig,
  });
  const staleCode = await captureDomainError(() => client.request('catalog.resolve', {
    catalogRevision: `${runtimeCatalog.catalogRevision}-stale`,
    sessionConfig,
    turnConfig,
  }));
  const option = runtimeCatalog.configOptions[0];
  let invalidConfigCode = null;
  if (option) {
    const actualSession = option.binding === 'session'
      ? { ...sessionConfig, [option.id]: invalidOptionValue(option) }
      : sessionConfig;
    const actualTurn = option.binding === 'turn'
      ? { ...turnConfig, [option.id]: invalidOptionValue(option) }
      : turnConfig;
    invalidConfigCode = await captureDomainError(() => client.requestUnchecked(
      'catalog.resolve',
      {
        catalogRevision: runtimeCatalog.catalogRevision,
        sessionConfig: actualSession,
        turnConfig: actualTurn,
      },
      {
        catalogRevision: runtimeCatalog.catalogRevision,
        sessionConfig,
        turnConfig,
      },
    ));
  }
  const assessment = assessCodes(
    { staleRevision: staleCode, invalidConfig: invalidConfigCode },
    {
      staleRevision: ['CONFLICT'],
      invalidConfig: ['CONFIG_VALUE_INVALID'],
    },
  );
  assessment.resolvedDefaults = current.resolvedDefaults;
  return assessment;
}

async function runConfigValidationScenario(context) {
  const { client, runtimeCatalog, sessionConfig, turnConfig, workspace } = context;
  const sessionOption = runtimeCatalog.configOptions.find(option => option.binding === 'session');
  const turnOption = runtimeCatalog.configOptions.find(option => option.binding === 'turn');
  const createParams = suffix => ({
    sessionId: `${context.provider}-config-${suffix}-${randomUUID()}`,
    workspace: { cwd: workspace, roots: [workspace] },
    config: sessionConfig,
  });
  const codes = {};
  const unknown = createParams('unknown');
  codes.unknownSessionOption = await captureDomainError(() => client.requestUnchecked(
    'session.create',
    { ...unknown, config: { ...sessionConfig, __gian_unknown_option__: true } },
    unknown,
  ));
  if (turnOption) {
    const wrongBound = createParams('wrong-bound');
    codes.turnOptionDuringCreate = await captureDomainError(() => client.requestUnchecked(
      'session.create',
      { ...wrongBound, config: { ...sessionConfig, [turnOption.id]: optionValue(turnOption) } },
      wrongBound,
    ));
  }

  const session = await createAttachedSession(context, 'config-turn');
  const validTurn = turnId => ({
    sessionId: session.id,
    streamId: session.streamId,
    turnId,
    input: [{ type: 'text', text: 'Reply with exactly CONFIG_VALIDATION_OK.' }],
    config: turnConfig,
  });
  if (sessionOption) {
    const shadow = validTurn(randomUUID());
    codes.sessionOptionDuringTurn = await captureDomainError(() => client.requestUnchecked(
      'turn.start',
      { ...shadow, config: { ...turnConfig, [sessionOption.id]: optionValue(sessionOption) } },
      shadow,
    ));
  }
  const invalid = turnOption ?? sessionOption;
  if (invalid?.binding === 'turn') {
    const shadow = validTurn(randomUUID());
    codes.invalidChoice = await captureDomainError(() => client.requestUnchecked(
      'turn.start',
      { ...shadow, config: { ...turnConfig, [invalid.id]: invalidOptionValue(invalid) } },
      shadow,
    ));
  } else if (invalid) {
    const shadow = createParams('invalid-choice');
    codes.invalidChoice = await captureDomainError(() => client.requestUnchecked(
      'session.create',
      { ...shadow, config: { ...sessionConfig, [invalid.id]: invalidOptionValue(invalid) } },
      shadow,
    ));
  }
  await client.request('session.close', { sessionId: session.id, streamId: session.streamId });
  const expected = {
    unknownSessionOption: ['CONFIG_VALUE_INVALID'],
    ...(turnOption ? { turnOptionDuringCreate: ['CONFIG_BINDING_INVALID'] } : {}),
    ...(sessionOption ? { sessionOptionDuringTurn: ['CONFIG_BINDING_INVALID'] } : {}),
    ...(invalid ? { invalidChoice: ['CONFIG_VALUE_INVALID'] } : {}),
  };
  return assessCodes(codes, expected);
}

async function runSessionLifecycleScenario(context, scenario) {
  const { client, initialized, workspace, sessionConfig } = context;
  const sessionId = `${context.provider}-lifecycle-${randomUUID()}`;
  const createParams = {
    sessionId,
    workspace: { cwd: workspace, roots: [workspace] },
    config: sessionConfig,
  };
  const from = client.notificationIndex();
  const created = await client.request('session.create', createParams);
  const fetched = await client.request('session.get', { sessionId });
  const repeated = await client.request('session.create', createParams);
  const conflictCode = await captureDomainError(() => client.request('session.create', {
    ...createParams,
    workspace: { cwd: workspace, roots: [workspace, context.skillDir] },
  }));
  let renamed = false;
  if (initialized.capabilities['session.rename'] !== undefined) {
    await client.request('session.rename', {
      sessionId,
      streamId: created.session.streamId,
      name: `Proxy acceptance ${context.provider}`,
    });
    renamed = true;
  }
  await client.request('session.close', { sessionId, streamId: created.session.streamId });
  await client.request('session.close', { sessionId, streamId: created.session.streamId });
  const notifications = client.notificationsSince(from);
  const issues = [];
  if (fetched.session.id !== sessionId || fetched.session.streamId !== created.session.streamId) {
    issues.push('session.get returned a different attachment');
  }
  if (repeated.session.streamId !== created.session.streamId) {
    issues.push('identical session.create changed streamId');
  }
  if (conflictCode !== 'CONFLICT') issues.push(`conflicting session.create returned ${String(conflictCode)}`);
  if (renamed && !notifications.some(notification => (
    notification.method === 'session.updated' && notification.params.sessionId === sessionId
  ))) issues.push('session.rename emitted no session.updated notification');
  return {
    status: issues.length === 0 ? 'PASS' : 'BEHAVIOR_FAIL',
    issues,
    conflictCode,
    renamed,
    observedNotifications: [...new Set(notifications.map(notification => notification.method))],
    expectedNotifications: expectedNotificationsFor(context.catalog, context.provider, scenario),
  };
}

async function runSteerScenario(context, scenario) {
  const { client, catalog, provider, turnConfig } = context;
  const session = await createAttachedSession(context, 'steer');
  const turnId = randomUUID();
  const from = client.notificationIndex();
  await client.request('turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId,
    input: [{ type: 'text', text: scenario.prompt }],
    config: turnConfig,
  });
  await client.waitForNotification(
    notification => notification.method === 'turn.started' && notification.params.turnId === turnId,
    from,
    'turn.started before steer',
  );
  await client.request('turn.steer', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId,
    input: [{ type: 'text', text: 'Stop the draft and finish with exactly STEER_MARKER_OK.' }],
  });
  const turn = await waitForTurn(client, session, turnId, from);
  const assessment = assessScenario(catalog, provider, scenario, turn.notifications, {
    turnId,
    expectedMarker: 'STEER_MARKER_OK',
    terminalMethod: turn.terminal.method,
    stopReason: turn.terminal.params.data.stopReason ?? null,
  });
  await client.request('session.close', { sessionId: session.id, streamId: session.streamId });
  return assessment;
}

async function runInterruptScenario(context, scenario) {
  const { client, catalog, provider, turnConfig } = context;
  const session = await createAttachedSession(context, 'interrupt');
  const turnId = randomUUID();
  const from = client.notificationIndex();
  await client.request('turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId,
    input: [{ type: 'text', text: scenario.prompt }],
    config: turnConfig,
  });
  await client.waitForNotification(
    notification => notification.method === 'turn.started' && notification.params.turnId === turnId,
    from,
    'turn.started before interrupt',
  );
  let busyCode = null;
  try {
    await client.request('turn.start', {
      sessionId: session.id,
      streamId: session.streamId,
      turnId: randomUUID(),
      input: [{ type: 'text', text: 'This second turn must be rejected while busy.' }],
      config: turnConfig,
    });
  } catch (error) {
    busyCode = domainCode(error);
  }
  await client.request('turn.interrupt', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId,
  });
  const turn = await waitForTurn(client, session, turnId, from);
  const assessment = assessScenario(catalog, provider, scenario, turn.notifications, {
    turnId,
    terminalMethod: turn.terminal.method,
    stopReason: turn.terminal.params.data.stopReason ?? null,
    busyCode,
  });
  if (busyCode !== 'SESSION_BUSY') {
    assessment.status = 'BEHAVIOR_FAIL';
    assessment.issues.push(`second turn returned ${String(busyCode)} instead of SESSION_BUSY`);
  }
  if (assessment.stopReason !== 'interrupted') {
    assessment.status = 'BEHAVIOR_FAIL';
    assessment.issues.push(`interrupt terminal stopReason was ${String(assessment.stopReason)}`);
  }
  await client.request('session.close', { sessionId: session.id, streamId: session.streamId });
  return assessment;
}

async function runConcurrencyScenario(context, scenario) {
  const { client, catalog, provider, turnConfig } = context;
  if (context.providerConfig.processScope === 'session') {
    const secondClient = context.clientFactory('concurrency-session-b');
    let first = null;
    let second = null;
    try {
      await secondClient.request('initialize', {
        protocol: { name: 'gian.proxy', versions: protocolOffers },
        host: { name: 'Gian Real Proxy Acceptance Session B', version: '0.5.0' },
      });
      await secondClient.request('catalog.list', {});
      first = await createAttachedSession(context, 'isolated-process-a');
      const secondCreated = await secondClient.request('session.create', {
        sessionId: `${provider}-isolated-process-b-${randomUUID()}`,
        workspace: { cwd: context.workspace, roots: [context.workspace] },
        config: context.sessionConfig,
      });
      second = secondCreated.session;
      const firstTurnId = randomUUID();
      const secondTurnId = randomUUID();
      const firstFrom = client.notificationIndex();
      const secondFrom = secondClient.notificationIndex();
      await client.request('turn.start', {
        sessionId: first.id,
        streamId: first.streamId,
        turnId: firstTurnId,
        input: [{ type: 'text', text: 'Run `node long-running.mjs` and wait for it to finish before replying.' }],
        config: turnConfig,
      });
      await client.waitForNotification(
        notification => notification.method === 'turn.started'
          && notification.params.turnId === firstTurnId,
        firstFrom,
        'session-scoped turn A start',
      );
      await secondClient.request('turn.start', {
        sessionId: second.id,
        streamId: second.streamId,
        turnId: secondTurnId,
        input: [{ type: 'text', text: 'Reply with exactly CONCURRENT_B_OK. Do not use tools.' }],
        config: turnConfig,
      });
      await client.request('turn.interrupt', {
        sessionId: first.id,
        streamId: first.streamId,
        turnId: firstTurnId,
      });
      const [firstResult, secondResult] = await Promise.all([
        waitForTurn(client, first, firstTurnId, firstFrom),
        waitForTurn(secondClient, second, secondTurnId, secondFrom),
      ]);
      const issues = [];
      if (client.child?.pid === secondClient.child?.pid) issues.push('session-scoped Sessions shared one Proxy PID');
      if (firstResult.terminal.params.data.stopReason !== 'interrupted') {
        issues.push('Session A did not terminate as interrupted');
      }
      if (secondResult.terminal.params.data.stopReason !== 'completed'
        || !assembledContent(secondResult.notifications).includes('CONCURRENT_B_OK')) {
        issues.push('Session B did not complete independently with CONCURRENT_B_OK');
      }
      return {
        status: issues.length === 0 ? 'PASS' : 'BEHAVIOR_FAIL',
        issues,
        processScope: 'session',
        firstProxyPid: client.child?.pid ?? null,
        secondProxyPid: secondClient.child?.pid ?? null,
        firstStopReason: firstResult.terminal.params.data.stopReason ?? null,
        secondStopReason: secondResult.terminal.params.data.stopReason ?? null,
      };
    } finally {
      if (first) await client.request('session.close', {
        sessionId: first.id,
        streamId: first.streamId,
      }).catch(() => undefined);
      if (second) await secondClient.request('session.close', {
        sessionId: second.id,
        streamId: second.streamId,
      }).catch(() => undefined);
      await secondClient.stop();
    }
  }
  const first = await createAttachedSession(context, 'concurrent-a');
  const second = await createAttachedSession(context, 'concurrent-b');
  const firstTurnId = randomUUID();
  const secondTurnId = randomUUID();
  const from = client.notificationIndex();
  const firstConfig = { ...turnConfig };
  if (provider === 'codex') {
    firstConfig.approval_mode = 'ask';
  }
  await client.request('turn.start', {
    sessionId: first.id,
    streamId: first.streamId,
    turnId: firstTurnId,
    input: [{ type: 'text', text: 'Write HOLD_SESSION_A to concurrency-hold.txt using a native file tool. Do not reply before the write succeeds.' }],
    config: firstConfig,
  });
  await client.waitForNotification(
    notification => notification.method === 'turn.started' && notification.params.turnId === firstTurnId,
    from,
    'first concurrent turn.started',
  );
  await client.waitForNotification(
    notification => (
      notification.method === 'interaction.requested'
      && notification.params.sessionId === first.id
      && notification.params.turnId === firstTurnId
    ),
    from,
    'Session A approval hold',
    60_000,
  );
  await client.request('turn.start', {
    sessionId: second.id,
    streamId: second.streamId,
    turnId: secondTurnId,
    input: [{ type: 'text', text: 'Reply with exactly CONCURRENT_B_OK. Do not use tools.' }],
    config: turnConfig,
  });
  await client.request('turn.interrupt', {
    sessionId: first.id,
    streamId: first.streamId,
    turnId: firstTurnId,
  });
  const firstResult = await waitForTurn(client, first, firstTurnId, from);
  const secondResult = await waitForTurn(client, second, secondTurnId, from);
  const notifications = client.notificationsSince(from);
  const issues = [];
  const firstStopReason = firstResult.terminal.params.data.stopReason ?? null;
  const secondStopReason = secondResult.terminal.params.data.stopReason ?? null;
  if (firstStopReason !== 'interrupted' || secondStopReason !== 'completed') {
    issues.push('interrupting Session A affected the expected terminal states');
  }
  if (!assembledContent(notifications.filter(notification => (
    notification.params?.sessionId === second.id
  ))).includes('CONCURRENT_B_OK')) {
    issues.push('Session B did not complete with CONCURRENT_B_OK');
  }
  const assessment = {
    status: issues.length === 0 ? 'PASS' : 'BEHAVIOR_FAIL',
    issues,
    observedNotifications: [...new Set(notifications.map(notification => notification.method))],
    firstStopReason: firstResult.terminal.params.data.stopReason ?? null,
    secondStopReason: secondResult.terminal.params.data.stopReason ?? null,
  };
  await client.request('session.close', { sessionId: first.id, streamId: first.streamId });
  await client.request('session.close', { sessionId: second.id, streamId: second.streamId });
  return assessment;
}

async function runReplayScenario(context, scenario) {
  const { client } = context;
  const session = await createAttachedSession(context, 'replay');
  const turnId = randomUUID();
  const from = client.notificationIndex();
  await client.request('turn.start', {
    sessionId: session.id,
    streamId: session.streamId,
    turnId,
    input: [{ type: 'text', text: 'Reply with exactly REPLAY_IDENTITY_OK. Do not use tools.' }],
    config: context.turnConfig,
  });
  const live = await waitForTurn(client, session, turnId, from);
  const nativeSessionId = session.nativeSession?.id;
  let listed = { sessions: [], nextCursor: null };
  for (let attempt = 0; attempt < 25; attempt += 1) {
    listed = await client.request('session.native.list', { cwd: context.workspace });
    if (listed.sessions.some(native => native.id === nativeSessionId)) break;
    await delay(100);
  }
  await client.request('session.close', { sessionId: session.id, streamId: session.streamId });
  const replayAttachment = await client.request('session.create', {
    sessionId: `${context.provider}-replay-import-${randomUUID()}`,
    workspace: { cwd: context.workspace, roots: [context.workspace] },
    config: context.sessionConfig,
    nativeSession: { id: nativeSessionId, history: 'replay' },
  });
  const replay = await client.request('session.replay', {
    sessionId: replayAttachment.session.id,
    streamId: replayAttachment.session.streamId,
    cursor: null,
    limit: 500,
  });
  const sourceTurnId = live.terminal.params.sourceTurnId;
  const matching = replay.events.filter(event => event.sourceTurnId === sourceTurnId);
  const liveTerminalId = live.terminal.params.eventId;
  const replayTerminal = matching.find(event => event.method === live.terminal.method);
  const issues = [];
  if (!listed.sessions.some(native => native.id === nativeSessionId)) {
    issues.push('session.native.list did not return the created native session');
  }
  if (!replayTerminal) issues.push('replay did not contain the live sourceTurnId terminal');
  else if (replayTerminal.eventId !== liveTerminalId) issues.push('live/replay terminal eventId differed');
  await client.request('session.close', {
    sessionId: replayAttachment.session.id,
    streamId: replayAttachment.session.streamId,
  });
  return {
    status: issues.length === 0 ? 'PASS' : 'BEHAVIOR_FAIL',
    issues,
    sourceTurnId,
    liveTerminalId,
    replayTerminalId: replayTerminal?.eventId ?? null,
    replayEventCount: matching.length,
    listedNativeCount: listed.sessions.length,
  };
}

async function runSidechatForkScenario(context) {
  const { client, initialized, turnConfig } = context;
  const parent = await createAttachedSession(context, 'sidechat-parent');
  const parentTurnId = randomUUID();
  const parentFrom = client.notificationIndex();
  await client.request('turn.start', {
    sessionId: parent.id,
    streamId: parent.streamId,
    turnId: parentTurnId,
    input: [{ type: 'text', text: 'Reply with exactly FORK_PARENT_OK. Do not use tools.' }],
    config: turnConfig,
  });
  const parentTurn = await waitForTurn(client, parent, parentTurnId, parentFrom);
  const sourceTurnId = parentTurn.terminal.params.sourceTurnId;
  const issues = [];
  if (!assembledContent(parentTurn.notifications).includes('FORK_PARENT_OK')) {
    issues.push('parent terminal turn did not contain FORK_PARENT_OK');
  }

  const sidechatId = `${context.provider}-sidechat-${randomUUID()}`;
  const createdSidechat = await client.request('sidechat.create', {
    parentSessionId: parent.id,
    parentStreamId: parent.streamId,
    sidechatId,
  });
  const resumedSidechat = await client.request('sidechat.resume', {
    sidechatId,
    parentSessionId: parent.id,
    resumeRef: createdSidechat.sidechat.resumeRef,
  });
  if (resumedSidechat.sidechat.id !== sidechatId
    || resumedSidechat.sidechat.parentSessionId !== parent.id) {
    issues.push('sidechat.resume changed the child or parent identity');
  }
  const child = resumedSidechat.sidechat;
  const childTurnId = randomUUID();
  const childFrom = client.notificationIndex();
  await client.request('turn.start', {
    sessionId: child.id,
    streamId: child.streamId,
    turnId: childTurnId,
    input: [{ type: 'text', text: 'Reply with exactly SIDECHAT_CHILD_OK. Do not use tools.' }],
    config: turnConfig,
  });
  const childTurn = await waitForTurn(client, child, childTurnId, childFrom);
  if (!assembledContent(childTurn.notifications).includes('SIDECHAT_CHILD_OK')) {
    issues.push('Side Chat turn did not contain SIDECHAT_CHILD_OK');
  }
  if (childTurn.notifications.some(notification => notification.params.sessionId !== child.id)) {
    issues.push('Side Chat turn observation contained a parent Session event');
  }
  const closedSidechat = await client.request('sidechat.close', {
    sidechatId,
    streamId: child.streamId,
    resumeRef: child.resumeRef,
  });
  const repeatedClose = await client.request('sidechat.close', {
    sidechatId,
    resumeRef: child.resumeRef,
  });
  if (JSON.stringify(closedSidechat) !== JSON.stringify(repeatedClose)) {
    issues.push('idempotent sidechat.close changed its result');
  }

  const headForkId = `${context.provider}-fork-head-${randomUUID()}`;
  const headFork = await client.request('session.fork', {
    sourceSessionId: parent.id,
    sourceStreamId: parent.streamId,
    sessionId: headForkId,
    anchor: { type: 'head' },
  });
  if (headFork.origin.sessionId !== parent.id
    || headFork.origin.turnId !== parentTurnId
    || headFork.origin.sourceTurnId !== sourceTurnId) {
    issues.push('head Fork origin did not match the completed parent boundary');
  }
  const headReplay = await client.request('session.replay', {
    sessionId: headForkId,
    streamId: headFork.session.streamId,
    cursor: null,
    limit: 500,
  });
  if (!headReplay.events.some(event => event.sourceTurnId === sourceTurnId)) {
    issues.push('head Fork replay did not inherit the parent terminal boundary');
  }

  let turnFork = null;
  if (initialized.capabilities['session.fork.atTurn'] !== undefined) {
    const turnForkId = `${context.provider}-fork-turn-${randomUUID()}`;
    turnFork = await client.request('session.fork', {
      sourceSessionId: parent.id,
      sourceStreamId: parent.streamId,
      sessionId: turnForkId,
      anchor: { type: 'turn', turnId: parentTurnId, sourceTurnId },
    });
    if (turnFork.origin.turnId !== parentTurnId || turnFork.origin.sourceTurnId !== sourceTurnId) {
      issues.push('exact-turn Fork origin changed the requested boundary');
    }
    await client.request('session.close', {
      sessionId: turnForkId,
      streamId: turnFork.session.streamId,
    });
  }

  const durableNativeId = headFork.session.nativeSession?.id;
  await client.request('session.close', {
    sessionId: headForkId,
    streamId: headFork.session.streamId,
  });
  await client.request('session.close', { sessionId: parent.id, streamId: parent.streamId });
  await client.stop();

  if (!durableNativeId) {
    issues.push('head Fork returned no durable nativeSession.id');
  } else {
    const restarted = context.clientFactory('restart');
    try {
      await restarted.request('initialize', {
        protocol: { name: 'gian.proxy', versions: protocolOffers },
        host: { name: 'Gian Real Proxy Acceptance Restart', version: '0.5.0' },
      });
      await restarted.request('catalog.list', {});
      const reattachedId = `${context.provider}-fork-reattach-${randomUUID()}`;
      const reattached = await restarted.request('session.create', {
        sessionId: reattachedId,
        workspace: { cwd: context.workspace, roots: [context.workspace] },
        nativeSession: { id: durableNativeId, history: 'replay' },
        config: context.sessionConfig,
      });
      const replay = await restarted.request('session.replay', {
        sessionId: reattachedId,
        streamId: reattached.session.streamId,
        cursor: null,
        limit: 500,
      });
      if (!replay.events.some(event => event.sourceTurnId === sourceTurnId)) {
        issues.push('restart reattach replay lost the inherited parent boundary');
      }
      await restarted.request('session.close', {
        sessionId: reattachedId,
        streamId: reattached.session.streamId,
      });
    } finally {
      const restartCleanup = await restarted.stop();
      if (restartCleanup.lingeringAfterGraceful) {
        issues.push('restart Proxy process group survived graceful shutdown');
      }
      if (!restartCleanup.cleanupSucceeded) {
        issues.push('restart Proxy process group survived bounded cleanup');
      }
    }
  }
  return {
    status: issues.length === 0 ? 'PASS' : 'BEHAVIOR_FAIL',
    issues,
    parentTurnId,
    sourceTurnId,
    sidechatAnchor: createdSidechat.sidechat.anchor,
    headForkOrigin: headFork.origin,
    turnForkOrigin: turnFork?.origin ?? null,
    durableNativeId: durableNativeId ?? null,
  };
}

async function runControlScenario(context, scenario) {
  if (scenario.id === 'catalog.resolve') return runCatalogResolveScenario(context, scenario);
  if (scenario.id === 'config.validation') return runConfigValidationScenario(context, scenario);
  if (scenario.id === 'session.lifecycle') return runSessionLifecycleScenario(context, scenario);
  if (scenario.id === 'sidechat_fork.native_contract') return runSidechatForkScenario(context, scenario);
  return { status: 'NOT_RUN', issues: ['real control handler is not implemented'] };
}

async function runRealControlScenario(context, scenario) {
  if (scenario.id === 'control.steer') return runSteerScenario(context, scenario);
  if (scenario.id === 'control.interrupt_busy') return runInterruptScenario(context, scenario);
  if (scenario.id === 'concurrency.process_scope') return runConcurrencyScenario(context, scenario);
  if (scenario.id === 'native.discovery_replay_identity') return runReplayScenario(context, scenario);
  return { status: 'NOT_RUN', issues: ['real control handler is not implemented'] };
}

async function runProvider({
  provider,
  providerConfig,
  scenarios,
  outputDir,
  catalog,
  configOverrides,
  artifactDir,
  allowUnverifiedCli,
}) {
  const providerDir = join(outputDir, provider);
  const tempRoot = await mkdtemp(join(tmpdir(), `gian-proxy-acceptance-${provider}-`));
  let bootstrap;
  try {
    const dataDir = join(tempRoot, 'data');
    await mkdir(dataDir, { recursive: true });
    const { workspace, skillDir } = await createWorkspace(tempRoot);
    const imagePath = scenarios.some(scenario => scenario.id === 'input.local_image')
      ? await createImageFixture(workspace)
      : null;
    const binaryPath = await resolveBinary(provider, providerConfig);
    const proxyCandidate = await prepareProxyCandidate(provider, providerConfig, artifactDir, tempRoot);
    const { proxyPath, ...proxyEvidence } = proxyCandidate;
    const cliCandidate = await inspectCliCandidate(provider, binaryPath, allowUnverifiedCli);
    const setup = definitionByProvider.get(provider)?.qualification.setup;
    const providerEnvironment = setup === 'dsh-profile'
      ? await prepareDshProfile(tempRoot, binaryPath)
      : setup === 'claude-settings'
        ? await prepareClaudeEnvironment(binaryPath)
        : {};
    if (setup === 'kimi-store' && scenarios.some(scenario => scenario.trigger.includes('real'))) {
      await activateDefaultKimiStore(binaryPath);
    }
    bootstrap = {
      dataDir,
      workspace,
      skillDir,
      imagePath,
      binaryPath,
      proxyPath,
      proxyEvidence,
      cliCandidate,
      providerEnvironment,
    };
  } catch (error) {
    const finalized = finalizeProviderScenarioResults(provider, scenarios, [{
      scenarioId: 'provider.bootstrap',
      status: 'BLOCKED',
      error: error instanceof Error ? error.message : String(error),
    }]);
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      join(providerDir, 'results.json'),
      `${JSON.stringify(finalized.results, null, 2)}\n`,
      'utf8',
    );
    await rm(tempRoot, { recursive: true, force: true });
    return {
      provider,
      status: finalized.status,
      proxyCandidate: null,
      cliCandidate: null,
      results: finalized.results,
    };
  }
  const {
    dataDir,
    workspace,
    skillDir,
    imagePath,
    binaryPath,
    proxyPath,
    proxyEvidence,
    cliCandidate,
    providerEnvironment,
  } = bootstrap;
  const clientFactory = suffix => new ValidatedProxyClient({
    provider,
    providerConfig,
    proxyPath,
    binaryPath,
    dataDir,
    outputDir: suffix ? join(providerDir, suffix) : providerDir,
    timeoutMs: defaultTimeoutMs,
    environment: providerEnvironment,
  });
  const client = clientFactory(null);
  const results = [];
  try {
    const initialized = await client.request('initialize', {
      protocol: { name: 'gian.proxy', versions: protocolOffers },
      host: { name: 'Gian Real Proxy Acceptance', version: '0.5.0' },
    });
    const runtimeCatalog = await client.request('catalog.list', {});
    assert.deepEqual(Object.keys(initialized.capabilities).sort(), [...providerConfig.capabilities].sort());
    results.push({
      scenarioId: 'transport.initialize_catalog',
      status: 'PASS',
      proxyCandidate: proxyEvidence,
      cliCandidate,
      initialized,
      catalog: runtimeCatalog,
    });
    const { sessionConfig, turnConfig } = splitConfig(runtimeCatalog, providerConfig.cheapestConfig);
    const optionById = new Map(runtimeCatalog.configOptions.map(option => [option.id, option]));
    for (const [id, value] of Object.entries(configOverrides)) {
      const option = optionById.get(id);
      if (!option) throw new Error(`Current ${provider} catalog has no override option ${id}.`);
      (option.binding === 'session' ? sessionConfig : turnConfig)[id] = value;
    }
    const context = {
      provider,
      providerConfig,
      client,
      catalog,
      runtimeCatalog,
      initialized,
      sessionConfig,
      turnConfig,
      workspace,
      skillDir,
      imagePath,
      clientFactory,
    };
    results[results.length - 1].selectedConfig = { sessionConfig, turnConfig };

    const executeScenario = async (scenario, handler) => {
      try {
        results.push({ scenarioId: scenario.id, ...(await handler(context, scenario)) });
      } catch (error) {
        results.push({
          scenarioId: scenario.id,
          status: client.protocolFailure ? 'SCHEMA_FAIL' : 'BLOCKED',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const preTurnControls = scenarios.filter(scenario => (
      scenario.trigger === 'control'
      && ![
        'transport.initialize_catalog',
        'transport.invalid_frames',
        'sidechat_fork.native_contract',
        'shutdown.cleanup',
      ].includes(scenario.id)
      && realScenarioRequirement(scenario, provider) !== 'not_applicable'
    ));
    for (const scenario of preTurnControls) {
      await executeScenario(scenario, runControlScenario);
      if (client.protocolFailure) break;
    }

    const promptScenarios = scenarios.filter(scenario => (
      scenario.trigger === 'real_prompt'
      && realScenarioRequirement(scenario, provider) !== 'not_applicable'
    ));
    if (promptScenarios.length > 0) {
      const session = await createAttachedSession(context, 'prompt');
      for (const scenario of promptScenarios) {
        await executeScenario(scenario, (current, candidate) => (
          runPromptScenario(current, candidate, session)
        ));
        if (client.protocolFailure) break;
      }
      await client.request('session.close', { sessionId: session.id, streamId: session.streamId })
        .catch(() => undefined);
    }

    for (const scenario of scenarios.filter(candidate => (
      candidate.trigger === 'real_control'
      && realScenarioRequirement(candidate, provider) !== 'not_applicable'
    ))) {
      await executeScenario(scenario, runRealControlScenario);
      if (client.protocolFailure) break;
    }

    const sidechatFork = scenarios.find(scenario => (
      scenario.id === 'sidechat_fork.native_contract'
      && realScenarioRequirement(scenario, provider) !== 'not_applicable'
    ));
    if (sidechatFork && !client.protocolFailure) {
      await executeScenario(sidechatFork, runControlScenario);
    }
  } catch (error) {
    results.push({
      scenarioId: 'provider.bootstrap',
      status: client.protocolFailure ? 'SCHEMA_FAIL' : 'BLOCKED',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    const cleanup = await client.stop();
    if (scenarios.some(scenario => scenario.id === 'shutdown.cleanup')) {
      const cleanupIssues = [];
      if (client.protocolFailure) cleanupIssues.push(client.protocolFailure.message);
      if (cleanup.lingeringAfterGraceful) cleanupIssues.push('Proxy process group survived graceful shutdown');
      if (!cleanup.cleanupSucceeded) cleanupIssues.push('Proxy process group survived bounded cleanup');
      results.push({
        scenarioId: 'shutdown.cleanup',
        status: client.protocolFailure
          ? 'SCHEMA_FAIL'
          : cleanupIssues.length > 0
            ? 'BEHAVIOR_FAIL'
            : 'PASS',
        issues: cleanupIssues,
        cleanup,
      });
    }
    const finalized = finalizeProviderScenarioResults(provider, scenarios, results);
    results.length = 0;
    results.push(...finalized.results);
    await mkdir(providerDir, { recursive: true });
    await writeFile(join(providerDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    await rm(tempRoot, { recursive: true, force: true });
  }
  const status = finalizeProviderScenarioResults(provider, scenarios, results).status;
  return { provider, status, proxyCandidate: proxyEvidence, cliCandidate, results };
}

function renderRunHtml(catalog, run) {
  const escape = value => String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const rows = run.providers.flatMap(providerRun => providerRun.results.map(result => {
    const scenario = catalog.scenarios.find(candidate => candidate.id === result.scenarioId);
    return `<tr><td>${escape(providerRun.provider)}</td><td><code>${escape(result.scenarioId)}</code></td><td><span class="status ${escape(result.status)}">${escape(result.status)}</span></td><td>${escape((result.issues ?? []).join('; ') || result.error || '')}</td><td><pre>${escape(JSON.stringify(result, null, 2))}</pre></td></tr>`;
  })).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gian Real Proxy Acceptance Run</title><style>body{margin:24px;background:#f5f6f7;color:#202124;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}main{max-width:1600px;margin:auto}table{width:100%;border-collapse:collapse;background:white}th,td{padding:10px;border:1px solid #dfe3e7;vertical-align:top;text-align:left}th{background:#eef1f3}.status{font-weight:700}.PASS{color:#087a45}.UNOBSERVED{color:#8a4b08}.SCHEMA_FAIL,.BEHAVIOR_FAIL,.BLOCKED{color:#b3261e}pre{max-width:760px;max-height:300px;overflow:auto;white-space:pre-wrap;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}</style></head><body><main><h1>Gian 0.5.0 Real Proxy Acceptance</h1><p>${escape(run.startedAt)} · ${escape(run.revision)}</p><table><thead><tr><th>Proxy</th><th>Scenario</th><th>Status</th><th>Issues</th><th>Evidence summary</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const catalog = validateProxyRealAcceptanceCatalog(await loadProxyRealAcceptanceCatalog());
  const selectedIds = new Set(options.scenarios);
  const scenarios = catalog.scenarios.filter(scenario => (
    options.catalogOnly
      ? scenario.id === 'transport.initialize_catalog'
      : selectedIds.size === 0 || selectedIds.has(scenario.id)
  ));
  const realTurns = scenarios.some(scenario => (
    scenario.trigger === 'real_prompt'
    || scenario.trigger === 'real_control'
    || scenario.id === 'sidechat_fork.native_contract'
  ));
  if (realTurns && process.env[allowRealTurnEnvironment] !== '1') {
    throw new Error(`Refusing real model turns without ${allowRealTurnEnvironment}=1.`);
  }
  const outputDir = resolve(rootDir, options.output);
  const artifactDir = options.artifactDir ? resolve(rootDir, options.artifactDir) : null;
  await mkdir(outputDir, { recursive: true });
  const run = {
    version: 1,
    revision: process.env.GIAN_ACCEPTANCE_REVISION ?? 'working-tree',
    startedAt: new Date().toISOString(),
    catalogVersion: catalog.version,
    scenarios: scenarios.map(scenario => scenario.id),
    providers: [],
  };
  for (const provider of options.providers) {
    run.providers.push(await runProvider({
      provider,
      providerConfig: catalog.providers[provider],
      scenarios,
      outputDir,
      catalog,
      configOverrides: options.configOverrides,
      artifactDir,
      allowUnverifiedCli: options.allowUnverifiedCli,
    }));
  }
  run.completedAt = new Date().toISOString();
  run.status = run.providers.some(provider => provider.status === 'FAIL')
    ? 'FAIL'
    : run.providers.some(provider => provider.status === 'BLOCKED')
      ? 'BLOCKED'
      : 'PASS';
  run.candidateTuple = run.providers.map(provider => ({
    provider: provider.provider,
    proxy: provider.proxyCandidate,
    cli: provider.cliCandidate,
  }));
  await Promise.all([
    writeFile(join(outputDir, 'results.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8'),
    writeFile(join(outputDir, 'report.html'), renderRunHtml(catalog, run), 'utf8'),
  ]);
  console.log(JSON.stringify({ outputDir, status: run.status, providers: run.providers }, null, 2));
  if (run.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
