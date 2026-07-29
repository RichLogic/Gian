#!/usr/bin/env node

import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

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
import { createProtocolWriter, protocolError } from '../transport/protocol.js';

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
    : process.env.KIMI_BIN;
  if (!kimiBin || !isAbsolute(kimiBin)) {
    throw new Error('--kimi-bin (or KIMI_BIN) must be an absolute managed binary path.');
  }
  return { kimiBin };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const writer = createProtocolWriter(process.stdout);

  const reportCrash = (kind: 'uncaught' | 'unhandledRejection', error: unknown) => {
    const message = error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : String(error);
    try {
      console.error(`[kimi-proxy:${kind}]`, message);
      writer.notification('runtime.error', {
        data: { code: kind, message },
      });
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
      writer.notification(method, params);
    },
  });
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
