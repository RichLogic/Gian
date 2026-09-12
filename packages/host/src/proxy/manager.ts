import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Executor } from '@gian/shared';
import {
  ProtocolV2Host,
  ProtocolV2SessionClient,
} from './protocol-v2-session-client.js';
import type { ProxyClient } from './types.js';
import type {
  RuntimeLease,
  RuntimeProcessGroupReservation,
} from '../runtime/types.js';
import {
  genericLaunchId,
  officialSessionLaunchId,
  sharedProcessKey,
  validateLaunchBinding,
  type ProxyLaunchBinding,
} from './launch-binding.js';
import type { LegacyLaunchResolution } from './legacy-launch.js';
import { ProxySupervisor } from './supervisor.js';

export type { ProxyProtocolDescriptor } from './launch-binding.js';

type OwnerKey = string;

export class InspectionUnavailableError extends Error {}

export interface InspectionHostOptions {
  agentId?: string;
  cliPath?: string | null;
  proxyVersion?: string | null;
  runtimeProfileId?: string | null;
  configHome?: string | null;
  cliFingerprint?: string | null;
}

export function inspectionProfileIdentity(options: InspectionHostOptions): string | null {
  const { runtimeProfileId, configHome, cliFingerprint } = options;
  if (!runtimeProfileId && !configHome && !cliFingerprint) return null;
  return createHash('sha256').update(
    [runtimeProfileId ?? '', configHome ?? '', cliFingerprint ?? ''].join('\u0000'),
  ).digest('hex').slice(0, 32);
}

interface RuntimeOwnerFacts {
  ownerKey: OwnerKey;
  launchId: string;
  processScope: 'shared' | 'session';
  retireOnFailedAttach: boolean;
}

interface RuntimeBinding {
  executor: OwnerKey;
  lease?: RuntimeLease;
  retiring: boolean;
  releaseEligible: boolean;
  processScope?: 'shared' | 'session';
  retireOnFailedAttach?: boolean;
  launchId?: string;
  ensureProcessTreeExited: () => Promise<void>;
  releaseProtection: () => Promise<void>;
  releasePromise?: Promise<void>;
  releaseFailure?: { error: unknown; reported: boolean };
}

interface SessionDisposal {
  executor?: OwnerKey;
  promise: Promise<void> | null;
  failure?: { error: unknown; reported: boolean };
}

interface SessionLaunchClaim {
  ownerKey: OwnerKey;
  launchId: string;
}

interface PreparedLaunch {
  binding: ProxyLaunchBinding;
  acquireLease: () => Promise<RuntimeLease | null>;
  fallbackRuntimeBin?: string;
  validateHandshake: boolean;
  launchId: string;
  offeredProtocolVersions?: readonly string[];
  retireOnFailedAttach?: boolean;
  executor?: Executor;
}

interface PreparedInspectionLaunch {
  binding: ProxyLaunchBinding;
  acquireLease: () => Promise<RuntimeLease | null>;
  releaseUnusedLease: () => Promise<void>;
}

interface InspectionBorrowRecord {
  count: number;
  idleTimer?: NodeJS.Timeout;
}

export interface ProxyManagerConfig {
  /** Root data dir; per-session proxy state lives under {root}/proxy/{sessionId}. */
  dataDir: string;
  /** Gian Host version sent during protocol negotiation. */
  hostVersion?: string;
  /** Bounded adapter for Sessions that predate proxy_binding_json. New and
   * exact Sessions never enter this path. */
  resolveLegacyLaunch?: (
    executor: Executor,
    options: { cliPath: string | null; proxyVersion: string | null },
  ) => Promise<LegacyLaunchResolution>;
  resolveInspectionLaunch?: (
    pluginId: string,
    options: InspectionHostOptions,
  ) => Promise<PreparedInspectionLaunch>;
  inspectionHostIdleTtlMs?: number;
}

/**
 * Owns proxy client lifecycles. Official getOrCreate is a one-way adapter
 * into the generic launch contract. Unknown reverse-domain plugins use
 * acquireWithBinding and never need a Host Provider registration.
 */
export class ProxyManager {
  private clients = new Map<string, ProxyClient>();
  private executorBySession = new Map<string, OwnerKey>();
  private runtimeByOwner = new Map<object, RuntimeBinding>();
  private pendingRuntimeReleasesByExecutor = new Map<OwnerKey, Set<Promise<void>>>();
  private creatingBySession = new Map<
    string,
    { executor: OwnerKey; launchId: string; promise: Promise<ProxyClient | null> }
  >();
  private disposingBySession = new Map<string, SessionDisposal>();
  private readonly supervisor = new ProxySupervisor();
  private readonly sharedHostIdentities = new WeakSet<ProtocolV2Host>();
  private readonly retireOnFailedAttachHosts = new WeakSet<ProtocolV2Host>();
  private readonly retiringHostBySession = new Map<string, ProtocolV2Host>();
  private readonly launchIdBySession = new Map<string, string>();
  private readonly factsByRuntime = new WeakMap<object, RuntimeOwnerFacts>();
  private closeEpochByExecutor = new Map<OwnerKey, number>();
  private closingByExecutor = new Map<OwnerKey, Promise<void>>();
  private creatingByExecutor = new Map<OwnerKey, Set<Promise<ProxyClient | null>>>();
  private runtimeLeaseReleases = new WeakMap<RuntimeLease, Promise<void>>();
  private readonly forkOwningSessionHosts = new WeakSet<ProtocolV2Host>();
  private readonly inspectionBorrowsByExecutor = new Map<
    OwnerKey,
    Map<ProtocolV2Host, InspectionBorrowRecord>
  >();

