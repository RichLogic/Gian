import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RemoteIdentityStore } from './remote-identity-store.js';

export const REMOTE_IDENTITY_BROKER_SOCKET_ENV = 'GIAN_DESKTOP_REMOTE_BROKER_SOCKET';

const BROKER_PATH = '/v1/remote-identity';
const MAX_REQUEST_BYTES = 8 * 1024;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export function resolveRemoteIdentityBrokerSocketPath(
  identity: string,
  temporaryDirectory = tmpdir(),
): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return join(temporaryDirectory, `gian-remote-${digest}.sock`);
}

export class RemoteIdentityBroker {
  private server: Server | null = null;

  constructor(private readonly options: {
    socketPath: string;
    store: RemoteIdentityStore;
  }) {}

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.options.socketPath);
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.socketPath, () => resolve());
    });
    await chmod(this.options.socketPath, 0o600);
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
    try {
      if (request.method !== 'POST' || request.url !== BROKER_PATH) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }
      const body = await readJson(request) as { op?: string; bytes_b64?: string; refresh_secret?: string };
      if (body.op === 'ensure') {
        const publicIdentity = await this.ensure();
        sendJson(response, 200, publicIdentity);
        return;
      }
      if (body.op === 'sign' && typeof body.bytes_b64 === 'string') {
        const signature = await this.sign(Buffer.from(body.bytes_b64, 'base64url'));
        sendJson(response, 200, { signature });
        return;
      }
      if (body.op === 'secret.get') {
        const stored = await this.options.store.load();
        sendJson(response, 200, { refresh_secret: stored?.refreshSecret ?? null });
        return;
      }
      if (body.op === 'secret.set' && typeof body.refresh_secret === 'string') {
        const stored = await this.options.store.load();
        if (!stored) throw new Error('identity is not initialized');
        await this.options.store.save({ ...stored, refreshSecret: body.refresh_secret });
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 400, { error: 'invalid_request' });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: 'broker_failed' });
    }
  }

  private async ensure(): Promise<{ public_key: { kty?: string; crv?: string; x?: string; y?: string }; fingerprint: string }> {
    let stored = await this.options.store.load();
    if (!stored) {
      const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
      stored = {
        identity: await crypto.subtle.exportKey('jwk', pair.privateKey),
        refreshSecret: null,
      };
      await this.options.store.save(stored);
    }
    const publicKey = { kty: stored.identity.kty, crv: stored.identity.crv, x: stored.identity.x, y: stored.identity.y };
    const canonical = JSON.stringify({
      crv: publicKey.crv,
      kty: publicKey.kty,
      x: publicKey.x,
      y: publicKey.y,
    });
    const fingerprint = createHash('sha256').update(canonical).digest('hex');
    return { public_key: publicKey, fingerprint };
  }

  private async sign(bytes: Buffer): Promise<string> {
    const stored = await this.options.store.load();
    if (!stored) throw new Error('identity is not initialized');
    const key = await crypto.subtle.importKey('jwk', stored.identity, ECDSA, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes));
    return Buffer.from(signature).toString('base64url');
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', String(payload.length));
  response.end(payload);
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isSocket()) throw new Error('Remote identity broker path is not a socket');
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeSocket(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (status.isSocket()) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
