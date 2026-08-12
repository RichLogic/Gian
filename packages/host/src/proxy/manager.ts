import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Executor } from '@gian/shared';
import { CcProxyClient } from './cc-proxy-client.js';
import { ClaudeProtocolV1Client } from './claude-protocol-v1-client.js';
import { CodexProxyHost, CodexProxySessionClient } from './codex-proxy-client.js';
import {
  CodexProtocolV1Host,
  CodexProtocolV1SessionClient,
} from './codex-protocol-v1-client.js';
import { KimiProxyHost, KimiProxySessionClient } from './kimi-proxy-client.js';
import {
  KimiProtocolV1Host,
  KimiProtocolV1SessionClient,
} from './kimi-protocol-v1-client.js';
import type { ProxyClient } from './types.js';
import type { CliRuntimeManager } from '../runtime/manager.js';
import type {
  RuntimeLease,
  RuntimeProcessGroupReservation,
} from '../runtime/types.js';

type ProxyExecutor = 'codex' | 'claude' | 'kimi';
type CodexRuntimeHost = CodexProxyHost | CodexProtocolV1Host;
type KimiRuntimeHost = KimiProxyHost | KimiProtocolV1Host;
type KimiRuntimeClient = KimiProxySessionClient | KimiProtocolV1SessionClient;

