import { createInterface } from 'node:readline';

import {
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  PROTOCOL_NAME,
  PROTOCOL_V22,
  RUNTIME_BOOTSTRAP_ENV,
  RUNTIME_BOOTSTRAP_VALUE,
} from './constants.js';
import type { RuntimeDiscoverResult, RuntimeProbeResult } from './schemas.js';

export function isRuntimeBootstrapOffer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RUNTIME_BOOTSTRAP_ENV] === RUNTIME_BOOTSTRAP_VALUE;
}

export interface RuntimeBootstrapServerOptions {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  processScope: 'shared' | 'session';
  discover: () => Promise<RuntimeDiscoverResult>;
  probe: (path: string) => Promise<RuntimeProbeResult>;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

function writeLine(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * 2.2-only stdio server. Serves initialize, catalog.list, runtime.discover,
 * runtime.probe, and shutdown without creating a vendor Runtime, bridge,
 * native Session store, or model service.
 */
export async function serveRuntimeBootstrap(options: RuntimeBootstrapServerOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const input = createInterface({ input: stdin, crlfDelay: Infinity });
  let initialized = false;

  for await (const line of input) {
    if (!line.trim()) continue;
    let request: { id?: unknown; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      writeLine(stdout, {
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: { code: JSONRPC_ERROR_CODES.PARSE_ERROR, message: 'Parse error' },
      });
      continue;
    }
    if (typeof request.id !== 'string' || request.id.length === 0) {
      writeLine(stdout, {
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: { code: JSONRPC_ERROR_CODES.INVALID_REQUEST, message: 'Request id must be a non-empty string.' },
      });
      continue;
    }
    const id = request.id;
    const method = typeof request.method === 'string' ? request.method : '';
    const params = (request.params ?? {}) as Record<string, unknown>;

    try {
      if (method === 'initialize') {
        const offered = (params.protocol as { versions?: unknown } | undefined)?.versions;
        const versions = Array.isArray(offered) ? offered.filter((item): item is string => typeof item === 'string') : [];
        if (!versions.includes(PROTOCOL_V22)) {
          throw Object.assign(new Error('Runtime bootstrap requires gian.proxy/2.2.'), { rpcCode: JSONRPC_ERROR_CODES.INVALID_PARAMS });
        }
        initialized = true;
        writeLine(stdout, {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: {
            protocol: { name: PROTOCOL_NAME, version: PROTOCOL_V22 },
            plugin: {
              id: options.pluginId,
              name: options.pluginName,
              version: options.pluginVersion,
            },
            process: { scope: options.processScope },
            capabilities: { 'runtime.discover': 1, 'runtime.probe': 1 },
          },
        });
        continue;
      }
      if (!initialized) {
        throw Object.assign(new Error('initialize must be first.'), { rpcCode: JSONRPC_ERROR_CODES.INVALID_REQUEST });
      }
      if (method === 'catalog.list') {
        writeLine(stdout, {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: {
            catalogRevision: 'runtime-bootstrap',
            input: [{ type: 'text' }],
            configOptions: [],
            slashCommands: [],
            specialCatalogs: {},
          },
        });
        continue;
      }
      if (method === 'runtime.discover') {
        writeLine(stdout, {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: await options.discover(),
        });
        continue;
      }
      if (method === 'runtime.probe') {
        const path = typeof params.path === 'string' ? params.path : '';
        writeLine(stdout, {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: await options.probe(path),
        });
        continue;
      }
      if (method === 'shutdown') {
        writeLine(stdout, { jsonrpc: JSONRPC_VERSION, id, result: { ok: true } });
        input.close();
        return;
      }
      writeLine(stdout, {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
          message: `${method} is not available during Runtime bootstrap.`,
        },
      });
    } catch (error) {
      writeLine(stdout, {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: typeof (error as { rpcCode?: unknown }).rpcCode === 'number'
            ? (error as { rpcCode: number }).rpcCode
            : JSONRPC_ERROR_CODES.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
