import { request as requestHttp } from 'node:http';
import { isAbsolute } from 'node:path';

const BROKER_PATH = '/v1/release-metadata';
const DEFAULT_BROKER_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024;
const MAX_TAG_LENGTH = 255;

type ReleaseMetadataOperation =
  | { repository: string; operation: 'list' }
  | { repository: string; operation: 'tag'; tag: string };

export interface GitHubReleaseFetchOptions {
  releaseRepository: string;
  brokerSocketPath?: string;
  fetchImpl?: typeof fetch;
  /** Test seam. Production deliberately fails over quickly to anonymous GitHub. */
  brokerTimeoutMs?: number;
  /** Test seam. This must not exceed AgentManager's release metadata limit. */
  maxResponseBytes?: number;
}

class BrokerUnavailableError extends Error {}

function requestSignal(
  input: string | URL | Request,
  init: RequestInit | undefined,
): AbortSignal | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

function requestMethod(
  input: string | URL | Request,
  init: RequestInit | undefined,
): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function requestUrl(input: string | URL | Request): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : input);
  } catch {
    return null;
  }
}

function releaseMetadataOperation(
  input: string | URL | Request,
  init: RequestInit | undefined,
  repository: string,
): ReleaseMetadataOperation | null {
  if (requestMethod(input, init) !== 'GET') return null;
  const url = requestUrl(input);
  if (
    !url
    || url.protocol !== 'https:'
    || url.hostname !== 'api.github.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
  ) {
    return null;
  }

  const releasesPath = `/repos/${repository}/releases`;
  if (url.pathname === releasesPath) {
    if (
      url.searchParams.size !== 1
      || url.searchParams.get('per_page') !== '100'
    ) {
      return null;
    }
    return { repository, operation: 'list' };
  }

  const tagPrefix = `${releasesPath}/tags/`;
  if (!url.pathname.startsWith(tagPrefix) || url.search !== '') return null;
  const encodedTag = url.pathname.slice(tagPrefix.length);
  if (encodedTag.length === 0) return null;
  let tag: string;
  try {
    tag = decodeURIComponent(encodedTag);
  } catch {
    return null;
  }
  if (
    tag.length === 0
    || tag.length > MAX_TAG_LENGTH
    || /[\u0000-\u001f\u007f]/.test(tag)
  ) {
    throw new Error('GitHub release metadata tag is invalid.');
  }
  return { repository, operation: 'tag', tag };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError');
}

function brokerResponse(
  socketPath: string,
  operation: ReleaseMetadataOperation,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<Response> {
  const body = Buffer.from(JSON.stringify(operation));
  if (body.length === 0 || body.length > MAX_REQUEST_BYTES) {
    throw new Error('GitHub release metadata broker request is too large.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      action();
    };
    const fail = (error: unknown): void => finish(() => reject(error));
    const onAbort = (): void => {
      request.destroy(abortReason(signal!));
      fail(abortReason(signal!));
    };

    const request = requestHttp({
      socketPath,
      path: BROKER_PATH,
      method: 'POST',
      maxHeaderSize: 16 * 1024,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
    }, response => {
      responseStarted = true;
      const declared = Number(response.headers['content-length'] ?? 0);
      if (!Number.isFinite(declared) || declared < 0 || declared > maxResponseBytes) {
        fail(new Error('GitHub release metadata broker response is too large.'));
        response.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > maxResponseBytes) {
          fail(new Error('GitHub release metadata broker response is too large.'));
          response.destroy();
          return;
        }
        chunks.push(bytes);
      });
      response.once('aborted', () => {
        fail(new Error('GitHub release metadata broker response was interrupted.'));
      });
      response.once('error', () => {
        fail(new Error('GitHub release metadata broker response failed.'));
      });
      response.once('end', () => {
        if (settled) return;
        const status = response.statusCode;
        if (!status || status < 200 || status > 599) {
          fail(new Error('GitHub release metadata broker returned an invalid status.'));
          return;
        }
        const responseBody = Buffer.concat(chunks, received);
        const headers = new Headers({
          'content-length': String(responseBody.length),
          'content-type': typeof response.headers['content-type'] === 'string'
            ? response.headers['content-type']
            : 'application/json',
        });
        const bodyValue = status === 204 || status === 205 || status === 304
          ? null
          : responseBody;
        finish(() => resolve(new Response(bodyValue, { status, headers })));
      });
    });

    request.once('error', () => {
      if (settled) return;
      if (signal?.aborted) {
        fail(abortReason(signal));
        return;
      }
      fail(responseStarted
        ? new Error('GitHub release metadata broker response failed.')
        : new BrokerUnavailableError());
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      const error = responseStarted
        ? new Error('GitHub release metadata broker response timed out.')
        : new BrokerUnavailableError();
      fail(error);
      request.destroy();
    }, timeoutMs);
    timer.unref?.();
    request.end(body);
  });
}

/**
 * Routes only the two GitHub REST reads used for release metadata through the
 * Desktop-owned credential boundary. The OAuth token never enters Host; every
 * other request, including release assets, remains an ordinary anonymous fetch.
 */
export function createGitHubReleaseFetch(options: GitHubReleaseFetchOptions): typeof fetch {
  const directFetch = options.fetchImpl ?? fetch;
  const releaseRepository = normalizeRepository(options.releaseRepository);
  const socketPath = options.brokerSocketPath?.trim();
  if (!socketPath || !isAbsolute(socketPath) || socketPath.includes('\0')) {
    return directFetch;
  }

  const timeoutMs = options.brokerTimeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('GitHub release metadata broker timeout must be positive.');
  }
  if (
    !Number.isSafeInteger(maxResponseBytes)
    || maxResponseBytes <= 0
    || maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES
  ) {
    throw new Error('GitHub release metadata broker response limit is invalid.');
  }

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const operation = releaseMetadataOperation(
      input,
      init,
      releaseRepository,
    );
    if (!operation) return directFetch(input, init);

    const signal = requestSignal(input, init);
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await brokerResponse(
        socketPath,
        operation,
        signal,
        timeoutMs,
        maxResponseBytes,
      );
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (!(error instanceof BrokerUnavailableError)) throw error;
      return directFetch(input, init);
    }
  }) as typeof fetch;
}

function normalizeRepository(value: string): string {
  const repository = value.trim();
  if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(repository)) {
    throw new Error('release repository must use owner/name format');
  }
  return repository;
}
