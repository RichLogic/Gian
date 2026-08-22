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

const runtime = new FakeDshRuntime({
  bridgeVersion: '0.1.0',
  dshVersion: process.env.DSH_FAKE_VERSION ?? '0.1.0-rc.7',
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
