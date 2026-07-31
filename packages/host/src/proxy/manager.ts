import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Executor } from '@gian/shared';
import { CcProxyClient } from './cc-proxy-client.js';
import { CodexProxyHost, CodexProxySessionClient } from './codex-proxy-client.js';
import { KimiProxyHost, KimiProxySessionClient } from './kimi-proxy-client.js';
import type { ProxyClient } from './types.js';
import type { CliRuntimeManager } from '../runtime/manager.js';
import type { RuntimeLease } from '../runtime/types.js';

type ProxyExecutor = 'codex' | 'claude' | 'kimi';

export interface ProxyManagerConfig {
  /** Root data dir; per-session proxy state lives under {root}/proxy/{sessionId}. */
  dataDir: string;
  /** Path to cc-proxy spawn.js entry. */
  ccProxyEntry: string;
  /** Path to codex-proxy spawn.js entry. */
  codexProxyEntry?: string;
  /** Path to kimi-proxy spawn.js entry. */
  kimiProxyEntry?: string;
  /** Optional codex CLI binary path (forwarded as --codex-bin). */
  codexBin?: string;
  /** Kimi always resolves through this manager; no PATH fallback in proxy. */
  runtimeManager?: CliRuntimeManager;
}

/**
 * Owns proxy client lifecycles. cc-proxy is one process per session
 * (matches its per-turn spawn model). codex-proxy is one shared process for
 * all codex sessions; per-session facades route notifications by params.sessionId.
 */
export class ProxyManager {
  private clients = new Map<string, ProxyClient>();
  private executorBySession = new Map<string, ProxyExecutor>();
  private codexHost: CodexProxyHost | null = null;
  private kimiHost: KimiProxyHost | null = null;
  private kimiHostInit: Promise<KimiProxyHost> | null = null;
  private kimiLease: RuntimeLease | null = null;

  constructor(private cfg: ProxyManagerConfig) {}

  async getOrCreate(sessionId: string, executor: Executor): Promise<ProxyClient> {
    const existing = this.clients.get(sessionId);
    if (existing) return existing;

    const client = executor === 'codex'
      ? this.createCodexClient(sessionId)
      : executor === 'kimi'
        ? await this.createKimiClient()
        : this.createClaudeClient(sessionId);

    this.clients.set(sessionId, client);
    this.executorBySession.set(sessionId, executor);
    client.onExit(code => {
      console.log(`[proxy] session=${sessionId} exited code=${code}`);
      this.clients.delete(sessionId);
      this.executorBySession.delete(sessionId);
    });

    return client;
  }

  get(sessionId: string): ProxyClient | undefined {
    return this.clients.get(sessionId);
  }

