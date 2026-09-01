import type { Executor } from '@gian/shared';

export type RuntimeSource =
  | 'managed'
  | 'override'
  | 'official-user'
  | 'official-system'
  | 'path';

export interface InstalledRuntime {
  cli: Executor;
  binaryPath: string;
  source: RuntimeSource;
}

export interface RuntimeProbe {
  cli: Executor;
  binaryPath: string;
  version: string;
  source: RuntimeSource;
  /** Environment additions required to execute this exact runtime. */
  env?: Readonly<Record<string, string>>;
}

export interface CliRuntimeProvider {
  readonly id: Executor;
  /** Scan for usable runtimes. An explicit `overridePath` wins over the
   *  provider's configured-path callback and becomes the single 'override'
   *  candidate; omit it to use the configured path, PATH, and official
   *  install locations. */
  inspectInstalled(overridePath?: string): Promise<InstalledRuntime[]>;
  probe(
    runtime: InstalledRuntime,
    protector?: RuntimeProcessGroupProtector,
  ): Promise<RuntimeProbe>;
  /** Stable identity of every provider-owned byte that determines what this
   * launcher executes. Optional only for synthetic/test providers. */
  snapshot?(runtime: InstalledRuntime | RuntimeProbe): Promise<string>;
  /** Commit provider-specific compatibility state immediately before this
   * exact probe becomes leaseable. Status/proxy probes intentionally skip it. */
  activate?(runtime: RuntimeProbe): Promise<void>;
  managedEnv(): Readonly<Record<string, string>>;
}

export interface RuntimeProcessGroupReservation {
  register(groupId: number): Promise<'registered' | 'already-empty'>;
  cancelBeforeSpawn(): Promise<void>;
  releaseUnregistered(groupId: number): Promise<void>;
  release(): Promise<void>;
}

export interface RuntimeProcessGroupProtector {
  reserveProcessGroup(): Promise<RuntimeProcessGroupReservation>;
}

export interface RuntimeLease extends RuntimeProbe {
  env: Readonly<Record<string, string>>;
  /** Publish a fail-closed spawn reservation before creating a detached
   * runtime process, then register its PGID before exposing the process. */
  reserveProcessGroup?(): Promise<RuntimeProcessGroupReservation>;
  release(): Promise<void>;
}
