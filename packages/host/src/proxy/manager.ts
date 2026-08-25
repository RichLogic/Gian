import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Executor } from '@gian/shared';
import {
  ProtocolV2Host,
  ProtocolV2SessionClient,
} from './protocol-v2-session-client.js';
import type { ProtocolV2ClientOptions } from './protocol-v2-client.js';
import type { ProxyClient } from './types.js';
import type { CliRuntimeManager } from '../runtime/manager.js';
import type {
  RuntimeLease,
  RuntimeProcessGroupReservation,
} from '../runtime/types.js';

type ProxyExecutor = 'codex' | 'claude' | 'kimi' | 'grok' | 'dsh';
type SharedRuntimeHost = ProtocolV2Host;
function isKimiRuntimeClient(client: ProxyClient): client is ProtocolV2SessionClient {
  return client instanceof ProtocolV2SessionClient && client.executor === 'kimi';
}

/** Product executor alias → gian.proxy plugin id (plan §2 Manifest v2). */
function pluginIdFor(executor: ProxyExecutor): string {
  return executor === 'dsh' ? 'ai.deepseek.harness' : executor;
}

export interface ProxyProtocolDescriptor {
  pluginVersion: string;
  processScope: 'shared' | 'session';
}

interface RuntimeBinding {
  executor: ProxyExecutor;
  lease?: RuntimeLease;
  retiring: boolean;
  releaseEligible: boolean;
  ensureProcessTreeExited: () => Promise<void>;
  releaseProtection: () => Promise<void>;
  releasePromise?: Promise<void>;
  releaseFailure?: { error: unknown; reported: boolean };
}

interface SessionDisposal {
  executor?: ProxyExecutor;
  promise: Promise<void> | null;
  failure?: { error: unknown; reported: boolean };
}

interface KimiHostRetirement {
  host: SharedRuntimeHost;
  promise: Promise<void> | null;
  failure?: { error: unknown; reported: boolean };
}

export interface ProxyManagerConfig {
  /** Root data dir; per-session proxy state lives under {root}/proxy/{sessionId}. */
  dataDir: string;
  /** Gian Host version sent during protocol negotiation. */
  hostVersion?: string;
  /** Path to cc-proxy spawn.js entry. */
  ccProxyEntry: string;
  claudeProxy?: ProxyProtocolDescriptor;
  /** Path to codex-proxy spawn.js entry. */
  codexProxyEntry?: string;
  codexProxy?: ProxyProtocolDescriptor;
  /** Path to kimi-proxy spawn.js entry. */
  kimiProxyEntry?: string;
  kimiProxy?: ProxyProtocolDescriptor;
  grokProxyEntry?: string;
  grokProxy?: ProxyProtocolDescriptor;
  /** Path to dsh-proxy spawn.js entry (plugin id ai.deepseek.harness). */
  dshProxyEntry?: string;
  dshProxy?: ProxyProtocolDescriptor;
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
  /** Runtime ownership follows the exact process-owning object, never a
   * reusable session id or mutable "current host" slot. */
  private runtimeByOwner = new Map<object, RuntimeBinding>();
  /** Strong cleanup tasks outlive cache/host-slot deletion. A failed release
   * remains here so a later close can retry instead of reporting a false
   * drain after losing the only owner reference. */
  private pendingRuntimeReleasesByExecutor = new Map<
    ProxyExecutor,
    Set<Promise<void>>
  >();
  private creatingBySession = new Map<
    string,
    { executor: ProxyExecutor; promise: Promise<ProxyClient | null> }
  >();
  /** A session key cannot be recreated while its previous identity is still
   * being disposed. Failed barriers remain closed until an explicit dispose
   * or executor close retries the exact cleanup. */
  private disposingBySession = new Map<string, SessionDisposal>();
  /** Shared hosts are keyed by the Agent's resolved CLI path ('' = the
   *  provider default): two Agents on one Proxy kind with different CLI
   *  paths get independent host processes; same-path Agents share one. */
  private codexHosts = new Map<string, SharedRuntimeHost>();
  private codexHostInits = new Map<string, Promise<SharedRuntimeHost>>();
  private kimiHosts = new Map<string, SharedRuntimeHost>();
  private kimiHostInits = new Map<string, Promise<SharedRuntimeHost>>();
  private dshHosts = new Map<string, SharedRuntimeHost>();
  private dshHostInits = new Map<string, Promise<SharedRuntimeHost>>();
  /** A failed-attach Kimi host is never replaced until this exact host has
   * completed process-tree and updater-lease retirement. Records are keyed by
   * the exact host so hosts of different (kind, path) pairs retire
   * independently. */
  private kimiHostRetirements = new Map<SharedRuntimeHost, KimiHostRetirement>();
  private retiringKimiHostBySession = new Map<string, SharedRuntimeHost>();
  private closeEpochByExecutor = new Map<ProxyExecutor, number>();
  private closingByExecutor = new Map<ProxyExecutor, Promise<void>>();
  private creatingByExecutor = new Map<
    ProxyExecutor,
    Set<Promise<ProxyClient | null>>
  >();
  private runtimeLeaseReleases = new WeakMap<RuntimeLease, Promise<void>>();
  /** Session-scoped Proxies may temporarily host persistent Fork children.
   *  Once that happens, runtime ownership moves from the parent facade to the
   *  exact ProtocolV2Host until its last attached facade closes. */
  private readonly forkOwningSessionHosts = new WeakSet<ProtocolV2Host>();

  constructor(private cfg: ProxyManagerConfig) {}

  /** Shared-host map key for one Agent's resolved CLI path. '' is the
   *  provider-default resolution (environment override / PATH / official). */
  private static hostKey(cliPath?: string | null): string {
    return cliPath ?? '';
  }