  /**
   * Tear down a single client by its session/cache key. No-ops when the
   * client isn't registered. Used by warmCapabilities() to retry model
   * discovery inside a fresh runtime when the previous attempt came back
   * with an empty model list.
   */
  async dispose(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) return;
    const executor = this.executorBySession.get(sessionId);
    const failedKimiAttach = (
      executor === 'kimi'
      && client instanceof KimiProxySessionClient
      && !client.hasAttachedSession()
    );
    this.clients.delete(sessionId);
    this.executorBySession.delete(sessionId);
    try { await client.shutdown(); } catch { /* swallow — process may already be gone */ }
    // A failed create (notably AUTH_REQUIRED) must not pin the old ACP process.
    // With no attached sessions it is safe to recycle, so `kimi login` in an
    // external terminal is picked up by the user's next Retry.
    if (failedKimiAttach && this.kimiHost && !this.kimiHost.hasSessions()) {
      const host = this.kimiHost;
      const lease = this.kimiLease;
      this.kimiHost = null;
      if (this.kimiLease === lease) this.kimiLease = null;
      // Drop other unattached facades such as the Native Sessions lister.
      // Otherwise they retain a reference to the recycled child forever.
      this.dropKimiClients();
      await host.shutdown().catch(() => undefined);
      lease?.release();
    }
  }

  async closeAll(): Promise<void> {
    const all = Array.from(this.clients.values());
    this.clients.clear();
    this.executorBySession.clear();
    await Promise.allSettled(all.map(c => c.shutdown()));
    if (this.codexHost) {
      await this.codexHost.shutdown();
      this.codexHost = null;
    }
    if (this.kimiHost) {
      await this.kimiHost.shutdown();
      this.kimiHost = null;
    }
    this.releaseKimiLease();
  }

  /**
   * Close only clients for the given executor. New clients will be lazily
   * spawned on the next session message. For codex, also shuts down the shared
   * host process so it re-spawns fresh on next use.
   */
  async closeByExecutor(executor: ProxyExecutor): Promise<void> {
    const toClose: ProxyClient[] = [];
    for (const [sid, exec] of this.executorBySession) {
      if (exec === executor) {
        const client = this.clients.get(sid);
        if (client) toClose.push(client);
        this.clients.delete(sid);
        this.executorBySession.delete(sid);
      }
    }
    await Promise.allSettled(toClose.map(c => c.shutdown()));
    if (executor === 'codex' && this.codexHost) {
      await this.codexHost.shutdown().catch(() => {});
      this.codexHost = null;
    }
    if (executor === 'kimi' && this.kimiHost) {
      await this.kimiHost.shutdown().catch(() => {});
      this.kimiHost = null;
      this.releaseKimiLease();
    }
  }

  private createClaudeClient(sessionId: string): ProxyClient {
    const dataDir = join(this.cfg.dataDir, 'proxy', sessionId);
    mkdirSync(dataDir, { recursive: true });
    return new CcProxyClient({
      entry: this.cfg.ccProxyEntry,
      dataDir,
      log: msg => console.log(msg),
    });
  }

  private createCodexClient(_sessionId: string): ProxyClient {
    if (!this.cfg.codexProxyEntry) {
      throw new Error(
        'codex executor requested but codexProxyEntry is not configured',
      );
    }
    if (!this.codexHost) {
      const dataDir = join(this.cfg.dataDir, 'proxy', 'codex');
      mkdirSync(dataDir, { recursive: true });
      this.codexHost = new CodexProxyHost({
        entry: this.cfg.codexProxyEntry,
        dataDir,
        codexBin: this.cfg.codexBin,
        log: msg => console.log(msg),
      });
    }
    return new CodexProxySessionClient(this.codexHost);
  }

  private async createKimiClient(): Promise<ProxyClient> {
    return new KimiProxySessionClient(await this.getOrCreateKimiHost());
  }

  private async getOrCreateKimiHost(): Promise<KimiProxyHost> {
    if (!this.cfg.kimiProxyEntry) {
      throw new Error('kimi executor requested but kimiProxyEntry is not configured');
    }
    if (!this.cfg.runtimeManager) {
      throw new Error('kimi executor requested but CliRuntimeManager is not configured');
    }
    if (this.kimiHost) return this.kimiHost;

    let pending = this.kimiHostInit;
    if (!pending) {
      pending = this.startKimiHost();
      this.kimiHostInit = pending;
    }
    try {
      return await pending;
    } finally {
      if (this.kimiHostInit === pending) this.kimiHostInit = null;
    }
  }

  private async startKimiHost(): Promise<KimiProxyHost> {
    const lease = await this.cfg.runtimeManager!.acquire('kimi');
    const host = new KimiProxyHost({
      entry: this.cfg.kimiProxyEntry!,
      kimiBin: lease.binaryPath,
      env: lease.env,
      log: message => console.log(message),
    });
    this.kimiLease = lease;
    this.kimiHost = host;
    host.onHostExit(() => {
      if (this.kimiHost === host) {
        this.kimiHost = null;
        // Attached facades receive their own exit callback from the host.
        // This also clears facades that never attached a native session.
        this.dropKimiClients();
      }
      this.releaseKimiLease(lease);
    });
    return host;
  }

  private dropKimiClients(): void {
    for (const [sessionId, executor] of this.executorBySession) {
      if (executor !== 'kimi') continue;
      this.clients.delete(sessionId);
      this.executorBySession.delete(sessionId);
    }
  }

  private releaseKimiLease(expected?: RuntimeLease): void {
    const lease = this.kimiLease;
    if (!lease || (expected && lease !== expected)) return;
    this.kimiLease = null;
    lease.release();
  }
}
