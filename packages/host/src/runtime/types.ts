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
}

export interface CliRuntimeProvider {
  readonly id: Executor;
  inspectInstalled(): Promise<InstalledRuntime[]>;
  probe(runtime: InstalledRuntime): Promise<RuntimeProbe>;
  managedEnv(): Readonly<Record<string, string>>;
}

export interface RuntimeLease extends RuntimeProbe {
  env: Readonly<Record<string, string>>;
  release(): void;
}
