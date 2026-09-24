import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GitHubReleaseMetadataRequest } from './github-auth.js';

export const GITHUB_RELEASE_BROKER_SOCKET_ENV = 'GIAN_DESKTOP_GITHUB_BROKER_SOCKET';

const BROKER_PATH = '/v1/release-metadata';
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface GitHubReleaseMetadataBrokerOptions {
  socketPath: string;
  allowedRepository: string;
  allowedCatalogRepository?: string;
  allowedArtifactRepositories?: readonly string[];
  fetchReleaseMetadata(
    request: GitHubReleaseMetadataRequest,
    signal: AbortSignal,
  ): Promise<Response>;
}

/** Keep the Unix socket path below macOS' short sockaddr_un path limit. */
export function resolveGitHubReleaseBrokerSocketPath(
  identity: string,
  temporaryDirectory = tmpdir(),
): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return join(temporaryDirectory, `gian-github-${digest}.sock`);
}

export class GitHubReleaseMetadataBroker {
  private server: Server | null = null;
  private readonly allowedRepositories: ReadonlySet<string>;
  private readonly allowedCatalogRepository: string | null;

  constructor(private readonly options: GitHubReleaseMetadataBrokerOptions) {
    this.allowedRepositories = new Set([
      normalizeRepository(options.allowedRepository),
      ...(options.allowedArtifactRepositories ?? []).map(normalizeRepository),
    ]);
    this.allowedCatalogRepository = options.allowedCatalogRepository
      ? normalizeRepository(options.allowedCatalogRepository)
      : null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.options.socketPath);
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
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
    if (server?.listening) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await removeSocket(this.options.socketPath);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      if (request.method !== 'POST' || request.url !== BROKER_PATH) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }
      const value = await readJsonBody(request);
      const releaseRequest = parseReleaseRequest(
        value,
        this.allowedRepositories,
        this.allowedCatalogRepository,
      );
      if (!releaseRequest) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }

      const upstream = await this.options.fetchReleaseMetadata(
        releaseRequest,
        controller.signal,
      );
      if (response.destroyed) return;
      if (upstream.status === 304) {
        response.statusCode = 304;
        const etag = upstream.headers.get('etag');
        if (etag) response.setHeader('etag', etag);
        response.end();
        return;
      }
      const maxBytes = releaseRequest.operation === 'catalog-asset'
        ? 16 * 1024 * 1024
        : releaseRequest.operation === 'release-asset'
          ? 64 * 1024 * 1024
          : MAX_RESPONSE_BYTES;
      const body = await readLimitedResponse(upstream, maxBytes);
      if (response.destroyed) return;
      response.statusCode = upstream.status;
      const etag = upstream.headers.get('etag');
      if (etag) response.setHeader('etag', etag);
      response.setHeader(
        'content-type',
        releaseRequest.operation === 'catalog-asset'
          || releaseRequest.operation === 'release-asset'
          ? 'application/octet-stream'
          : 'application/json; charset=utf-8',
      );
      response.setHeader('content-length', String(body.length));
      response.end(body);
    } catch {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 502, { error: 'github_request_failed' });
      } else if (!response.destroyed) {
        response.end();
      }
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
    }
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isSocket()) throw new Error('GitHub broker path is not a socket');
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeSocket(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isSocket()) throw new Error('GitHub broker path is not a socket');
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function parseReleaseRequest(
  value: unknown,
  allowedRepositories: ReadonlySet<string>,
  allowedCatalogRepository: string | null,
): GitHubReleaseMetadataRequest | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.operation === 'latest-catalog'
    && allowedCatalogRepository
    && candidate.repository === allowedCatalogRepository
  ) {
    if (
      candidate.ifNoneMatch !== undefined
      && (
        typeof candidate.ifNoneMatch !== 'string'
        || candidate.ifNoneMatch.length === 0
        || candidate.ifNoneMatch.length > 256
        || /[\u0000-\u001f\u007f]/.test(candidate.ifNoneMatch)
      )
    ) {
      return null;
    }
    return {
      repository: allowedCatalogRepository,
      operation: 'latest-catalog',
      ...(typeof candidate.ifNoneMatch === 'string'
        ? { ifNoneMatch: candidate.ifNoneMatch }
        : {}),
    };
  }
  if (
    candidate.operation === 'catalog-asset'
    && allowedCatalogRepository
    && candidate.repository === allowedCatalogRepository
    && typeof candidate.tag === 'string'
    && /^catalog-v1\.[1-9]\d*\.0$/.test(candidate.tag)
    && typeof candidate.asset === 'string'
    && candidate.asset.length > 0
    && candidate.asset.length <= 256
    && !candidate.asset.includes('\\')
    && !candidate.asset.startsWith('/')
    && !candidate.asset.includes('\0')
    && !candidate.asset.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    return {
      repository: allowedCatalogRepository,
      operation: 'catalog-asset',
      tag: candidate.tag,
      asset: candidate.asset,
    };
  }
  if (typeof candidate.repository !== 'string' || !allowedRepositories.has(candidate.repository)) return null;
  const repository = candidate.repository;
  if (
    candidate.operation === 'release-asset'
    && typeof candidate.tag === 'string'
    && candidate.tag.length > 0
    && candidate.tag.length <= 255
    && !/[\u0000-\u001f\u007f]/.test(candidate.tag)
    && typeof candidate.asset === 'string'
    && candidate.asset.length > 0
    && candidate.asset.length <= 256
    && !candidate.asset.includes('\\')
    && !candidate.asset.startsWith('/')
    && !candidate.asset.includes('\0')
    && !candidate.asset.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    return {
      repository,
      operation: 'release-asset',
      tag: candidate.tag,
      asset: candidate.asset,
    };
  }
  if (candidate.operation === 'list' && candidate.tag === undefined) {
    return { repository };
  }
  if (
    candidate.operation === 'tag'
    && typeof candidate.tag === 'string'
    && candidate.tag.length > 0
    && candidate.tag.length <= 255
    && !/[\u0000-\u001f\u007f]/.test(candidate.tag)
  ) {
    return { repository, tag: candidate.tag };
  }
  return null;
}

function normalizeRepository(value: string): string {
  const repository = value.trim();
  if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(repository)) {
    throw new Error('invalid GitHub release repository');
  }
  return repository;
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('response too large');
  if (!response.body) throw new Error('empty response');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = Buffer.from(result.value);
    size += chunk.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new Error('empty response');
  return Buffer.concat(chunks, size);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', String(body.length));
  response.end(body);
}
