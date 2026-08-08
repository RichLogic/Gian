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
  probe: RuntimeProbe;
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
  cli: Executor;
  claim: AgentUpdateLease;
  retirement?: Promise<void>;
  failure: unknown;
}

export class CliRuntimeManager {
  private readonly providers = new Map<Executor, CliRuntimeProvider>();
  private readonly active = new Map<Executor, ActiveRuntime>();
  private readonly resolving = new Map<Executor, {
    generation: number;
    promise: Promise<ActiveRuntime>;
  }>();
  private readonly generations = new Map<Executor, number>();
  /** Strongly owns every exact runtime whose shared claim is retiring. A
   * failed claim release stays here until acquire() or drain() retries it. */
  private readonly retirementsByExecutor = new Map<Executor, Set<ActiveRuntime>>();
  private readonly failedResolutionClaimsByExecutor = new Map<
    Executor,
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

  async acquire(cli: Executor): Promise<RuntimeLease> {
    while (true) {
      const retirement = this.retryRetirements(cli);
      if (retirement) {
        await retirement;
        // Another exact runtime can enter retirement during the await. Recheck
        // the strong registries without opening a resolve/publication window.
        continue;
      }
      const generation = this.generations.get(cli) ?? 0;
      let active = this.active.get(cli);
      if (active?.generation !== generation || active?.retired) active = undefined;
      if (!active) {
        let pending = this.resolving.get(cli);
        if (pending?.generation !== generation) {
          const promise = this.resolve(cli, generation);
          pending = { generation, promise };
          this.resolving.set(cli, pending);
        }
        try {
          active = await pending.promise;
        } finally {
          if (this.resolving.get(cli)?.promise === pending.promise) this.resolving.delete(cli);
        }
      }

      // A sibling acquire can obtain and release the just-resolved runtime
      // before this continuation runs. Never resurrect a generation after its
      // shared cross-process claim has started retiring.
      if (active.retired) continue;
      if ((this.generations.get(cli) ?? 0) !== generation) {
        if (active.leases === 0) await this.retire(active);
        continue;
      }
      active.leases += 1;
      return this.makeLease(active);
    }
  }

  private async resolve(cli: Executor, generation: number): Promise<ActiveRuntime> {
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
      const installed = await provider.inspectInstalled();
      if (installed.length === 0) {
        throw Object.assign(
          new Error(`${cli} CLI is not installed. Install it with the official installer, then retry.`),
          { code: 'RUNTIME_NOT_INSTALLED' },
        );
      }

      const failures: string[] = [];
      let resolved: ActiveRuntime | undefined;
      for (const candidate of installed) {
        try {
          const probe = await provider.probe(candidate, claim);
          resolved = {
            probe,
            env: Object.freeze({ ...provider.managedEnv(), ...probe.env }),
            leases: 0,
            generation,
            claim,
            retired: false,
            retirementComplete: false,
          };
          break;
        } catch (error) {
          failures.push(
            `${candidate.binaryPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // An explicit override is a contract, not a hint. Never silently run a
          // different binary when it is invalid.
          if (candidate.source === 'override') break;
        }
      }

      if (!resolved) {
        throw Object.assign(
          new Error(`No usable ${cli} CLI runtime found. ${failures.join(' | ')}`),
          { code: 'RUNTIME_PROBE_FAILED' },
        );
      }

      if ((this.generations.get(cli) ?? 0) === generation) {
        this.active.set(cli, resolved);
      }
      return resolved;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await claim.release();
      } catch (cleanupError) {
        this.trackFailedResolutionClaim(cli, claim, cleanupError);
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
   */
  invalidate(cli: Executor): boolean {
    const generation = this.generations.get(cli) ?? 0;
    this.generations.set(cli, generation + 1);
    const wasResolving = this.resolving.get(cli)?.generation === generation;
    const active = this.active.get(cli);
    this.active.delete(cli);
    // Existing leases retain their selection, but the active map is retired
    // immediately so every later acquire resolves the new generation.
    if (active?.leases === 0) {
      void this.retire(active).catch(error => {
        console.error(`[runtime] failed to retire idle ${cli} claim:`, error);
      });
    }
    return !wasResolving && (!active || active.leases === 0);
  }

  /** Retire every idle exact runtime and retry any previously failed claim
   * retirement. Install routes use this after Proxy shutdown and before they
   * request the exclusive updater claim. Active leases remain fail-closed and
   * are rejected by the updater lock itself. */
  async drain(cli: Executor): Promise<void> {
    while (true) {
      const resolving = this.resolving.get(cli)?.promise;
      if (resolving) {
        // Resolution failure itself is not the drain target, but resolve()
        // registers any failed claim cleanup before rejecting. Loop so that
        // strong cleanup record is retried instead of returning false success.
        await resolving.catch(() => undefined);
        await Promise.resolve();
        continue;
      }
      const active = this.active.get(cli);
      if (active && active.leases === 0) {
        await this.retire(active);
        continue;
      }
      const retirement = this.retryRetirements(cli);
      if (retirement) {
        await retirement;
        continue;
      }
      return;
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
    let retirements = this.retirementsByExecutor.get(active.probe.cli);
    if (!retirements) {
      retirements = new Set();
      this.retirementsByExecutor.set(active.probe.cli, retirements);
    }
    retirements.add(active);
    if (active.retirement) return active.retirement;
    active.retired = true;
    if (this.active.get(active.probe.cli) === active) {
      this.active.delete(active.probe.cli);
    }
    active.retirementFailure = undefined;
    const retirement = active.claim.release().then(
      () => {
        active.retirementComplete = true;
        retirements!.delete(active);
        if (
          retirements!.size === 0
          && this.retirementsByExecutor.get(active.probe.cli) === retirements
        ) {
          this.retirementsByExecutor.delete(active.probe.cli);
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

  private retryRetirements(cli: Executor): Promise<void> | null {
    const retirements = Array.from(this.retirementsByExecutor.get(cli) ?? []);
    const failedResolutions = Array.from(
      this.failedResolutionClaimsByExecutor.get(cli) ?? [],
    );
    if (retirements.length === 0 && failedResolutions.length === 0) return null;
    return Promise.all([
      ...retirements.map(active => this.retire(active)),
      ...failedResolutions.map(failed => this.retireFailedResolutionClaim(failed)),
    ]).then(() => undefined);
  }

  private trackFailedResolutionClaim(
    cli: Executor,
    claim: AgentUpdateLease,
    failure: unknown,
  ): void {
    let failed = this.failedResolutionClaimsByExecutor.get(cli);
    if (!failed) {
      failed = new Set();
      this.failedResolutionClaimsByExecutor.set(cli, failed);
    }
    failed.add({ cli, claim, failure });
  }

  private retireFailedResolutionClaim(failed: FailedResolutionClaim): Promise<void> {
    if (failed.retirement) return failed.retirement;
    const retirement = failed.claim.release().then(
      () => {
        const claims = this.failedResolutionClaimsByExecutor.get(failed.cli);
        claims?.delete(failed);
        if (claims?.size === 0) this.failedResolutionClaimsByExecutor.delete(failed.cli);
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
