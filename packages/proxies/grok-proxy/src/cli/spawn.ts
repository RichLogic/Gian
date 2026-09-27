#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';
import { planRuntimeInstallation } from '../runtime/install.js';

import { GrokProxyService } from '../core/service.js';
import { GrokProtocolV2Adapter, standardError } from '../protocol/v2-adapter.js';
import { discoverGrokRuntimes, probeGrokRuntime } from '../runtime/discover.js';
import {
  createProtocolWriter,
  parseRequestLine,
} from '../transport/protocol.js';

const SELF_TEST_FLAG = '--self-test';

function readPluginVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (
        typeof pkg.version === 'string'
        && pkg.version.length > 0
        && typeof pkg.name === 'string'
        && pkg.name.startsWith('@gian/')
        && pkg.name.endsWith('-proxy')
      ) {
        return pkg.version;
      }
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.3.6';
}

const PLUGIN_VERSION = readPluginVersion();

function runSelfTest(argv: string[]): boolean {
  if (!argv.includes(SELF_TEST_FLAG)) return false;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 4,
    id: 'grok',
    pluginVersion: PLUGIN_VERSION,
    ok: true,
  })}\n`);
  return true;
}

function parseArgs(argv: string[]) {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }

  const grokBin = typeof options['grok-bin'] === 'string'
    ? options['grok-bin']
    : process.env.GIAN_RUNTIME_BIN ?? process.env.GROK_BIN;
  if (!grokBin || !isAbsolute(grokBin)) {
    throw new Error('--grok-bin (or GROK_BIN) must be an absolute managed binary path.');
  }
  return { grokBin };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runSelfTest(argv)) return;
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'grok',
      pluginName: 'Grok Build',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'session',
      discover: discoverGrokRuntimes,
      probe: probeGrokRuntime,
    });
    return;
  }
  const options = parseArgs(argv);
  const writer = createProtocolWriter(process.stdout);

  const reportCrash = (kind: 'uncaught' | 'unhandledRejection', error: unknown) => {
    const message = error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : String(error);
    try {
      console.error(`[grok-proxy:${kind}]`, message);
      writer.notification('runtime.error', {
        eventId: `crash-${Date.now()}`,
        emittedAt: new Date().toISOString(),
        data: {
          domainCode: 'RUNTIME_ERROR',
          message,
          retryable: false,
          details: { kind },
        },
      });
    } finally {
      setTimeout(() => process.exit(1), 50);
    }
  };
  process.on('uncaughtException', (error) => reportCrash('uncaught', error));
  process.on('unhandledRejection', (error) => reportCrash('unhandledRejection', error));

  const service = new GrokProxyService({ binaryPath: options.grokBin });
  const adapter = new GrokProtocolV2Adapter(
    service,
    PLUGIN_VERSION,
    (method, params) => writer.notification(method, params),
  );

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await service.close();
    process.exit(code);
  };
  process.on('SIGINT', () => {
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  const { createInterface } = await import('node:readline');
  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  // Live-runtime requirement (E2E-verified against grok 1.0.41): while a
  // turn.start handle is still awaiting the native turn, the runtime can block
  // on a permission reverse request. A strictly serial loop would deadlock —
  // the Host's interaction.respond line sits unread behind the open
  // turn.start. These methods therefore overtake the loop and run
  // concurrently; their own notification barrier still holds (beginRequest /
  // flushNotifications), so Response-before-Notification is preserved.
  const OVERTAKE_METHODS = new Set(['interaction.respond', 'turn.interrupt', 'turn.steer']);

  const runOvertakeRequest = async (request: { id: string; method: string; params: Record<string, unknown> }) => {
    adapter.beginRequest();
    try {
      const result = await adapter.handle(request);
      writer.result(request.id, result);
      adapter.flushNotifications();
    } catch (error) {
      writer.error(request.id, standardError(error));
      adapter.flushNotifications();
    }
  };

  for await (const line of input) {
    if (!line.trim()) continue;
    let request: { id: string; method: string; params: Record<string, unknown> };
    try {
      request = parseRequestLine(line);
    } catch (error) {
      const id = (() => {
        try {
          const value = JSON.parse(line) as { id?: unknown };
          return typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
        } catch {
          return null;
        }
      })();
      writer.error(id, error);
      continue;
    }

    if (OVERTAKE_METHODS.has(request.method)) {
      void runOvertakeRequest(request);
      continue;
    }

    adapter.beginRequest();
    try {
      const result = await adapter.handle(request);
      if (request.method === 'sidechat.close') {
        adapter.flushNotifications();
        writer.result(request.id, result);
      } else {
        writer.result(request.id, result);
        adapter.flushNotifications();
      }
      if (request.method === 'shutdown') {
        input.close();
        await shutdown(0);
        return;
      }
    } catch (error) {
      // Domain-mapped: a raw GrokProxyError must never degrade to INTERNAL on
      // the wire (the E2E rename path surfaced exactly that).
      writer.error(request.id, standardError(error));
      adapter.flushNotifications();
    }
  }

  await shutdown(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
