#!/usr/bin/env node

import { isAbsolute } from 'node:path';
import {
  CORE_METHODS,
  OPTIONAL_METHOD_CAPABILITIES,
  ProxyProtocolError,
  parseNdjsonObject,
  parseProxyRequest,
  readNdjsonLines,
  type ProxyNotification,
  type ProxyRequest,
} from '@gian/proxy-protocol';

import { GrokProxyService } from '../core/service.js';
import { writeJsonLine } from '../transport/protocol.js';
import { GrokProtocolV1Adapter, grokProtocolError } from '../protocol/v1-adapter.js';

const SELF_TEST_FLAG = '--self-test';
const PLUGIN_VERSION = '0.2.3';
const V1_METHODS = new Set<string>([
  ...CORE_METHODS,
  ...Object.keys(OPTIONAL_METHOD_CAPABILITIES),
]);

function runSelfTest(argv: string[]): boolean {
  if (!argv.includes(SELF_TEST_FLAG)) return false;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 2,
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

function createV1Writer() {
  return {
    result(id: string | number, result: unknown) {
      writeJsonLine(process.stdout, { id, result });
    },
    error(id: string | number, error: unknown) {
      writeJsonLine(process.stdout, { id, error: grokProtocolError(error) });
    },
    notification(notification: ProxyNotification) {
      writeJsonLine(process.stdout, notification);
    },
  };
}

function usableRequestId(value: unknown): string | number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as { id?: unknown }).id;
  return (typeof id === 'string' && id.length > 0) || Number.isSafeInteger(id)
    ? id as string | number
    : null;
}

async function runV1Loop(service: GrokProxyService): Promise<void> {
  const writer = createV1Writer();
  const adapter = new GrokProtocolV1Adapter(
    service,
    PLUGIN_VERSION,
    notification => writer.notification(notification),
  );
  for await (const line of readNdjsonLines(process.stdin)) {
    const value = parseNdjsonObject(line);
    if (value === null) continue;
    const id = usableRequestId(value);
    const method = typeof value.method === 'string' ? value.method : null;
    if (method && !V1_METHODS.has(method)) {
      if (id === null) {
        throw new ProxyProtocolError('PROTOCOL_VIOLATION', 'Unknown method omitted a usable id.', true);
      }
      writer.error(id, new ProxyProtocolError(
        'METHOD_NOT_FOUND',
        `Unknown method "${method}".`,
        false,
      ));
      continue;
    }
    let request: ProxyRequest;
    try {
      request = parseProxyRequest(value);
    } catch (error) {
      if (id === null) throw error;
      writer.error(id, error);
      continue;
    }
    try {
      const result = await adapter.handle(request);
      writer.result(request.id, result);
      if (request.method === 'shutdown') {
        process.stdin.pause();
        await service.close();
        return;
      }
    } catch (error) {
      writer.error(request.id, error);
    }
  }
  process.stdin.pause();
  await service.close();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runSelfTest(argv)) return;
  const options = parseArgs(argv);

  const reportCrash = (kind: 'uncaught' | 'unhandledRejection', error: unknown) => {
    const message = error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : String(error);
    try {
      console.error(`[grok-proxy:${kind}]`, message);
      writeJsonLine(process.stdout, {
        method: 'runtime.error',
        params: {
          eventId: `crash-${Date.now()}`,
          emittedAt: new Date().toISOString(),
          data: {
            code: 'RUNTIME_ERROR',
            message,
            retryable: false,
            data: { kind },
          },
        },
      });
    } finally {
      setTimeout(() => process.exit(1), 50);
    }
  };
  process.on('uncaughtException', (error) => reportCrash('uncaught', error));
  process.on('unhandledRejection', (error) => reportCrash('unhandledRejection', error));

  const service = new GrokProxyService({ binaryPath: options.grokBin });
  await runV1Loop(service);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
