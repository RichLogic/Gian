import { request as requestHttp } from 'node:http';
import { isAbsolute } from 'node:path';

import { isCanonicalRelativePath } from '@gian/proxy-catalog-contract';

import { MAX_PLUGIN_ARCHIVE_BYTES } from '../plugin-store/limits.js';
import type { PluginArtifactNetwork } from '../plugin-store/types.js';

const BROKER_PATH = '/v1/release-metadata';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BYTES = 2 * 1024;

export function createPluginArtifactNetwork(options: {
  socketPath: string;
  timeoutMs?: number;
}): PluginArtifactNetwork {
  const socketPath = options.socketPath.trim();
  if (!socketPath || !isAbsolute(socketPath) || socketPath.includes('\0')) {
    throw new Error('Plugin artifact broker socket path is invalid.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async download(input) {
      if (!isCanonicalRelativePath(input.asset)) {
        throw new Error('Plugin asset path is not canonical.');
      }
      const maxBytes = Math.min(input.maxBytes, MAX_PLUGIN_ARCHIVE_BYTES);
      const response = await brokerRequest({
        socketPath,
        timeoutMs,
        maxBytes,
        signal: input.signal,
        body: {
          repository: input.repository,
          operation: 'release-asset',
          tag: input.tag,
          asset: input.asset,
        },
      });
      if (response.status !== 200) {
        throw new Error(`Plugin asset download failed (${response.status}): ${input.asset}`);
      }
      if (response.body.length === 0 || response.body.length > maxBytes) {
        throw new Error(`Plugin asset size is invalid: ${input.asset}`);
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
}): Promise<{ status: number; body: Buffer }> {
  const body = Buffer.from(JSON.stringify(input.body));
  if (body.length === 0 || body.length > MAX_REQUEST_BYTES) {
    throw new Error('Plugin broker request is too large.');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
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
    }, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > input.maxBytes) {
          fail(new Error('Plugin broker response is too large.'));
          response.destroy();
        } else {
          chunks.push(bytes);
        }
      });
      response.once('error', () => fail(new Error('Plugin broker response failed.')));
      response.once('end', () => {
        finish(() => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks, received),
        }));
      });
    });
    request.once('error', () => fail(new Error('Plugin artifact broker is unavailable.')));
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      fail(new Error('Plugin artifact broker request timed out.'));
      request.destroy();
    }, input.timeoutMs);
    timer.unref?.();
    request.end(body);
  });
}
