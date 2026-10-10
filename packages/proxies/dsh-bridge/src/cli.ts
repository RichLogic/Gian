#!/usr/bin/env node
/**
 * Standalone `gian.dsh.bridge/1.0` stdio server over a fake DSH runtime.
 *
 * This is the contract-suite entry used by the dsh-proxy tests and the bridge
 * unit tests: it drives the exact same BridgeServer as the real Cordis bundle
 * but against `FakeDshRuntime`, with zero model calls and zero process tree.
 */

import { BridgeServer } from './server.js';
import { BridgeWriter, runBridgeInput } from './jsonrpc.js';
import { FakeDshRuntime } from './fake-host.js';
import { BRIDGE_PACKAGE_VERSION } from './package-version.js';

const runtime = new FakeDshRuntime({
  bridgeVersion: BRIDGE_PACKAGE_VERSION,
  // Format 4 belongs to the pinned 0.2.0 runtime. 0.1.1-rc.2 never wrote it.
  dshVersion: process.env.DSH_FAKE_VERSION ?? '0.2.0-rc.2',
  ...(process.env.GIAN_HOST_BINDING_KEY
    ? { hostBindingKey: process.env.GIAN_HOST_BINDING_KEY }
    : {}),
});
const writer = new BridgeWriter(process.stdout);
const server = new BridgeServer({ host: runtime, writer });

process.on('SIGTERM', async () => {
  await runtime.shutdown();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await runtime.shutdown();
  process.exit(0);
});
process.on('uncaughtException', () => {
  process.exit(1);
});

await runBridgeInput(
  process.stdin,
  async (request) => server.handle(request),
  writer,
  (error) => {
    process.stderr.write(`[dsh-bridge] ${error instanceof Error ? error.message : String(error)}\n`);
  },
);