  constructor(private cfg: ProxyManagerConfig) {}

  async getOrCreate(
    sessionId: string,
    executor: Executor,
    options?: { cliPath?: string | null; proxyVersion?: string | null },
  ): Promise<ProxyClient> {
    const resolveLegacyLaunch = this.cfg.resolveLegacyLaunch;
    if (!resolveLegacyLaunch) {
      throw new Error('Legacy unbound Proxy launch is unavailable.');
    }
    const claim: SessionLaunchClaim = {
      ownerKey: executor,
      launchId: officialSessionLaunchId({
        executor,
        cliPath: options?.cliPath ?? null,
        proxyVersion: options?.proxyVersion ?? null,
      }),
    };
    return this.acquire(sessionId, claim, async () => ({
      ...(await resolveLegacyLaunch(executor, {
        cliPath: options?.cliPath ?? null,
        proxyVersion: options?.proxyVersion ?? null,
      })),
      validateHandshake: false,
      launchId: claim.launchId,
    }));
  }

  /** Generic supervisor entry: exact binding in, no Provider registry. */
  async acquireWithBinding(
    sessionId: string,
    binding: ProxyLaunchBinding,
    options?: { acquireLease?: () => Promise<RuntimeLease | null> },
  ): Promise<ProxyClient> {
    const validated = validateLaunchBinding(binding);
    const claim: SessionLaunchClaim = {
      ownerKey: validated.pluginId,
      launchId: genericLaunchId(validated),
    };
    return this.acquire(sessionId, claim, async () => ({
      binding: validated,
      acquireLease: options?.acquireLease ?? (async () => null),
      validateHandshake: true,
      launchId: claim.launchId,
    }));
  }

