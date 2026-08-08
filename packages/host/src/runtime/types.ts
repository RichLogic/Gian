import type { Executor } from '@gian/shared';

export type RuntimeSource = 'managed' | 'override' | 'official-user' | 'path';

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
  inspectInstalled(): Promise<InstalledRuntime[]>;
  probe(
    runtime: InstalledRuntime,
    protector?: RuntimeProcessGroupProtector,
  ): Promise<RuntimeProbe>;
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
