#!/usr/bin/env node
/**
 * ai.deepseek.harness — shared-scope gian.proxy/2.1 over gian.dsh.bridge/1.0.
 */

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';
import { planRuntimeInstallation } from '../runtime/install.js';
import { DshV2Adapter } from '../protocol/v2-adapter.js';
import { BridgeClient, BridgeClientError } from '../runtime/bridge-client.js';
import { discoverDshRuntimes, probeDshRuntime } from '../runtime/discover.js';
import { ensureGianProfile } from '../runtime/profile.js';
import { parseArgs } from './bridge-launch.js';

function readPluginVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@gian/dsh-proxy' && typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('DSH Proxy package version is unavailable');
}

const PLUGIN_VERSION = readPluginVersion();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 4,
      id: 'ai.deepseek.harness',
      pluginVersion: PLUGIN_VERSION,
      ok: true,
    })}\n`);
    return;
  }
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'ai.deepseek.harness',
      pluginName: 'DeepSeek Harness',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'shared',
      discover: discoverDshRuntimes,
      probe: probeDshRuntime,
    });
    return;
  }
  const options = parseArgs(argv);
  if (options.managedProfile) {
    const profile = await ensureGianProfile();
    if (profile.actions.length > 0) {
      process.stderr.write(
        `[dsh-proxy] gian profile ${profile.actions.join(', ')} at ${profile.profileDir}\n`,
      );
    }
  }
  const bridge = new BridgeClient({ command: options.bridgeCommand, args: options.args });
  await bridge.start();

  const writer = {
    result(id: string, result: unknown): void {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    },
    error(id: string | null, error: unknown): void {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
    },
    notification(method: string, params: Record<string, unknown>): void {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };

  const adapter = new DshV2Adapter(bridge, {
    pluginVersion: PLUGIN_VERSION,
    ...(process.env.GIAN_HOST_BINDING_KEY
      ? { hostBindingKey: process.env.GIAN_HOST_BINDING_KEY }
      : {}),
  });
  adapter.setEmitSink((method, params) => writer.notification(method, params));

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let shuttingDown = false;

  for await (const line of reader) {
    if (line.trim() === '') continue;
    let request: { id: string; method: string; params: Record<string, unknown> };
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
    try {
      const outcome = await adapter.dispatch(request);
      if (outcome.error) writer.error(request.id, outcome.error);
      else writer.result(request.id, outcome.result);
      for (const notification of outcome.notifications) {
        writer.notification(notification.method, notification.params);
      }
      if (request.method === 'shutdown') {
        shuttingDown = true;
        await bridge.stop();
        process.exit(0);
      }
    } catch (error) {
      writer.error(request.id, {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (shuttingDown === false) {
    await bridge.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`[dsh-proxy] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
