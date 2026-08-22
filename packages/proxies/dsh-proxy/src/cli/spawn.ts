#!/usr/bin/env node
/**
 * ai.deepseek.harness — shared-scope gian.proxy/2.0 over gian.dsh.bridge/1.0.
 */

import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { DshV2Adapter } from '../protocol/v2-adapter.js';
import { BridgeClient, BridgeClientError } from '../runtime/bridge-client.js';

const PLUGIN_VERSION = '0.1.0';

function bridgeArgs(argv: string[], explicit: string | undefined): string[] {
  const configured = process.env.GIAN_DSH_HOST_ARGS;
  if (configured !== undefined) {
    const parsed = JSON.parse(configured) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === 'string')) {
      throw new Error('GIAN_DSH_HOST_ARGS must be a JSON array of strings.');
    }
    return parsed;
  }
  const extraArgs = argv.filter((arg) => arg.startsWith('--') === false);
  // The protocol client passes the DSH profile launcher via GIAN_RUNTIME_BIN.
  // An explicit test bridge is already a bridge/1.0 stdio entry; the real DSH
  // launcher always needs `--profile gian` so the bridge bundle mounts on
  // stdout (plan §3.4: shared Host running profile "gian").
  return explicit !== undefined
    ? extraArgs
    : ['--profile', 'gian', ...extraArgs];
}

function parseArgs(argv: string[]): { bridgeCommand: string; args: string[] } {
  const explicit = argv.find((arg) => arg.startsWith('--bridge='))?.slice('--bridge='.length);
  const command = process.env.GIAN_DSH_HOST_ENTRY
    ?? explicit
    ?? process.env.GIAN_RUNTIME_BIN
    ?? process.env.DSH_HOST_ENTRY
    ?? null;
  if (!command) {
    throw new Error('dsh-proxy requires GIAN_DSH_HOST_ENTRY (or --bridge=<path>) to the DSH host entry.');
  }
  return { bridgeCommand: command, args: bridgeArgs(argv, explicit) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 2,
      id: 'ai.deepseek.harness',
      pluginVersion: PLUGIN_VERSION,
      ok: true,
    })}\n`);
    return;
  }
  const options = parseArgs(argv);
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

  const adapter = new DshV2Adapter(bridge, { pluginVersion: PLUGIN_VERSION });
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
