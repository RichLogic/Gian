// Lightweight `createApp` harness for HTTP-level integration tests.
//
// `createApp` instantiates ProxyManager and schedules fire-and-forget
// capability warmup. The warmup is gated on `GIAN_SKIP_PROXY_WARMUP=1`,
// which this fixture sets before calling createApp.
//
// The returned `fetch` is a thin shim around `app.fetch` so tests can hit
// any route via the standard Request/Response API without binding a port.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../src/storage/db.js';
import { loadConfig } from '../../src/storage/config.js';
import { createApp, type AppHandle } from '../../src/web/app.js';

export interface TestAppCtx {
  app: AppHandle;
  db: Db;
  dataDir: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  cleanup: () => Promise<void>;
}

export async function makeTestApp(): Promise<TestAppCtx> {
  // Pin the env-var skip BEFORE createApp reads it. Without this the
  // app would spawn a real cc-proxy / codex-proxy.
  process.env['GIAN_SKIP_PROXY_WARMUP'] = '1';
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-test-app-'));
  // `writeAttachment` (and anything else still calling `resolveDataDir()`
  // directly) reads `GIAN_DATA_DIR` first. Without this, the attachment
  // HTTP route writes into the real `~/.gian/attachments` during
  // tests. Restore the prior value on cleanup so test files that didn't
  // set it don't inherit our temp dir after teardown.
  const prevDataDirEnv = process.env['GIAN_DATA_DIR'];
  process.env['GIAN_DATA_DIR'] = dataDir;
  const db = openDatabase(dataDir);
  const config = loadConfig(db);

  const app = createApp({
    db,
    config,
    dataDir,
    // Point at the local dist (the entry doesn't need to exist for routes
    // that don't spawn a proxy). Tests that call /api/proxy/.../models or
    // anything that triggers proxy spawn will fail; that's a routing test
    // we don't run here.
    ccProxyEntry: join(dataDir, 'cc-proxy-not-used.js'),
    codexProxyEntry: join(dataDir, 'codex-proxy-not-used.js'),
  });

  async function fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const req = new Request(`http://test.invalid${path}`, init);
    return app.app.fetch(req);
  }

  return {
    app,
    db,
    dataDir,
    fetch,
    cleanup: async () => {
      await app.shutdown().catch(() => undefined);
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
      if (prevDataDirEnv === undefined) {
        delete process.env['GIAN_DATA_DIR'];
      } else {
        process.env['GIAN_DATA_DIR'] = prevDataDirEnv;
      }
    },
  };
}
