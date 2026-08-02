import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { serve } from '@hono/node-server';
import { createApp } from './web/app.js';
import { openDatabase } from './storage/db.js';
import { loadConfig } from './storage/config.js';
import { resolveDataDir } from './storage/paths.js';
import { sweepColdEvents } from './events/lifecycle.js';
import { CliRuntimeManager } from './runtime/manager.js';
import { AgentManager } from './agents/manager.js';

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
  } as const;
  const agentManager = await AgentManager.create({
    dataDir,
    releaseVersion: process.env.GIAN_RELEASE_VERSION ?? '0.1.0',
    releaseRepository: process.env.GIAN_RELEASE_REPOSITORY ?? 'RichLogic/Gian',
    managedProxies: process.env.GIAN_MANAGED_PLUGINS === '1',
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
    },
    environmentCliPaths: {
      ...(process.env.CLAUDE_BIN ? { claude: process.env.CLAUDE_BIN } : {}),
      ...(process.env.CODEX_BIN ? { codex: process.env.CODEX_BIN } : {}),
      ...(process.env.KIMI_BIN ? { kimi: process.env.KIMI_BIN } : {}),
    },
  });
  const runtimeManager = new CliRuntimeManager(agentManager.runtimeProviders());

  const handle = createApp({
    db,
    config,
    dataDir,
    ccProxyEntry: agentManager.proxyEntry('claude'),
    codexProxyEntry: agentManager.proxyEntry('codex'),
    kimiProxyEntry: agentManager.proxyEntry('kimi'),
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
