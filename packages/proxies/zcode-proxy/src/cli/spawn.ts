#!/usr/bin/env node
/**
 * com.zhipu.zcode — shared-scope gian.proxy/2.1 over ZCode Protocol v1.
 *
 * The Host spawns this entry with:
 *   GIAN_RUNTIME_BIN      path to the Runtime embedded in ZCode.app (zcode.cjs)
 *   GIAN_PLUGIN_DATA_DIR  plugin-owned data dir (identity mapping, 0600 files)
 *   GIAN_PLUGIN_ID        must equal com.zhipu.zcode
 *
 * ZCode env contract: the app-server child receives a strict allowlist
 * (HOME/PATH/TMPDIR/locale + the GIAN_* identity above) so cloud credentials,
 * CI tokens and other agents' env never reach the runtime (Revision 2 §4.3).
 */

import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';
import { planRuntimeInstallation } from '../runtime/install.js';
import { ZcodeSharedService } from '../service.js';
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_VERSION } from '../identity.js';
import {
  builtinProviderConfigCandidates,
  discoverZcodeRuntimes,
  locateBuiltinProviderConfig,
  probeZcodeRuntime,
} from '../runtime/discover.js';
import { resolve } from 'node:path';

function selfTest(): void {
  // Verify the module graph loads and the wire constants are coherent.
  if (PLUGIN_ID !== 'com.zhipu.zcode') throw new Error('plugin id drifted');
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 4,
    id: PLUGIN_ID,
    pluginVersion: PLUGIN_VERSION,
    ok: true,
  })}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? PLUGIN_ID,
      pluginName: PLUGIN_NAME,
      pluginVersion: PLUGIN_VERSION,
      processScope: 'shared',
      discover: discoverZcodeRuntimes,
      probe: probeZcodeRuntime,
    });
    return;
  }

  const runtimeBin = process.env.GIAN_RUNTIME_BIN;
  if (runtimeBin === undefined || runtimeBin === '') {
    throw new Error('zcode-proxy requires GIAN_RUNTIME_BIN pointing at the Runtime embedded in ZCode.app.');
  }
  if (process.env.GIAN_PLUGIN_ID !== undefined && process.env.GIAN_PLUGIN_ID !== PLUGIN_ID) {
    throw new Error(`zcode-proxy expects plugin id ${PLUGIN_ID}, received ${process.env.GIAN_PLUGIN_ID}.`);
  }
  const dataDir = process.env.GIAN_PLUGIN_DATA_DIR ?? null;

  // Pre-spawn diagnostic: a missing builtin provider config makes the inner
  // app-server exit before answering anything, which otherwise surfaces as an
  // opaque "app-server exited" loop. Warn once with the checked paths.
  if (await locateBuiltinProviderConfig(resolve(runtimeBin)) === null) {
    const [near, up] = builtinProviderConfigCandidates(resolve(runtimeBin));
    process.stderr.write(
      `[zcode-proxy:runtime] builtin provider config not found (checked ${near}, ${up}); `
      + 'the ZCode app-server will exit at startup. See Gian-Dev #163.\n',
    );
  }

  const service = new ZcodeSharedService({
    runtimeBin,
    dataDir,
    catalogWorkspace: dataDir ?? tmpdir(),
    interactionEnabled: process.env.GIAN_ZCODE_DISABLE_INTERACTION !== '1',
    env: {
      home: process.env.HOME ?? '',
      path: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
      tmpdir: tmpdir(),
      lang: 'en_US.UTF-8',
      // Explicit passthrough: plugin identity per Revision 2 §4.3 plus the
      // test-fixture scenario seam used by the fake app-server.
      gian: {
        ...(process.env.GIAN_PLUGIN_ID ? { GIAN_PLUGIN_ID: process.env.GIAN_PLUGIN_ID } : {}),
        ...(process.env.GIAN_PLUGIN_DATA_DIR ? { GIAN_PLUGIN_DATA_DIR: process.env.GIAN_PLUGIN_DATA_DIR } : {}),
        ...(process.env.FAKE_SCENARIO ? { FAKE_SCENARIO: process.env.FAKE_SCENARIO } : {}),
        ...(process.env.FAKE_LOG ? { FAKE_LOG: process.env.FAKE_LOG } : {}),
      },
    },
    onStderr: (_runtimeKey, line) => {
      process.stderr.write(`[zcode-proxy:app-server] ${String(line)}\n`);
    },
    onDiagnostic: (_runtimeKey, info) => {
      process.stderr.write(`[zcode-proxy:inner] ${JSON.stringify(info)}\n`);
    },
  });

  service.setEmitSink((notification) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: notification.method, params: notification.params })}\n`);
  });

  const writer = {
    result(id: string, result: unknown): void {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    },
    error(id: string | null, error: { code: number; message: string; data?: unknown }): void {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
    },
  };

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.trim() === '') continue;
    let request: { id?: unknown; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      writer.error(null, { code: -32700, message: 'Parse error' });
      continue;
    }
    if (typeof request.id !== 'string' || request.id.length === 0) {
      writer.error(null, { code: -32600, message: 'Request id must be a non-empty string.' });
      continue;
    }
    const wireRequest = {
      id: request.id,
      method: typeof request.method === 'string' ? request.method : '',
      params: (request.params ?? {}) as Record<string, unknown>,
    };
    const outcome = await service.dispatch(wireRequest);
    if (outcome.error !== undefined) writer.error(wireRequest.id, outcome.error);
    else writer.result(wireRequest.id, outcome.result);
    for (const notification of outcome.notifications) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: notification.method, params: notification.params })}\n`);
    }
    if (wireRequest.method === 'shutdown') {
      process.exit(0);
    }
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[zcode-proxy] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