  async getOrCreate(
    sessionId: string,
    executor: Executor,
    options?: { cliPath?: string | null },
  ): Promise<ProxyClient> {
    const proxyExecutor: ProxyExecutor = executor;
    const cliPath = options?.cliPath ?? null;
    while (true) {
      const closing = this.closingByExecutor.get(proxyExecutor);
      if (closing) {
        await closing;
        continue;
      }
      const runtimeCleanup = this.runtimeCleanupBarrier(proxyExecutor);
      if (runtimeCleanup) {
        await runtimeCleanup;
        continue;
      }
      const disposing = this.disposingBySession.get(sessionId);
      if (disposing) {
        if (disposing.promise) {
          await disposing.promise;
          continue;
        }
        throw disposing.failure?.error ?? new Error(
          `Proxy session ${sessionId} disposal must be retried before reuse.`,
        );
      }
      const existing = this.clients.get(sessionId);
      if (existing) {
        if (existing.executor !== proxyExecutor) {
          throw new Error(
            `Proxy session ${sessionId} already belongs to ${existing.executor}, not ${proxyExecutor}.`,
          );
        }
        if (this.isPublishableClient(sessionId, proxyExecutor, existing)) return existing;
        if (!existing.isExited()) {
          if (this.clients.get(sessionId) === existing) {
            this.clients.delete(sessionId);
            this.executorBySession.delete(sessionId);
          }
          continue;
        }
        // A fail-closed PGID cleanup intentionally suppresses onExit, so a
        // dead facade may remain cached for retryable cleanup. Never hand it
        // back to a caller; prove the tree exited/release its exact binding
        // or surface the cleanup error while retaining that strong owner.
        await this.cleanupExitedClientBeforePublish(existing);
        if (this.clients.get(sessionId) === existing) {
          this.clients.delete(sessionId);
          this.executorBySession.delete(sessionId);
        }
        continue;
      }

      // A session key has one owning Proxy identity. Without this single
      // flight, concurrent callers can spawn two children, overwrite both
      // maps, and let the older child's exit callback delete/release the newer
      // one. Share the complete create/publish attempt instead.
      const creating = this.creatingBySession.get(sessionId);
      if (creating) {
        if (creating.executor !== proxyExecutor) {
          throw new Error(
            `Proxy session ${sessionId} is already starting as ${creating.executor}, not ${proxyExecutor}.`,
          );
        }
        const client = await creating.promise;
        if (client && this.isPublishableClient(sessionId, proxyExecutor, client)) {
          return client;
        }
        continue;
      }

      const closeEpoch = this.closeEpochByExecutor.get(proxyExecutor) ?? 0;
      const attempt = this.createClientAttempt(sessionId, proxyExecutor, closeEpoch, cliPath);
      this.creatingBySession.set(sessionId, { executor: proxyExecutor, promise: attempt });
      let attempts = this.creatingByExecutor.get(proxyExecutor);
      if (!attempts) {
        attempts = new Set();
        this.creatingByExecutor.set(proxyExecutor, attempts);
      }
      attempts.add(attempt);
      try {
        const client = await attempt;
        // dispose() registers its barrier before its first await. If it raced
        // this creation, let that barrier consume the newly published exact
        // client rather than returning a facade that is already shutting down.
        if (client && this.isPublishableClient(sessionId, proxyExecutor, client)) {
          return client;
        }
      } finally {
        if (this.creatingBySession.get(sessionId)?.promise === attempt) {
          this.creatingBySession.delete(sessionId);
        }
        attempts.delete(attempt);
        if (attempts.size === 0 && this.creatingByExecutor.get(proxyExecutor) === attempts) {
          this.creatingByExecutor.delete(proxyExecutor);
        }
      }
    }
  }

  private async createClientAttempt(
    sessionId: string,
    executor: ProxyExecutor,
    closeEpoch: number,
    cliPath: string | null,
  ): Promise<ProxyClient | null> {
    const client = executor === 'codex'
      ? await this.createCodexClient(sessionId, cliPath)
      : executor === 'kimi'
        ? await this.createKimiClient(sessionId, cliPath)
        : executor === 'grok'
          ? await this.createGrokClient(sessionId, cliPath)
          : executor === 'dsh'
            ? await this.createDshClient(sessionId, cliPath)
            : await this.createClaudeClient(sessionId, cliPath);

    if (!client) return null;

    if (
      (this.closeEpochByExecutor.get(executor) ?? 0) !== closeEpoch
      || this.closingByExecutor.has(executor)
    ) {
      // closeByExecutor started while the runtime/Proxy was resolving. Do not
      // publish a facade that escaped its drain barrier. This whole cleanup is
      // part of the tracked creation attempt, so closeByExecutor cannot return
      // before the stale runtime claim is actually released.
      if (executor === 'claude' || executor === 'grok') {
        if (this.runtimeByOwner.has(client)) await this.releaseRuntimeBinding(client);
        else await client.shutdown();
      }
      return null;
    }

    // Keep this check in the same synchronous continuation as publication.
    // Exit callbacks may already have cleared an empty host slot while an
    // earlier register/async return was pending; such a facade must never be
    // cached after that callback has run.
    if (client.isExited()) {
      await this.cleanupExitedClientBeforePublish(client);
      return null;
    }

    // Shared-host identity can change while an async factory continuation is
    // pending. Never insert a facade whose exact host has already been
    // detached or entered retirement, even transiently.
    if (!this.isCurrentSharedClient(client)) return null;

    this.clients.set(sessionId, client);
    this.executorBySession.set(sessionId, executor);
    client.onExit(code => {
      // A force-recovered session may already have installed a fresh client
      // under the same Gian session id by the time the old process exits.
      // Never let that stale exit evict the replacement.
      if (this.clients.get(sessionId) !== client) return;
      console.log(`[proxy] session=${sessionId} exited code=${code}`);
      if (this.clients.get(sessionId) === client) {
        this.clients.delete(sessionId);
        this.executorBySession.delete(sessionId);
      }
      // Always release this exact client's lease. Never look up by session id:
      // that id may already belong to a replacement client.
      this.markRuntimeBindingReleaseEligible(client);
      void this.releaseRuntimeBinding(client).catch(error => {
        console.error(`[proxy] failed to release runtime for session=${sessionId}:`, error);
      });
    });
    return client;
  }

  /** Register a session facade that already exists on a live Host, such as a
   *  session.fork child. Does not spawn a process or claim a runtime lease. */
  adoptExisting(sessionId: string, client: ProxyClient): void {
    const existing = this.clients.get(sessionId);
    if (existing === client) return;
    if (existing) {
      throw new Error(`Proxy session ${sessionId} is already registered.`);
    }
    this.clients.set(sessionId, client);
    this.executorBySession.set(sessionId, client.executor as ProxyExecutor);
    if (
      client instanceof ProtocolV2SessionClient
      && (client.executor === 'claude' || client.executor === 'grok')
    ) {
      this.promoteForkOwningSessionHost(client.runtimeHost());
    }
    client.onExit((code) => {
      if (this.clients.get(sessionId) !== client) return;
      console.log(`[proxy] session=${sessionId} exited code=${code}`);
      if (this.clients.get(sessionId) === client) {
        this.clients.delete(sessionId);
        this.executorBySession.delete(sessionId);
      }
    });
  }

  private promoteForkOwningSessionHost(host: ProtocolV2Host): void {
    if (this.forkOwningSessionHosts.has(host)) return;
    for (const [owner, binding] of this.runtimeByOwner) {
      if (!(owner instanceof ProtocolV2SessionClient) || owner.runtimeHost() !== host) continue;
      this.runtimeByOwner.set(host, binding);
      this.runtimeByOwner.delete(owner);
      this.forkOwningSessionHosts.add(host);
      host.onHostExit(() => {
        this.dropSessionScopedClientsForHost(host.executor, host);
        this.markRuntimeBindingReleaseEligible(host);
        void this.releaseRuntimeBinding(host).catch(error => {
          console.error(`[proxy] failed to release fork-owning ${host.executor} runtime:`, error);
        });
      });
      return;
    }
    throw new Error('Fork child runtime ownership could not be promoted to its Protocol host.');
  }

  /** Drop an adopted facade without disposing the parent Proxy process. */
  forgetAdopted(sessionId: string): void {
    this.clients.delete(sessionId);
    this.executorBySession.delete(sessionId);
  }

