import { request as requestHttp } from 'node:http';
import { isAbsolute } from 'node:path';

import { isCanonicalRelativePath } from '@gian/proxy-catalog-contract';
import type { OfficialCatalogSourcePolicy } from '@gian/shared';

import { parseCatalogLatestRelease } from './release-metadata.js';
import { DEFAULT_CATALOG_BROKER_TIMEOUT_MS } from './timeouts.js';
import type { CatalogNetwork } from './types.js';

export class CatalogBrokerUnavailableError extends Error {
  readonly code = 'CATALOG_BROKER_UNAVAILABLE';
  constructor(message = 'Catalog broker is unavailable.') {
    super(message);
    this.name = 'CatalogBrokerUnavailableError';
  }
}

const BROKER_PATH = '/v1/release-metadata';
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024;

export function createCatalogBrokerNetwork(options: {
  socketPath: string;
  policy: OfficialCatalogSourcePolicy;
  timeoutMs?: number;
}): CatalogNetwork {
  const socketPath = options.socketPath.trim();
  if (!socketPath || !isAbsolute(socketPath) || socketPath.includes('\0')) {
    throw new Error('Catalog broker socket path is invalid.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_BROKER_TIMEOUT_MS;

  return {
    async latest(input) {
      const response = await brokerRequest({
        socketPath,
        timeoutMs,
        maxBytes: MAX_METADATA_BYTES,
        signal: input.signal,
        body: {
          repository: options.policy.repository,
          operation: 'latest-catalog',
          ...(input.ifNoneMatch ? { ifNoneMatch: input.ifNoneMatch } : {}),
        },
      });
      if (response.status === 304) {
        return { status: 304, etag: response.etag };
      }
      if (response.status !== 200) {
        throw new Error(`Catalog latest lookup failed (${response.status}).`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body.toString('utf8'));
      } catch {
        throw new Error('Catalog latest lookup returned invalid JSON.');
      }
      return {
        status: 200,
        release: parseCatalogLatestRelease(parsed, response.etag),
      };
    },

    async download(input) {
      if (!isCanonicalRelativePath(input.asset)) {
        throw new Error('Catalog asset path is not canonical.');
      }
      const response = await brokerRequest({
        socketPath,
        timeoutMs,
        maxBytes: input.maxBytes,
        signal: input.signal,
        body: {
          repository: options.policy.repository,
          operation: 'catalog-asset',
          tag: input.tag,
          asset: input.asset,
        },
      });
      if (response.status !== 200) {
        throw new Error(`Catalog asset download failed (${response.status}): ${input.asset}`);
      }
      if (response.body.length === 0 || response.body.length > input.maxBytes) {
        throw new Error(`Catalog asset size is invalid: ${input.asset}`);
      }
      return response.body;
    },
  };
}

function brokerRequest(input: {
  socketPath: string;
  body: unknown;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<{ status: number; body: Buffer; etag?: string }> {
  const body = Buffer.from(JSON.stringify(input.body));
  if (body.length === 0 || body.length > MAX_REQUEST_BYTES) {
    throw new Error('Catalog broker request is too large.');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    let receivedBytes = 0;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      action();
    };
    const fail = (error: unknown): void => finish(() => reject(error));
    const onAbort = (): void => {
      request.destroy();
      fail(input.signal?.reason instanceof Error
        ? input.signal.reason
        : new DOMException('This operation was aborted', 'AbortError'));
    };
    const request = requestHttp({
      socketPath: input.socketPath,
      path: BROKER_PATH,
      method: 'POST',
      headers: {
        accept: 'application/octet-stream',
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
    }, response => {
      responseStarted = true;
      const declared = Number(response.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > input.maxBytes) {
        fail(new Error('Catalog broker response is too large.'));
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > input.maxBytes) {
          fail(new Error('Catalog broker response is too large.'));
          response.destroy();
        } else {
          chunks.push(bytes);
        }
      });
      response.once('error', () => fail(new Error('Catalog broker response failed.')));
      response.once('end', () => {
        const status = response.statusCode ?? 0;
        const etag = typeof response.headers.etag === 'string' ? response.headers.etag : undefined;
        finish(() => resolve({
          status,
          body: Buffer.concat(chunks, received),
          etag,
        }));
      });
    });
    request.on('socket', (socket) => {
      socket.on('data', (chunk: Buffer | string) => {
        receivedBytes += Buffer.byteLength(chunk);
      });
    });
    request.once('error', (error) => {
      if (!responseStarted && receivedBytes === 0) {
        fail(new CatalogBrokerUnavailableError(
          error instanceof Error ? error.message : 'Catalog broker is unavailable.',
        ));
        return;
      }
      fail(new Error('Catalog broker request failed.'));
    });
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      if (!responseStarted && receivedBytes === 0) {
        fail(new CatalogBrokerUnavailableError('Catalog broker request timed out.'));
      } else {
        fail(new Error('Catalog broker request timed out.'));
      }
      request.destroy();
    }, input.timeoutMs);
    timer.unref?.();
    request.end(body);
  });
}
