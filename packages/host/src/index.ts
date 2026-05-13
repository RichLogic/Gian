import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './web/app.js';
import { openDatabase } from './storage/db.js';
import { loadConfig } from './storage/config.js';
import { resolveDataDir } from './storage/paths.js';
import { TunnelManager } from './tunnel/index.js';
import { sweepColdEvents } from './events/lifecycle.js';

// Vendored proxies live under packages/proxies/{cc,codex}-proxy in the
// monorepo. At runtime this file resolves from packages/host/{src or
// dist}/index.{ts,js}, so walking up two levels lands us at packages/,
// regardless of dev/build mode.
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, '..', '..');

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const db = openDatabase(dataDir);
  const config = loadConfig(db);
  const tunnel = new TunnelManager();

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

  const ccProxyEntry =
    process.env.GIAN_CC_PROXY_ENTRY ??
    join(PACKAGES_DIR, 'proxies', 'cc-proxy', 'dist', 'src', 'cli', 'spawn.js');

  const codexProxyEntry =
    process.env.GIAN_CODEX_PROXY_ENTRY ??
    join(PACKAGES_DIR, 'proxies', 'codex-proxy', 'dist', 'src', 'cli', 'spawn.js');

  const codexBin = process.env.CODEX_BIN;

  const handle = createApp({
    db,
    config,
    dataDir,
    ccProxyEntry,
    codexProxyEntry,
    codexBin,
  });

  const server = serve({ fetch: handle.app.fetch, hostname: config.host, port: config.port }, info => {
    console.log(`[gian] listening on http://${info.address}:${info.port}`);
  });

  handle.injectWebSocket(server);

  await tunnel.start(config);

  const shutdown = async (): Promise<void> => {
    console.log('[gian] shutting down…');
    await tunnel.stop();
    await handle.shutdown();
    db.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(err => {
  console.error('[gian] fatal:', err);
  process.exit(1);
});
