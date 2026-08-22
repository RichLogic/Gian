import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { serve } from '@hono/node-server';
import { createApp } from './web/app.js';
import { openDatabase } from './storage/db.js';
import { loadConfig } from './storage/config.js';
import { resolveDataDir } from './storage/paths.js';
import { assertNoEventStorageMaintenance } from './storage/maintenance-lock.js';
import { sweepColdEvents } from './events/lifecycle.js';
import { CliRuntimeManager } from './runtime/manager.js';
import { AgentManager } from './agents/manager.js';
import { createGitHubReleaseFetch } from './agents/github-release-fetch.js';
import { syncAgentInstructionBlocks } from './onboarding/agent-instructions.js';
import { expandHome } from './workspace/index.js';

// Vendored proxies live under packages/proxies/{cc,codex}-proxy in the
// monorepo. At runtime this file resolves from packages/host/{src or
// dist}/index.{ts,js}, so walking up two levels lands us at packages/,
// regardless of dev/build mode.
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);

function resolveProxyEntry(
  override: string | undefined,
  packageName: string,
  monorepoDirectory: string,
): string {
  if (override) return override;
  try {
    return require.resolve(packageName);
  } catch {
    return join(
      PACKAGES_DIR,
      'proxies',
      monorepoDirectory,
      'dist',
      'src',
      'cli',
      'spawn.js',
    );
  }
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const releaseVersion = process.env.GIAN_RELEASE_VERSION ?? '0.1.0';
  const releaseRepository = (process.env.GIAN_RELEASE_REPOSITORY ?? 'RichLogic/Gian').trim();
  const githubBrokerSocketPath = process.env.GIAN_DESKTOP_GITHUB_BROKER_SOCKET;
  // The socket is a Desktop-only credential boundary. Do not let the
  // capability path flow into Proxy or vendor CLI child environments.
  delete process.env.GIAN_DESKTOP_GITHUB_BROKER_SOCKET;
  assertNoEventStorageMaintenance(dataDir);
  const db = openDatabase(dataDir);
  const config = loadConfig(db);

  // Sweep cold events on every boot. Sessions whose events haven't been
  // touched in 30 days (or that are archived) get their events / turns
  // rows evicted; the session row itself is preserved with
  // native_session_id intact, and the events list endpoint will lazy
  // rebuild from JSONL when the user reopens it.
  try {
    const swept = sweepColdEvents(db);
    if (swept.sessionsSwept > 0) {
      console.log(
        `[gian] swept events cache: ${swept.sessionsSwept} session(s), ` +
          `${swept.eventsDeleted} event(s), ${swept.turnsDeleted} turn(s)`,
      );
    }
  } catch (err) {
    console.warn('[gian] event sweep failed:', err);
  }

  // Publish the workspace-root convention (worktrees live under
  // `<root>/worktrees/`) into each agent CLI's global instruction file, so
  // agent-created worktrees land in one predictable place.
  try {
    const synced = await syncAgentInstructionBlocks(expandHome(config.workspace_root));
    if (synced.length > 0) {
      console.log(`[gian] synced agent instruction files: ${synced.join(', ')}`);
    }
  } catch (err) {
    console.warn('[gian] agent instruction sync failed:', err);
  }

  const developmentProxyEntries = {
    claude: resolveProxyEntry(
      process.env.GIAN_CC_PROXY_ENTRY,
      '@gian/cc-proxy',
      'cc-proxy',
    ),
    codex: resolveProxyEntry(
      process.env.GIAN_CODEX_PROXY_ENTRY,
      '@gian/codex-proxy',
      'codex-proxy',
    ),
    kimi: resolveProxyEntry(
      process.env.GIAN_KIMI_PROXY_ENTRY,
      '@gian/kimi-proxy',
      'kimi-proxy',
    ),
    grok: resolveProxyEntry(
      process.env.GIAN_GROK_PROXY_ENTRY,
      '@gian/grok-proxy',
      'grok-proxy',
    ),
    dsh: resolveProxyEntry(
      process.env.GIAN_DSH_PROXY_ENTRY,
      '@gian/dsh-proxy',
      'dsh-proxy',
    ),
  } as const;
  const agentManager = await AgentManager.create({
    dataDir,
    releaseVersion,
    releaseRepository,
    fetchImpl: createGitHubReleaseFetch({
      releaseRepository,
      brokerSocketPath: githubBrokerSocketPath,
    }),
    managedProxies: process.env.GIAN_MANAGED_PLUGINS === '1',
    independentProxyReleases: process.env.GIAN_MANAGED_PLUGINS === '1',
    dshBridgePackageDir: process.env.GIAN_DSH_BRIDGE_PACKAGE_DIR
      ? resolve(process.env.GIAN_DSH_BRIDGE_PACKAGE_DIR)
      : join(PACKAGES_DIR, 'proxies', 'dsh-bridge'),
    developmentProxyEntries,
    legacyProxyDefaults: {
      claude: {
        model: config.default_claude_model,
        thinking: config.default_claude_effort,
        mode: 'ask',
      },
      codex: {
        model: config.default_codex_model,
        thinking: config.default_codex_effort,
        mode: 'ask',
      },
      kimi: { model: '', thinking: '', mode: '' },
      grok: { model: '', thinking: '', mode: '' },
      dsh: { model: '', thinking: '', mode: '' },
    },
    environmentCliPaths: {
      ...(process.env.CLAUDE_BIN ? { claude: process.env.CLAUDE_BIN } : {}),
      ...(process.env.CODEX_BIN ? { codex: process.env.CODEX_BIN } : {}),
      ...(process.env.KIMI_BIN ? { kimi: process.env.KIMI_BIN } : {}),
      ...(process.env.GROK_BIN ? { grok: process.env.GROK_BIN } : {}),
      ...(process.env.DSH_BIN ? { dsh: process.env.DSH_BIN } : {}),
    },
  });
  const runtimeManager = new CliRuntimeManager(
    agentManager.runtimeProviders(),
    agentManager.updateLockDataDir(),
  );
  const [claudeProxy, codexProxy, kimiProxy, grokProxy, dshProxy] = await Promise.all([
    agentManager.proxyLaunchDescriptor('claude'),
    agentManager.proxyLaunchDescriptor('codex'),
    agentManager.proxyLaunchDescriptor('kimi'),
    agentManager.proxyLaunchDescriptor('grok'),
    agentManager.proxyLaunchDescriptor('dsh'),
  ]);

  const handle = createApp({
    db,
    config,
    dataDir,
    hostVersion: releaseVersion,
    ccProxyEntry: claudeProxy.entryPath,
    claudeProxy: claudeProxy.protocol,
    codexProxyEntry: codexProxy.entryPath,
    kimiProxyEntry: kimiProxy.entryPath,
    grokProxyEntry: grokProxy.entryPath,
    dshProxyEntry: dshProxy.entryPath,
    codexProxy: codexProxy.protocol,
    kimiProxy: kimiProxy.protocol,
    grokProxy: grokProxy.protocol,
    dshProxy: dshProxy.protocol,
    runtimeManager,
    agentManager,
  });

  const server = serve({ fetch: handle.app.fetch, hostname: config.host, port: config.port }, info => {
    console.log(`[gian] listening on http://${info.address}:${info.port}`);
  });

  handle.injectWebSocket(server);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[gian] shutting down…');
    await handle.shutdown();
    db.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  if (process.env.GIAN_PARENT_MANAGED === '1') {
    process.stdin.resume();
    process.stdin.once('end', () => void shutdown());
  }
}

main().catch(err => {
  console.error('[gian] fatal:', err);
  process.exit(1);
});
