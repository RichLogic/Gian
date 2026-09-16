#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';
import { planRuntimeInstallation } from '../runtime/install.js';
import { createTaskQueue } from '../core/task-queue.js';
import { CodexProxyService } from '../core/service.js';
import { CodexProtocolV2Adapter } from '../protocol/v2-adapter.js';
import { CodexAppServerClient } from '../runtime/codex-app-server-client.js';
import { discoverCodexRuntimes, probeCodexRuntime } from '../runtime/discover.js';
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
  return '0.3.1';
}

const PLUGIN_VERSION = readPluginVersion();

function runSelfTest(argv: string[]): boolean {
  if (!argv.includes(SELF_TEST_FLAG)) return false;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 4,
    id: 'codex',
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

  return {
    codexBin: typeof options['codex-bin'] === 'string'
      ? options['codex-bin']
      : process.env.GIAN_RUNTIME_BIN ?? process.env.CODEX_BIN,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runSelfTest(argv)) return;
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'codex',
      pluginName: 'Codex',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'shared',
      discover: discoverCodexRuntimes,
      probe: probeCodexRuntime,
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
      console.error(`[codex-proxy:${kind}]`, message);
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

  const runtime = new CodexAppServerClient(
    options.codexBin ? { codexBin: options.codexBin } : {},
  );
  const service = new CodexProxyService({ runtime });
  // Request pipelining (shared Host responsiveness): a slow customization
  // scan must never block live session traffic, and session traffic must
  // never block a scan. Session-scoped requests stay serialized among
  // themselves; customization requests dispatch concurrently. Notifications
  // produced while a session handler is executing are captured per request
  // and flushed after that request's Response (Contract: Response-before-
  // Notification); notifications emitted with no handler active (spontaneous
  // runtime events) go out immediately.
  //
  // The capture slot is request-scoped: only session dispatch tasks install
  // one, and exactly one session task runs at a time (they are serialized
  // through the task queue). A concurrent customization scan must never touch
  // the slot — otherwise it would swallow, reorder, or prematurely flush a
  // live session's notifications.
  let sessionCapture: Array<{ method: string; params: Record<string, unknown> }> | null = null;
  const adapter = new CodexProtocolV2Adapter(
    service,
    PLUGIN_VERSION,
    (method, params) => {
      if (sessionCapture) sessionCapture.push({ method, params });
      else writer.notification(method, params);
    },
  );
  await service.initialize();

  // Every dispatched task (session or scan) is tracked so EOF/shutdown/signal
  // can drain in-flight work before the process exits: a scan must never be
  // orphaned without its Response because the loop ended or a shutdown was
  // processed while it was still running.
  const queue = createTaskQueue('codex-proxy');

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await queue.drain();
      await service.close();
    } catch (error) {
      // Fail closed: an unverified terminal cleanup must turn the shutdown
      // into a failed exit, not a silent clean one — and must never surface
      // as an unhandled rejection.
      console.error(
        '[codex-proxy:shutdown] cleanup failed:',
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

  const isCustomization = (method: string): boolean => (
    method === 'customization.list' || method === 'customization.detail'
  );

  const dispatchTask = (request: { id: string; method: string; params: Record<string, unknown> }): Promise<void> => (
    (async () => {
      // Customization scans emit no notifications: they never install a
      // capture, so a scan running concurrently with a session handler
      // cannot steal or reorder that handler's notifications.
      const capture: Array<{ method: string; params: Record<string, unknown> }> | null
        = isCustomization(request.method) ? null : [];
      if (capture) sessionCapture = capture;
      const flushCapture = (): void => {
        if (!capture) return;
        for (const notification of capture) {
          writer.notification(notification.method, notification.params);
        }
        capture.length = 0;
      };
      try {
        const result = await adapter.handle(request);
        if (request.method === 'sidechat.close') {
          // Contract §10.5.4: terminal teardown notifications are the one
          // explicit exception to normal Response-before-Notification order.
          if (capture) sessionCapture = null;
          flushCapture();
          writer.result(request.id, result);
          return;
        }
        writer.result(request.id, result);
      } catch (error) {
        writer.error(request.id, error);
      } finally {
        if (capture) {
          if (sessionCapture === capture) sessionCapture = null;
          flushCapture();
        }
        if (request.method === 'shutdown') {
          input.close();
          void shutdown(0);
        }
      }
    })()
  );

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
