import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import {
  officialCatalogSourcePolicy,
  parseProxyPluginId,
  parseSessionProxyBinding,
  resolvePluginIdInput,
  isResumableSessionBinding,
  type Executor,
} from '@gian/shared';
import { createApp } from './web/app.js';
import { startGianToolRpc } from './tool/rpc-server.js';
import { openDatabase } from './storage/db.js';
import {
  configureUserSettingsFile,
  ensureUserSettingsFile,
  loadConfig,
} from './storage/config.js';
import { resolveDataDir } from './storage/paths.js';
import { assertNoEventStorageMaintenance } from './storage/maintenance-lock.js';
import { sweepColdEvents } from './events/lifecycle.js';
import { RuntimeResolver } from './runtime/resolver.js';
import { RuntimeReadinessCache } from './runtime/readiness-cache.js';
import { RuntimeControlPlane } from './runtime/control-plane.js';
import { ManagedRuntimeInstaller } from './runtime/installer.js';
import { downloadManagedRuntimeAsset } from './runtime/download.js';
import { discoverDevelopmentProxyEntries } from './runtime/development-proxy-source.js';
import { AgentManager } from './agents/manager.js';
import { legacyAgentBootstrap } from './agents/legacy-bootstrap.js';
import { resolveLegacyLaunch as resolveLegacySessionLaunch } from './proxy/legacy-launch.js';
import { createGitHubReleaseFetch } from './agents/github-release-fetch.js';
import { cleanupAgentInstructionBlocks } from './onboarding/agent-instructions.js';
import {
  CatalogRefreshController,
  CatalogService,
  CatalogSourceClient,
  CatalogStore,
  createCatalogNetwork,
  createPluginArtifactNetwork,
} from './catalog/index.js';
import { PluginStore } from './plugin-store/index.js';
import { RemoteIdentityBrokerClient } from './remote/identity-broker.js';
import {
  BROWSER_USE_BROKER_SOCKET_ENV,
  DesktopBrowserBrokerClient,
} from './tool/browser-broker.js';

