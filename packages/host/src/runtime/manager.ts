import type { Executor } from '@gian/shared';
import {
  acquireAgentRuntimeUseLock,
  type AgentUpdateLease,
} from '../agents/update-lock.js';
import type {
  CliRuntimeProvider,
  RuntimeLease,
  RuntimeProbe,
} from './types.js';

interface ActiveRuntime {
  key: RuntimeKey;
  probe: RuntimeProbe;
  snapshot?: string;
  env: Readonly<Record<string, string>>;
  leases: number;
  generation: number;
  claim: AgentUpdateLease;
  retired: boolean;
  retirement?: Promise<void>;
  retirementComplete: boolean;
  retirementFailure?: unknown;
}

interface FailedResolutionClaim {
  key: RuntimeKey;
  cli: Executor;
  claim: AgentUpdateLease;
  retirement?: Promise<void>;
  failure: unknown;
}

/** Runtimes are keyed by (kind, resolved CLI path): two Agents sharing one
 *  Proxy kind but pointing at different CLI binaries get independent
 *  runtimes; Agents resolving to the same path share one process lease. A
 *  null path means the provider's environment/PATH/official scan. */
export type RuntimeKey = string;

export function runtimeKey(cli: Executor, overridePath?: string | null): RuntimeKey {
  return JSON.stringify([cli, overridePath ?? null]);
}

function keyCli(key: RuntimeKey): Executor {
  return (JSON.parse(key) as [Executor, string | null])[0];
}

export class CliRuntimeManager {
  private readonly providers = new Map<Executor, CliRuntimeProvider>();
  private readonly active = new Map<RuntimeKey, ActiveRuntime>();
  private readonly resolving = new Map<RuntimeKey, {
    generation: number;
    promise: Promise<ActiveRuntime>;
  }>();
  private readonly generations = new Map<RuntimeKey, number>();
  /** Strongly owns every exact runtime whose shared claim is retiring. A
   * failed claim release stays here until acquire() or drain() retries it. */
  private readonly retirementsByKey = new Map<RuntimeKey, Set<ActiveRuntime>>();
  private readonly failedResolutionClaimsByKey = new Map<
    RuntimeKey,
    Set<FailedResolutionClaim>
  >();

