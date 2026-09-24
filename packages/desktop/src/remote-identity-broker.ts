import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RemoteIdentityStore } from './remote-identity-store.js';
import type { RemoteAccountCredential } from '@gian/shared';

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
  private tail: Promise<unknown> = Promise.resolve();
  private loggingOut = false;

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  resumeAccountSessions(): void { this.loggingOut = false; }

  constructor(private readonly options: {
    socketPath: string;
    store: RemoteIdentityStore;
    githubAccountId?: () => Promise<string | null>;
  }) {}

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.options.socketPath);
    const server = createServer((request, response) => {
      request.setTimeout(2000, () => request.destroy());
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

  async revokeAccountSessions(): Promise<void> {
    this.loggingOut = true;
    const accounts = await this.exclusive(async () => {
      const stored = await this.options.store.load();
      if (!stored?.accounts) return [];
      const accounts = Object.values(stored.accounts);
      await this.options.store.save({ ...stored, accounts: {} });
      return accounts;
    });
    await Promise.allSettled(accounts.map(async account => {
      const origin = new URL(account.serverOrigin);
      if (!validAccountOrigin(origin, account.serverOrigin, account.role)) return;
      await fetch(new URL('/api/v1/account/logout', origin), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: 'Bearer ' + account.token, 'content-type': 'application/json' },
        body: JSON.stringify({ protocol: 'gian.remote.account/1' }),
      });
    }));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== BROKER_PATH) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }
      const body = await readJson(request) as { op?: string; bytes_b64?: string; refresh_secret?: string;
        origin?: string; role?: string; account?: RemoteAccountCredential | null; scope?: string };
      await this.exclusive(async () => {
      if (body.op === 'controller.ensure' || body.op === 'controller.sign') {
        if (this.loggingOut || (this.options.githubAccountId && !await this.options.githubAccountId())) throw new Error('signed out');
        if (typeof body.scope !== 'string' || !/^[0-9a-f-]{36}$/.test(body.scope)) throw new Error('invalid controller scope');
        await this.ensure();
        const stored = (await this.options.store.load())!;
        const controllers = { ...stored.controllers };
        let jwk = controllers[body.scope];
        if (!jwk) {
          const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
          jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
          controllers[body.scope] = jwk;
          await this.options.store.save({ ...stored, controllers });
        }
        const publicKey = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
        if (body.op === 'controller.ensure') {
          sendJson(response, 200, { public_key: publicKey,
            fingerprint: createHash('sha256').update(JSON.stringify(publicKey)).digest('hex') }); return;
        }
        if (typeof body.bytes_b64 !== 'string') throw new Error('invalid signing input');
        const key = await crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['sign']);
        const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(body.bytes_b64, 'base64url'));
        sendJson(response, 200, { signature: Buffer.from(signature).toString('base64url') }); return;
      }
      if (body.op === 'account.get' || body.op === 'account.set') {
        if (this.loggingOut) { sendJson(response, 403, { error: 'signed_out' }); return; }
        const origin = typeof body.origin === 'string' ? body.origin : '';
        const parsed = new URL(origin);
        if (!validAccountOrigin(parsed, origin, body.role === 'controller' ? 'controller' : 'host')) {
          sendJson(response, 400, { error: 'invalid_origin' }); return;
        }
        const stored = await this.options.store.load();
        if (!stored) throw new Error('identity is not initialized');
        const accountId = await this.options.githubAccountId?.();
        const role = body.role === 'controller' ? 'controller' : 'host';
        const key = `${origin}#${role}`;
        if (body.op === 'account.get') {
          const account = stored.accounts?.[key];
          sendJson(response, 200, { account: account && account.accountId === accountId ? account : null });
          return;
        }
        const account = body.account;
        if (account !== null && (!account || account.serverOrigin !== origin || account.role !== role
          || account.accountId !== accountId || typeof account.token !== 'string' || account.token.length > 256
          || typeof account.expiresAt !== 'number' || !Number.isFinite(account.expiresAt)
          || typeof account.installationId !== 'string'
          || typeof account.serverFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(account.serverFingerprint))) {
          sendJson(response, 403, { error: 'account_mismatch' }); return;
        }
        const accounts = { ...stored.accounts };
        if (account) accounts[key] = account; else delete accounts[key];
        await this.options.store.save({ ...stored, accounts });
        sendJson(response, 200, { ok: true }); return;
      }
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
      });
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
    if (this.loggingOut) throw new Error('GitHub sign-in required');
    if (this.options.githubAccountId && !await this.options.githubAccountId()) throw new Error('GitHub sign-in required');
    const stored = await this.options.store.load();
    if (!stored) throw new Error('identity is not initialized');
    const key = await crypto.subtle.importKey('jwk', stored.identity, ECDSA, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes));
    return Buffer.from(signature).toString('base64url');
  }
}

function validAccountOrigin(url: URL, origin: string, role: 'host' | 'controller'): boolean {
  if (url.origin !== origin || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  // Preserve the existing Host-only SSH loopback transport. Controllers use HTTPS.
  return role === 'host' && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
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