  get(sessionId: string): ProxyClient | undefined {
    if (this.disposingBySession.has(sessionId)) return undefined;
    const client = this.clients.get(sessionId);
    const executor = this.executorBySession.get(sessionId);
    return client && executor && this.isPublishableClient(sessionId, executor, client)
      ? client
      : undefined;
  }

  private isCurrentSharedClient(client: ProxyClient): boolean {
    if (!(client instanceof ProtocolV2SessionClient)) return true;
    const host = client.runtimeHost();
    if (client.executor === 'codex') {
      return [...this.codexHosts.values()].includes(host);
    }
    if (client.executor === 'kimi') {
      return [...this.kimiHosts.values()].includes(host)
        && !this.kimiHostRetirements.has(host);
    }
    if (client.executor === 'dsh') {
      return [...this.dshHosts.values()].includes(host);
    }
    return true;
  }

  private isPublishableClient(
    sessionId: string,
    executor: ProxyExecutor,
    client: ProxyClient,
  ): boolean {
    if (
      this.clients.get(sessionId) !== client
      || this.executorBySession.get(sessionId) !== executor
      || this.disposingBySession.has(sessionId)
      || this.closingByExecutor.has(executor)
      || client.isExited()
    ) return false;
    return this.isCurrentSharedClient(client);
  }