function isKimiRuntimeClient(client: ProxyClient): client is KimiRuntimeClient {
  return client instanceof KimiProxySessionClient
    || client instanceof KimiProtocolV1SessionClient;
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
  host: KimiRuntimeHost;
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
  claudeProxyProtocolV1?: {
    pluginVersion: string;
    processScope: 'shared' | 'session';
  };
  /** Path to codex-proxy spawn.js entry. */
  codexProxyEntry?: string;
  codexProxyProtocolV1?: {
    pluginVersion: string;
    processScope: 'shared' | 'session';
  };
  /** Path to kimi-proxy spawn.js entry. */
  kimiProxyEntry?: string;
  kimiProxyProtocolV1?: {
    pluginVersion: string;
    processScope: 'shared' | 'session';
  };
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
  private codexHost: CodexRuntimeHost | null = null;
  private codexHostInit: Promise<CodexRuntimeHost> | null = null;
  private kimiHost: KimiRuntimeHost | null = null;
  private kimiHostInit: Promise<KimiRuntimeHost> | null = null;
  /** A failed-attach Kimi host is never replaced until this exact host has
   * completed process-tree and updater-lease retirement. */
  private kimiHostRetirement: KimiHostRetirement | null = null;
  private retiringKimiHostBySession = new Map<string, KimiRuntimeHost>();
  private closeEpochByExecutor = new Map<ProxyExecutor, number>();
  private closingByExecutor = new Map<ProxyExecutor, Promise<void>>();
  private creatingByExecutor = new Map<
    ProxyExecutor,
    Set<Promise<ProxyClient | null>>
  >();
  private runtimeLeaseReleases = new WeakMap<RuntimeLease, Promise<void>>();

  constructor(private cfg: ProxyManagerConfig) {}

  usesProtocolV1(executor: Executor): boolean {
    if (executor === 'claude') return this.cfg.claudeProxyProtocolV1 !== undefined;
    if (executor === 'codex') return this.cfg.codexProxyProtocolV1 !== undefined;
    return this.cfg.kimiProxyProtocolV1 !== undefined;
  }

  async getOrCreate(sessionId: string, executor: Executor): Promise<ProxyClient> {
    const proxyExecutor: ProxyExecutor = executor;
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
      const attempt = this.createClientAttempt(sessionId, proxyExecutor, closeEpoch);
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
  ): Promise<ProxyClient | null> {
    const client = executor === 'codex'
      ? await this.createCodexClient(sessionId)
      : executor === 'kimi'
        ? await this.createKimiClient(sessionId)
        : await this.createClaudeClient(sessionId);

    if (!client) return null;

    if (
      (this.closeEpochByExecutor.get(executor) ?? 0) !== closeEpoch
      || this.closingByExecutor.has(executor)
    ) {
      // closeByExecutor started while the runtime/Proxy was resolving. Do not
      // publish a facade that escaped its drain barrier. This whole cleanup is
      // part of the tracked creation attempt, so closeByExecutor cannot return
      // before the stale runtime claim is actually released.
      if (executor === 'claude') {
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

  get(sessionId: string): ProxyClient | undefined {
    if (this.disposingBySession.has(sessionId)) return undefined;
    const client = this.clients.get(sessionId);
    const executor = this.executorBySession.get(sessionId);
    return client && executor && this.isPublishableClient(sessionId, executor, client)
      ? client
      : undefined;
  }

  private isCurrentSharedClient(client: ProxyClient): boolean {
    if (client instanceof CodexProxySessionClient) {
      return this.codexHost === client.runtimeHost();
    }
    if (client instanceof CodexProtocolV1SessionClient) {
      return this.codexHost === client.runtimeHost();
    }
    if (isKimiRuntimeClient(client)) {
      const host = client.runtimeHost();
      return this.kimiHost === host && this.kimiHostRetirement?.host !== host;
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
    let failedKimiHost: KimiRuntimeHost | undefined;
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
    failedKimiHost?: KimiRuntimeHost,
  ): Promise<void> {
    const creating = this.creatingBySession.get(sessionId);
    if (creating) {
      record.executor ??= creating.executor;
      await creating.promise;
    }

    const client = this.clients.get(sessionId);
    if (!client) {
      const retiringHost = failedKimiHost ?? this.retiringKimiHostBySession.get(sessionId);
      if (retiringHost) {
        await this.retryKimiHostRetirement(retiringHost);
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

    if (executor === 'claude') {
      if (this.runtimeByOwner.has(client)) await this.releaseRuntimeBinding(client);
      else await client.shutdown();
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
      (['claude', 'codex', 'kimi'] as const).map(executor => this.closeByExecutor(executor)),
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
    if (executor === 'claude') {
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
      const pending = this.codexHostInit;
      if (pending) await pending.catch(() => undefined);
      if (this.codexHostInit === pending) this.codexHostInit = null;
      const host = this.codexHost;
      if (this.codexHost === host) {
        this.codexHost = null;
        this.dropExecutorClients('codex');
      }
      if (host) {
        cleanupAttempts.push({
          owner: host,
          promise: this.runtimeByOwner.has(host)
            ? this.releaseRuntimeBinding(host)
            : host.shutdown(),
        });
      }
    } else {
      const pending = this.kimiHostInit;
      if (pending) await pending.catch(() => undefined);
      if (this.kimiHostInit === pending) this.kimiHostInit = null;
      const host = this.kimiHost;
      if (host) {
        this.detachKimiHostForRetirement(host);
        cleanupAttempts.push({ owner: host, promise: this.beginKimiHostRetirement(host) });
      } else if (this.kimiHostRetirement) {
        const retiringHost = this.kimiHostRetirement.host;
        cleanupAttempts.push({
          owner: retiringHost,
          promise: this.retryKimiHostRetirement(retiringHost),
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

  private async createClaudeClient(sessionId: string): Promise<ProxyClient> {
    const dataDir = join(this.cfg.dataDir, 'proxy', sessionId);
    mkdirSync(dataDir, { recursive: true });
    const lease = this.cfg.runtimeManager
      ? await this.cfg.runtimeManager.acquire('claude')
      : null;
    let runtimeOwner: object | undefined = lease
      ? this.trackStartupRuntime('claude', lease)
      : undefined;
    let reservation: RuntimeProcessGroupReservation | undefined;
    let client: CcProxyClient | ClaudeProtocolV1Client | undefined;
    try {
      reservation = await lease?.reserveProcessGroup?.();
      if (runtimeOwner && reservation) {
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.cancelBeforeSpawn(),
        );
      }
      const protocolV1 = this.cfg.claudeProxyProtocolV1;
      if (protocolV1 && protocolV1.processScope !== 'session') {
        throw new Error('Claude gian.proxy/1 manifest must use session process scope.');
      }
      client = protocolV1
        ? new ClaudeProtocolV1Client({
            entry: this.cfg.ccProxyEntry,
            pluginVersion: protocolV1.pluginVersion,
            processScope: 'session',
            dataDir,
            hostVersion: this.cfg.hostVersion ?? '0.1.0',
            hostSessionId: sessionId,
            ...(lease ? { runtimeBin: lease.binaryPath, env: lease.env } : {}),
            log: msg => console.log(msg),
          })
        : new CcProxyClient({
            entry: this.cfg.ccProxyEntry,
            dataDir,
            ...(lease
              ? {
                  env: {
                    ...lease.env,
                    CLAUDE_BIN: lease.binaryPath,
                  },
                }
              : {}),
            log: msg => console.log(msg),
          });
      if (runtimeOwner) {
        this.promoteStartupRuntime(runtimeOwner, client, () => client!.shutdown());
        runtimeOwner = client;
      } else {
        this.trackSpawnedRuntime('claude', client, () => client!.shutdown());
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

  private async createCodexClient(sessionId: string): Promise<ProxyClient> {
    const host = await this.getOrCreateCodexHost();
    return host instanceof CodexProtocolV1Host
      ? host.createSessionClient(sessionId)
      : new CodexProxySessionClient(host);
  }

  private async getOrCreateCodexHost(): Promise<CodexRuntimeHost> {
    if (!this.cfg.codexProxyEntry) {
      throw new Error(
        'codex executor requested but codexProxyEntry is not configured',
      );
    }
    if (this.codexHost) return this.codexHost;
    let pending = this.codexHostInit;
    if (!pending) {
      pending = this.startCodexHost();
      this.codexHostInit = pending;
    }
    try {
      return await pending;
    } finally {
      if (this.codexHostInit === pending) this.codexHostInit = null;
    }
  }

  private async startCodexHost(): Promise<CodexRuntimeHost> {
    const lease = this.cfg.runtimeManager
      ? await this.cfg.runtimeManager.acquire('codex')
      : null;
    let runtimeOwner: object | undefined = lease
      ? this.trackStartupRuntime('codex', lease)
      : undefined;
    let reservation: RuntimeProcessGroupReservation | undefined;
    let host: CodexRuntimeHost | undefined;
    try {
      reservation = await lease?.reserveProcessGroup?.();
      if (runtimeOwner && reservation) {
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.cancelBeforeSpawn(),
        );
      }
      const dataDir = join(this.cfg.dataDir, 'proxy', 'codex');
      mkdirSync(dataDir, { recursive: true });
      const protocolV1 = this.cfg.codexProxyProtocolV1;
      if (protocolV1 && protocolV1.processScope !== 'shared') {
        throw new Error('Codex gian.proxy/1 manifest must use shared process scope.');
      }
      host = protocolV1
        ? new CodexProtocolV1Host({
            entry: this.cfg.codexProxyEntry!,
            pluginVersion: protocolV1.pluginVersion,
            processScope: 'shared',
            dataDir,
            hostVersion: this.cfg.hostVersion ?? '0.1.0',
            ...(lease?.binaryPath ?? this.cfg.codexBin
              ? { runtimeBin: lease?.binaryPath ?? this.cfg.codexBin! }
              : {}),
            ...(lease ? { env: lease.env } : {}),
            log: msg => console.log(msg),
          })
        : new CodexProxyHost({
            entry: this.cfg.codexProxyEntry!,
            dataDir,
            codexBin: lease?.binaryPath ?? this.cfg.codexBin,
            ...(lease ? { env: lease.env } : {}),
            log: msg => console.log(msg),
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
      this.codexHost = startedHost;
      startedHost.onHostExit(() => {
        if (this.codexHost === startedHost) {
          this.codexHost = null;
          this.dropExecutorClients('codex');
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

  private async createKimiClient(sessionId: string): Promise<ProxyClient | null> {
    const host = await this.getOrCreateKimiHost(sessionId);
    if (!host) return null;
    return host instanceof KimiProtocolV1Host
      ? host.createSessionClient(sessionId)
      : new KimiProxySessionClient(host);
  }

  private currentKimiHost(): KimiRuntimeHost | null {
    return this.kimiHost;
  }

  private currentKimiHostRetirement(): KimiHostRetirement | null {
    return this.kimiHostRetirement;
  }

  private async getOrCreateKimiHost(sessionId: string): Promise<KimiRuntimeHost | null> {
    if (!this.cfg.kimiProxyEntry) {
      throw new Error('kimi executor requested but kimiProxyEntry is not configured');
    }
    if (!this.cfg.runtimeManager) {
      throw new Error('kimi executor requested but CliRuntimeManager is not configured');
    }
    while (true) {
      if (this.disposingBySession.has(sessionId)) {
        if (this.kimiHostRetirement) await this.retryKimiHostRetirement();
        return null;
      }
      // Preserve a synchronous fast path when no host is retiring. Awaiting an
      // already-resolved helper here would open a microtask window in which a
      // failed-attach dispose can detach the old host after this check.
      if (this.kimiHostRetirement) {
        await this.retryKimiHostRetirement();
        continue;
      }
      if (this.kimiHost) return this.kimiHost;

      let pending = this.kimiHostInit;
      if (!pending) {
        pending = this.startKimiHost();
        this.kimiHostInit = pending;
      }
      try {
        const host = await pending;
        if (this.disposingBySession.has(sessionId)) {
          if (this.currentKimiHost() === host && !host.hasSessions()) {
            this.detachKimiHostForRetirement(host);
            this.beginKimiHostRetirement(host);
          }
          if (this.currentKimiHostRetirement()?.host === host) {
            await this.retryKimiHostRetirement(host);
          }
          return null;
        }
        // A waiter can resume after another session synchronously detached
        // this just-started host. Re-enter the barrier instead of publishing a
        // facade for the retiring identity.
        if (this.currentKimiHostRetirement() || this.currentKimiHost() !== host) continue;
        return host;
      } finally {
        if (this.kimiHostInit === pending) this.kimiHostInit = null;
      }
    }
  }

  private async startKimiHost(): Promise<KimiRuntimeHost> {
    const lease = await this.cfg.runtimeManager!.acquire('kimi');
    let runtimeOwner: object = this.trackStartupRuntime('kimi', lease);
    let reservation: RuntimeProcessGroupReservation | undefined;
    let host: KimiRuntimeHost | undefined;
    try {
      reservation = await lease.reserveProcessGroup?.();
      if (reservation) {
        this.setRuntimeProtection(
          runtimeOwner,
          () => reservation!.cancelBeforeSpawn(),
        );
      }
      const protocol = this.cfg.kimiProxyProtocolV1;
      host = protocol
        ? new KimiProtocolV1Host({
            entry: this.cfg.kimiProxyEntry!,
            pluginVersion: protocol.pluginVersion,
            processScope: 'shared',
            dataDir: join(this.cfg.dataDir, 'proxy', 'kimi'),
            hostVersion: this.cfg.hostVersion ?? '0.0.0',
            runtimeBin: lease.binaryPath,
            env: lease.env,
            log: message => console.log(message),
          })
        : new KimiProxyHost({
            entry: this.cfg.kimiProxyEntry!,
            kimiBin: lease.binaryPath,
            env: lease.env,
            log: message => console.log(message),
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
      this.kimiHost = startedHost;
      startedHost.onHostExit(() => {
        if (this.kimiHost === startedHost) {
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

  private dropKimiClientsForHost(host: KimiRuntimeHost): void {
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

  private detachKimiHostForRetirement(host: KimiRuntimeHost): void {
    if (this.kimiHost === host) this.kimiHost = null;
    this.dropKimiClientsForHost(host);
    const current = this.kimiHostRetirement;
    if (!current) {
      this.kimiHostRetirement = { host, promise: null };
    } else if (current.host !== host) {
      throw new Error('Cannot retire two Kimi Proxy hosts concurrently.');
    }
  }

  private beginKimiHostRetirement(host: KimiRuntimeHost): Promise<void> {
    this.detachKimiHostForRetirement(host);
    const record = this.kimiHostRetirement!;
    if (record.promise) return record.promise;
    record.failure = undefined;
    const attempt = this.runtimeByOwner.has(host)
      ? this.releaseRuntimeBinding(host)
      : host.shutdown();
    record.promise = attempt;
    void attempt.then(
      () => {
        if (this.kimiHostRetirement === record) this.kimiHostRetirement = null;
        for (const [sessionId, retiringHost] of this.retiringKimiHostBySession) {
          if (retiringHost === host) this.retiringKimiHostBySession.delete(sessionId);
        }
      },
      error => {
        if (this.kimiHostRetirement === record) {
          record.promise = null;
          record.failure = { error, reported: false };
        }
      },
    );
    return attempt;
  }

  private async retryKimiHostRetirement(expectedHost?: KimiRuntimeHost): Promise<void> {
    const record = this.kimiHostRetirement;
    if (!record) return;
    if (expectedHost && record.host !== expectedHost) {
      throw new Error('A different Kimi Proxy host is already retiring.');
    }
    await this.beginKimiHostRetirement(record.host);
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
    if (client instanceof CodexProxySessionClient) {
      const host = client.runtimeHost();
      if (this.codexHost === host) {
        this.codexHost = null;
        this.dropExecutorClients('codex');
      }
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
    else await client.shutdown();
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
