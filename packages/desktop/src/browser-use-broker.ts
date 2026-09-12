import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  validateGianToolParams,
  type GianToolError,
  type GianToolMethod,
  type GianToolMethodData,
  type GianToolMethodParams,
} from '@gian/shared';
import {
  BrowserAutomationError,
  isBrowserToolMethod,
} from './browser-automation.js';

export const BROWSER_USE_BROKER_SOCKET_ENV = 'GIAN_DESKTOP_BROWSER_BROKER_SOCKET';
export const BROWSER_USE_BROKER_PATH = '/v1/browser-use';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

export interface BrowserUseBrokerCall {
  method: GianToolMethod;
  params: GianToolMethodParams[GianToolMethod];
  actor: { callerId: string; sessionId: string | null };
}

export interface BrowserUseBrokerHandler {
  call<M extends GianToolMethod>(
    method: M,
    params: GianToolMethodParams[M],
    actor: BrowserUseBrokerCall['actor'],
  ): Promise<GianToolMethodData[M]>;
}

export function resolveBrowserUseBrokerSocketPath(
  identity: string,
  temporaryDirectory = tmpdir(),
): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return join(temporaryDirectory, `gian-browser-${digest}.sock`);
}

export class BrowserUseBroker {
  private server: Server | null = null;

  constructor(private readonly options: {
    socketPath: string;
    handler: () => BrowserUseBrokerHandler | null;
  }) {}

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.options.socketPath);
    const server = createServer((request, response) => { void this.handle(request, response); });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.options.socketPath);
      });
      await chmod(this.options.socketPath, 0o600);
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await removeSocket(this.options.socketPath);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      if (request.method !== 'POST' || request.url !== BROWSER_USE_BROKER_PATH) {
        sendJson(response, 404, { ok: false, error: brokerError('NOT_FOUND', 'Browser broker route not found') });
        return;
      }
      const call = parseCall(await readJsonBody(request));
      if (!call) {
        sendJson(response, 400, { ok: false, error: brokerError('INVALID_ARGUMENT', 'Invalid Browser broker request') });
        return;
      }
      const handler = this.options.handler();
      if (!handler) {
        sendJson(response, 503, { ok: false, error: brokerError('EXECUTOR_NOT_READY', 'Gian Browser is not available', true) });
        return;
      }
      const data = await handler.call(call.method, call.params, call.actor);
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      const normalized = error instanceof BrowserAutomationError
        ? brokerError(error.code, error.message, error.code === 'TIMEOUT', error.details)
        : brokerError('INTERNAL_ERROR', 'Gian Browser operation failed', true);
      sendJson(response, normalized.code === 'INTERNAL_ERROR' ? 500 : 409, { ok: false, error: normalized });
    }
  }
}

function brokerError(
  code: GianToolError['code'],
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): GianToolError {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

function parseCall(value: unknown): BrowserUseBrokerCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['method', 'params', 'actor'].includes(key))) return null;
  if (typeof input['method'] !== 'string') return null;
  const method = input['method'] as GianToolMethod;
  if (!isBrowserToolMethod(method)) return null;
  const actor = input['actor'];
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
  const identity = actor as Record<string, unknown>;
  if (Object.keys(identity).some(key => !['caller_id', 'session_id'].includes(key))) return null;
  if (typeof identity['caller_id'] !== 'string' || !identity['caller_id'].trim() || identity['caller_id'].length > 512) return null;
  if (typeof identity['session_id'] !== 'string'
    || !identity['session_id'].trim()
    || identity['session_id'].length > 512
    || identity['caller_id'] !== `internal-session:${identity['session_id']}`) return null;
  try {
    const params = validateGianToolParams(method, input['params']);
    return {
      method,
      params,
      actor: {
        callerId: identity['caller_id'],
        sessionId: identity['session_id'],
      },
    };
  } catch {
    return null;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new BrowserAutomationError('INVALID_ARGUMENT', 'Browser broker request is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    const fallback = Buffer.from(JSON.stringify({
      ok: false,
      error: brokerError('INTERNAL_ERROR', 'Browser broker response is too large'),
    }));
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-length', String(fallback.byteLength));
    response.end(fallback);
    return;
  }
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', String(body.byteLength));
  response.end(body);
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isSocket()) throw new Error('Browser broker path is not a socket');
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeSocket(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isSocket()) throw new Error('Browser broker path is not a socket');
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
