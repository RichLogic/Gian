#!/usr/bin/env node

import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CORE_METHODS,
  OPTIONAL_METHOD_CAPABILITIES,
  PROTOCOL_V1,
  ProxyProtocolError,
  parseNdjsonObject,
  parseProxyRequest,
  readNdjsonLines,
  type ProxyNotification,
  type ProxyRequest,
} from '@gian/proxy-protocol';

import { KimiProxyService } from '../core/service.js';
import type {
  ApprovalResponseParams,
  CloseSessionParams,
  CreateSessionParams,
  GetSessionParams,
  InterruptTurnParams,
  JsonRpcLikeRequest,
  ListNativeSessionsParams,
  SessionSnapshotParams,
  SetConfigOptionParams,
  StartTurnParams,
} from '../core/types.js';
import { KimiAcpClient } from '../runtime/kimi-acp-client.js';
import { createProtocolWriter, protocolError, writeJsonLine } from '../transport/protocol.js';
import { KimiProtocolV1Adapter, kimiProtocolError } from '../protocol/v1-adapter.js';

const SELF_TEST_FLAG = '--self-test';
const PLUGIN_VERSION = '0.1.0';
const V1_METHODS = new Set<string>([
  ...CORE_METHODS,
  ...Object.keys(OPTIONAL_METHOD_CAPABILITIES),
]);

function protocolV1Enabled(): boolean {
  return (process.env.GIAN_PROTOCOL_VERSIONS ?? '')
    .split(',')
    .map(value => value.trim())
    .includes(PROTOCOL_V1);
}

function runSelfTest(argv: string[], v1: boolean): boolean {
  if (!argv.includes(SELF_TEST_FLAG)) return false;
  process.stdout.write(`${JSON.stringify(v1
    ? { schemaVersion: 2, id: 'kimi', pluginVersion: PLUGIN_VERSION, ok: true }
    : { schemaVersion: 1, id: 'kimi', ok: true })}\n`);
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

function createV1Writer() {
  return {
    result(id: string | number, result: unknown) {
      writeJsonLine(process.stdout, { id, result });
    },
    error(id: string | number, error: unknown) {
      writeJsonLine(process.stdout, { id, error: kimiProtocolError(error) });
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

async function runV1Loop(service: KimiProxyService): Promise<void> {
  const writer = createV1Writer();
  const adapter = new KimiProtocolV1Adapter(
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
  const v1 = protocolV1Enabled();
  if (runSelfTest(argv, v1)) return;
  const options = parseArgs(argv);
  const writer = createProtocolWriter(process.stdout);

  const reportCrash = (kind: 'uncaught' | 'unhandledRejection', error: unknown) => {
    const message = error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : String(error);
    try {
      console.error(`[kimi-proxy:${kind}]`, message);
      if (v1) {
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
      } else {
        writer.notification('runtime.error', {
          data: { code: kind, message },
        });
      }
    } finally {
      setTimeout(() => process.exit(1), 50);
    }
  };
  process.on('uncaughtException', (error) => reportCrash('uncaught', error));
  process.on('unhandledRejection', (error) => reportCrash('unhandledRejection', error));

  const runtime = new KimiAcpClient({ binaryPath: options.kimiBin });
  const service = new KimiProxyService({
    runtime,
    emitEvent(method, params) {
      if (v1) {
        if (method === 'debug') console.error(`[kimi-proxy] ${JSON.stringify(params)}`);
        return;
      }
      writer.notification(method, params);
    },
  });
  await service.initialize();

  if (v1) {
    await runV1Loop(service);
    return;
  }

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

  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of input) {
    if (!line.trim()) continue;

    let message: JsonRpcLikeRequest;
    try {
      message = JSON.parse(line) as JsonRpcLikeRequest;
    } catch (error) {
      writer.notification('protocol.error', protocolError(error, 'INVALID_JSON'));
      continue;
    }

    if (!message.method || typeof message.method !== 'string') {
      const error = { code: 'INVALID_REQUEST', message: 'method is required.' };
      if (message.id === undefined) writer.notification('protocol.error', error);
      else writer.error(message.id, error);
      continue;
    }

    try {
      switch (message.method) {
        case 'initialize':
          writer.result(message.id, service.initializePayload());
          break;
        case 'capabilities.list':
          writer.result(message.id, await service.listCapabilities());
          break;
        case 'slash.list':
          writer.result(
            message.id,
            await service.listSlashCommands((message.params ?? {}) as GetSessionParams),
          );
          break;
        case 'session.create':
          writer.result(
            message.id,
            await service.createSession((message.params ?? {}) as CreateSessionParams),
          );
          break;
        case 'session.get':
          writer.result(
            message.id,
            service.getSession((message.params ?? {}) as GetSessionParams),
          );
          break;
        case 'session.listNative':
          writer.result(
            message.id,
            await service.listNativeSessions(
              (message.params ?? {}) as ListNativeSessionsParams,
            ),
          );
          break;
        case 'session.config.set':
          writer.result(
            message.id,
            await service.setConfigOption(
              (message.params ?? {}) as SetConfigOptionParams,
            ),
          );
          break;
        case 'turn.start':
          writer.result(
            message.id,
            await service.startTurn(
              (message.params ?? {}) as StartTurnParams,
              message.id,
            ),
          );
          break;
        case 'turn.interrupt':
          writer.result(
            message.id,
            await service.interruptTurn(
              (message.params ?? {}) as InterruptTurnParams,
            ),
          );
          break;
        case 'approval.respond':
          writer.result(
            message.id,
            await service.respondApproval(
              (message.params ?? {}) as ApprovalResponseParams,
            ),
          );
          break;
        case 'session.snapshot':
          writer.result(
            message.id,
            await service.sessionSnapshot(
              (message.params ?? {}) as SessionSnapshotParams,
            ),
          );
          break;
        case 'session.close':
          writer.result(
            message.id,
            await service.closeSession(
              (message.params ?? {}) as CloseSessionParams,
            ),
          );
          break;
        case 'shutdown':
          writer.result(message.id, { ok: true });
          await shutdown(0);
          return;
        default:
          writer.error(message.id, {
            code: 'METHOD_NOT_FOUND',
            message: `Unknown method ${message.method}.`,
          });
      }
    } catch (error) {
      writer.error(message.id, error);
    }
  }

  await shutdown(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