  /**
   * Evict a wedged per-session facade, then wait for its executor-specific
   * hard stop. Eviction happens before the first await so concurrent reuse
   * cannot observe the stale facade. Shared Codex recovery closes only the
   * affected proxy session; the host process and other sessions stay alive.
   */
  async forceDispose(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) return;
    const executor = this.executorBySession.get(sessionId);
    this.clients.delete(sessionId);
    this.executorBySession.delete(sessionId);
    try {
      await client.forceKill();
    } catch (error) {
      // Keep a failed cleanup retryable instead of losing the only facade
      // that can still address the wedged proxy-side session.
      if (!this.clients.has(sessionId)) {
        this.clients.set(sessionId, client);
        if (executor) this.executorBySession.set(sessionId, executor);
      }
      throw error;
    }
    // Runtime leases are now bound to the exact process owner rather than the
    // session id. Force Recover must not release the lease until that old
    // process tree is confirmed gone, and it must never touch a replacement
    // facade installed under the same session id.
    if (this.runtimeByOwner.has(client)) {
      void this.releaseRuntimeBinding(client).catch(error => {
        console.error(`[proxy] failed to release recovered runtime for session=${sessionId}:`, error);
      });
    } else {
      void this.releaseForkHostIfEmpty(client).catch(error => {
        console.error(`[proxy] failed to release recovered fork host for session=${sessionId}:`, error);
      });
    }
  }

  /**
   * Tear down a single client by its session/cache key. No-ops when the
   * client isn't registered. Used by warmCapabilities() to retry model
   * discovery inside a fresh runtime when the previous attempt came back
   * with an empty model list.
   */
  async dispose(sessionId: string): Promise<void> {
    let record = this.disposingBySession.get(sessionId);
    if (record?.promise) return record.promise;
    if (!record) {
      record = {
        executor: this.executorBySession.get(sessionId)
          ?? this.creatingBySession.get(sessionId)?.executor
          ?? (this.retiringKimiHostBySession.has(sessionId) ? 'kimi' : undefined),
        promise: null,
      };
      // Publish the barrier before inspecting or detaching any client. A
      // same-key getOrCreate can no longer return the old facade from here on.
      this.disposingBySession.set(sessionId, record);
    }
    record.failure = undefined;

    // An unattached Kimi facade has no session.close RPC to await. Capture its
    // exact host and remove it from reuse synchronously, before this async
    // method reaches its first await; another session key must observe the
    // host-retirement barrier in the same tick.
    const immediateClient = this.clients.get(sessionId);
    let failedKimiHost: SharedRuntimeHost | undefined;
    if (
      immediateClient && isKimiRuntimeClient(immediateClient)
      && !immediateClient.hasAttachedSession()
    ) {
      failedKimiHost = immediateClient.runtimeHost();
      if (!failedKimiHost.hasSessions()) {
        this.detachKimiHostForRetirement(failedKimiHost);
        this.beginKimiHostRetirement(failedKimiHost);
      }
    }

    const attempt = this.performDispose(sessionId, record, failedKimiHost);
    record.promise = attempt;
    try {
      await attempt;
      if (this.disposingBySession.get(sessionId) === record) {
        this.disposingBySession.delete(sessionId);
      }
    } catch (error) {
      if (this.disposingBySession.get(sessionId) === record) {
        record.promise = null;
        record.failure = { error, reported: false };
      }
      throw error;
    }
  }

  private async performDispose(
    sessionId: string,
    record: SessionDisposal,
    failedKimiHost?: SharedRuntimeHost,
  ): Promise<void> {
    const creating = this.creatingBySession.get(sessionId);
    if (creating) {
      record.executor ??= creating.executor;
      await creating.promise;
    }

    const client = this.clients.get(sessionId);
    if (!client) {
      const retiringKimi = failedKimiHost ?? this.retiringKimiHostBySession.get(sessionId);
      if (retiringKimi) {
        await this.retryKimiHostRetirement(retiringKimi);
      } else if (record.executor === 'kimi') {
        await this.retryKimiHostRetirement();
      }
      return;
    }
    const executor = this.executorBySession.get(sessionId) ?? client.executor;
    record.executor = executor;
    let retiringKimiHost = failedKimiHost;
    if (
      !retiringKimiHost
      && isKimiRuntimeClient(client)
      && !client.hasAttachedSession()
    ) {
      retiringKimiHost = client.runtimeHost();
      if (!retiringKimiHost.hasSessions()) {
        this.detachKimiHostForRetirement(retiringKimiHost);
        this.beginKimiHostRetirement(retiringKimiHost);
      }
    }

    if (executor === 'claude' || executor === 'grok') {
      if (this.runtimeByOwner.has(client)) await this.releaseRuntimeBinding(client);
      else {
        await client.shutdown();
        await this.releaseForkHostIfEmpty(client);
      }
    } else {
      await client.shutdown();
    }

    if (this.clients.get(sessionId) === client) {
      this.clients.delete(sessionId);
      this.executorBySession.delete(sessionId);
    }

    if (retiringKimiHost && !retiringKimiHost.hasSessions()) {
      await this.retryKimiHostRetirement(retiringKimiHost);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.closingByExecutor.values());
    const results = await Promise.allSettled(
      (['claude', 'codex', 'kimi', 'grok', 'dsh'] as const).map(executor => this.closeByExecutor(executor)),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Proxy runtimes could not be closed.');
    }
  }

  /**
   * Close only clients for the given executor. New clients will be lazily
   * spawned on the next session message. For codex, also shuts down the shared
   * host process so it re-spawns fresh on next use.
   */
  async closeByExecutor(executor: ProxyExecutor): Promise<void> {
    const previous = this.closingByExecutor.get(executor);
    this.closeEpochByExecutor.set(
      executor,
      (this.closeEpochByExecutor.get(executor) ?? 0) + 1,
    );
    const closing = (async () => {
      if (previous) await previous;
      await this.performCloseByExecutor(executor);
    })();
    this.closingByExecutor.set(executor, closing);
    try {
      await closing;
    } finally {
      if (this.closingByExecutor.get(executor) === closing) {
        this.closingByExecutor.delete(executor);
      }
    }
  }

  private async performCloseByExecutor(executor: ProxyExecutor): Promise<void> {
    const creating = Array.from(this.creatingByExecutor.get(executor) ?? []);
    const failures: unknown[] = [];
    const retryableSessionDisposals = new Set(
      Array.from(this.disposingBySession.entries())
        .filter(([, record]) => (
          record.executor === executor && record.promise === null && record.failure
        ))
        .map(([sessionId]) => sessionId),
    );
    if (creating.length > 0) {
      const creationResults = await Promise.allSettled(creating);
      for (const result of creationResults) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    }

    const deferredBindings = new Set<object>();
    const toClose: Array<{ sessionId: string; client: ProxyClient }> = [];
    for (const [sid, exec] of this.executorBySession) {
      if (exec === executor) {
        const client = this.clients.get(sid);
        if (client) toClose.push({ sessionId: sid, client });
      }
    }

    // Start bounded process-tree cleanup before waiting for any per-session
    // disposal. A shared facade may be stuck forever in session.close; killing
    // its exact host rejects that RPC and lets the disposal barrier drain.
    const cleanupAttempts: Array<{ owner?: object; promise: Promise<void> }> = [];
    if (executor === 'claude' || executor === 'grok') {
      for (const current of toClose) {
        if (this.clients.get(current.sessionId) === current.client) {
          this.clients.delete(current.sessionId);
          this.executorBySession.delete(current.sessionId);
        }
        cleanupAttempts.push({
          owner: current.client,
          promise: this.runtimeByOwner.has(current.client)
            ? this.releaseRuntimeBinding(current.client)
            : current.client.shutdown(),
        });
      }
    } else if (executor === 'codex') {
      const pendings = [...this.codexHostInits.values()];
      if (pendings.length > 0) await Promise.allSettled(pendings);
      this.codexHostInits.clear();
      const hosts = [...this.codexHosts.values()];
      this.codexHosts.clear();
      if (hosts.length > 0) this.dropExecutorClients('codex');
      for (const host of hosts) {
        cleanupAttempts.push({
          owner: host,
          promise: this.runtimeByOwner.has(host)
            ? this.releaseRuntimeBinding(host)
            : host.shutdown(),
        });
      }
    } else if (executor === 'dsh') {
      const pendings = [...this.dshHostInits.values()];
      if (pendings.length > 0) await Promise.allSettled(pendings);
      this.dshHostInits.clear();
      const hosts = [...this.dshHosts.values()];
      this.dshHosts.clear();
      if (hosts.length > 0) this.dropExecutorClients('dsh');
      for (const host of hosts) {
        cleanupAttempts.push({
          owner: host,
          promise: this.runtimeByOwner.has(host)
            ? this.releaseRuntimeBinding(host)
            : host.shutdown(),
        });
      }
    } else {
      const pendings = [...this.kimiHostInits.values()];
      if (pendings.length > 0) await Promise.allSettled(pendings);
      this.kimiHostInits.clear();
      const hosts = [...this.kimiHosts.values()];
      for (const host of hosts) {
        this.detachKimiHostForRetirement(host);
        cleanupAttempts.push({ owner: host, promise: this.beginKimiHostRetirement(host) });
      }
      for (const record of [...this.kimiHostRetirements.values()]) {
        if (hosts.includes(record.host)) continue;
        cleanupAttempts.push({
          owner: record.host,
          promise: this.retryKimiHostRetirement(record.host),
        });
      }
    }

    const cleanupResults = await Promise.allSettled(
      cleanupAttempts.map(attempt => attempt.promise),
    );
    for (let index = 0; index < cleanupResults.length; index += 1) {
      const result = cleanupResults[index]!;
      if (result.status !== 'rejected') continue;
      const owner = cleanupAttempts[index]!.owner;
      if (owner) {
        deferredBindings.add(owner);
        const binding = this.runtimeByOwner.get(owner);
        if (binding?.releaseFailure) binding.releaseFailure.reported = true;
      }
      failures.push(result.reason);
    }

    await this.drainSessionDisposals(executor, retryableSessionDisposals, failures);
    // Unexpected-exit cleanup may already have removed every cache/host slot.
    // Its strong promise and binding still form part of this close barrier.
    await this.awaitPendingRuntimeReleases(executor);
    for (const owner of this.collectUnreportedRuntimeReleaseFailures(executor, failures)) {
      deferredBindings.add(owner);
    }
    await this.drainRuntimeBindings(executor, deferredBindings, failures);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to close ${executor} Proxy runtime safely.`);
    }
  }

  private requireProtocol(
    executor: ProxyExecutor,
    protocol: ProxyProtocolDescriptor | undefined,
    expectedScope: 'shared' | 'session',
  ): ProxyProtocolDescriptor {
    if (!protocol) {
      throw new Error(`${executor} Proxy launch descriptor is required.`);
    }
    if (protocol.processScope !== expectedScope) {
      throw new Error(
        `${executor} gian.proxy/2 manifest must use ${expectedScope} process scope.`,
      );
    }
    return protocol;
  }

  private createProtocolHost(
    executor: ProxyExecutor,
    options: Omit<ProtocolV2ClientOptions, 'pluginId' | 'pluginVersion' | 'processScope' | 'hostVersion'>
      & { protocol: ProxyProtocolDescriptor },
  ): ProtocolV2Host {
    return new ProtocolV2Host({
      executor,
      pluginId: pluginIdFor(executor),
      pluginVersion: options.protocol.pluginVersion,
      processScope: options.protocol.processScope,
      entry: options.entry,
      dataDir: options.dataDir,
      hostVersion: this.cfg.hostVersion ?? '0.1.0',
      ...(options.runtimeBin ? { runtimeBin: options.runtimeBin } : {}),
      ...(options.nodeBin ? { nodeBin: options.nodeBin } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.log ? { log: options.log } : { log: (message) => console.log(message) }),
    });
  }

  private async createClaudeClient(sessionId: string, cliPath: string | null): Promise<ProxyClient> {
    const dataDir = join(this.cfg.dataDir, 'proxy', sessionId);
    mkdirSync(dataDir, { recursive: true });
    const lease = this.cfg.runtimeManager
      ? await this.cfg.runtimeManager.acquire('claude', cliPath)
      : null;
    let runtimeOwner: object | undefined = lease
      ? this.trackStartupRuntime('claude', lease)
      : undefined;
    let reservation: RuntimeProcessGroupReservation | undefined;
    let host: ProtocolV2Host | undefined;
    try {
      reservation = await lease?.reserveProcessGroup?.();
      if (runtimeOwner && reservation) {
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.cancelBeforeSpawn(),
        );
      }
      const protocol = this.requireProtocol('claude', this.cfg.claudeProxy, 'session');
      host = this.createProtocolHost('claude', {
        protocol,
        entry: this.cfg.ccProxyEntry,
        dataDir,
        ...(lease ? { runtimeBin: lease.binaryPath, env: lease.env } : {}),
      });
      const client = host.createSessionClient(sessionId);
      if (runtimeOwner) {
        this.promoteStartupRuntime(runtimeOwner, client, () => host!.shutdown());
        runtimeOwner = client;
      } else {
        this.trackSpawnedRuntime('claude', client, () => host!.shutdown());
        runtimeOwner = client;
      }
      if (reservation) {
        if (!runtimeOwner) throw new Error('Claude runtime reservation lost its lease owner.');
        this.setRuntimeProtection(runtimeOwner, async () => {
          throw new Error(
            'Claude Proxy spawned without a verifiable process group; retaining its pending reservation.',
          );
        });
        const groupId = client.processGroupId();
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.releaseUnregistered(groupId),
        );
        const registration = await reservation.register(groupId);
        if (registration === 'already-empty') {
          client.observeProcessGroupAbsence();
          this.markRuntimeBindingReleaseEligible(runtimeOwner);
          throw new Error('Claude Proxy exited before its process group could be registered.');
        }
        this.setRuntimeProtection(runtimeOwner, () => reservation!.release());
      }
      return client;
    } catch (error) {
      if (runtimeOwner) {
        await this.cleanupFailedRuntimeStartup(
          runtimeOwner,
          error,
          'Claude runtime startup cleanup failed.',
        );
      }
      throw error;
    }
  }

  private async createCodexClient(sessionId: string, cliPath: string | null): Promise<ProxyClient> {
    const host = await this.getOrCreateCodexHost(cliPath);
    return host.createSessionClient(sessionId);
  }

  private async getOrCreateCodexHost(cliPath: string | null): Promise<SharedRuntimeHost> {
    if (!this.cfg.codexProxyEntry) {
      throw new Error(
        'codex executor requested but codexProxyEntry is not configured',
      );
    }
    const key = ProxyManager.hostKey(cliPath);
    const current = this.codexHosts.get(key);
    if (current) return current;
    let pending = this.codexHostInits.get(key);
    if (!pending) {
      pending = this.startCodexHost(key, cliPath);
      this.codexHostInits.set(key, pending);
    }
    try {
      return await pending;
    } finally {
      if (this.codexHostInits.get(key) === pending) this.codexHostInits.delete(key);
    }
  }

  private async startCodexHost(key: string, cliPath: string | null): Promise<SharedRuntimeHost> {
    const lease = this.cfg.runtimeManager
      ? await this.cfg.runtimeManager.acquire('codex', cliPath)
      : null;
    let runtimeOwner: object | undefined = lease
      ? this.trackStartupRuntime('codex', lease)
      : undefined;
    let reservation: RuntimeProcessGroupReservation | undefined;
    let host: SharedRuntimeHost | undefined;
    try {
      reservation = await lease?.reserveProcessGroup?.();
      if (runtimeOwner && reservation) {
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.cancelBeforeSpawn(),
        );
      }
      const dataDir = this.hostDataDir('codex', key);
      mkdirSync(dataDir, { recursive: true });
      const protocol = this.requireProtocol('codex', this.cfg.codexProxy, 'shared');
      host = this.createProtocolHost('codex', {
        protocol,
        entry: this.cfg.codexProxyEntry!,
        dataDir,
        ...(lease?.binaryPath ?? this.cfg.codexBin
          ? { runtimeBin: lease?.binaryPath ?? this.cfg.codexBin! }
          : {}),
        ...(lease ? { env: lease.env } : {}),
      });
      if (runtimeOwner) {
        this.promoteStartupRuntime(runtimeOwner, host, () => host!.shutdown());
        runtimeOwner = host;
      } else {
        this.trackSpawnedRuntime('codex', host, () => host!.shutdown());
        runtimeOwner = host;
      }
      if (reservation) {
        if (!runtimeOwner) throw new Error('Codex runtime reservation lost its lease owner.');
        this.setRuntimeProtection(runtimeOwner, async () => {
          throw new Error(
            'Codex Proxy spawned without a verifiable process group; retaining its pending reservation.',
          );
        });
        const groupId = host.processGroupId();
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.releaseUnregistered(groupId),
        );
        const registration = await reservation.register(groupId);
        if (registration === 'already-empty') {
          host.observeProcessGroupAbsence();
          this.markRuntimeBindingReleaseEligible(runtimeOwner);
          throw new Error('Codex Proxy exited before its process group could be registered.');
        }
        this.setRuntimeProtection(runtimeOwner, () => reservation!.release());
      }
      const startedHost = host;
      this.codexHosts.set(key, startedHost);
      startedHost.onHostExit(() => {
        if (this.codexHosts.get(key) === startedHost) {
          this.codexHosts.delete(key);
          this.dropSharedClientsForHost('codex', startedHost);
        }
        this.markRuntimeBindingReleaseEligible(startedHost);
        void this.releaseRuntimeBinding(startedHost).catch(error => {
          console.error('[proxy] failed to release Codex runtime:', error);
        });
      });
      return startedHost;
    } catch (error) {
      if (runtimeOwner) {
        await this.cleanupFailedRuntimeStartup(
          runtimeOwner,
          error,
          'Codex runtime startup cleanup failed.',
        );
      }
      throw error;
    }
  }

  private async createDshClient(sessionId: string, cliPath: string | null): Promise<ProxyClient | null> {
    const host = await this.getOrCreateDshHost(cliPath);
    if (!host) return null;
    return host.createSessionClient(sessionId);
  }

  private async getOrCreateDshHost(cliPath: string | null): Promise<SharedRuntimeHost | null> {
    if (!this.cfg.dshProxyEntry) {
      throw new Error(
        'dsh executor requested but dshProxyEntry is not configured',
      );
    }
    if (!this.cfg.runtimeManager) {
      throw new Error(
        'dsh executor requested but CliRuntimeManager is not configured',
      );
    }
    const key = ProxyManager.hostKey(cliPath);
    const current = this.dshHosts.get(key);
    if (current) return current;
    let pending = this.dshHostInits.get(key);
    if (!pending) {
      pending = this.startDshHost(key, cliPath);
      this.dshHostInits.set(key, pending);
    }
    try {
      return await pending;
    } finally {
      if (this.dshHostInits.get(key) === pending) this.dshHostInits.delete(key);
    }
  }

  private async startDshHost(key: string, cliPath: string | null): Promise<SharedRuntimeHost> {
    const lease = await this.cfg.runtimeManager!.acquire('dsh', cliPath);
    let runtimeOwner: object | undefined = this.trackStartupRuntime('dsh', lease);
    let reservation: RuntimeProcessGroupReservation | undefined;
    let host: SharedRuntimeHost | undefined;
    try {
      reservation = await lease.reserveProcessGroup?.();
      if (reservation) {
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.cancelBeforeSpawn(),
        );
      }
      const protocol = this.requireProtocol('dsh', this.cfg.dshProxy, 'shared');
      host = this.createProtocolHost('dsh', {
        protocol,
        entry: this.cfg.dshProxyEntry!,
        dataDir: this.hostDataDir('dsh', key),
        runtimeBin: lease.binaryPath,
        env: lease.env,
      });
      this.promoteStartupRuntime(runtimeOwner, host, () => host!.shutdown());
      runtimeOwner = host;
      if (reservation) {
        this.setRuntimeProtection(runtimeOwner, async () => {
          throw new Error(
            'DSH Proxy spawned without a verifiable process group; retaining its pending reservation.',
          );
        });
        const groupId = host.processGroupId();
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.releaseUnregistered(groupId),
        );
        const registration = await reservation.register(groupId);
        if (registration === 'already-empty') {
          host.observeProcessGroupAbsence();
          this.markRuntimeBindingReleaseEligible(runtimeOwner);
          throw new Error('DSH Proxy exited before its process group could be registered.');
        }
        this.setRuntimeProtection(runtimeOwner, () => reservation!.release());
      }
      const startedHost = host;
      this.dshHosts.set(key, startedHost);
      startedHost.onHostExit(() => {
        if (this.dshHosts.get(key) === startedHost) {
          this.dshHosts.delete(key);
          this.dropSharedClientsForHost('dsh', startedHost);
        }
        this.markRuntimeBindingReleaseEligible(startedHost);
        void this.releaseRuntimeBinding(startedHost).catch(error => {
          console.error('[proxy] failed to release DSH runtime:', error);
        });
      });
      return startedHost;
    } catch (error) {
      await this.cleanupFailedRuntimeStartup(
        runtimeOwner,
        error,
        'DSH runtime startup cleanup failed.',
      );
      throw error;
    }
  }

  private async createKimiClient(sessionId: string, cliPath: string | null): Promise<ProxyClient | null> {
    const host = await this.getOrCreateKimiHost(sessionId, cliPath);
    if (!host) return null;
    return host.createSessionClient(sessionId);
  }

  private async getOrCreateKimiHost(
    sessionId: string,
    cliPath: string | null,
  ): Promise<SharedRuntimeHost | null> {
    if (!this.cfg.kimiProxyEntry) {
      throw new Error('kimi executor requested but kimiProxyEntry is not configured');
    }
    if (!this.cfg.runtimeManager) {
      throw new Error('kimi executor requested but CliRuntimeManager is not configured');
    }
    const key = ProxyManager.hostKey(cliPath);
    while (true) {
      if (this.disposingBySession.has(sessionId)) {
        if (this.kimiHostRetirements.size > 0) await this.retryKimiHostRetirement();
        return null;
      }
      // Preserve a synchronous fast path when no host is retiring. Awaiting an
      // already-resolved helper here would open a microtask window in which a
      // failed-attach dispose can detach the old host after this check.
      if (this.kimiHostRetirements.size > 0) {
        await this.retryKimiHostRetirement();
        continue;
      }
      const current = this.kimiHosts.get(key);
      if (current) return current;

      let pending = this.kimiHostInits.get(key);
      if (!pending) {
        pending = this.startKimiHost(key, cliPath);
        this.kimiHostInits.set(key, pending);
      }
      try {
        const host = await pending;
        if (this.disposingBySession.has(sessionId)) {
          if (this.kimiHosts.get(key) === host && !host.hasSessions()) {
            this.detachKimiHostForRetirement(host);
            this.beginKimiHostRetirement(host);
          }
          if (this.kimiHostRetirements.has(host)) {
            await this.retryKimiHostRetirement(host);
          }
          return null;
        }
        // A waiter can resume after another session synchronously detached
        // this just-started host. Re-enter the barrier instead of publishing a
        // facade for the retiring identity.
        if (this.kimiHostRetirements.size > 0 || this.kimiHosts.get(key) !== host) continue;
        return host;
      } finally {
        if (this.kimiHostInits.get(key) === pending) this.kimiHostInits.delete(key);
      }
    }
  }

  private async startKimiHost(key: string, cliPath: string | null): Promise<SharedRuntimeHost> {
    const lease = await this.cfg.runtimeManager!.acquire('kimi', cliPath);
    let runtimeOwner: object = this.trackStartupRuntime('kimi', lease);
    let reservation: RuntimeProcessGroupReservation | undefined;
    let host: SharedRuntimeHost | undefined;
    try {
      reservation = await lease.reserveProcessGroup?.();
      if (reservation) {
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.cancelBeforeSpawn(),
        );
      }
      const protocol = this.requireProtocol('kimi', this.cfg.kimiProxy, 'shared');
      host = this.createProtocolHost('kimi', {
        protocol,
        entry: this.cfg.kimiProxyEntry!,
        dataDir: this.hostDataDir('kimi', key),
        runtimeBin: lease.binaryPath,
        env: lease.env,
      });
      this.promoteStartupRuntime(runtimeOwner, host, () => host!.shutdown());
      runtimeOwner = host;
      if (reservation) {
        this.setRuntimeProtection(runtimeOwner, async () => {
          throw new Error(
            'Kimi Proxy spawned without a verifiable process group; retaining its pending reservation.',
          );
        });
        const groupId = host.processGroupId();
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.releaseUnregistered(groupId),
        );
        const registration = await reservation.register(groupId);
        if (registration === 'already-empty') {
          host.observeProcessGroupAbsence();
          this.markRuntimeBindingReleaseEligible(runtimeOwner);
          throw new Error('Kimi Proxy exited before its process group could be registered.');
        }
        this.setRuntimeProtection(runtimeOwner, () => reservation!.release());
      }
      const startedHost = host;
      this.kimiHosts.set(key, startedHost);
      startedHost.onHostExit(() => {
        if (this.kimiHosts.get(key) === startedHost) {
          // Attached facades receive their own exit callback from the host.
          // This also clears facades that never attached a native session.
          this.detachKimiHostForRetirement(startedHost);
        }
        this.markRuntimeBindingReleaseEligible(startedHost);
        void this.beginKimiHostRetirement(startedHost).catch(error => {
          console.error('[proxy] failed to release Kimi runtime:', error);
        });
      });
      // Session waiters re-check their exact facade/host relationship after
      // this shared init resolves, before this host can be published.
      return startedHost;
    } catch (error) {
      await this.cleanupFailedRuntimeStartup(
        runtimeOwner,
        error,
        'Kimi runtime startup cleanup failed.',
      );
      throw error;
    }
  }

  private async createGrokClient(sessionId: string, cliPath: string | null): Promise<ProxyClient | null> {
    if (!this.cfg.grokProxyEntry) {
      throw new Error('grok executor requested but grokProxyEntry is not configured');
    }
    if (!this.cfg.runtimeManager) {
      throw new Error('grok executor requested but CliRuntimeManager is not configured');
    }
    if (this.disposingBySession.has(sessionId)) return null;
    const dataDir = join(this.cfg.dataDir, 'proxy', sessionId);
    mkdirSync(dataDir, { recursive: true });
    const lease = await this.cfg.runtimeManager.acquire('grok', cliPath);
    let runtimeOwner: object = this.trackStartupRuntime('grok', lease);
    let reservation: RuntimeProcessGroupReservation | undefined;
    let host: ProtocolV2Host | undefined;
    try {
      reservation = await lease.reserveProcessGroup?.();
      if (reservation) {
        this.setRuntimeProtection(runtimeOwner, () => reservation!.cancelBeforeSpawn());
      }
      const protocol = this.requireProtocol('grok', this.cfg.grokProxy, 'session');
      host = this.createProtocolHost('grok', {
        protocol,
        entry: this.cfg.grokProxyEntry,
        dataDir,
        runtimeBin: lease.binaryPath,
        env: lease.env,
      });
      this.promoteStartupRuntime(runtimeOwner, host, () => host!.shutdown());
      runtimeOwner = host;
      if (reservation) {
        this.setRuntimeProtection(runtimeOwner, async () => {
          throw new Error(
            'Grok Proxy spawned without a verifiable process group; retaining its pending reservation.',
          );
        });
        const groupId = host.processGroupId();
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.releaseUnregistered(groupId),
        );
        const registration = await reservation.register(groupId);
        if (registration === 'already-empty') {
          host.observeProcessGroupAbsence();
          this.markRuntimeBindingReleaseEligible(runtimeOwner);
          throw new Error('Grok Proxy exited before its process group could be registered.');
        }
        this.setRuntimeProtection(runtimeOwner, () => reservation!.release());
      }
      const client = host.createSessionClient(sessionId);
      this.promoteStartupRuntime(host, client, () => host!.shutdown());
      return client;
    } catch (error) {
      await this.cleanupFailedRuntimeStartup(
        runtimeOwner,
        error,
        'Grok runtime startup cleanup failed.',
      );
      throw error;
    }
  }

  private dropKimiClientsForHost(host: SharedRuntimeHost): void {
    for (const [sessionId, executor] of this.executorBySession) {
      if (executor !== 'kimi') continue;
      const client = this.clients.get(sessionId);
      if (
        client && isKimiRuntimeClient(client)
        && client.runtimeHost() === host
      ) {
        this.retiringKimiHostBySession.set(sessionId, host);
        this.clients.delete(sessionId);
        this.executorBySession.delete(sessionId);
      }
    }
  }

  private dropExecutorClients(executorToDrop: ProxyExecutor): void {
    for (const [sessionId, executor] of this.executorBySession) {
      if (executor !== executorToDrop) continue;
      this.clients.delete(sessionId);
      this.executorBySession.delete(sessionId);
    }
  }

  /** Drop only the facades bound to one exact shared host — other (kind,
   *  path) hosts of the same executor keep their sessions. */
  private dropSharedClientsForHost(executorToDrop: ProxyExecutor, host: SharedRuntimeHost): void {
    for (const [sessionId, executor] of this.executorBySession) {
      if (executor !== executorToDrop) continue;
      const client = this.clients.get(sessionId);
      if (
        client instanceof ProtocolV2SessionClient
        && client.runtimeHost() === host
      ) {
        this.clients.delete(sessionId);
        this.executorBySession.delete(sessionId);
      }
    }
  }

  private dropSessionScopedClientsForHost(executorToDrop: ProxyExecutor, host: ProtocolV2Host): void {
    for (const [sessionId, executor] of this.executorBySession) {
      if (executor !== executorToDrop) continue;
      const client = this.clients.get(sessionId);
      if (
        client instanceof ProtocolV2SessionClient
        && client.runtimeHost() === host
      ) {
        this.clients.delete(sessionId);
        this.executorBySession.delete(sessionId);
      }
    }
  }

  /** Per-(kind, path) host state directory. The default path keeps the
   *  legacy `{kind}` directory so existing profiles stay compatible. */
  private hostDataDir(kind: string, key: string): string {
    const suffix = key
      ? `-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
      : '';
    return join(this.cfg.dataDir, 'proxy', `${kind}${suffix}`);
  }

  private trackStartupRuntime(executor: ProxyExecutor, lease: RuntimeLease): object {
    const owner = {};
    this.runtimeByOwner.set(owner, {
      executor,
      lease,
      retiring: false,
      releaseEligible: true,
      ensureProcessTreeExited: async () => undefined,
      releaseProtection: async () => undefined,
    });
    return owner;
  }

  private trackSpawnedRuntime(
    executor: ProxyExecutor,
    owner: object,
    ensureProcessTreeExited: () => Promise<void>,
  ): void {
    this.runtimeByOwner.set(owner, {
      executor,
      retiring: false,
      releaseEligible: false,
      ensureProcessTreeExited,
      releaseProtection: async () => undefined,
    });
  }

  private setRuntimeProtection(owner: object, releaseProtection: () => Promise<void>): void {
    const binding = this.runtimeByOwner.get(owner);
    if (!binding) throw new Error('Runtime startup binding was lost.');
    binding.releaseProtection = releaseProtection;
  }

  private promoteStartupRuntime(
    startupOwner: object,
    runtimeOwner: object,
    ensureProcessTreeExited: () => Promise<void>,
  ): void {
    const binding = this.runtimeByOwner.get(startupOwner);
    if (!binding) throw new Error('Runtime startup binding was lost before spawn publication.');
    binding.releaseEligible = false;
    binding.ensureProcessTreeExited = ensureProcessTreeExited;
    // Publish the real owner before deleting the token, with no await between
    // operations, so close enumeration always sees one strong binding.
    this.runtimeByOwner.set(runtimeOwner, binding);
    if (this.runtimeByOwner.get(startupOwner) === binding) {
      this.runtimeByOwner.delete(startupOwner);
    }
  }

  private async cleanupFailedRuntimeStartup(
    owner: object,
    startupError: unknown,
    message: string,
  ): Promise<void> {
    try {
      await this.releaseRuntimeBinding(owner);
    } catch (cleanupError) {
      throw new AggregateError([startupError, cleanupError], message);
    }
  }

  private detachKimiHostForRetirement(host: SharedRuntimeHost): void {
    for (const [key, current] of this.kimiHosts) {
      if (current === host) this.kimiHosts.delete(key);
    }
    this.dropKimiClientsForHost(host);
    if (!this.kimiHostRetirements.has(host)) {
      this.kimiHostRetirements.set(host, { host, promise: null });
    }
  }

  private beginKimiHostRetirement(host: SharedRuntimeHost): Promise<void> {
    this.detachKimiHostForRetirement(host);
    const record = this.kimiHostRetirements.get(host)!;
    if (record.promise) return record.promise;
    record.failure = undefined;
    const attempt = this.runtimeByOwner.has(host)
      ? this.releaseRuntimeBinding(host)
      : host.shutdown();
    record.promise = attempt;
    void attempt.then(
      () => {
        if (this.kimiHostRetirements.get(host) === record) {
          this.kimiHostRetirements.delete(host);
        }
        for (const [sessionId, retiringHost] of this.retiringKimiHostBySession) {
          if (retiringHost === host) this.retiringKimiHostBySession.delete(sessionId);
        }
      },
      error => {
        if (this.kimiHostRetirements.get(host) === record) {
          record.promise = null;
          record.failure = { error, reported: false };
        }
      },
    );
    return attempt;
  }

  private async retryKimiHostRetirement(expectedHost?: SharedRuntimeHost): Promise<void> {
    if (expectedHost) {
      const record = this.kimiHostRetirements.get(expectedHost);
      if (!record) return;
      await this.beginKimiHostRetirement(record.host);
      return;
    }
    await Promise.all(
      [...this.kimiHostRetirements.values()].map(record => (
        this.beginKimiHostRetirement(record.host)
      )),
    );
  }

  private async drainSessionDisposals(
    executor: ProxyExecutor,
    retryableAtStart: ReadonlySet<string>,
    failures: unknown[],
  ): Promise<void> {
    const active = Array.from(this.disposingBySession.entries())
      .filter(([, record]) => record.executor === executor && record.promise)
      .map(([, record]) => record.promise!);
    if (active.length > 0) await Promise.allSettled(active);

    const remaining = Array.from(this.disposingBySession.entries())
      .filter(([, record]) => record.executor === executor);
    for (const [sessionId, record] of remaining) {
      if (retryableAtStart.has(sessionId)) {
        try {
          await this.dispose(sessionId);
        } catch (error) {
          const current = this.disposingBySession.get(sessionId);
          if (current?.failure) current.failure.reported = true;
          failures.push(error);
        }
        continue;
      }
      if (record.failure && !record.failure.reported) {
        record.failure.reported = true;
        failures.push(record.failure.error);
      }
    }
  }

  private runtimeCleanupBarrier(executor: ProxyExecutor): Promise<void> | null {
    const pending: Promise<void>[] = [];
    for (const binding of this.runtimeByOwner.values()) {
      if (binding.executor !== executor || !binding.retiring) continue;
      if (binding.releasePromise) {
        pending.push(binding.releasePromise);
        continue;
      }
      return Promise.reject(
        binding.releaseFailure?.error
          ?? new Error(`${executor} runtime cleanup must be retried before reuse.`),
      );
    }
    if (pending.length === 0) return null;
    return pending.length === 1 ? pending[0]! : Promise.all(pending).then(() => undefined);
  }

  private async cleanupExitedClientBeforePublish(client: ProxyClient): Promise<void> {
    if (client instanceof ProtocolV2SessionClient && client.executor === 'codex') {
      const host = client.runtimeHost();
      for (const [key, current] of this.codexHosts) {
        if (current === host) this.codexHosts.delete(key);
      }
      this.dropSharedClientsForHost('codex', host);
      if (this.runtimeByOwner.has(host)) await this.releaseRuntimeBinding(host);
      else await host.shutdown();
      return;
    }
    if (isKimiRuntimeClient(client)) {
      const host = client.runtimeHost();
      this.detachKimiHostForRetirement(host);
      await this.beginKimiHostRetirement(host);
      return;
    }
    if (this.runtimeByOwner.has(client)) await this.releaseRuntimeBinding(client);
    else {
      await client.shutdown();
      await this.releaseForkHostIfEmpty(client);
    }
  }

  private async releaseForkHostIfEmpty(client: ProxyClient): Promise<void> {
    if (
      !(client instanceof ProtocolV2SessionClient)
      || (client.executor !== 'claude' && client.executor !== 'grok')
    ) return;
    const host = client.runtimeHost();
    if (!host.hasSessions() && this.runtimeByOwner.has(host)) {
      await this.releaseRuntimeBinding(host);
    }
  }

  private markRuntimeBindingReleaseEligible(owner: object): void {
    const binding = this.runtimeByOwner.get(owner);
    if (binding) binding.releaseEligible = true;
  }

  private async releaseRuntimeBinding(owner: object): Promise<void> {
    const binding = this.runtimeByOwner.get(owner);
    if (!binding) return;
    if (binding.releasePromise) return binding.releasePromise;
    binding.retiring = true;
    binding.releaseFailure = undefined;
    let release!: Promise<void>;
    release = (async () => {
      try {
        if (!binding.releaseEligible) {
          await binding.ensureProcessTreeExited();
          binding.releaseEligible = true;
        }
        await binding.releaseProtection();
        if (binding.lease) await this.releaseRuntimeLease(binding.lease);
        if (this.runtimeByOwner.get(owner) === binding) {
          this.runtimeByOwner.delete(owner);
        }
      } catch (error) {
        binding.releaseFailure = { error, reported: false };
        throw error;
      } finally {
        if (binding.releasePromise === release) binding.releasePromise = undefined;
      }
    })();
    binding.releasePromise = release;
    let pending = this.pendingRuntimeReleasesByExecutor.get(binding.executor);
    if (!pending) {
      pending = new Set();
      this.pendingRuntimeReleasesByExecutor.set(binding.executor, pending);
    }
    pending.add(release);
    const retirePending = (): void => {
      pending!.delete(release);
      if (
        pending!.size === 0
        && this.pendingRuntimeReleasesByExecutor.get(binding.executor) === pending
      ) {
        this.pendingRuntimeReleasesByExecutor.delete(binding.executor);
      }
    };
    release.then(retirePending, retirePending);
    return release;
  }

  private async awaitPendingRuntimeReleases(executor: ProxyExecutor): Promise<void> {
    const pending = Array.from(this.pendingRuntimeReleasesByExecutor.get(executor) ?? []);
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  private collectUnreportedRuntimeReleaseFailures(
    executor: ProxyExecutor,
    failures: unknown[],
  ): Set<object> {
    const deferred = new Set<object>();
    for (const [owner, binding] of this.runtimeByOwner) {
      if (binding.executor !== executor) continue;
      const failure = binding.releaseFailure;
      if (!failure || failure.reported) continue;
      failure.reported = true;
      failures.push(failure.error);
      deferred.add(owner);
    }
    return deferred;
  }

  private async drainRuntimeBindings(
    executor: ProxyExecutor,
    deferred: ReadonlySet<object>,
    failures: unknown[],
  ): Promise<void> {
    const bindings = Array.from(this.runtimeByOwner.entries())
      .filter(([owner, binding]) => binding.executor === executor && !deferred.has(owner));
    const results = await Promise.allSettled(
      bindings.map(([owner]) => this.releaseRuntimeBinding(owner)),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      if (result.status !== 'rejected') continue;
      const [owner, binding] = bindings[index]!;
      const current = this.runtimeByOwner.get(owner);
      if (current === binding && current.releaseFailure) {
        current.releaseFailure.reported = true;
      }
      failures.push(result.reason);
    }
  }

  private releaseRuntimeLease(lease: RuntimeLease): Promise<void> {
    const existing = this.runtimeLeaseReleases.get(lease);
    if (existing) return existing;
    let release: Promise<void>;
    release = lease.release().catch(error => {
      if (this.runtimeLeaseReleases.get(lease) === release) {
        this.runtimeLeaseReleases.delete(lease);
      }
      throw error;
    });
    this.runtimeLeaseReleases.set(lease, release);
    return release;
  }
}
