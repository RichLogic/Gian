import { createInterface } from 'node:readline';

import { CcProxyService } from '../core/service.js';
import type {
  ApprovalResponseParams,
  CloseSessionParams,
  CreateSessionParams,
  GetSessionParams,
  InterruptTurnParams,
  JsonRpcLikeRequest,
  SessionSnapshotParams,
  StartTurnParams,
} from '../core/types.js';
import { ClaudeMcpRuntime } from '../runtime/claude-mcp-runtime.js';
import { createProtocolWriter, protocolError } from '../transport/protocol.js';

function parseArgs(argv: string[]) {
  // The proxy is fully stateless — the only flag we still accept is
  // `--data-dir` for backward compat with existing host wiring; it's
  // ignored. No persistence, no on-disk state.
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--data-dir' && argv[index + 1]) {
      index += 1;
      continue;
    }
  }
}

async function main() {
  parseArgs(process.argv.slice(2));
  const writer = createProtocolWriter(process.stdout);

  // Crash safety net. Without these, any async error in event handlers
  // (handleProcessExited, runtime listeners, etc.) silently kills the
  // proxy and the host only sees `child.on('exit')` with no signal as to
  // why. We dump to stderr (which host pipes through as `[cc-proxy:stderr]`
  // log lines) and ALSO push a `runtime.error` notification so the host
  // can persist a session_error event before we go down. Then exit
  // explicitly so the supervisor (host) re-spawns on next turn.
  const reportCrash = (kind: 'uncaught' | 'unhandledRejection', err: unknown) => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    try { console.error(`[cc-proxy:${kind}]`, msg); } catch {}
    try {
      writer.notification('runtime.error', {
        data: { code: kind, message: msg },
      });
    } catch {}
    // Give stdout a tick to flush before tearing down.
    setTimeout(() => process.exit(1), 50);
  };
  process.on('uncaughtException', (err) => reportCrash('uncaught', err));
  process.on('unhandledRejection', (reason) => reportCrash('unhandledRejection', reason));

  const runtime = new ClaudeMcpRuntime();
  const service = new CcProxyService({
    runtime,
    emitEvent(method, params) {
      writer.notification(method, params);
    },
  });
  await service.initialize();

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
        case 'turn.start':
          writer.result(message.id, await service.startTurn((message.params ?? {}) as StartTurnParams, message.id));
          break;
        case 'turn.interrupt':
          writer.result(message.id, await service.interruptTurn((message.params ?? {}) as InterruptTurnParams));
          break;
        case 'approval.respond':
          writer.result(message.id, await service.respondApproval((message.params ?? {}) as ApprovalResponseParams));
          break;
        case 'session.snapshot':
          writer.result(message.id, service.sessionSnapshot((message.params ?? {}) as SessionSnapshotParams));
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
