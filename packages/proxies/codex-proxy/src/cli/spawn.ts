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

import { CodexProxyService } from '../core/service.js';
import type {
  ApprovalResponseParams,
  CloseSessionParams,
  CreateSessionParams,
  GetSessionParams,
  InterruptTurnParams,
  SetNameParams,
  JsonRpcLikeRequest,
  SessionSnapshotParams,
  StartTurnParams,
  SteerTurnParams,
} from '../core/types.js';
import { CodexAppServerClient } from '../runtime/codex-app-server-client.js';
import { createProtocolWriter, protocolError, writeJsonLine } from '../transport/protocol.js';
import { CodexProtocolV1Adapter, codexProtocolError } from '../protocol/v1-adapter.js';

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
    ? { schemaVersion: 2, id: 'codex', pluginVersion: PLUGIN_VERSION, ok: true }
    : { schemaVersion: 1, id: 'codex', ok: true })}\n`);
  return true;
}

function parseArgs(argv: string[]) {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current || !current.startsWith('--')) {
      continue;
    }
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

function createV1Writer() {
  return {
    result(id: string | number, result: unknown) {
      writeJsonLine(process.stdout, { id, result });
    },
    error(id: string | number, error: unknown) {
      writeJsonLine(process.stdout, { id, error: codexProtocolError(error) });
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

async function runV1Loop(service: CodexProxyService): Promise<void> {
  const writer = createV1Writer();
  const adapter = new CodexProtocolV1Adapter(
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

async function main() {
  const argv = process.argv.slice(2);
  const v1 = protocolV1Enabled();
  if (runSelfTest(argv, v1)) return;
  const options = parseArgs(argv);
  const writer = createProtocolWriter(process.stdout);

  // Crash safety net — without these, any async error in runtime listeners
  // silently kills the proxy and host only sees `child.on('exit')` with no
  // diagnostic. Surface via stderr + a `runtime.error` notification so host
  // can persist a session_error event before we go down.
  const reportCrash = (kind: 'uncaught' | 'unhandledRejection', err: unknown) => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    try { console.error(`[codex-proxy:${kind}]`, msg); } catch {}
    try {
      if (v1) {
        writeJsonLine(process.stdout, {
          method: 'runtime.error',
          params: {
            eventId: `crash-${Date.now()}`,
            emittedAt: new Date().toISOString(),
            data: {
              code: 'RUNTIME_ERROR',
              message: msg,
              retryable: false,
              data: { kind },
            },
          },
        });
      } else {
        writer.notification('runtime.error', {
          data: { code: kind, message: msg },
        });
      }
    } catch {}
    setTimeout(() => process.exit(1), 50);
  };
  process.on('uncaughtException', (err) => reportCrash('uncaught', err));
  process.on('unhandledRejection', (reason) => reportCrash('unhandledRejection', reason));
  const runtime = new CodexAppServerClient(
    options.codexBin
      ? { codexBin: options.codexBin }
      : {},
  );
  const service = new CodexProxyService({
    runtime,
    emitEvent(method, params) {
      if (v1) {
        if (method === 'debug') console.error(`[codex-proxy] ${JSON.stringify(params)}`);
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

  const shutdown = async (code = 0) => {
    await service.close();
    process.exit(code);
  };

  process.on('SIGINT', () => {
    shutdown(0).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdown(0).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    let message: JsonRpcLikeRequest;
    try {
      message = JSON.parse(line) as JsonRpcLikeRequest;
    } catch (error) {
      writer.notification('protocol.error', protocolError(error, 'INVALID_JSON'));
      continue;
    }

    if (!message.method || typeof message.method !== 'string') {
      if (message.id !== undefined) {
        writer.error(message.id, { code: 'INVALID_REQUEST', message: 'method is required.' });
      } else {
        writer.notification('protocol.error', { code: 'INVALID_REQUEST', message: 'method is required.' });
      }
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
        case 'slash.list': {
          const slashParams = (message.params ?? {}) as { cwd?: unknown };
          const cwd = typeof slashParams.cwd === 'string' ? slashParams.cwd : undefined;
          writer.result(message.id, await service.listSlashCommands(cwd));
          break;
        }
        case 'session.create':
          writer.result(message.id, await service.createSession((message.params ?? {}) as CreateSessionParams));
          break;
        case 'session.get':
          writer.result(message.id, service.getSession((message.params ?? {}) as GetSessionParams));
          break;
        case 'session.setName':
          writer.result(message.id, await service.setName((message.params ?? {}) as SetNameParams));
          break;
        case 'turn.start':
          writer.result(message.id, await service.startTurn((message.params ?? {}) as StartTurnParams, message.id));
          break;
        case 'turn.interrupt':
          writer.result(message.id, await service.interruptTurn((message.params ?? {}) as InterruptTurnParams));
          break;
        case 'turn.steer':
          writer.result(message.id, await service.steerTurn((message.params ?? {}) as SteerTurnParams));
          break;
        case 'approval.respond':
          writer.result(message.id, await service.respondApproval((message.params ?? {}) as ApprovalResponseParams));
          break;
        case 'session.snapshot':
          writer.result(message.id, await service.sessionSnapshot((message.params ?? {}) as SessionSnapshotParams));
          break;
        case 'session.close':
          writer.result(message.id, await service.closeSession((message.params ?? {}) as CloseSessionParams));
          break;
        case 'shutdown':
          writer.result(message.id, { ok: true });
          await shutdown(0);
          return;
        default:
          writer.error(message.id, {
            code: 'METHOD_NOT_FOUND',
            message: `Unknown method "${message.method}".`,
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