  async acquireInspectionHost(
    pluginId: string,
    options: InspectionHostOptions = {},
  ): Promise<{ host: ProtocolV2Host; shared: boolean; release: () => Promise<void> }> {
    const resolver = this.cfg.resolveInspectionLaunch;
    if (!resolver) {
      throw new InspectionUnavailableError('Exact Proxy inspection launch is unavailable.');
    }
    let prepared: PreparedInspectionLaunch;
    let binding: ProxyLaunchBinding;
    try {
      prepared = await resolver(pluginId, options);
      const validated = validateLaunchBinding(prepared.binding);
      if (validated.pluginId !== pluginId) {
        throw new Error('Inspection launch resolved a different pluginId.');
      }
      if (options.proxyVersion && validated.pluginVersion !== options.proxyVersion) {
        throw new Error('Inspection launch resolved a different Proxy version.');
      }
      const inspectionIdentity = inspectionProfileIdentity(options);
      binding = inspectionIdentity
        ? {
            ...validated,
            runtimeProfile: {
              identity: createHash('sha256').update(JSON.stringify({
                launchRuntime: validated.runtimeProfile?.identity ?? null,
                inspectionIdentity,
              })).digest('hex'),
            },
          }
        : validated;
    } catch (error) {
      throw new InspectionUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }

    const inspectionId = `__inspect__${randomUUID()}`;
    let client: ProxyClient;
    try {
      const validated = validateLaunchBinding(binding);
      const claim: SessionLaunchClaim = {
        ownerKey: validated.pluginId,
        launchId: genericLaunchId(validated),
      };
      client = await this.acquire(inspectionId, claim, async () => ({
        binding: validated,
        acquireLease: prepared.acquireLease,
        validateHandshake: false,
        launchId: claim.launchId,
      }));
      await prepared.releaseUnusedLease();
    } catch (error) {
      await prepared.releaseUnusedLease().catch(() => undefined);
      throw error;
    }
    if (!(client instanceof ProtocolV2SessionClient)) {
      await this.dispose(inspectionId).catch(() => undefined);
      throw new InspectionUnavailableError('Inspection requires a gian.proxy/2 host.');
    }
    const host = client.runtimeHost();
    if (binding.processScope === 'session') {
      let released = false;
      return {
        host,
        shared: false,
        release: async () => {
          if (released) return;
          released = true;
          await this.dispose(inspectionId);
        },
      };
    }

    const ownerKey = binding.pluginId;
    let borrows = this.inspectionBorrowsByExecutor.get(ownerKey);
    if (!borrows) {
      borrows = new Map();
      this.inspectionBorrowsByExecutor.set(ownerKey, borrows);
    }
    let record = borrows.get(host);
    if (!record) {
      record = { count: 0 };
      borrows.set(host, record);
    }
    record.count += 1;
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }
    let released = false;
    return {
      host,
      shared: true,
      release: async () => {
        if (released) return;
        released = true;
        await this.dispose(inspectionId);
        this.releaseInspectionBorrow(ownerKey, host, record!);
      },
    };
  }

  private releaseInspectionBorrow(
    ownerKey: OwnerKey,
    host: ProtocolV2Host,
    record: InspectionBorrowRecord,
  ): void {
    const current = this.inspectionBorrowsByExecutor.get(ownerKey)?.get(host);
    if (current !== record) return;
    record.count = Math.max(0, record.count - 1);
    if (record.count > 0) return;
    const ttlMs = Math.max(1, this.cfg.inspectionHostIdleTtlMs ?? 30_000);
    record.idleTimer = setTimeout(() => {
      void this.releaseIdleInspectionHost(ownerKey, host, record).catch(error => {
        console.error(`[proxy] failed to release idle ${ownerKey} inspection host:`, error);
      });
    }, ttlMs);
    record.idleTimer.unref?.();
  }

  private async releaseIdleInspectionHost(
    ownerKey: OwnerKey,
    host: ProtocolV2Host,
    record: InspectionBorrowRecord,
  ): Promise<void> {
    const borrows = this.inspectionBorrowsByExecutor.get(ownerKey);
    if (borrows?.get(host) !== record || record.count > 0) return;
    borrows.delete(host);
    if (borrows.size === 0) this.inspectionBorrowsByExecutor.delete(ownerKey);
    if (
      host.hasSessions()
      || this.hostHasRegisteredFacade(host)
      || !this.supervisor.hasShared(host)
      || this.supervisor.isRetiring(host)
    ) return;
    this.supervisor.deleteHost(host);
    if (this.runtimeByOwner.has(host)) await this.releaseRuntimeBinding(host);
    else await host.shutdown();
  }

  private async acquire(
    sessionId: string,
    claim: SessionLaunchClaim,
    prepare: () => Promise<PreparedLaunch>,
  ): Promise<ProxyClient> {
    const { ownerKey, launchId } = claim;
    while (true) {
      const closing = this.closingByExecutor.get(ownerKey);
      if (closing) {
        await closing;
        continue;
      }
      const runtimeCleanup = this.runtimeCleanupBarrier(ownerKey);
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
        this.assertCompatibleLaunch(sessionId, claim, this.launchIdBySession.get(sessionId));
        if (this.isPublishableClient(sessionId, ownerKey, existing)) return existing;
        if (!existing.isExited()) {
          this.forgetSession(sessionId, existing);
          continue;
        }
        await this.cleanupExitedClientBeforePublish(existing);
        this.forgetSession(sessionId, existing);
        continue;
      }

      const creating = this.creatingBySession.get(sessionId);
      if (creating) {
        this.assertCompatibleLaunch(sessionId, claim, creating.launchId);
        const client = await creating.promise;
        if (client && this.isPublishableClient(sessionId, ownerKey, client)) {
          return client;
        }
        continue;
      }

      const closeEpoch = this.closeEpochByExecutor.get(ownerKey) ?? 0;
      const attempt = this.createClientAttempt(sessionId, claim, closeEpoch, prepare);
      this.creatingBySession.set(sessionId, {
        executor: ownerKey,
        launchId,
        promise: attempt,
      });
      let attempts = this.creatingByExecutor.get(ownerKey);
      if (!attempts) {
        attempts = new Set();
        this.creatingByExecutor.set(ownerKey, attempts);
      }
      attempts.add(attempt);
      try {
        const client = await attempt;
        if (client && this.isPublishableClient(sessionId, ownerKey, client)) {
          return client;
        }
      } finally {
        if (this.creatingBySession.get(sessionId)?.promise === attempt) {
          this.creatingBySession.delete(sessionId);
        }
        attempts.delete(attempt);
        if (attempts.size === 0 && this.creatingByExecutor.get(ownerKey) === attempts) {
          this.creatingByExecutor.delete(ownerKey);
        }
      }
    }
  }

  private assertCompatibleLaunch(
    sessionId: string,
    claim: SessionLaunchClaim,
    existingLaunchId: string | undefined,
  ): void {
    if (existingLaunchId !== undefined && existingLaunchId !== claim.launchId) {
      throw new Error(
        `Proxy session ${sessionId} is already bound to a different exact launch.`,
      );
    }
    const existingOwner = this.executorBySession.get(sessionId)
      ?? this.creatingBySession.get(sessionId)?.executor;
    if (existingOwner !== undefined && existingOwner !== claim.ownerKey) {
      throw new Error(
        `Proxy session ${sessionId} already belongs to ${existingOwner}, not ${claim.ownerKey}.`,
      );
    }
  }

  private rememberSession(
    sessionId: string,
    ownerKey: OwnerKey,
    launchId: string,
    client: ProxyClient,
  ): void {
    this.clients.set(sessionId, client);
    this.executorBySession.set(sessionId, ownerKey);
    this.launchIdBySession.set(sessionId, launchId);
  }

  private forgetSession(sessionId: string, expected?: ProxyClient): void {
    if (expected && this.clients.get(sessionId) !== expected) return;
    this.clients.delete(sessionId);
    this.executorBySession.delete(sessionId);
    this.launchIdBySession.delete(sessionId);
  }

  private factsFor(owner: object): RuntimeOwnerFacts | undefined {
    return this.factsByRuntime.get(owner)
      ?? (owner instanceof ProtocolV2SessionClient
        ? this.factsByRuntime.get(owner.runtimeHost())
        : undefined);
  }

  private stampFacts(owner: object, facts: RuntimeOwnerFacts): void {
    this.factsByRuntime.set(owner, facts);
    const binding = this.runtimeByOwner.get(owner);
    if (binding) {
      binding.processScope = facts.processScope;
      binding.retireOnFailedAttach = facts.retireOnFailedAttach;
      binding.launchId = facts.launchId;
    }
  }

  private async createClientAttempt(
    sessionId: string,
    claim: SessionLaunchClaim,
    closeEpoch: number,
    prepare: () => Promise<PreparedLaunch>,
  ): Promise<ProxyClient | null> {
    const { ownerKey } = claim;
    const launch = await prepare();
    const facts: RuntimeOwnerFacts = {
      ownerKey,
      launchId: launch.launchId,
      processScope: launch.binding.processScope,
      retireOnFailedAttach: launch.retireOnFailedAttach === true,
    };
    const client = await this.spawnFromBinding(sessionId, ownerKey, launch, facts);
    if (!client) return null;

    if (
      (this.closeEpochByExecutor.get(ownerKey) ?? 0) !== closeEpoch
      || this.closingByExecutor.has(ownerKey)
    ) {
      if (launch.binding.processScope === 'session') {
        if (this.runtimeByOwner.has(client)) await this.releaseRuntimeBinding(client);
        else await client.shutdown();
      }
      return null;
    }

    if (client.isExited()) {
      await this.cleanupExitedClientBeforePublish(client);
      return null;
    }

    if (!this.isCurrentSharedClient(client)) return null;

    this.rememberSession(sessionId, ownerKey, launch.launchId, client);
    client.onExit(code => {
      if (this.clients.get(sessionId) !== client) return;
      console.log(`[proxy] session=${sessionId} exited code=${code}`);
      this.forgetSession(sessionId, client);
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
    const ownerKey = client instanceof ProtocolV2SessionClient
      ? (this.supervisor.ownerOf(client.runtimeHost()) ?? String(client.pluginId))
      : String(client.executor ?? client.pluginId ?? 'unknown');
    const facts = this.factsFor(client);
    this.rememberSession(sessionId, ownerKey, facts?.launchId ?? `adopted:${sessionId}`, client);
    if (
      client instanceof ProtocolV2SessionClient
      && !this.sharedHostIdentities.has(client.runtimeHost())
    ) {
      this.promoteForkOwningSessionHost(client.runtimeHost());
    }
    client.onExit((code) => {
      if (this.clients.get(sessionId) !== client) return;
      console.log(`[proxy] session=${sessionId} exited code=${code}`);
      this.forgetSession(sessionId, client);
    });
  }

  private promoteForkOwningSessionHost(host: ProtocolV2Host): void {
    if (this.forkOwningSessionHosts.has(host)) return;
    for (const [owner, binding] of this.runtimeByOwner) {
      if (!(owner instanceof ProtocolV2SessionClient) || owner.runtimeHost() !== host) continue;
      this.runtimeByOwner.set(host, binding);
      this.runtimeByOwner.delete(owner);
      const facts = this.factsFor(owner) ?? this.factsFor(host);
      if (facts) this.stampFacts(host, facts);
      this.forkOwningSessionHosts.add(host);
      host.onHostExit(() => {
        this.dropClientsForHost(host);
        this.markRuntimeBindingReleaseEligible(host);
        void this.releaseRuntimeBinding(host).catch(error => {
          console.error(`[proxy] failed to release fork-owning ${host.pluginId} runtime:`, error);
        });
      });
      return;
    }
    throw new Error('Fork child runtime ownership could not be promoted to its Protocol host.');
  }

  /** Drop an adopted facade without disposing the parent Proxy process. */
  forgetAdopted(sessionId: string): void {
    this.forgetSession(sessionId);
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
    if (this.sharedHostIdentities.has(host)) {
      return this.supervisor.hasShared(host) && !this.supervisor.isRetiring(host);
    }
    return !this.supervisor.isRetiring(host);
  }

  private isPublishableClient(
    sessionId: string,
    executor: OwnerKey,
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

  async forceDispose(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) return;
    const executor = this.executorBySession.get(sessionId);
    const launchId = this.launchIdBySession.get(sessionId);
    this.forgetSession(sessionId);
    try {
      await client.forceKill();
    } catch (error) {
      if (!this.clients.has(sessionId) && executor && launchId) {
        this.rememberSession(sessionId, executor, launchId, client);
      }
      throw error;
    }
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

  async dispose(sessionId: string): Promise<void> {
    let record = this.disposingBySession.get(sessionId);
    if (record?.promise) return record.promise;
    if (!record) {
      record = {
        executor: this.executorBySession.get(sessionId)
          ?? this.creatingBySession.get(sessionId)?.executor
          ?? (this.retiringHostBySession.has(sessionId)
            ? this.supervisor.ownerOf(this.retiringHostBySession.get(sessionId)!)
            : undefined),
        promise: null,
      };
      this.disposingBySession.set(sessionId, record);
    }
    record.failure = undefined;

    const immediateClient = this.clients.get(sessionId);
    let failedAttachHost: ProtocolV2Host | undefined;
    if (
      immediateClient instanceof ProtocolV2SessionClient
      && this.retireOnFailedAttachHosts.has(immediateClient.runtimeHost())
      && !immediateClient.hasAttachedSession()
    ) {
      failedAttachHost = immediateClient.runtimeHost();
      if (!failedAttachHost.hasSessions()) {
        this.detachHostForRetirement(failedAttachHost);
        this.beginHostRetirement(failedAttachHost);
      }
    }

    const attempt = this.performDispose(sessionId, record, failedAttachHost);
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
    failedAttachHost?: ProtocolV2Host,
  ): Promise<void> {
    const creating = this.creatingBySession.get(sessionId);
    if (creating) {
      record.executor ??= creating.executor;
      await creating.promise;
    }

    const client = this.clients.get(sessionId);
    if (!client) {
      const retiring = failedAttachHost ?? this.retiringHostBySession.get(sessionId);
      if (retiring) {
        await this.retryHostRetirement(retiring);
      } else if (record.executor && this.supervisor.hasRetirementsFor(record.executor)) {
        await this.retryHostRetirement(undefined, record.executor);
      }
      return;
    }
    const executor = this.executorBySession.get(sessionId)
      ?? (client instanceof ProtocolV2SessionClient
        ? String(client.pluginId)
        : String(client.executor ?? client.pluginId ?? 'unknown'));
    record.executor = executor;
    let retiringHost = failedAttachHost;
    if (
      !retiringHost
      && client instanceof ProtocolV2SessionClient
      && this.retireOnFailedAttachHosts.has(client.runtimeHost())
      && !client.hasAttachedSession()
    ) {
      retiringHost = client.runtimeHost();
      if (!retiringHost.hasSessions()) {
        this.detachHostForRetirement(retiringHost);
        this.beginHostRetirement(retiringHost);
      }
    }

    const facts = this.factsFor(client);
    if (facts?.processScope === 'session') {
      if (this.runtimeByOwner.has(client)) await this.releaseRuntimeBinding(client);
      else {
        await client.shutdown();
        await this.releaseForkHostIfEmpty(client);
      }
    } else {
      await client.shutdown();
    }

    this.forgetSession(sessionId, client);

    if (retiringHost && !retiringHost.hasSessions()) {
      await this.retryHostRetirement(retiringHost);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.closingByExecutor.values());
    const owners = new Set<string>();
    for (const owner of this.executorBySession.values()) owners.add(owner);
    for (const owner of this.creatingByExecutor.keys()) owners.add(owner);
    for (const owner of this.pendingRuntimeReleasesByExecutor.keys()) owners.add(owner);
    for (const owner of this.inspectionBorrowsByExecutor.keys()) owners.add(owner);
    for (const binding of this.runtimeByOwner.values()) owners.add(binding.executor);
    for (const record of this.disposingBySession.values()) {
      if (record.executor) owners.add(record.executor);
    }
    for (const host of this.supervisor.listShared()) {
      const owner = this.supervisor.ownerOf(host);
      if (owner) owners.add(owner);
    }
    for (const host of this.supervisor.retirementHosts()) {
      const owner = this.supervisor.ownerOf(host);
      if (owner) owners.add(owner);
    }
    const results = await Promise.allSettled(
      [...owners].map(owner => this.closeByOwnerKey(owner)),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Proxy runtimes could not be closed.');
    }
  }

  async closeByExecutor(executor: Executor | string): Promise<void> {
    return this.closeByOwnerKey(executor as OwnerKey);
  }

  private async closeByOwnerKey(ownerKey: OwnerKey): Promise<void> {
    const previous = this.closingByExecutor.get(ownerKey);
    this.closeEpochByExecutor.set(
      ownerKey,
      (this.closeEpochByExecutor.get(ownerKey) ?? 0) + 1,
    );
    const closing = (async () => {
      if (previous) await previous;
      await this.performCloseByOwner(ownerKey);
    })();
    this.closingByExecutor.set(ownerKey, closing);
    try {
      await closing;
    } finally {
      if (this.closingByExecutor.get(ownerKey) === closing) {
        this.closingByExecutor.delete(ownerKey);
      }
    }
  }

  private async performCloseByOwner(ownerKey: OwnerKey): Promise<void> {
    const inspectionBorrows = this.inspectionBorrowsByExecutor.get(ownerKey);
    if (inspectionBorrows) {
      for (const record of inspectionBorrows.values()) {
        if (record.idleTimer) clearTimeout(record.idleTimer);
      }
      inspectionBorrows.clear();
      this.inspectionBorrowsByExecutor.delete(ownerKey);
    }
    const creating = Array.from(this.creatingByExecutor.get(ownerKey) ?? []);
    const failures: unknown[] = [];
    const retryableSessionDisposals = new Set(
      Array.from(this.disposingBySession.entries())
        .filter(([, record]) => (
          record.executor === ownerKey && record.promise === null && record.failure
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
      if (exec === ownerKey) {
        const client = this.clients.get(sid);
        if (client) toClose.push({ sessionId: sid, client });
      }
    }

    const cleanupAttempts: Array<{ owner?: object; promise: Promise<void> }> = [];
    const sessionClients: Array<{ sessionId: string; client: ProxyClient }> = [];
    const sharedHosts = new Set<ProtocolV2Host>([
      ...this.supervisor.hostsForOwner(ownerKey),
      ...this.supervisor.retirementHosts(ownerKey),
    ]);
    for (const current of toClose) {
      const facts = this.factsFor(current.client);
      if (facts?.processScope === 'session') {
        sessionClients.push(current);
        continue;
      }
      if (current.client instanceof ProtocolV2SessionClient) {
        sharedHosts.add(current.client.runtimeHost());
      } else if (this.runtimeByOwner.has(current.client)) {
        sessionClients.push(current);
      }
    }

    for (const current of sessionClients) {
      this.forgetSession(current.sessionId, current.client);
      cleanupAttempts.push({
        owner: current.client,
        promise: this.runtimeByOwner.has(current.client)
          ? this.releaseRuntimeBinding(current.client)
          : current.client.shutdown(),
      });
    }

    const pendings = this.supervisor.pendingInitsFor(ownerKey);
    if (pendings.length > 0) await Promise.allSettled(pendings);
    for (const host of sharedHosts) {
      const facts = this.factsFor(host);
      const retire = facts?.retireOnFailedAttach === true
        || this.retireOnFailedAttachHosts.has(host);
      if (retire) {
        this.detachHostForRetirement(host);
        cleanupAttempts.push({
          owner: host,
          promise: this.supervisor.isRetiring(host)
            ? this.retryHostRetirement(host)
            : this.beginHostRetirement(host),
        });
        continue;
      }
      this.supervisor.deleteHost(host);
      this.dropClientsForHost(host);
      cleanupAttempts.push({
        owner: host,
        promise: this.runtimeByOwner.has(host)
          ? this.releaseRuntimeBinding(host)
          : host.shutdown(),
      });
    }
    this.dropOwnerClients(ownerKey);

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

    await this.drainSessionDisposals(ownerKey, retryableSessionDisposals, failures);
    await this.awaitPendingRuntimeReleases(ownerKey);
    for (const owner of this.collectUnreportedRuntimeReleaseFailures(ownerKey, failures)) {
      deferredBindings.add(owner);
    }
    await this.drainRuntimeBindings(ownerKey, deferredBindings, failures);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to close ${ownerKey} Proxy runtime safely.`);
    }
  }

  private async spawnFromBinding(
    sessionId: string,
    ownerKey: OwnerKey,
    launch: PreparedLaunch,
    facts: RuntimeOwnerFacts,
  ): Promise<ProxyClient | null> {
    if (launch.binding.processScope === 'session') {
      return this.spawnSessionScoped(sessionId, ownerKey, launch, facts);
    }
    const host = await this.getOrCreateSharedHost(sessionId, ownerKey, launch, facts);
    if (!host) return null;
    const client = host.createSessionClient(sessionId);
    this.stampFacts(client, facts);
    return client;
  }

  private async getOrCreateSharedHost(
    sessionId: string,
    ownerKey: OwnerKey,
    launch: PreparedLaunch,
    facts: RuntimeOwnerFacts,
  ): Promise<ProtocolV2Host | null> {
    const key = sharedProcessKey(launch.binding);
    const retire = facts.retireOnFailedAttach;
    while (true) {
      if (retire) {
        if (this.disposingBySession.has(sessionId)) {
          if (this.supervisor.hasRetirementsFor(ownerKey)) {
            await this.retryHostRetirement(undefined, ownerKey);
          }
          return null;
        }
        if (this.supervisor.hasRetirementsFor(ownerKey)) {
          await this.retryHostRetirement(undefined, ownerKey);
          continue;
        }
      }
      const current = this.supervisor.getShared(key);
      if (current) return current;

      const host = await this.supervisor.getOrStart(
        key,
        ownerKey,
        () => this.startSharedHost(key, ownerKey, launch, facts),
      );
      if (retire && this.disposingBySession.has(sessionId)) {
        if (this.supervisor.getShared(key) === host && !host.hasSessions()) {
          this.detachHostForRetirement(host);
          this.beginHostRetirement(host);
        }
        if (this.supervisor.isRetiring(host)) {
          await this.retryHostRetirement(host);
        }
        return null;
      }
      if (retire && (this.supervisor.hasRetirementsFor(ownerKey) || this.supervisor.getShared(key) !== host)) {
        continue;
      }
      return host;
    }
  }

  private async startSharedHost(
    key: string,
    ownerKey: OwnerKey,
    launch: PreparedLaunch,
    facts: RuntimeOwnerFacts,
  ): Promise<ProtocolV2Host> {
    const lease = await launch.acquireLease();
    let runtimeOwner: object | undefined = lease
      ? this.trackStartupRuntime(ownerKey, lease)
      : undefined;
    let reservation: RuntimeProcessGroupReservation | undefined;
    let host: ProtocolV2Host | undefined;
    try {
      reservation = await lease?.reserveProcessGroup?.();
      if (runtimeOwner && reservation) {
        this.setRuntimeProtection(runtimeOwner, () => reservation!.cancelBeforeSpawn());
      }
      const dataDir = this.hostDataDir(String(launch.binding.pluginId), key);
      mkdirSync(dataDir, { recursive: true });
      host = this.createProtocolHost(launch, {
        dataDir,
        runtimeBin: lease?.binaryPath ?? launch.fallbackRuntimeBin,
        env: lease?.env,
      });
      this.sharedHostIdentities.add(host);
      if (facts.retireOnFailedAttach) this.retireOnFailedAttachHosts.add(host);
      if (runtimeOwner) {
        this.promoteStartupRuntime(runtimeOwner, host, () => host!.shutdown());
        runtimeOwner = host;
      } else {
        this.trackSpawnedRuntime(ownerKey, host, () => host!.shutdown());
        runtimeOwner = host;
      }
      this.stampFacts(host, facts);
      if (reservation) {
        if (!runtimeOwner) throw new Error('Shared runtime reservation lost its lease owner.');
        this.setRuntimeProtection(runtimeOwner, async () => {
          throw new Error(
            'Proxy spawned without a verifiable process group; retaining its pending reservation.',
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
          throw new Error('Proxy exited before its process group could be registered.');
        }
        this.setRuntimeProtection(runtimeOwner, () => reservation!.release());
      }
      if (launch.validateHandshake) {
        await host.initialize();
        await host.catalog();
      }
      const startedHost = host;
      this.supervisor.setShared(key, startedHost, ownerKey);
      startedHost.onHostExit(() => {
        if (this.supervisor.getShared(key) === startedHost) {
          if (facts.retireOnFailedAttach) {
            this.detachHostForRetirement(startedHost);
          } else {
            this.supervisor.deleteShared(key, startedHost);
            this.dropClientsForHost(startedHost);
          }
        }
        this.markRuntimeBindingReleaseEligible(startedHost);
        if (facts.retireOnFailedAttach) {
          void this.beginHostRetirement(startedHost).catch(error => {
            console.error(`[proxy] failed to release ${startedHost.pluginId} runtime:`, error);
          });
        } else {
          void this.releaseRuntimeBinding(startedHost).catch(error => {
            console.error(`[proxy] failed to release ${startedHost.pluginId} runtime:`, error);
          });
        }
      });
      return startedHost;
    } catch (error) {
      if (runtimeOwner) {
        await this.cleanupFailedRuntimeStartup(
          runtimeOwner,
          error,
          `${String(launch.binding.pluginId)} runtime startup cleanup failed.`,
        );
      }
      throw error;
    }
  }

  private async spawnSessionScoped(
    sessionId: string,
    ownerKey: OwnerKey,
    launch: PreparedLaunch,
    facts: RuntimeOwnerFacts,
  ): Promise<ProxyClient | null> {
    if (this.disposingBySession.has(sessionId)) return null;
    const dataDir = join(this.cfg.dataDir, 'proxy', sessionId);
    mkdirSync(dataDir, { recursive: true });
    const lease = await launch.acquireLease();
    let runtimeOwner: object | undefined = lease
      ? this.trackStartupRuntime(ownerKey, lease)
      : undefined;
    let reservation: RuntimeProcessGroupReservation | undefined;
    let host: ProtocolV2Host | undefined;
    try {
      reservation = await lease?.reserveProcessGroup?.();
      if (runtimeOwner && reservation) {
        this.setRuntimeProtection(runtimeOwner, () => reservation!.cancelBeforeSpawn());
      }
      host = this.createProtocolHost(launch, {
        dataDir,
        runtimeBin: lease?.binaryPath ?? launch.fallbackRuntimeBin,
        env: lease?.env,
      });
      this.supervisor.rememberOwner(host, ownerKey);
      const client = host.createSessionClient(sessionId);
      if (runtimeOwner) {
        this.promoteStartupRuntime(runtimeOwner, client, () => host!.shutdown());
        runtimeOwner = client;
      } else {
        this.trackSpawnedRuntime(ownerKey, client, () => host!.shutdown());
        runtimeOwner = client;
      }
      this.stampFacts(host, facts);
      this.stampFacts(client, facts);
      if (reservation) {
        if (!runtimeOwner) throw new Error('Session runtime reservation lost its lease owner.');
        this.setRuntimeProtection(runtimeOwner, async () => {
          throw new Error(
            'Proxy spawned without a verifiable process group; retaining its pending reservation.',
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
          throw new Error('Proxy exited before its process group could be registered.');
        }
        this.setRuntimeProtection(runtimeOwner, () => reservation!.release());
      }
      if (launch.validateHandshake) {
        await client.initialize();
        await client.catalog();
      }
      return client;
    } catch (error) {
      if (runtimeOwner) {
        await this.cleanupFailedRuntimeStartup(
          runtimeOwner,
          error,
          `${String(launch.binding.pluginId)} runtime startup cleanup failed.`,
        );
      }
      throw error;
    }
  }

  private createProtocolHost(
    launch: PreparedLaunch,
    options: {
      dataDir: string;
      runtimeBin?: string;
      env?: Readonly<Record<string, string>>;
    },
  ): ProtocolV2Host {
    const binding = launch.binding;
    return new ProtocolV2Host({
      ...(launch.executor ? { executor: launch.executor } : {}),
      pluginId: binding.pluginId,
      pluginVersion: binding.pluginVersion,
      processScope: binding.processScope,
      protocolVersions: launch.offeredProtocolVersions
        ? [...launch.offeredProtocolVersions]
        : [binding.protocolVersion],
      entry: binding.entryPath,
      dataDir: options.dataDir,
      hostVersion: this.cfg.hostVersion ?? '0.1.0',
      ...(options.runtimeBin ? { runtimeBin: options.runtimeBin } : {}),
      ...(options.env ? { env: options.env } : {}),
      log: (message) => console.log(message),
    });
  }

  private dropOwnerClients(ownerKey: OwnerKey): void {
    for (const [sessionId, executor] of [...this.executorBySession]) {
      if (executor !== ownerKey) continue;
      this.forgetSession(sessionId);
    }
  }

  private dropClientsForHost(host: ProtocolV2Host): void {
    for (const [sessionId, client] of this.clients) {
      if (
        client instanceof ProtocolV2SessionClient
        && client.runtimeHost() === host
      ) {
        if (this.retireOnFailedAttachHosts.has(host)) {
          this.retiringHostBySession.set(sessionId, host);
        }
        this.forgetSession(sessionId);
      }
    }
  }

  private hostDataDir(kind: string, key: string): string {
    const suffix = key
      ? `-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
      : '';
    return join(this.cfg.dataDir, 'proxy', `${kind}${suffix}`);
  }

  private trackStartupRuntime(executor: OwnerKey, lease: RuntimeLease): object {
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
    executor: OwnerKey,
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

  private detachHostForRetirement(host: ProtocolV2Host): void {
    this.supervisor.detachForRetirement(host);
    this.dropClientsForHost(host);
  }

  private beginHostRetirement(host: ProtocolV2Host): Promise<void> {
    this.detachHostForRetirement(host);
    const existing = this.supervisor.retirementPromise(host);
    if (existing) return existing;
    const attempt = this.runtimeByOwner.has(host)
      ? this.releaseRuntimeBinding(host)
      : host.shutdown();
    return this.supervisor.beginRetirement(host, attempt, (ok) => {
      if (!ok) return;
      for (const [sessionId, retiringHost] of this.retiringHostBySession) {
        if (retiringHost === host) this.retiringHostBySession.delete(sessionId);
      }
    });
  }

  private async retryHostRetirement(
    expectedHost?: ProtocolV2Host,
    ownerKey?: OwnerKey,
  ): Promise<void> {
    if (expectedHost) {
      await this.beginHostRetirement(expectedHost);
      return;
    }
    await Promise.all(
      this.supervisor.retirementHosts(ownerKey).map(host => this.beginHostRetirement(host)),
    );
  }

  private async drainSessionDisposals(
    executor: OwnerKey,
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

  private runtimeCleanupBarrier(executor: OwnerKey): Promise<void> | null {
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
    if (client instanceof ProtocolV2SessionClient && this.sharedHostIdentities.has(client.runtimeHost())) {
      const host = client.runtimeHost();
      if (this.retireOnFailedAttachHosts.has(host)) {
        this.detachHostForRetirement(host);
        await this.beginHostRetirement(host);
        return;
      }
      this.supervisor.deleteHost(host);
      this.dropClientsForHost(host);
      if (this.runtimeByOwner.has(host)) await this.releaseRuntimeBinding(host);
      else await host.shutdown();
      return;
    }
    if (this.runtimeByOwner.has(client)) await this.releaseRuntimeBinding(client);
    else {
      await client.shutdown();
      await this.releaseForkHostIfEmpty(client);
    }
  }

  private hostHasRegisteredFacade(host: ProtocolV2Host, except?: ProxyClient): boolean {
    for (const client of this.clients.values()) {
      if (client === except) continue;
      if (client instanceof ProtocolV2SessionClient && client.runtimeHost() === host) {
        return true;
      }
    }
    return false;
  }

  private async releaseForkHostIfEmpty(client: ProxyClient): Promise<void> {
    if (!(client instanceof ProtocolV2SessionClient)) return;
    if (this.sharedHostIdentities.has(client.runtimeHost())) return;
    const host = client.runtimeHost();
    if (this.hostHasRegisteredFacade(host, client)) return;
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

  private async awaitPendingRuntimeReleases(executor: OwnerKey): Promise<void> {
    const pending = Array.from(this.pendingRuntimeReleasesByExecutor.get(executor) ?? []);
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  private collectUnreportedRuntimeReleaseFailures(
    executor: OwnerKey,
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
    executor: OwnerKey,
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