// Vendored proxies live under packages/proxies/{cc,codex}-proxy in the
// monorepo. At runtime this file resolves from packages/host/{src or
// dist}/index.{ts,js}, so walking up two levels lands us at packages/,
// regardless of dev/build mode.
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, '..', '..');

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const releaseVersion = process.env.GIAN_RELEASE_VERSION ?? '0.1.0';
  const releaseRepository = (process.env.GIAN_RELEASE_REPOSITORY ?? 'RichLogic/Gian').trim();
  const githubBrokerSocketPath = process.env.GIAN_DESKTOP_GITHUB_BROKER_SOCKET;
  const remoteBrokerSocketPath = process.env.GIAN_DESKTOP_REMOTE_BROKER_SOCKET;
  const browserBrokerSocketPath = process.env[BROWSER_USE_BROKER_SOCKET_ENV];
  // The socket is a Desktop-only credential boundary. Do not let the
  // capability path flow into Proxy or vendor CLI child environments.
  delete process.env.GIAN_DESKTOP_GITHUB_BROKER_SOCKET;
  delete process.env.GIAN_DESKTOP_REMOTE_BROKER_SOCKET;
  delete process.env[BROWSER_USE_BROKER_SOCKET_ENV];
  assertNoEventStorageMaintenance(dataDir);
  const db = openDatabase(dataDir);
  configureUserSettingsFile(dataDir);
  const config = loadConfig(db);
  ensureUserSettingsFile(config);

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

  // Retire the old global instruction mutation. Dynamic Gian identity and
  // workspace guidance belongs to the authenticated Session MCP boundary.
  try {
    const cleaned = await cleanupAgentInstructionBlocks();
    if (cleaned.length > 0) {
      console.log(`[gian] removed legacy agent instruction blocks: ${cleaned.join(', ')}`);
    }
  } catch (err) {
    console.warn('[gian] agent instruction cleanup failed:', err);
  }

  const developmentProxyEntries = await discoverDevelopmentProxyEntries({
    proxiesDir: join(PACKAGES_DIR, 'proxies'),
    overridesJson: process.env.GIAN_DEV_PROXY_ENTRIES,
    overridesOnly: process.env.GIAN_DEV_PROXY_OVERRIDES_ONLY === '1',
  });
  const legacyAgents = legacyAgentBootstrap(config, process.env);
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
    legacyProxyDefaults: legacyAgents.legacyProxyDefaults,
    environmentCliPaths: legacyAgents.environmentCliPaths,
    // v2 migration source: kinds that appear in existing sessions get one
    // default Agent even without a configured path or installed Proxy.
    sessionExecutors: () => (
      db.prepare('SELECT DISTINCT executor FROM sessions').all() as Array<{ executor: Executor }>
    ).map(row => row.executor),
  });
  const skillResults = await agentManager.reconcileManagedSkills();
  for (const result of skillResults) {
    if (result.state === 'ready') {
      if (result.changed) console.log(`[gian] reconciled managed Skill: ${result.path}`);
    } else {
      console.warn(`[gian] managed Skill ${result.state}: ${result.path}${result.error ? ` (${result.error})` : ''}`);
    }
  }
  const runtimeResolver = new RuntimeResolver({
    dataDir: join(dataDir, 'runtime-resolver'),
    updateLockDataDir: agentManager.updateLockDataDir(),
    hostVersion: releaseVersion,
  });
  const readinessCache = new RuntimeReadinessCache();
  agentManager.setRuntimeResolver(runtimeResolver);
  agentManager.setReadinessCache(readinessCache);
  const runtimeControl = new RuntimeControlPlane({
    resolver: runtimeResolver,
    cache: readinessCache,
    resolveLaunch: (pluginId) => agentManager.trustedLaunch(pluginId),
    catalogItem: (pluginId) => catalogService.get(pluginId),
  });
  const catalogPolicy = officialCatalogSourcePolicy();
  const catalogStore = new CatalogStore({
    rootDir: join(dataDir, 'catalogs', catalogPolicy.sourceId),
    policy: catalogPolicy,
  });
  await catalogStore.open();
  const pluginArtifactNetwork = githubBrokerSocketPath
    ? createPluginArtifactNetwork({ socketPath: githubBrokerSocketPath })
    : {
      async download() {
        throw new Error('Plugin artifact broker is not configured.');
      },
    };
  const pluginStore = new PluginStore({
    dataDir,
    pluginsDir: join(dataDir, 'plugins'),
    updateLockDataDir: agentManager.updateLockDataDir(),
    allowedArtifactRepositories: catalogPolicy.artifactRepositories,
    hostVersion: releaseVersion,
    network: pluginArtifactNetwork,
    listBindingReferences: () => {
      const rows = db.prepare(
        'SELECT proxy_binding_json, worktree_outcome FROM sessions WHERE proxy_binding_json IS NOT NULL',
      ).all() as Array<{ proxy_binding_json: string | null; worktree_outcome: string | null }>;
      const refs = [];
      for (const row of rows) {
        const parsed = parseSessionProxyBinding(row.proxy_binding_json);
        if (
          parsed.ok
          && isResumableSessionBinding({
            proxy_binding: parsed.binding,
            worktree_outcome: row.worktree_outcome,
          })
        ) {
          refs.push({
            pluginId: parsed.binding.pluginId,
            pluginVersion: parsed.binding.pluginVersion,
          });
        }
      }
      return refs;
    },
  });
  const catalogSourceClient = new CatalogSourceClient({
    store: catalogStore,
    network: createCatalogNetwork({
      socketPath: githubBrokerSocketPath,
      policy: catalogPolicy,
    }),
    policy: catalogPolicy,
  });
  agentManager.setPluginStore(pluginStore);
  const catalogService = new CatalogService({
    store: catalogStore,
    plugins: pluginStore,
    policy: catalogPolicy,
    sourceClient: catalogSourceClient,
    readinessCache,
    managedRuntimeStatus: pluginId => agentManager.managedRuntimeStatus(pluginId),
    officialPresence: async (pluginId) => agentManager.officialPresence(pluginId),
    onPluginGenerationChanged: (pluginId) => {
      readinessCache.invalidate(pluginId);
      runtimeResolver.invalidate(parseProxyPluginId(pluginId));
    },
  });
  agentManager.setCatalogService(catalogService);
  const runtimeInstaller = new ManagedRuntimeInstaller({
    dataDir,
    hostVersion: releaseVersion,
    store: agentManager.managedRuntimeGenerationStore(),
    download: (asset, signal, onProgress) => downloadManagedRuntimeAsset(
      asset,
      catalogPolicy.runtimeAssetPrefixes ?? [],
      signal,
      fetch,
      onProgress,
    ),
    probeVersion: async ({ executable, pluginId }) => {
      const launch = await agentManager.trustedLaunch(pluginId);
      if (!launch || launch.runtime.kind === 'none') {
        throw new Error(`${pluginId} Proxy is unavailable for managed Runtime verification.`);
      }
      const resolved = await runtimeResolver.resolve({
        pluginId: parseProxyPluginId(pluginId),
        pluginVersion: launch.pluginVersion,
        agentId: 'runtime-installer',
        entryPath: launch.entryPath,
        processScope: launch.processScope,
        runtime: launch.runtime,
        selectedPath: executable,
      });
      try {
        // Installation verifies executable identity, not an Agent's account
        // or HOME configuration. Those remain Provider-owned setup concerns.
        if (!resolved.profile.version) throw new Error(`${pluginId} Runtime reported no version.`);
        return resolved.profile.version;
      } finally {
        await resolved.lease?.release();
      }
    },
  });
  const catalogRefresh = new CatalogRefreshController({
    sourceClient: catalogSourceClient,
  });
  catalogRefresh.start();

  const handle = createApp({
    db,
    config,
    dataDir,
    hostVersion: releaseVersion,
    resolveLegacyLaunch: async (executor, options) => {
      const pluginId = resolvePluginIdInput(executor);
      if (!pluginId) throw new Error(`Legacy Session has an invalid Proxy identity: ${executor}`);
      const launch = await agentManager.trustedLaunchVersion(pluginId, options.proxyVersion);
      if (!launch) {
        throw new Error(
          `Trusted Proxy package is unavailable for legacy Session ${pluginId}`
          + (options.proxyVersion ? `@${options.proxyVersion}` : ''),
        );
      }
      return resolveLegacySessionLaunch({
        executor,
        launch,
        runtimeResolver,
        cliPath: options.cliPath,
      });
    },
    runtimeResolver,
    runtimeControl,
    runtimeInstaller,
    readinessCache,
    agentManager,
    catalogService,
    ...(remoteBrokerSocketPath
      ? { remoteIdentity: new RemoteIdentityBrokerClient(remoteBrokerSocketPath) }
      : {}),
    ...(browserBrokerSocketPath
      ? { browser: new DesktopBrowserBrokerClient(browserBrokerSocketPath) }
      : {}),
  });
  const toolRpc = await startGianToolRpc({ dataDir, service: handle.toolService });

  const server = serve({ fetch: handle.app.fetch, hostname: config.host, port: config.port }, info => {
    console.log(`[gian] listening on http://${info.address}:${info.port}`);
  });

  handle.injectWebSocket(server);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[gian] shutting down…');
    await catalogRefresh.stop();
    await toolRpc.close();
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
