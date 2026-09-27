/**
 * Supervisor for the Kimi local server (`kimi web`).
 *
 * Upstream facts (kimi-code 2.1.1):
 * - `kimi web --no-open [--port N] [--host 127.0.0.1] [--log-level silent]`
 *   runs the HTTP+WS server in the foreground.
 * - The bearer token is persisted at `$KIMI_CODE_HOME/server/server.token`
 *   (rotate-token rewrites it) and printed in the startup URL fragment.
 * - `GET /api/v1/healthz` → {code:0, data:{ok:true}} once the server is up.
 * - `POST /api/v1/shutdown` stops a loopback server.
 *
 * The proxy always runs its own dedicated instance on a proxy-chosen free
 * port: reusing a user-started `kimi web` would couple Gian sessions to a
 * web-UI process the user can close at any time.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { KimiServerRestClient } from './rest-client.js';

export interface KimiServerEndpoint {
  baseUrl: string;
  token: string;
}

export interface SupervisorExit {
  code: number | null;
  signal: string | null;
}

export interface SupervisorOptions {
  kimiBin: string;
  /** Injected endpoint: skip spawn (test seam / externally managed server). */
  endpoint?: KimiServerEndpoint;
  port?: number;
  homeDir?: string;
  /** Absolute KIMI_CODE_HOME for token discovery; defaults to
   *  $KIMI_CODE_HOME else $HOME/.kimi-code (mirrors runtime/discover.ts). */
  kimiCodeHome?: string;
  startupTimeoutMs?: number;
}

export interface KimiServerSupervisorResult {
  endpoint: KimiServerEndpoint;
  pid: number | null;
  exit: Promise<SupervisorExit>;
  stop(): Promise<void>;
}

const TOKEN_FILE = join('server', 'server.token');

function homeDir(): string {
  return process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir();
}

function kimiCodeHomeOf(explicit?: string): string {
  const configured = process.env.KIMI_CODE_HOME;
  const base = explicit ?? (configured && isAbsolute(configured) ? configured : join(homeDir(), '.kimi-code'));
  return base;
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolvePromise(port) : rejectPromise(new Error('no free port'))));
    });
  });
}

async function readTokenFile(kimiCodeHome: string): Promise<string | null> {
  const path = join(kimiCodeHome, TOKEN_FILE);
  try {
    await access(path, fsConstants.R_OK);
    const token = (await readFile(path, 'utf8')).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export class KimiServerSupervisor {
  constructor(private readonly options: SupervisorOptions) {}

  async start(): Promise<KimiServerSupervisorResult> {
    if (this.options.endpoint !== undefined) {
      const exit = new Promise<SupervisorExit>(() => {
        /* injected endpoints have no child to wait for */
      });
      return {
        endpoint: this.options.endpoint,
        pid: null,
        exit,
        stop: async () => undefined,
      };
    }
    const kimiBin = this.options.kimiBin;
    if (!isAbsolute(kimiBin)) {
      throw new Error(`Kimi binary path must be absolute: ${kimiBin}`);
    }
    const kimiCodeHome = kimiCodeHomeOf(this.options.kimiCodeHome);
    const port = this.options.port ?? await findFreePort();
    const child: ChildProcess = spawn(kimiBin, [
      'web', '--no-open',
      '--port', String(port),
      '--host', '127.0.0.1',
      '--log-level', 'silent',
    ], {
      env: { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    const exit = new Promise<SupervisorExit>((resolvePromise) => {
      child.once('exit', (code, signal) => resolvePromise({ code, signal }));
    });

    const timeoutMs = this.options.startupTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    const rest = new KimiServerRestClient({ baseUrl: `http://127.0.0.1:${port}`, token: '' });
    // 1. token: the persisted file is authoritative; the startup banner is
    //    the fallback for a first-ever start that has not rotated yet.
    let token: string | null = await readTokenFile(kimiCodeHome);
    // 2. health: wait until the server answers.
    for (;;) {
      if (token === null) token = await readTokenFile(kimiCodeHome);
      if (await rest.healthz()) break;
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(
          `Kimi server did not become healthy within ${timeoutMs}ms`
          + `${stdout.trim() ? `; output: ${stdout.trim().slice(-400)}` : ''}`,
        );
      }
      const raced = await Promise.race([
        exit.then(() => 'exited' as const),
        new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), 300)),
      ]);
      if (raced === 'exited') {
        throw new Error(
          `Kimi server exited during startup`
          + `${stdout.trim() ? `: ${stdout.trim().slice(-400)}` : ''}`,
        );
      }
    }
    if (token === null) {
      const match = stdout.match(/[#&?]token=([A-Za-z0-9._-]+)/);
      token = match?.[1] ?? null;
    }
    if (token === null || token === '') {
      child.kill('SIGKILL');
      throw new Error('Kimi server is healthy but no bearer token was found (server.token or startup banner).');
    }

    const endpoint: KimiServerEndpoint = { baseUrl: `http://127.0.0.1:${port}`, token };
    let stopping = false;
    return {
      endpoint,
      pid: child.pid ?? null,
      exit: exit.then((value) => {
        void value;
        return { code: child.exitCode, signal: child.signalCode };
      }),
      stop: async () => {
        if (stopping) return;
        stopping = true;
        await new KimiServerRestClient(endpoint).shutdown();
        const graceful = await Promise.race([
          exit.then(() => true),
          new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 3_000)),
        ]);
        if (graceful) return;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        const terminated = await Promise.race([
          exit.then(() => true),
          new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
        ]);
        if (terminated) return;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await exit.catch(() => undefined);
      },
    };
  }
}
