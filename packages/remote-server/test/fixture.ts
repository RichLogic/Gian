import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  AUTH_PROTOCOL,
  exportPublicJwk,
  generateCanonicalId,
  generateP256SigningKeyPair,
  signBytes,
} from '@gian/remote-protocol';

import { serve } from '@hono/node-server';

import { createRemoteApp, type RemoteAppHandle } from '../src/app.js';
import { createConfig, type RemoteServerConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';

export interface TestClock {
  now: number;
  tick(ms: number): void;
}
export function createTestClock(start = Date.UTC(2026, 8, 1)): TestClock {
  return {
    now: start,
    tick(ms) {
      this.now += ms;
    },
  };
}

export async function makeRemoteTestApp(options: {
  clock?: TestClock;
  logs?: string[];
  staticDir?: string;
  config?: Partial<RemoteServerConfig>;
} = {}): Promise<{
  handle: RemoteAppHandle;
  clock: TestClock;
  logs: string[];
  dataDir: string;
  publicOrigin: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}> {
  const clock = options.clock ?? createTestClock();
  const logs = options.logs ?? [];
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-'));
  const publicOrigin = 'https://remote.test';
  const handle = await createRemoteApp(createConfig({
    dataDir,
    publicOrigin,
    allowedOrigins: [publicOrigin],
    adminToken: 'admin-test-token',
    staticDir: options.staticDir,
    now: () => clock.now,
    logger: createLogger({
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    }),
    ...(options.config ?? {}),
  }));

  async function fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('origin') && path.startsWith('/api/')) headers.set('origin', publicOrigin);
    return handle.app.fetch(new Request(`https://remote.test${path}`, { ...init, headers }));
  }

  return { handle, clock, logs, dataDir, publicOrigin, fetch };
}

export async function signChallenge(privateKey: CryptoKey, challengeId: string): Promise<string> {
  return signBytes(privateKey, new TextEncoder().encode(challengeId));
}

export async function enrollHost(fetch: (path: string, init?: RequestInit) => Promise<Response>) {
  const keys = await generateP256SigningKeyPair();
  const publicKey = await exportPublicJwk(keys.publicKey);
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  const claimed = await (await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: created.enrollment_token,
      host_name: 'Office Mac',
      host_version: '0.5.3',
      host_public_key: publicKey,
    }),
  })).json() as { host_id: string; connector_refresh_secret: string };
  const challenge = await (await fetch('/api/v1/host/connector-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, host_id: claimed.host_id }),
  })).json() as { challenge_id: string };
  const login = await (await fetch('/api/v1/host/connector-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      host_id: claimed.host_id,
      challenge_id: challenge.challenge_id,
      signature: await signChallenge(keys.privateKey, challenge.challenge_id),
      refresh_secret: claimed.connector_refresh_secret,
    }),
  })).json() as { connector_access_token: string; refresh_secret: string };
  return {
    keys,
    hostId: claimed.host_id,
    accessToken: login.connector_access_token,
    refreshSecret: login.refresh_secret,
  };
}

export async function pairDevice(
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
  hostAccessToken: string,
  hostId: string,
  existing?: { keys?: CryptoKeyPair; browserId: string },
) {
  const keys = existing?.keys ?? await generateP256SigningKeyPair();
  const publicKey = await exportPublicJwk(keys.publicKey);
  const browserId = existing?.browserId ?? generateCanonicalId();
  const created = await (await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { code: string; grant_nonce: string };
  const claimed = await (await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: browserId,
      device_public_key: publicKey,
      platform: 'macOS',
      user_agent: 'TestBrowser',
      code: created.code,
    }),
  })).json() as { pairing_id: string; host_id: string };
  await fetch(`/api/v1/pairings/${claimed.pairing_id}/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      pairing_id: claimed.pairing_id,
      decision: 'confirm',
    }),
  });
  const challenge = await (await fetch('/api/v1/sessions/device-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: browserId,
      host_id: hostId,
    }),
  })).json() as { challenge_id: string };
  const login = await fetch('/api/v1/sessions/device-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: browserId,
      host_id: hostId,
      challenge_id: challenge.challenge_id,
      signature: await signChallenge(keys.privateKey, challenge.challenge_id),
    }),
  });
  const body = await login.json() as {
    access_token: string;
    device_id: string;
    crypto_connection_id: string;
  };
  return {
    keys,
    browserId,
    deviceId: body.device_id,
    accessToken: body.access_token,
    cryptoConnectionId: body.crypto_connection_id,
    cookies: login.headers.getSetCookie(),
    code: created.code,
    pairingId: claimed.pairing_id,
  };
}

export function cookieHeader(setCookies: string[]): string {
  return setCookies.map((entry) => entry.split(';', 1)[0]).join('; ');
}

export async function listenRemoteApp(
  handle: Awaited<ReturnType<typeof createRemoteApp>>,
  listenPort = 0,
): Promise<{ port: number; url: string; wsUrl: string; server: ReturnType<typeof serve>; close(): void }> {
  const server = serve({
    fetch: handle.app.fetch,
    port: listenPort,
    hostname: '127.0.0.1',
  });
  handle.injectWebSocket(server);
  await new Promise<void>((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    server,
    close() {
      handle.shutdown();
      // Isolation workers never exit if Device/Host WS stay ESTABLISHED; server.close()
      // waits for those sockets, so drain them first.
      const nodeServer = server as typeof server & { closeAllConnections?: () => void };
      nodeServer.closeAllConnections?.();
      server.close();
    },
  };
}

export function writeStaticArtifact(buildId = 'build-1'): string {
  const dir = mkdtempSync(join(tmpdir(), 'gian-remote-static-'));
  const html = '<html><head></head><body>remote</body></html>';
  writeFileSync(join(dir, 'index.html'), html);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    build_id: buildId,
    files: {
      'index.html': createHash('sha256').update(html).digest('hex'),
    },
  }));
  mkdirSync(join(dir, 'nested'), { recursive: true });
  return dir;
}
