import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { SystemConfig } from '@gian/shared';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

type TunnelMode = SystemConfig['tunnel_mode'];

interface TunnelStatus {
  mode: TunnelMode;
  public_url: string;
  healthy: boolean;
  last_error: string | null;
  force_https: boolean;
}

export class TunnelManager {
  private mode: TunnelMode = 'none';
  private publicUrl = '';
  private forceHttps = false;
  private proc: ChildProcess | null = null;
  private healthy = false;
  private lastError: string | null = null;
  private stopped = false;
  private retries = 0;
  private port = 8990;

  async start(config: SystemConfig): Promise<void> {
    this.mode = config.tunnel_mode;
    this.publicUrl = config.public_url;
    this.forceHttps = config.force_https;
    this.port = config.port;
    this.stopped = false;

    switch (this.mode) {
      case 'none':
        this.healthy = true;
        console.log('[tunnel] mode=none, no tunnel started');
        break;

      case 'cloudflare-tunnel':
        if (!config.tunnel_id) {
          this.lastError = 'tunnel_id is required for cloudflare-tunnel mode';
          console.warn(`[tunnel] ${this.lastError}`);
          return;
        }
        await this.spawnCloudflared(config.tunnel_id);
        break;

      case 'tailscale-funnel':
        await this.execTailscale();
        break;

      case 'reverse-proxy':
        if (!config.public_url) {
          this.lastError = 'public_url should be set when using reverse-proxy mode';
          console.warn(`[tunnel] ${this.lastError}`);
        } else {
          this.healthy = true;
          console.log(`[tunnel] mode=reverse-proxy, public_url=${config.public_url}`);
        }
        break;
    }
  }

  private spawnCloudflared(tunnelId: string): Promise<void> {
    return new Promise(resolve => {
      const doSpawn = (): void => {
        if (this.stopped) return;

        console.log(`[tunnel] spawning cloudflared tunnel run ${tunnelId} (attempt ${this.retries + 1})`);

        const child = spawn('cloudflared', ['tunnel', 'run', tunnelId], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.proc = child;

        child.stdout?.on('data', (chunk: Buffer) => {
          console.log(`[tunnel:cloudflared] ${chunk.toString().trimEnd()}`);
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          console.error(`[tunnel:cloudflared] ${chunk.toString().trimEnd()}`);
        });

        child.on('spawn', () => {
          this.healthy = true;
          this.lastError = null;
          this.retries = 0;
          console.log('[tunnel] cloudflared started');
          resolve();
        });

        child.on('error', err => {
          this.healthy = false;
          this.lastError = err.message;
          console.error(`[tunnel] cloudflared error: ${err.message}`);
          resolve();
          this.scheduleRestart(tunnelId);
        });

        child.on('exit', (code, signal) => {
          this.healthy = false;
          if (this.stopped) return;
          this.lastError = `cloudflared exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
          console.warn(`[tunnel] ${this.lastError}`);
          this.scheduleRestart(tunnelId);
        });
      };

      doSpawn();
    });
  }

  private scheduleRestart(tunnelId: string): void {
    if (this.stopped) return;
    if (this.retries >= MAX_RETRIES) {
      this.lastError = `cloudflared failed after ${MAX_RETRIES} retries — giving up`;
      console.error(`[tunnel] ${this.lastError}`);
      return;
    }
    this.retries++;
    const delay = RETRY_BASE_MS * this.retries;
    console.log(`[tunnel] restarting cloudflared in ${delay}ms (retry ${this.retries}/${MAX_RETRIES})`);
    setTimeout(() => {
      if (!this.stopped) {
        void this.spawnCloudflared(tunnelId);
      }
    }, delay);
  }

  private execTailscale(): Promise<void> {
    return new Promise(resolve => {
      console.log(`[tunnel] running: tailscale funnel ${this.port}`);

      const child = spawn('tailscale', ['funnel', String(this.port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        console.log(`[tunnel:tailscale] ${chunk.toString().trimEnd()}`);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        console.error(`[tunnel:tailscale] ${chunk.toString().trimEnd()}`);
      });

      child.on('error', err => {
        this.healthy = false;
        this.lastError = err.message;
        console.error(`[tunnel] tailscale error: ${err.message}`);
        resolve();
      });

      child.on('exit', (code, signal) => {
        if (code === 0 || signal === null) {
          this.healthy = true;
          console.log('[tunnel] tailscale funnel configured (persists in tailscale daemon)');
        } else {
          this.healthy = false;
          this.lastError = `tailscale funnel exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
          console.warn(`[tunnel] ${this.lastError}`);
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.proc) {
      console.log('[tunnel] sending SIGTERM to tunnel process');
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.healthy = false;
  }

  status(): TunnelStatus {
    return {
      mode: this.mode,
      public_url: this.publicUrl,
      healthy: this.healthy,
      last_error: this.lastError,
      force_https: this.forceHttps,
    };
  }
}
