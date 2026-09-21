#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';

import { createRemoteApp, type RemoteAppHandle } from './app.js';
import { createConfig, type RemoteServerConfig } from './config.js';
import { createEnrollmentFromEnv } from './enrollment-command.js';

export interface RemoteServerListenOptions {
  host: string;
  port: number;
}

export interface StartedRemoteServer {
  handle: RemoteAppHandle;
  server: ReturnType<typeof serve>;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export function loadRemoteServerEnv(env: NodeJS.ProcessEnv = process.env): {
  config: RemoteServerConfig;
  listen: RemoteServerListenOptions;
} {
  const dataDir = required(env, 'GIAN_REMOTE_DATA_DIR');
  const publicOrigin = required(env, 'GIAN_REMOTE_PUBLIC_ORIGIN');
  const adminToken = required(env, 'GIAN_REMOTE_ADMIN_TOKEN');
  const staticDir = env.GIAN_REMOTE_STATIC_DIR?.trim();
  const host = env.GIAN_REMOTE_HOST?.trim() || '127.0.0.1';
  const port = parsePort(env.GIAN_REMOTE_PORT, 8787);
  const allowedOrigins = env.GIAN_REMOTE_ALLOWED_ORIGINS
    ? env.GIAN_REMOTE_ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean)
    : [publicOrigin];
  return {
    config: createConfig({
      dataDir: resolve(dataDir),
      publicOrigin,
      adminToken,
      allowedOrigins,
      ...(staticDir ? { staticDir: resolve(staticDir) } : {}),
      trustedProxy: env.GIAN_REMOTE_TRUSTED_PROXY === '1',
      version: env.GIAN_REMOTE_VERSION?.trim() || '1.0.0',
      buildId: env.GIAN_REMOTE_BUILD_ID?.trim() || 'dev',
    }),
    listen: { host, port },
  };
}

export async function startRemoteServer(input: {
  config: RemoteServerConfig;
  listen: RemoteServerListenOptions;
}): Promise<StartedRemoteServer> {
  const handle = await createRemoteApp(input.config);
  const server = serve({
    fetch: handle.app.fetch,
    hostname: input.listen.host,
    port: input.listen.port,
  });
  handle.injectWebSocket(server);
  await new Promise<void>((resolveListening, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    if (server.listening) {
      server.off('error', onError);
      resolveListening();
      return;
    }
    server.once('listening', () => {
      server.off('error', onError);
      resolveListening();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : input.listen.port;
  const url = `http://${input.listen.host}:${port}`;
  return {
    handle,
    server,
    host: input.listen.host,
    port,
    url,
    async close() {
      handle.shutdown();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<StartedRemoteServer> {
  const loaded = loadRemoteServerEnv(env);
  const started = await startRemoteServer(loaded);
  process.stdout.write(`gian-remote-server listening ${started.url}\n`);
  const shutdown = () => {
    void started.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return started;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('GIAN_REMOTE_PORT must be an integer 0-65535');
  }
  return port;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
export async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (args.length === 0) { await main(env); return; }
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write('Usage: gian-remote-server [enrollment create [--label NAME]]\nRun enrollment create inside the running server container/service environment.\n');
    return;
  }
  if (args[0] !== 'enrollment' || args[1] !== 'create'
      || !(args.length === 2 || (args.length === 4 && args[2] === '--label'))) {
    throw new Error('Usage: gian-remote-server enrollment create [--label NAME]');
  }
  const issued = await createEnrollmentFromEnv(env, args[3]);
  process.stdout.write(`Server URL: ${issued.server_url}\nEnrollment token: ${issued.enrollment_token}\nExpires at: ${issued.expires_at}\nUse once in Gian > Settings > Remote before expiry.\n`);
}
if (invoked) {
  void runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
