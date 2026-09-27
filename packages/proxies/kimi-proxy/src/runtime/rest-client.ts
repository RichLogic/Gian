/**
 * Kimi local server REST client (`kimi web`, kap-server).
 *
 * Every response uses the envelope {code, msg, data, request_id, stack?}:
 * code 0 is success, anything else is a business error carrying one of the
 * stable numeric codes from packages/kap-server/src/protocol/error-codes.ts
 * (upstream 2.1.1). The client never interprets envelope fields beyond that;
 * the adapter maps codes to gian DomainCodes.
 */

export interface KimiApiErrorShape {
  /** Stable numeric business code (e.g. 40401 SESSION_NOT_FOUND). */
  code: number;
  msg: string;
  requestId: string | null;
  httpStatus: number | null;
}

export class KimiApiError extends Error {
  readonly code: number;
  readonly requestId: string | null;
  readonly httpStatus: number | null;

  constructor(shape: KimiApiErrorShape) {
    super(`Kimi server error ${shape.code}${shape.httpStatus !== null ? ` (HTTP ${shape.httpStatus})` : ''}: ${shape.msg}`);
    this.name = 'KimiApiError';
    this.code = shape.code;
    this.requestId = shape.requestId;
    this.httpStatus = shape.httpStatus;
  }
}

/** The request did not answer within its deadline (connection refused counts
 *  as transport failure, not a business error). */
export class KimiTransportError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'KimiTransportError';
    this.cause = cause;
  }
}

export interface RestRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  /** Raw body (multipart upload). */
  body?: Buffer;
  contentType?: string;
  timeoutMs?: number;
}

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id?: string;
}

export class KimiServerRestClient {
  constructor(private readonly options: {
    baseUrl: string;
    token: string;
    defaultTimeoutMs?: number;
  }) {}

  private url(path: string, query: RestRequestOptions['query']): string {
    const url = new URL(path, this.options.baseUrl);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T>(method: string, path: string, options: RestRequestOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      // Low-frequency control plane: a fresh connection per request avoids
      // any half-open keepalive reuse against a restartable local server.
      connection: 'close',
      ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.contentType !== undefined ? { 'content-type': options.contentType } : {}),
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (options.json !== undefined) init.body = JSON.stringify(options.json);
    else if (options.body !== undefined) init.body = new Uint8Array(options.body);
    let response: Response;
    try {
      response = await fetch(this.url(path, options.query), init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new KimiTransportError(`Kimi server request ${method} ${path} failed: ${message}`, error);
    } finally {
      clearTimeout(timer);
    }
    const raw = await response.text().catch(() => '');
    let envelope: Envelope<T> | null = null;
    try {
      envelope = raw === '' ? null : JSON.parse(raw) as Envelope<T>;
    } catch {
      envelope = null;
    }
    if (envelope === null || typeof envelope.code !== 'number') {
      throw new KimiApiError({
        code: -1,
        msg: `Kimi server returned a non-envelope response (HTTP ${response.status}).`,
        requestId: null,
        httpStatus: response.status,
      });
    }
    if (envelope.code !== 0) {
      throw new KimiApiError({
        code: envelope.code,
        msg: envelope.msg,
        requestId: envelope.request_id ?? null,
        httpStatus: response.status,
      });
    }
    return envelope.data;
  }

  /** POST /api/v1/files (multipart upload) → {id, name, media_type, size}. */
  async uploadFile(path: string, name?: string, timeoutMs?: number): Promise<{
    id: string;
    name: string;
    media_type: string;
    size: number;
  }> {
    const boundary = `gian-kimi-${Math.random().toString(36).slice(2)}`;
    const filePart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="file"; filename="${JSON.stringify(name ?? path).slice(1, -1)}"\r\n`
        + `Content-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      ),
      bodyOf(path),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    return this.request('POST', '/api/v1/files', {
      body: filePart,
      contentType: `multipart/form-data; boundary=${boundary}`,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  async healthz(timeoutMs = 2_000): Promise<boolean> {
    try {
      const data = await this.request<{ ok?: boolean }>('GET', '/api/v1/healthz', { timeoutMs });
      return data?.ok === true;
    } catch {
      return false;
    }
  }

  /** Best-effort loopback shutdown (`--allow-remote-shutdown` keeps it on for
   *  non-loopback binds; loopback default is enabled). */
  async shutdown(timeoutMs = 3_000): Promise<void> {
    try {
      await this.request('POST', '/api/v1/shutdown', { timeoutMs });
    } catch {
      /* the process may already be gone; the supervisor escalates to signals */
    }
  }
}

function bodyOf(path: string): Buffer {
  // Lazily required so the client module stays importable in browsers/tests
  // without fs side effects.
  const { readFileSync, statSync } = require('node:fs') as typeof import('node:fs');
  const stats = statSync(path);
  if (!stats.isFile()) throw new KimiTransportError(`Upload path is not a regular file: ${path}`);
  return readFileSync(path);
}
