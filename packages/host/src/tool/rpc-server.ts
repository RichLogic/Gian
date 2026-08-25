import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import {
  GIAN_TOOL_ERROR_CODES,
  GIAN_TOOL_METHODS,
  GIAN_TOOL_MUTATION_METHODS,
} from '@gian/shared';
import type { GianToolService } from './service.js';

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_CONCURRENT_WAITS = 8;

export function gianToolSocketPath(dataDir: string): string {
  return join(dataDir, 'run', 'gian-tool-v1.sock');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request exceeds 1 MiB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const request = httpRequest({ socketPath, path: '/ping', method: 'GET', timeout: 500 }, response => {
      response.resume();
      resolve(true);
    });
    request.once('timeout', () => {
      request.destroy();
      resolve(true);
    });
    request.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOENT') resolve(false);
      else reject(error);
    });
    request.end();
  });
}

async function prepareSocket(socketPath: string): Promise<void> {
  const runDir = dirname(socketPath);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await chmod(runDir, 0o700);
  let stat;
  try { stat = await lstat(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw new Error(`refusing unsafe Gian Tool socket path: ${socketPath}`);
  }
  if (await socketIsActive(socketPath)) {
    throw new Error(`another Gian Host owns the Tool socket: ${socketPath}`);
  }
  await unlink(socketPath);
}

export interface GianToolRpcHandle {
  socketPath: string;
  close(): Promise<void>;
}

export async function startGianToolRpc(options: {
  dataDir: string;
  service: GianToolService;
}): Promise<GianToolRpcHandle> {
  const socketPath = gianToolSocketPath(options.dataDir);
  await prepareSocket(socketPath);
  let active = 0;
  let activeWaits = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/ping') {
      json(response, 200, { ok: true, protocol: 'gian.tool', version: 1 });
      return;
    }
    if (request.method === 'GET' && request.url === '/schema') {
      json(response, 200, {
        protocol: 'gian.tool',
        version: 1,
        methods: GIAN_TOOL_METHODS,
        mutations: GIAN_TOOL_MUTATION_METHODS,
        errors: GIAN_TOOL_ERROR_CODES,
      });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/rpc') {
      json(response, 404, {
        ok: false,
        request_id: '',
        error: { code: 'NOT_FOUND', message: 'RPC endpoint not found', retryable: false },
      });
      return;
    }
    if (active >= MAX_CONCURRENT_REQUESTS) {
      json(response, 503, {
        ok: false,
        request_id: '',
        error: { code: 'CONFLICT', message: 'Too many concurrent Tool calls', retryable: true },
      });
      return;
    }
    active += 1;
    let waitClaimed = false;
    try {
      const call = await body(request);
      const isWait = !!call && typeof call === 'object'
        && (call as { method?: unknown }).method === 'session.wait';
      if (isWait) {
        if (activeWaits >= MAX_CONCURRENT_WAITS) {
          json(response, 503, {
            ok: false,
            request_id: '',
            error: { code: 'CONFLICT', message: 'Too many concurrent waits', retryable: true },
          });
          return;
        }
        activeWaits += 1;
        waitClaimed = true;
      }
      json(response, 200, await options.service.call(call));
    } catch (error) {
      json(response, 400, {
        ok: false,
        request_id: '',
        error: {
          code: 'INVALID_ARGUMENT',
          message: error instanceof SyntaxError ? 'Request body must be valid JSON' : 'Invalid Gian Tool request',
          retryable: false,
        },
      });
    } finally {
      active -= 1;
      if (waitClaimed) activeWaits -= 1;
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  const owned = await lstat(socketPath);

  return {
    socketPath,
    close: async () => {
      options.service.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      try {
        const current = await lstat(socketPath);
        if (current.dev === owned.dev && current.ino === owned.ino && current.isSocket()) await unlink(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