  constructor(
    providers: CliRuntimeProvider[],
    private readonly updateLockDataDir: string,
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new Error(`duplicate CLI runtime provider: ${provider.id}`);
      }
      this.providers.set(provider.id, provider);
    }
  }

  private keysFor(cli: Executor, overridePath?: string | null): RuntimeKey[] {
    if (overridePath !== undefined) return [runtimeKey(cli, overridePath)];
    const keys = new Set<RuntimeKey>();
    for (const key of [
      ...this.active.keys(),
      ...this.resolving.keys(),
      ...this.generations.keys(),
      ...this.retirementsByKey.keys(),
      ...this.failedResolutionClaimsByKey.keys(),
    ]) {
      if (keyCli(key) === cli) keys.add(key);
    }
    return [...keys];
  }

  /** Acquire a lease on the runtime for (cli, overridePath). The path is the
   *  owning Agent's resolved CLI path; omit it for the provider default. */
  async acquire(cli: Executor, overridePath?: string | null): Promise<RuntimeLease> {
    const key = runtimeKey(cli, overridePath);
    while (true) {
      const retirement = this.retryRetirements(key);
      if (retirement) {
        await retirement;
        // Another exact runtime can enter retirement during the await. Recheck
        // the strong registries without opening a resolve/publication window.
        continue;
      }
      const generation = this.generations.get(key) ?? 0;
      let active = this.active.get(key);
      if (active?.generation !== generation || active?.retired) active = undefined;
      if (!active) {
        let pending = this.resolving.get(key);
        if (pending?.generation !== generation) {
          const promise = this.resolve(cli, overridePath ?? undefined, generation, key);
          pending = { generation, promise };
          this.resolving.set(key, pending);
        }
        try {
          active = await pending.promise;
        } finally {
          if (this.resolving.get(key)?.promise === pending.promise) this.resolving.delete(key);
        }
      }

      // A sibling acquire can obtain and release the just-resolved runtime
      // before this continuation runs. Never resurrect a generation after its
      // shared cross-process claim has started retiring.
      if (active.retired) continue;
      if ((this.generations.get(key) ?? 0) !== generation) {
        if (active.leases === 0) await this.retire(active);
        continue;
      }
      active.leases += 1;
      return this.makeLease(active);
    }
  }

  private async resolve(
    cli: Executor,
    overridePath: string | undefined,
    generation: number,
    key: RuntimeKey,
  ): Promise<ActiveRuntime> {
    const provider = this.providers.get(cli);
    if (!provider) {
      throw new Error(`CLI runtime provider is not configured: ${cli}`);
    }
    const claim = await acquireAgentRuntimeUseLock(
      this.updateLockDataDir,
      cli,
      `${cli} CLI runtime use`,
    );
    try {
      const installed = await provider.inspectInstalled(overridePath);
      if (installed.length === 0) {
        throw Object.assign(
          new Error(`${cli} CLI is not installed. Install it with the official installer, then retry.`),
          { code: 'RUNTIME_NOT_INSTALLED' },
        );
      }

      const failures: string[] = [];
      let dataVersionFailure: unknown;
      let dataVersionFailureCount = 0;
      let resolved: ActiveRuntime | undefined;
      for (const candidate of installed) {
        try {
          const snapshotBeforeProbe = await provider.snapshot?.(candidate);
          const probe = await provider.probe(candidate, claim);
          const snapshot = await provider.snapshot?.(probe);
          if (
            snapshotBeforeProbe !== undefined
            && snapshot !== snapshotBeforeProbe
          ) {
            throw new Error(
              `${cli} CLI runtime content changed while its version was being probed`,
            );
          }
          await provider.activate?.(probe);
          resolved = {
            key,
            probe,
            ...(snapshot ? { snapshot } : {}),
            env: Object.freeze({ ...provider.managedEnv(), ...probe.env }),
            leases: 0,
            generation,
            claim,
            retired: false,
            retirementComplete: false,
          };
          break;
        } catch (error) {
          if (
            error
            && typeof error === 'object'
            && (error as { code?: unknown }).code === 'DATA_VERSION_INCOMPATIBLE'
          ) {
            dataVersionFailure ??= error;
            dataVersionFailureCount += 1;
          }
          failures.push(
            `${candidate.binaryPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // An explicit override is a contract, not a hint. Never silently run a
          // different binary when it is invalid.
          if (candidate.source === 'override') break;
        }
      }

      if (!resolved) {
        if (dataVersionFailure && dataVersionFailureCount === failures.length) {
          throw dataVersionFailure;
        }
        throw Object.assign(
          new Error(`No usable ${cli} CLI runtime found. ${failures.join(' | ')}`),
          { code: 'RUNTIME_PROBE_FAILED' },
        );
      }

      if ((this.generations.get(key) ?? 0) === generation) {
        this.active.set(key, resolved);
      }
      return resolved;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await claim.release();
      } catch (cleanupError) {
        this.trackFailedResolutionClaim(key, cli, claim, cleanupError);
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `${cli} CLI runtime resolution failed and its shared claim could not be retired.`,
        );
      }
      throw error;
    }
  }

  /**
   * Retire the cached selection for every future acquire. Existing leases
   * keep their selected path and shared claim until they release, while later
   * work resolves the next runtime generation immediately. This coordinates
   * Gian-managed installers; it does not make externally mutable path bytes
   * into a content-addressed snapshot.
   *
   * With `overridePath` omitted every runtime of the kind is retired;
   * pass an Agent's previous path to retire exactly one (kind, path) pair.
   */
  invalidate(cli: Executor, overridePath?: string | null): boolean {
    let idle = true;
    for (const key of this.keysFor(cli, overridePath)) {
      const generation = this.generations.get(key) ?? 0;
      this.generations.set(key, generation + 1);
      const wasResolving = this.resolving.get(key)?.generation === generation;
      const active = this.active.get(key);
      this.active.delete(key);
      // Existing leases retain their selection, but the active map is retired
      // immediately so every later acquire resolves the new generation.
      if (active?.leases === 0) {
        void this.retire(active).catch(error => {
          console.error(`[runtime] failed to retire idle ${cli} claim:`, error);
        });
      }
      if (wasResolving || (active && active.leases > 0)) idle = false;
    }
    return idle;
  }

  /** Detect externally mutated launcher/runtime bytes without disturbing a
   * healthy active generation. Snapshot errors (including a removed binary)
   * count as a change so the guardian fails closed and retires its owner. */
  async detectExternalChanges(): Promise<Executor[]> {
    const checks = Array.from(this.active.entries()).map(async ([key, active]) => {
      if (active.retired || !active.snapshot) return null;
      const cli = keyCli(key);
      const provider = this.providers.get(cli);
      if (!provider?.snapshot) return null;
      let changed = false;
      try {
        changed = await provider.snapshot(active.probe) !== active.snapshot;
      } catch {
        changed = true;
      }
      if (!changed || active.retired || this.active.get(key) !== active) return null;
      if ((this.generations.get(key) ?? 0) !== active.generation) return null;
      return cli;
    });
    const changed = await Promise.all(checks);
    return [...new Set(changed.filter((cli): cli is Executor => cli !== null))];
  }

  /** Retire every idle exact runtime of the kind (all paths) and retry any
   * previously failed claim retirement. Install routes use this after Proxy
   * shutdown and before they request the exclusive updater claim. Active
   * leases remain fail-closed and are rejected by the updater lock itself. */
  async drain(cli: Executor): Promise<void> {
    while (true) {
      let progressed = false;
      for (const key of this.keysFor(cli)) {
        const resolving = this.resolving.get(key)?.promise;
        if (resolving) {
          // Resolution failure itself is not the drain target, but resolve()
          // registers any failed claim cleanup before rejecting. Loop so that
          // strong cleanup record is retried instead of returning false success.
          await resolving.catch(() => undefined);
          await Promise.resolve();
          progressed = true;
          continue;
        }
        const active = this.active.get(key);
        if (active && active.leases === 0) {
          await this.retire(active);
          progressed = true;
          continue;
        }
        const retirement = this.retryRetirements(key);
        if (retirement) {
          await retirement;
          progressed = true;
        }
      }
      if (!progressed) return;
    }
  }

  private makeLease(active: ActiveRuntime): RuntimeLease {
    let counted = false;
    let releasePromise: Promise<void> | undefined;
    return {
      ...active.probe,
      env: active.env,
      reserveProcessGroup: () => active.claim.reserveProcessGroup(),
      release: () => {
        if (releasePromise) return releasePromise;
        if (!counted) {
          counted = true;
          active.leases = Math.max(0, active.leases - 1);
        }
        releasePromise = active.leases === 0
          ? this.retire(active)
          : Promise.resolve();
        return releasePromise.finally(() => {
          releasePromise = undefined;
        });
      },
    };
  }

  private retire(active: ActiveRuntime): Promise<void> {
    if (active.retirementComplete) return Promise.resolve();
    const bindingKey = active.key;
    let retirements = this.retirementsByKey.get(bindingKey);
    if (!retirements) {
      retirements = new Set();
      this.retirementsByKey.set(bindingKey, retirements);
    }
    retirements.add(active);
    if (active.retirement) return active.retirement;
    active.retired = true;
    if (this.active.get(bindingKey) === active) {
      this.active.delete(bindingKey);
    }
    active.retirementFailure = undefined;
    const retirement = active.claim.release().then(
      () => {
        active.retirementComplete = true;
        retirements!.delete(active);
        if (
          retirements!.size === 0
          && this.retirementsByKey.get(bindingKey) === retirements
        ) {
          this.retirementsByKey.delete(bindingKey);
        }
      },
      error => {
        active.retirementFailure = error;
        throw error;
      },
    ).finally(() => {
      if (active.retirement === retirement && !active.retirementComplete) {
        active.retirement = undefined;
      }
    });
    active.retirement = retirement;
    return active.retirement;
  }

  private retryRetirements(key: RuntimeKey): Promise<void> | null {
    const retirements = Array.from(this.retirementsByKey.get(key) ?? []);
    const failedResolutions = Array.from(
      this.failedResolutionClaimsByKey.get(key) ?? [],
    );
    if (retirements.length === 0 && failedResolutions.length === 0) return null;
    return Promise.all([
      ...retirements.map(active => this.retire(active)),
      ...failedResolutions.map(failed => this.retireFailedResolutionClaim(failed)),
    ]).then(() => undefined);
  }

  private trackFailedResolutionClaim(
    key: RuntimeKey,
    cli: Executor,
    claim: AgentUpdateLease,
    failure: unknown,
  ): void {
    let failed = this.failedResolutionClaimsByKey.get(key);
    if (!failed) {
      failed = new Set();
      this.failedResolutionClaimsByKey.set(key, failed);
    }
    failed.add({ key, cli, claim, failure });
  }

  private retireFailedResolutionClaim(failed: FailedResolutionClaim): Promise<void> {
    if (failed.retirement) return failed.retirement;
    const retirement = failed.claim.release().then(
      () => {
        const claims = this.failedResolutionClaimsByKey.get(failed.key);
        claims?.delete(failed);
        if (claims?.size === 0) this.failedResolutionClaimsByKey.delete(failed.key);
      },
      error => {
        failed.failure = error;
        throw error;
      },
    ).finally(() => {
      if (failed.retirement === retirement) failed.retirement = undefined;
    });
    failed.retirement = retirement;
    return retirement;
  }
}
