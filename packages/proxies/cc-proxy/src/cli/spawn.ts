#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRuntimeBootstrapOffer, serveRuntimeBootstrap } from '@gian/proxy-protocol/node';
import { planRuntimeInstallation } from '../runtime/install.js';

import { CcProxyService } from '../core/service.js';
import { createTaskQueue } from '../core/task-queue.js';
import { ClaudeProtocolV2Adapter } from '../protocol/v2-adapter.js';
import { ClaudeMcpRuntime } from '../runtime/claude-mcp-runtime.js';
import { discoverClaudeRuntimes, probeClaudeRuntime } from '../runtime/discover.js';
import {
  ClaudeProtocolError,
  createProtocolWriter,
  parseRequestLine,
} from '../transport/protocol.js';

const SELF_TEST_FLAG = '--self-test';
const MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024;

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
    id: 'claude',
    pluginVersion: PLUGIN_VERSION,
    ok: true,
  })}\n`);
  return true;
}

function parseArgs(argv: string[]) {
  // `--data-dir` is ignored. The proxy is stateless; Host may still pass it.
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--data-dir' && argv[index + 1]) {
      index += 1;
      continue;
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runSelfTest(argv)) return;
  if (isRuntimeBootstrapOffer()) {
    await serveRuntimeBootstrap({
      installPlan: planRuntimeInstallation,
      pluginId: process.env.GIAN_PLUGIN_ID ?? 'claude',
      pluginName: 'Claude Code',
      pluginVersion: PLUGIN_VERSION,
      processScope: 'session',
      discover: discoverClaudeRuntimes,
      probe: probeClaudeRuntime,
    });
    return;
  }
  parseArgs(argv);
  if (process.env.GIAN_RUNTIME_BIN) {
    process.env.CLAUDE_BIN = process.env.GIAN_RUNTIME_BIN;
  }
  const writer = createProtocolWriter(process.stdout);

  const reportCrash = (kind: 'uncaught' | 'unhandledRejection', error: unknown) => {
    const message = error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : String(error);
    try {
      console.error(`[cc-proxy:${kind}]`, message);
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

  const runtime = new ClaudeMcpRuntime();
  const service = new CcProxyService({ runtime });
  const adapter = new ClaudeProtocolV2Adapter(
    service,
    PLUGIN_VERSION,
    (method, params) => writer.notification(method, params),
  );
  await service.initialize();

  // Every dispatched task (session or scan) is tracked so EOF/shutdown/signal
  // can drain in-flight work before the process exits: a scan must never be
  // orphaned without its Response because the loop ended or a shutdown was
  // processed while it was still running.
  const queue = createTaskQueue('cc-proxy');

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
        '[cc-proxy:shutdown] cleanup failed:',
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

  // Customization scans are pipelined (never await each other) so every kind
  // of an aggregate inspection is answered within its own bound: a slow kind
  // must not queue the remaining kinds behind it and push them past the Host
  // per-request timeout. Inspection processes never carry live sessions;
  // session requests (including shutdown) stay serialized among themselves.
  const isCustomization = (method: string): boolean => (
    method === 'customization.list' || method === 'customization.detail'
  );

  const dispatchTask = async (request: { id: string; method: string; params: Record<string, unknown> }) => {
    try {
      const result = await adapter.handle(request);
      if (request.method === 'sidechat.close') {
        // Contract §10.5.4 explicitly requires teardown terminals before the
        // close Success response.
        adapter.flushDeferredNotifications();
        writer.result(request.id, result);
      } else {
        writer.result(request.id, result);
        // Response-before-Notification: turn.started and interaction.resolved
        // are produced inside handle(), so the CLI must flush them only after
        // the JSON-RPC Response has been written.
        adapter.flushDeferredNotifications();
      }
      if (request.method === 'shutdown') {
        input.close();
        void shutdown(0);
      }
    } catch (error) {
      // Failure responses still precede notifications. Never discard a queued
      // notification: it may resolve a pending interaction or close a content
      // stream that the Host is already rendering.
      writer.error(request.id, error);
      adapter.flushDeferredNotifications();
    }
  };

  for await (const line of input) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_NDJSON_LINE_BYTES) {
      writer.error(null, new ClaudeProtocolError(
        'PARSE_ERROR',
        `NDJSON line exceeds ${MAX_NDJSON_LINE_BYTES} bytes.`,
      ));
      await shutdown(1);
      return;
    }
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
      if (id === null && error instanceof ClaudeProtocolError && error.domainCode === 'INVALID_REQUEST') {
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
