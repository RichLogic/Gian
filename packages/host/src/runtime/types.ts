export type RuntimeSource =
  | 'managed'
  | 'override'
  | 'official-user'
  | 'official-system'
  | 'path';

export interface RuntimeProcessGroupReservation {
  register(groupId: number): Promise<'registered' | 'already-empty'>;
  cancelBeforeSpawn(): Promise<void>;
  releaseUnregistered(groupId: number): Promise<void>;
  release(): Promise<void>;
}

export interface RuntimeProcessGroupProtector {
  reserveProcessGroup(): Promise<RuntimeProcessGroupReservation>;
}

export interface RuntimeLease {
  binaryPath: string;
  version: string;
  source: RuntimeSource;
  env: Readonly<Record<string, string>>;
  /** Publish a fail-closed spawn reservation before creating a detached
   * runtime process, then register its PGID before exposing the process. */
  reserveProcessGroup?(): Promise<RuntimeProcessGroupReservation>;
  release(): Promise<void>;
}
