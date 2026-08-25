#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexProxyService } from '../core/service.js';
import { CodexProtocolV2Adapter } from '../protocol/v2-adapter.js';
import { CodexAppServerClient } from '../runtime/codex-app-server-client.js';
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
  return '0.2.3';
}

const PLUGIN_VERSION = readPluginVersion();

function runSelfTest(argv: string[]): boolean {
  if (!argv.includes(SELF_TEST_FLAG)) return false;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 2,
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
  let responsePending = false;
  const pendingNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const flushNotifications = () => {
    for (const notification of pendingNotifications.splice(0)) {
      writer.notification(notification.method, notification.params);
    }
  };
  const adapter = new CodexProtocolV2Adapter(
    service,
    PLUGIN_VERSION,
    (method, params) => {
      if (responsePending) pendingNotifications.push({ method, params });
      else writer.notification(method, params);
    },
  );
  await service.initialize();

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

    responsePending = true;
    try {
      const result = await adapter.handle(request);
      if (request.method === 'sidechat.close') {
        // Contract §10.5.4: terminal teardown notifications are the one
        // explicit exception to normal Response-before-Notification order.
        responsePending = false;
        flushNotifications();
        writer.result(request.id, result);
      } else {
        writer.result(request.id, result);
        responsePending = false;
        flushNotifications();
      }
      if (request.method === 'shutdown') {
        input.close();
        await shutdown(0);
        return;
      }
    } catch (error) {
      writer.error(request.id, error);
      responsePending = false;
      flushNotifications();
    }
  }

  await shutdown(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
