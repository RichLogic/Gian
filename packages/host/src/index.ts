import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { serve } from '@hono/node-server';
import { EXECUTOR_DEFS, EXECUTOR_IDS, type Executor } from '@gian/shared';
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
import { CliRuntimeManager } from './runtime/manager.js';
import { AgentManager } from './agents/manager.js';
import { resolveBootProxyDescriptors } from './proxy/boot-descriptors.js';
import { createGitHubReleaseFetch } from './agents/github-release-fetch.js';
import { cleanupAgentInstructionBlocks } from './onboarding/agent-instructions.js';

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

  const developmentProxyEntries = Object.fromEntries(
    EXECUTOR_IDS.map((id) => {
      const def = EXECUTOR_DEFS[id];
      return [
        id,
        resolveProxyEntry(
          process.env[def.entryEnvVar],
          def.proxyPackageName,
          def.proxyPackageDir,
        ),
      ];
    }),
  ) as Record<Executor, string>;
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
      zcode: { model: '', thinking: '', mode: '' },
    },
    environmentCliPaths: Object.fromEntries(
      EXECUTOR_IDS
        .map((id) => [id, process.env[EXECUTOR_DEFS[id].binEnvVar]] as const)
        .filter((entry): entry is [Executor, string] => Boolean(entry[1])),
    ),
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
  const runtimeManager = new CliRuntimeManager(
    agentManager.runtimeProviders(),
    agentManager.updateLockDataDir(),
  );
  const bootDescriptors = await resolveBootProxyDescriptors(agentManager);

  const handle = createApp({
    db,
    config,
    dataDir,
    hostVersion: releaseVersion,
    ccProxyEntry: bootDescriptors.claude.entryPath,
    claudeProxy: bootDescriptors.claude.protocol,
    codexProxyEntry: bootDescriptors.codex?.entryPath,
    kimiProxyEntry: bootDescriptors.kimi?.entryPath,
    grokProxyEntry: bootDescriptors.grok?.entryPath,
    dshProxyEntry: bootDescriptors.dsh?.entryPath,
    zcodeProxyEntry: bootDescriptors.zcode?.entryPath,
    codexProxy: bootDescriptors.codex?.protocol,
    kimiProxy: bootDescriptors.kimi?.protocol,
    grokProxy: bootDescriptors.grok?.protocol,
    dshProxy: bootDescriptors.dsh?.protocol,
    zcodeProxy: bootDescriptors.zcode?.protocol,
    runtimeManager,
    agentManager,
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
