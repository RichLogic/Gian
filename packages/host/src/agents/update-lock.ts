import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CHOOSING_SETTLE_ATTEMPTS = 20;
const CHOOSING_SETTLE_DELAY_MS = 5;
const MAX_CLAIM_BYTES = 1024 * 1024;
const MAX_OUTSTANDING_PROCESS_GROUPS = 1_024;

interface LockClaim {
  /** v2 adds crash-safe protected-process metadata. Publishing it as v1
   * would let an older Host ignore those fields and reclaim a dead owner's
   * claim while its detached child is still alive. Older Hosts reject v2 and
   * therefore fail closed; current Hosts continue to read legacy v1 claims. */
  schemaVersion: 1 | 2;
  token: string;
  pid: number;
  processIdentity: string;
  operation: string;
  /** Missing means legacy-exclusive for compatibility with v1 claims. Older
   * Hosts reject v2 claims altogether and therefore fail closed. */
  scope?: LockScope;
  createdAt: string;
  choosing: boolean;
  ticket: number;
  /** Reservations are published before a protected child is spawned. If the
   * owner dies in the spawn -> PGID registration window, stale recovery keeps
   * the claim instead of assuming no child escaped. */
  pendingProcessGroups?: string[];
  /** Detached child groups that may outlive the Host process. */
  protectedProcessGroups?: ProtectedProcessGroupClaim[];
}

interface ProtectedProcessGroupClaim {
  token: string;
  groupId: number;
  leaderIdentity: string;
}

type LockScope = 'runtime-use' | 'cli-update' | 'proxy-update';

interface ActiveClaim {
  path: string;
  claim: LockClaim;
}

type ProcessProbe =
  | { state: 'live'; identity: string }
  | { state: 'dead' }
  | { state: 'unknown' };

export class AgentUpdateBusyError extends Error {
  readonly code = 'AGENT_UPDATE_BUSY';

  constructor(readonly operation: string) {
    super(`Another Agent update is already in progress (${operation}).`);
    this.name = 'AgentUpdateBusyError';
  }
}

export interface AgentUpdateLease {
  reserveProcessGroup(): Promise<AgentProcessGroupReservation>;
  release(): Promise<void>;
}

