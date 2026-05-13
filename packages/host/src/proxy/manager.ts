import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Executor } from '@gian/shared';
import { CcProxyClient } from './cc-proxy-client.js';
import { CodexProxyHost, CodexProxySessionClient } from './codex-proxy-client.js';
import type { ProxyClient } from './types.js';

type ProxyExecutor = 'codex' | 'claude';

export interface ProxyManagerConfig {
  /** Root data dir; per-session proxy state lives under {root}/proxy/{sessionId}. */
  dataDir: string;
  /** Path to cc-proxy spawn.js entry. */
  ccProxyEntry: string;
  /** Path to codex-proxy spawn.js entry. */
  codexProxyEntry?: string;
  /** Optional codex CLI binary path (forwarded as --codex-bin). */
  codexBin?: string;
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

  constructor(private cfg: ProxyManagerConfig) {}

  async getOrCreate(sessionId: string, executor: Executor): Promise<ProxyClient> {
    const existing = this.clients.get(sessionId);
    if (existing) return existing;

    const client =
      executor === 'codex'
        ? this.createCodexClient(sessionId)
        : this.createClaudeClient(sessionId);

    this.clients.set(sessionId, client);
    this.executorBySession.set(sessionId, executor === 'codex' ? 'codex' : 'claude');
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
    this.clients.delete(sessionId);
    this.executorBySession.delete(sessionId);
    try { await client.shutdown(); } catch { /* swallow — process may already be gone */ }
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

  private createCodexClient(sessionId: string): ProxyClient {
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
}
