#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';
import { planRuntimeInstallation } from '../runtime/install.js';

import { KimiProxyService } from '../core/service.js';
import { createTaskQueue } from '../core/task-queue.js';
import { KimiProtocolV2Adapter } from '../protocol/v2-adapter.js';
import { KimiAcpClient } from '../runtime/kimi-acp-client.js';
import { discoverKimiRuntimes, probeKimiRuntime } from '../runtime/discover.js';
import {
  createProtocolWriter,
  KimiProtocolError,
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
  return '0.3.2';
}

const PLUGIN_VERSION = readPluginVersion();

function runSelfTest(argv: string[]): boolean {
  if (!argv.includes(SELF_TEST_FLAG)) return false;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 4,
    id: 'kimi',
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

  const kimiBin = typeof options['kimi-bin'] === 'string'
    ? options['kimi-bin']
    : process.env.GIAN_RUNTIME_BIN ?? process.env.KIMI_BIN;
  if (!kimiBin || !isAbsolute(kimiBin)) {
    throw new Error('--kimi-bin (or KIMI_BIN) must be an absolute managed binary path.');
  }
  return { kimiBin };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runSelfTest(argv)) return;
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'kimi',
      pluginName: 'Kimi Code',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'shared',
      discover: discoverKimiRuntimes,
      probe: probeKimiRuntime,
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
      console.error(`[kimi-proxy:${kind}]`, message);
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

  const runtime = new KimiAcpClient({ binaryPath: options.kimiBin });
  const service = new KimiProxyService({ runtime });
  const adapter = new KimiProtocolV2Adapter(
    service,
    PLUGIN_VERSION,
    (method, params) => writer.notification(method, params),
  );
  await service.initialize();

  // Every dispatched task (session or scan) is tracked so EOF/shutdown/signal
  // can drain in-flight work before the process exits: a scan must never be
  // orphaned without its Response because the loop ended or a shutdown was
  // processed while it was still running.
  const queue = createTaskQueue('kimi-proxy');

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await queue.drain();
      await service.close();
    } catch (error) {
      // Fail closed: an unverified terminal process group must turn the
      // shutdown into a failed exit, not a silent clean one — and must never
      // surface as an unhandled rejection.
      console.error(
        '[kimi-proxy:shutdown] terminal cleanup failed:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
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

  // Request pipelining (shared Host responsiveness): a slow customization
  // scan must never block live session traffic, and session traffic must
  // never block a scan. Session-scoped requests stay serialized among
  // themselves; customization requests dispatch concurrently. Kimi's
  // dispatch() returns per-request notifications, so Response-before-
  // Notification holds for every pipelined request.
  const isCustomization = (method: string): boolean => (
    method === 'customization.list' || method === 'customization.detail'
  );

  const dispatchTask = async (request: { id: string; method: string; params: Record<string, unknown> }) => {
    try {
      const outcome = await adapter.dispatch(request);
      if (outcome.ok && request.method === 'sidechat.close') {
        // Side Chat close is the explicit teardown-order exception: finish
        // the route before acknowledging permanent local deletion.
        for (const notification of outcome.notifications) {
          writer.notification(notification.method, notification.params);
        }
        writer.result(request.id, outcome.result);
      } else {
        if (outcome.ok) writer.result(request.id, outcome.result);
        else writer.error(request.id, outcome.error);
        for (const notification of outcome.notifications) {
          writer.notification(notification.method, notification.params);
        }
      }
      if (outcome.ok && request.method === 'shutdown') {
        input.close();
        void shutdown(0);
      }
    } catch (error) {
      writer.error(request.id, error);
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
      if (
        id === null
        && error instanceof KimiProtocolError
        && (error.domainCode === 'INVALID_REQUEST' || error.domainCode === 'PARSE_ERROR')
      ) {
        writer.error(null, error);
        continue;
      }
      writer.error(id, error);
      continue;
    }

    if (isCustomization(request.method)) {
      // Pipelined by design; the loop never waits for a scan.
      queue.enqueuePipelined(() => dispatchTask(request));
      continue;
    }
    // Session traffic is strictly serialized relative to itself but never
    // waits for an in-flight customization scan (and vice versa).
    queue.enqueueSession(() => dispatchTask(request));
  }

  // EOF with work still in flight: every tracked task (including scans) gets
  // to write its Response before the process exits.
  await queue.drain();
  await shutdown(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
