/**
 * Bridge/1.0 JSON-RPC client + DSH child supervisor.
 *
 * The proxy spawns one shared DSH Host (a `gian` profile running
 * `@gian/dsh-bridge`) and speaks `gian.dsh.bridge/1.0` over its stdio.
 *
 * The client does not interpret bridge payloads; the adapter owns projection.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Buffer } from 'node:buffer';

export interface BridgeClientOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Bound on one bridge request round-trip (default 30 s). */
  requestTimeoutMs?: number;
  /** Bound between spawn and a live stdio channel (default 60 s). */
  startTimeoutMs?: number;
}

export interface BridgeNotification {
  method: string;
  params: Record<string, unknown>;
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeClientError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly domainCode?: string,
  ) {
    super(message);
    this.name = 'BridgeClientError';
  }
}

export class BridgeClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(notification: BridgeNotification) => void>();
  private readonly exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  private initialized = false;

  constructor(private readonly options: BridgeClientOptions) {}

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.child) {
        resolve();
        return;
      }
      let settled = false;
      const startTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new BridgeClientError(
          -32000,
          `DSH bridge did not open stdio within ${this.startTimeoutMs}ms.`,
          'RUNTIME_UNAVAILABLE',
        ));
        void this.stop();
      }, this.startTimeoutMs);
      startTimer.unref();
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        if (error) reject(error);
        else resolve();
      };
      const child = spawn(this.options.command, this.options.args ?? [], {
        env: { ...process.env, ...(this.options.env ?? {}) },
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group on POSIX so shutdown takes the whole DSH tree
        // (the launcher spawns profile bundles as children) without touching
        // processes this proxy did not start.
        detached: process.platform !== 'win32',
      });
      this.child = child;
      child.once('error', (error) => settle(error));
      child.once('spawn', () => settle());
      child.once('exit', (code, signal) => {
        settle(new BridgeClientError(-32000, `bridge child exited (code=${code}, signal=${signal})`, 'RUNTIME_UNAVAILABLE'));
        const reason = `bridge child exited (code=${code}, signal=${signal})`;
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new BridgeClientError(-32000, reason, 'RUNTIME_UNAVAILABLE'));
        }
        this.pending.clear();
        for (const listener of this.exitListeners) {
          listener({ code, signal });
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[dsh-proxy] ${chunk.toString('utf8')}`);
      });

      const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      reader.on('line', (line) => {
        if (line.trim() === '') return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return;
        }
        this.handleLine(value);
      });
    });
  }

  private get startTimeoutMs(): number {
    return this.options.startTimeoutMs ?? 60_000;
  }

  private handleLine(value: unknown): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (record.jsonrpc !== '2.0') return;
    if (typeof record.id === 'string' && record.id.length > 0) {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if ('error' in record && record.error !== undefined) {
        const error = record.error as { code?: unknown; message?: unknown; data?: unknown };
        const data = error.data as { domainCode?: unknown } | undefined;
        pending.reject(new BridgeClientError(
          typeof error.code === 'number' ? error.code : -32603,
          typeof error.message === 'string' ? error.message : 'bridge error',
          typeof data?.domainCode === 'string' ? data.domainCode : undefined,
        ));
      } else {
        pending.resolve((record.result ?? {}) as Record<string, unknown>);
      }
      return;
    }
    if (typeof record.method === 'string') {
      const notification: BridgeNotification = {
        method: record.method,
        params: (record.params ?? {}) as Record<string, unknown>,
      };
      for (const listener of this.listeners) listener(notification);
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.child) {
      return Promise.reject(new BridgeClientError(-32000, 'bridge is not started.', 'RUNTIME_UNAVAILABLE'));
    }
    const id = `dsh-${this.nextId}`;
    this.nextId += 1;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeClientError(
          -32000,
          `bridge request ${method} exceeded ${this.options.requestTimeoutMs ?? 30_000}ms.`,
          'RUNTIME_UNAVAILABLE',
        ));
      }, this.options.requestTimeoutMs ?? 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  onNotification(listener: (notification: BridgeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to the shared child's exit to terminalize open Gian turns. */
  onExit(listener: (info: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Kill the shared DSH child and all its managed descendants. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.child;
      if (!child) {
        resolve();
        return;
      }
      this.child = null;
      child.once('exit', () => resolve());
      const pid = child.pid;
      if (process.platform !== 'win32' && pid !== undefined) {
        // Negative pid targets the process group this proxy spawned.
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      } else {
        child.kill('SIGTERM');
      }
      // Bounded descendant cleanup for shared process scope (plan §11.3).
      const timer = setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
          if (process.platform !== 'win32' && pid !== undefined) process.kill(-pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 1500);
      timer.unref();
    });
  }
}

export const MAX_BRIDGE_LINE_BYTES = 16 * 1024 * 1024;
export function bridgeLineBytes(line: string): number {
  return Buffer.byteLength(line, 'utf8');
}