export interface AgentProcessGroupReservation {
  /** A very short-lived child may be gone before its identity can be
   * recorded. In that case the pending reservation remains until the caller
   * retires it with a second ESRCH check. */
  register(groupId: number): Promise<'registered' | 'already-empty'>;
  /** Cancel only when the caller has not spawned a child. */
  cancelBeforeSpawn(): Promise<void>;
  /** Retire a pending registration only after this PGID is confirmed absent. */
  releaseUnregistered(groupId: number): Promise<void>;
  /** Registered reservations enforce PGID ESRCH themselves. */
  release(): Promise<void>;
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function processGroupLiveness(groupId: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return 'dead';
  try {
    process.kill(-groupId, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/** PID alone is not a lease identity because operating systems reuse it. The
 * long start time is stable for one process lifetime and changes on reuse.
 * Gian's supported desktop platform and Linux both provide it through ps. */
async function probeProcess(pid: number): Promise<ProcessProbe> {
  const liveness = processLiveness(pid);
  if (liveness === 'dead') return { state: 'dead' };
  if (liveness === 'unknown') return { state: 'unknown' };
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const result = await execFileAsync('/bin/ps', [
        '-p', String(pid), '-o', 'lstart=',
      ], {
        timeout: 2_000,
        maxBuffer: 4_096,
        encoding: 'utf8',
        env: {
          ...process.env,
          LC_ALL: 'C',
          LANG: 'C',
          TZ: 'UTC',
        },
      });
      const startedAt = String(result.stdout).trim().replace(/\s+/g, ' ');
      if (startedAt) return { state: 'live', identity: `${process.platform}:${startedAt}` };
    } catch {
      const afterFailure = processLiveness(pid);
      if (afterFailure === 'dead') return { state: 'dead' };
      // A transient ps/permission failure is not evidence that the owner died.
      // Fail closed instead of switching identity schemes and deleting a live
      // claim on the next successful probe.
      return { state: 'unknown' };
    }
    return { state: 'unknown' };
  }
  // Unsupported platforms still get crash recovery. The packaged desktop
  // path uses the start-time identity above, which also closes PID reuse.
  return { state: 'live', identity: `pid:${pid}` };
}

function validClaim(value: unknown): value is LockClaim {
  if (!value || typeof value !== 'object') return false;
  const claim = value as Partial<LockClaim>;
  return (
    (claim.schemaVersion === 1 || claim.schemaVersion === 2)
    && typeof claim.token === 'string'
    && Number.isSafeInteger(claim.pid)
    && typeof claim.processIdentity === 'string'
    && typeof claim.operation === 'string'
    && (
      claim.scope === undefined
      || claim.scope === 'runtime-use'
      || claim.scope === 'cli-update'
      || claim.scope === 'proxy-update'
    )
    && typeof claim.createdAt === 'string'
    && typeof claim.choosing === 'boolean'
    && Number.isSafeInteger(claim.ticket)
    && (claim.ticket ?? -1) >= 0
    && (
      claim.pendingProcessGroups === undefined
      || (
        Array.isArray(claim.pendingProcessGroups)
        && claim.pendingProcessGroups.length <= 1_024
        && claim.pendingProcessGroups.every(token => (
          typeof token === 'string' && token.length > 0
        ))
      )
    )
    && (
      claim.protectedProcessGroups === undefined
      || (
        Array.isArray(claim.protectedProcessGroups)
        && claim.protectedProcessGroups.length <= 1_024
        && claim.protectedProcessGroups.every(group => (
          group !== null
          && typeof group === 'object'
          && typeof group.token === 'string'
          && group.token.length > 0
          && Number.isSafeInteger(group.groupId)
          && group.groupId > 0
          && typeof group.leaderIdentity === 'string'
          && group.leaderIdentity.length > 0
        ))
      )
    )
    && (
      claim.schemaVersion === 2
      || (
        claim.pendingProcessGroups === undefined
        && claim.protectedProcessGroups === undefined
      )
    )
    && (
      (claim.pendingProcessGroups?.length ?? 0)
      + (claim.protectedProcessGroups?.length ?? 0)
      <= MAX_OUTSTANDING_PROCESS_GROUPS
    )
  );
}

async function readClaim(path: string): Promise<LockClaim | null> {
  try {
    const metadata = await lstat(path);
    let serialized: string;
    let expectedSchema: 1 | 2;
    if (metadata.isSymbolicLink()) {
      // v1 used the symlink target as its atomic payload. Keep reading it for
      // compatibility, but never publish new mutable process metadata there:
      // macOS limits symlink targets to roughly 1 KiB.
      serialized = await readlink(path);
      expectedSchema = 1;
    } else if (metadata.isFile()) {
      if (metadata.size > MAX_CLAIM_BYTES) {
        throw new Error(`Agent updater lock claim is too large: ${path}`);
      }
      serialized = await readFile(path, 'utf8');
      if (Buffer.byteLength(serialized) > MAX_CLAIM_BYTES) {
        throw new Error(`Agent updater lock claim is too large: ${path}`);
      }
      expectedSchema = 2;
    } else {
      throw new Error(`Agent updater lock claim has an unsupported file type: ${path}`);
    }
    const parsed: unknown = JSON.parse(serialized);
    if (!validClaim(parsed)) throw new Error(`Agent updater lock claim is invalid: ${path}`);
    if (parsed.schemaVersion !== expectedSchema) {
      throw new Error(`Agent updater lock claim storage does not match its schema: ${path}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function replaceClaim(path: string, claim: LockClaim): Promise<void> {
  const candidate = join(dirname(path), `.candidate-${claim.token}-${randomUUID()}`);
  const serialized = JSON.stringify(claim);
  if (Buffer.byteLength(serialized) > MAX_CLAIM_BYTES) {
    throw new Error('Agent updater lock claim exceeds its maximum safe size.');
  }
  try {
    await writeFile(candidate, serialized, { flag: 'wx', mode: 0o600 });
    // Replacing our own uniquely named file publishes the ticket in one
    // namespace operation; readers observe either choosing=true or the final
    // ticket, never a partially written owner record.
    await rename(candidate, path);
  } finally {
    await rm(candidate, { force: true });
  }
}

/**
 * Decide whether a dead claim can be reclaimed. A pending reservation is
 * intentionally unreclaimable automatically: the Host may have died after
 * spawn but before it could publish the PGID. Registered groups are retained
 * until signal 0 reports ESRCH. The leader identity is retained for explicit
 * operator repair; automatic recovery never relies on an ambiguous mismatch.
 */
async function deadClaimHasProtectedWork(claim: LockClaim): Promise<boolean> {
  // A legacy v1 owner could have spawned an updater/Proxy child without any
  // metadata that a new Host can verify. Automatic removal would recreate the
  // original crash race, so dead v1 claims require explicit operator repair.
  if (claim.schemaVersion === 1) return true;
  if ((claim.pendingProcessGroups?.length ?? 0) > 0) return true;
  for (const group of claim.protectedProcessGroups ?? []) {
    const groupState = processGroupLiveness(group.groupId);
    if (groupState === 'unknown') {
      throw new Error(
        `Cannot verify protected Agent process group ${group.groupId}; refusing stale recovery.`,
      );
    }
    if (groupState === 'dead') continue;

    // ESRCH above is the sole automatic recovery proof. Even a different
    // leader identity can represent numeric PGID reuse after an observation
    // gap; retain the claim rather than mutating a CLI under an unverified
    // group. The recorded identity remains useful for operator repair.
    return true;
  }
  return false;
}

async function activeClaims(directory: string): Promise<ActiveClaim[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const identityByPid = new Map<number, Promise<ProcessProbe>>();
  const active: ActiveClaim[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('claim-')) continue;
    const path = join(directory, entry.name);
    const claim = await readClaim(path);
    if (!claim) continue;
    let identity = identityByPid.get(claim.pid);
    if (!identity) {
      identity = probeProcess(claim.pid);
      identityByPid.set(claim.pid, identity);
    }
    const owner = await identity;
    if (owner.state === 'unknown') {
      throw new Error(`Cannot verify Agent updater owner process ${claim.pid}; refusing stale recovery.`);
    }
    if (owner.state === 'dead' || owner.identity !== claim.processIdentity) {
      if (await deadClaimHasProtectedWork(claim)) {
        active.push({ path, claim });
        continue;
      }
      // Claims are unique and owners never rename a different claim onto this
      // path. Removing a dead process's path cannot delete a successor's lock.
      await rm(path, { force: true });
      continue;
    }
    active.push({ path, claim });
  }
  return active;
}

function precedes(left: LockClaim, right: LockClaim): boolean {
  return left.ticket < right.ticket
    || (left.ticket === right.ticket && left.token < right.token);
}

function conflicts(left: LockClaim, right: LockClaim): boolean {
  const leftScope = left.scope;
  const rightScope = right.scope;
  // Claims from an older Host had no scope and represented a globally
  // exclusive updater, so every new participant must conflict with them.
  if (!leftScope || !rightScope) return true;
  if (leftScope === 'cli-update' || rightScope === 'cli-update') return true;
  // A Proxy update only swaps Gian's immutable Proxy version pointer. It may
  // probe a vendor CLI that another Host is using, but cannot mutate that CLI.
  // Two updaters still serialize their status/activation work.
  if (leftScope === 'proxy-update' && rightScope === 'proxy-update') return true;
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retireClaim(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      lastError = error;
      if (attempt < 2) await delay(CHOOSING_SETTLE_DELAY_MS);
    }
  }
  throw lastError;
}

/**
 * Cross-process, fail-fast Agent updater lock.
 *
 * Every contender owns a unique, atomically published claim and chooses a
 * Lamport bakery ticket. Dead claims can be removed by their unique path; no
 * contender ever reads a fixed stale owner and later renames/unlinks whatever
 * happens to occupy that path, which closes the stale-reclaim TOCTOU.
 */
async function acquireAgentLock(
  dataDir: string,
  agentId: string,
  operation: string,
  scope: LockScope,
): Promise<AgentUpdateLease> {
  const directory = join(dataDir, 'update-locks', `agent-${agentId}-claims`);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const token = randomUUID();
  const path = join(directory, `claim-${token}`);
  const processOwner = await probeProcess(process.pid);
  if (processOwner.state !== 'live') {
    throw new Error('Cannot establish the Agent updater process identity.');
  }
  let ownClaim: LockClaim = {
    schemaVersion: 2,
    token,
    pid: process.pid,
    processIdentity: processOwner.identity,
    operation,
    scope,
    createdAt: new Date().toISOString(),
    choosing: true,
    ticket: 0,
  };

  await replaceClaim(path, ownClaim);
  try {
    const selecting = await activeClaims(directory);
    const maximumTicket = selecting.reduce(
      (maximum, current) => Math.max(maximum, current.claim.ticket),
      0,
    );
    if (maximumTicket >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Agent updater lock ticket space is exhausted.');
    }
    const ticketedClaim = { ...ownClaim, choosing: false, ticket: maximumTicket + 1 };
    await replaceClaim(path, ticketedClaim);
    ownClaim = ticketedClaim;

    for (let attempt = 0; attempt < CHOOSING_SETTLE_ATTEMPTS; attempt += 1) {
      const contenders = await activeClaims(directory);
      if (!contenders.some(current => current.claim.token === token)) {
        throw new Error('Agent updater lock claim was lost while acquiring.');
      }
      const choosing = contenders.find(current => (
        current.claim.token !== token && current.claim.choosing
      ));
      if (choosing) {
        await delay(CHOOSING_SETTLE_DELAY_MS);
        continue;
      }
      const blocker = contenders
        .filter(current => current.claim.token !== token && !current.claim.choosing)
        .map(current => current.claim)
        .filter(current => precedes(current, ownClaim) && conflicts(current, ownClaim))
        .sort((left, right) => (
          left.ticket - right.ticket || left.token.localeCompare(right.token)
        ))[0];
      if (blocker) throw new AgentUpdateBusyError(blocker.operation);

      let released = false;
      let mutationTail = Promise.resolve();
      const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
        const current = mutationTail.then(operation);
        mutationTail = current.then(() => undefined, () => undefined);
        return current;
      };
      return {
        reserveProcessGroup() {
          const reservationToken = randomUUID();
          let state: 'new' | 'pending' | 'registered' | 'released' = 'new';
          let registeredGroupId: number | undefined;
          return mutate(async () => {
            if (released) throw new Error('Agent updater claim is already released.');
            const outstanding = (ownClaim.pendingProcessGroups?.length ?? 0)
              + (ownClaim.protectedProcessGroups?.length ?? 0);
            if (outstanding >= MAX_OUTSTANDING_PROCESS_GROUPS) {
              throw new Error(
                `Agent updater claim cannot protect more than ${MAX_OUTSTANDING_PROCESS_GROUPS} process groups.`,
              );
            }
            const nextClaim = {
              ...ownClaim,
              pendingProcessGroups: [
                ...(ownClaim.pendingProcessGroups ?? []),
                reservationToken,
              ],
            };
            await replaceClaim(path, nextClaim);
            ownClaim = nextClaim;
            state = 'pending';
            const reservation: AgentProcessGroupReservation = {
              async register(groupId: number): Promise<'registered' | 'already-empty'> {
                if (!Number.isSafeInteger(groupId) || groupId <= 0) {
                  throw new Error(`Invalid protected process group: ${groupId}`);
                }
                const groupState = processGroupLiveness(groupId);
                if (groupState === 'dead') {
                  return mutate(async () => {
                    if (state !== 'pending') {
                      throw new Error('Agent process-group reservation is not pending.');
                    }
                    return 'already-empty' as const;
                  });
                }
                if (groupState === 'unknown') {
                  throw new Error(`Protected process group is not alive: ${groupId}`);
                }
                const leader = await probeProcess(groupId);
                if (leader.state !== 'live') {
                  // The process can exit between signal-0 and ps. Only a
                  // fresh PGID ESRCH proves this is the benign fast-exit
                  // case; unknown or a surviving descendant group stays
                  // pending and fails closed.
                  if (
                    leader.state === 'dead'
                    && processGroupLiveness(groupId) === 'dead'
                  ) {
                    return mutate(async () => {
                      if (state !== 'pending') {
                        throw new Error('Agent process-group reservation is not pending.');
                      }
                      return 'already-empty' as const;
                    });
                  }
                  throw new Error(
                    `Cannot establish protected process-group identity: ${groupId}`,
                  );
                }
                return mutate(async () => {
                  if (state !== 'pending') {
                    throw new Error('Agent process-group reservation is not pending.');
                  }
                  const nextClaim = {
                    ...ownClaim,
                    pendingProcessGroups: (ownClaim.pendingProcessGroups ?? [])
                      .filter(token => token !== reservationToken),
                    protectedProcessGroups: [
                      ...(ownClaim.protectedProcessGroups ?? []),
                      {
                        token: reservationToken,
                        groupId,
                        leaderIdentity: leader.identity,
                      },
                    ],
                  };
                  await replaceClaim(path, nextClaim);
                  ownClaim = nextClaim;
                  registeredGroupId = groupId;
                  state = 'registered';
                  return 'registered' as const;
                });
              },
              async cancelBeforeSpawn() {
                await mutate(async () => {
                  if (state === 'released') return;
                  if (state !== 'pending') {
                    throw new Error(
                      'Only an unregistered Agent process-group reservation can be cancelled.',
                    );
                  }
                  const nextClaim = {
                    ...ownClaim,
                    pendingProcessGroups: (ownClaim.pendingProcessGroups ?? [])
                      .filter(token => token !== reservationToken),
                  };
                  await replaceClaim(path, nextClaim);
                  ownClaim = nextClaim;
                  state = 'released';
                });
              },
              async releaseUnregistered(groupId: number) {
                await mutate(async () => {
                  if (state === 'released') return;
                  if (state !== 'pending') {
                    throw new Error('Agent process-group reservation is not pending.');
                  }
                  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
                    throw new Error(`Invalid protected process group: ${groupId}`);
                  }
                  if (processGroupLiveness(groupId) !== 'dead') {
                    throw new Error(
                      `Cannot retire pending Agent reservation; process group ${groupId} is not confirmed absent.`,
                    );
                  }
                  const nextClaim = {
                    ...ownClaim,
                    pendingProcessGroups: (ownClaim.pendingProcessGroups ?? [])
                      .filter(token => token !== reservationToken),
                  };
                  await replaceClaim(path, nextClaim);
                  ownClaim = nextClaim;
                  state = 'released';
                });
              },
              async release() {
                await mutate(async () => {
                  if (state === 'released') return;
                  if (state !== 'registered' || registeredGroupId === undefined) {
                    throw new Error(
                      'Pending Agent process-group reservation requires an explicit no-spawn or ESRCH proof.',
                    );
                  }
                  if (processGroupLiveness(registeredGroupId) !== 'dead') {
                    throw new Error(
                      `Cannot release protected Agent process group ${registeredGroupId}; ESRCH was not observed.`,
                    );
                  }
                  const nextClaim = {
                    ...ownClaim,
                    pendingProcessGroups: (ownClaim.pendingProcessGroups ?? [])
                      .filter(token => token !== reservationToken),
                    protectedProcessGroups: (ownClaim.protectedProcessGroups ?? [])
                      .filter(group => group.token !== reservationToken),
                  };
                  await replaceClaim(path, nextClaim);
                  ownClaim = nextClaim;
                  state = 'released';
                });
              },
            };
            return reservation;
          });
        },
        async release() {
          await mutate(async () => {
            if (released) return;
            if (
              (ownClaim.pendingProcessGroups?.length ?? 0) > 0
              || (ownClaim.protectedProcessGroups?.length ?? 0) > 0
            ) {
              throw new Error(
                'Cannot release Agent updater claim while protected process groups remain.',
              );
            }
            await retireClaim(path);
            released = true;
          });
        },
      };
    }

    const contenders = await activeClaims(directory);
    const choosing = contenders.find(current => (
      current.claim.token !== token && current.claim.choosing
    ));
    throw new AgentUpdateBusyError(choosing?.claim.operation ?? operation);
  } catch (error) {
    try {
      await retireClaim(path);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Agent updater lock acquisition failed and its claim could not be retired.',
      );
    }
    throw error;
  }
}

/** Acquire the exclusive side of the Agent update/runtime boundary. */
export function acquireAgentUpdateLock(
  dataDir: string,
  agentId: string,
  operation: string,
): Promise<AgentUpdateLease> {
  return acquireAgentLock(dataDir, agentId, operation, 'cli-update');
}

/** Serialize a Gian Proxy update without blocking read-only vendor CLI use. */
export function acquireAgentProxyUpdateLock(
  dataDir: string,
  agentId: string,
  operation: string,
): Promise<AgentUpdateLease> {
  return acquireAgentLock(dataDir, agentId, operation, 'proxy-update');
}

/**
 * Acquire a shared runtime-use claim in the same namespace as Agent updates.
 * Multiple Hosts and a read-only Proxy compatibility probe may execute one
 * CLI concurrently, while an official CLI updater waits for every runtime
 * generation to drain.
 */
export function acquireAgentRuntimeUseLock(
  dataDir: string,
  agentId: string,
  operation = 'CLI runtime use',
): Promise<AgentUpdateLease> {
  return acquireAgentLock(dataDir, agentId, operation, 'runtime-use');
}
