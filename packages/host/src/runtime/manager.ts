import type { Executor } from '@gian/shared';
import type {
  CliRuntimeProvider,
  RuntimeLease,
  RuntimeProbe,
} from './types.js';

interface ActiveRuntime {
  probe: RuntimeProbe;
  env: Readonly<Record<string, string>>;
  leases: number;
}

export class CliRuntimeManager {
  private readonly providers = new Map<Executor, CliRuntimeProvider>();
  private readonly active = new Map<Executor, ActiveRuntime>();
  private readonly resolving = new Map<Executor, Promise<ActiveRuntime>>();

  constructor(providers: CliRuntimeProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new Error(`duplicate CLI runtime provider: ${provider.id}`);
      }
      this.providers.set(provider.id, provider);
    }
  }

  async acquire(cli: Executor): Promise<RuntimeLease> {
    let active = this.active.get(cli);
    if (!active) {
      let pending = this.resolving.get(cli);
      if (!pending) {
        pending = this.resolve(cli);
        this.resolving.set(cli, pending);
      }
      try {
        active = await pending;
      } finally {
        if (this.resolving.get(cli) === pending) this.resolving.delete(cli);
      }
    }

    active.leases += 1;
    return this.makeLease(active);
  }

  private async resolve(cli: Executor): Promise<ActiveRuntime> {
    const provider = this.providers.get(cli);
    if (!provider) {
      throw new Error(`CLI runtime provider is not configured: ${cli}`);
    }
    const installed = await provider.inspectInstalled();
    if (installed.length === 0) {
      throw Object.assign(
        new Error(`${cli} CLI is not installed. Install it with the official installer, then retry.`),
        { code: 'RUNTIME_NOT_INSTALLED' },
      );
    }

    const failures: string[] = [];
    for (const candidate of installed) {
      try {
        const probe = await provider.probe(candidate);
        const active: ActiveRuntime = {
          probe,
          env: Object.freeze({ ...provider.managedEnv() }),
          leases: 0,
        };
        this.active.set(cli, active);
        return active;
      } catch (error) {
        failures.push(
          `${candidate.binaryPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // An explicit override is a contract, not a hint. Never silently run a
        // different binary when it is invalid.
        if (candidate.source === 'override') break;
      }
    }

    throw Object.assign(
      new Error(`No usable ${cli} CLI runtime found. ${failures.join(' | ')}`),
      { code: 'RUNTIME_PROBE_FAILED' },
    );
  }

  /**
   * Drop the cached selection after all leases are released. Used after an
   * update activation or an operator repair; active processes keep their
   * immutable absolute path until they release.
   */
  invalidate(cli: Executor): boolean {
    if (this.resolving.has(cli)) return false;
    const active = this.active.get(cli);
    if (!active) return true;
    if (active.leases > 0) return false;
    this.active.delete(cli);
    return true;
  }

  private makeLease(active: ActiveRuntime): RuntimeLease {
    let released = false;
    return {
      ...active.probe,
      env: active.env,
      release: () => {
        if (released) return;
        released = true;
        active.leases = Math.max(0, active.leases - 1);
      },
    };
  }
}
