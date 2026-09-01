import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalExitStatus,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

const DEFAULT_OUTPUT_BYTE_LIMIT = 256 * 1024;
const HARD_MAX_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const MAX_TERMINALS_PER_SESSION = 4;
const MAX_TERMINALS_PER_RUNTIME = 16;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_GROUP_VERIFY_MS = 2_000;
const DEFAULT_GROUP_POLL_MS = 50;
const DEFAULT_EXIT_SETTLE_MS = 2_000;

export type TerminalStatus = 'running' | 'killing' | 'exited' | 'releasing' | 'released';

/** Raised when a terminal process group could not be verified dead. The
 *  record stays in the service with its PGID so a supervisor can diagnose or
 *  finish the harvest; cleanup is never faked as successful. */
export class TerminalCleanupError extends Error {
  readonly terminalId?: string;
  readonly sessionId?: string;
  readonly pgid?: number;

  constructor(
    message: string,
    details: { terminalId?: string; sessionId?: string; pgid?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'TerminalCleanupError';
    if (details.terminalId !== undefined) this.terminalId = details.terminalId;
    if (details.sessionId !== undefined) this.sessionId = details.sessionId;
    if (details.pgid !== undefined) this.pgid = details.pgid;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

/** Injectable process-group seam for deterministic cleanup tests. The real
 *  adapter signals process groups via `process.kill(-pgid, …)`. */
export interface TerminalProcessGroupAdapter {
  signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL' | 0): void;
  groupExists(pgid: number): boolean;
}

const realProcessGroupAdapter: TerminalProcessGroupAdapter = {
  signalGroup(pgid, signal) {
    process.kill(-pgid, signal);
  },
  groupExists(pgid) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      // ESRCH: no such group. EPERM: the group still has members we may not
      // signal — treat it as alive so the bounded verify loop keeps trying.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
};

interface TerminalExit {
  exitCode: number | null;
  signal: string | null;
}

interface TerminalRecord {
  terminalId: string;
  sessionId: string;
  generation: number;
  pid: number;
  byteLimit: number;
  /** Decoded output chunks in arrival order; oldest first. */
  chunks: string[];
  chunkBytes: number[];
  totalBytes: number;
  truncated: boolean;
  status: TerminalStatus;
  /** Settled synchronously by the child exit listener. */
  exitStatus: TerminalExitStatus | null;
  exit: Promise<TerminalExit>;
  harvest: Promise<void>;
  lastCleanupError?: string;
}

/** One in-flight create: past entry validation, awaiting its spawn settle. */
interface PendingCreate {
  sessionId: string;
  generation: number;
  promise: Promise<void>;
  pid?: number;
}

export class TerminalOwnershipError extends Error {}

/** Lease owning one session drain. The barrier rises synchronously when the
 *  lease is created; release semantics are ref-counted per session so
 *  concurrent interrupt/turn-finalizer/close drains can never unlock each
 *  other early, and a permanent close drain keeps the session closed. */
export interface SessionDrainLease {
  /** Harvest every record of the session and wait for its in-flight creates
   *  to settle (each is reaped and rejected under the barrier). */
  drain(): Promise<void>;
  /** Lift the temporary barrier after a fully successful drain. No-op when a
   *  permanent drain owns the session or a sibling lease is still open. */
  releaseForNextTurn(): void;
  /** Keep the session blocked after a failure; never unlocks. */
  keepBlocked(): void;
}

function invalidParams(message: string): Error {
  const error = new Error(message);
  error.name = 'InvalidParams';
  return error;
}

/** One indistinguishable error for unknown, released, cross-session, and
 *  stale-generation ids so a failure never reveals whether another session
 *  owns a terminal id. */
function ownershipError(): TerminalOwnershipError {
  return new TerminalOwnershipError('Unknown terminal.');
}

/** Longest suffix of `input` whose UTF-8 encoding fits `limit` bytes, cut on
 *  code-point boundaries. Input arrives from incremental decoders that only
 *  emit complete code points, so every cut sits between code points and the
 *  retained string stays valid UTF-8. Exported for truncation regression
 *  tests. */
export function tailWithinByteLimit(input: string, limit: number): string {
  if (limit <= 0) return '';
  let bytes = 0;
  let index = input.length;
  while (index > 0) {
    const unit = input.charCodeAt(index - 1);
    // Walk UTF-16 backward: a low surrogate must consume its preceding high
    // surrogate as one supplementary code point (4 UTF-8 bytes), or the cut
    // would strand a lone surrogate half.
    const isLowSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
    const hasHighPair = isLowSurrogate
      && index >= 2
      && input.charCodeAt(index - 2) >= 0xd800
      && input.charCodeAt(index - 2) <= 0xdbff;
    const width = hasHighPair ? 2 : 1;
    const encodedBytes = unit <= 0x7f ? 1
      : unit <= 0x7ff ? 2
        : (unit >= 0xd800 && unit <= 0xdfff) ? (hasHighPair ? 4 : 3)
          : 3;
    if (bytes + encodedBytes > limit) break;
    bytes += encodedBytes;
    index -= width;
  }
  return input.slice(index);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Client-side ACP terminal service for one shared Kimi ACP runtime. Executes
 * non-interactive tool commands in their own POSIX process group, keeps a
 * bounded UTF-8 output tail, and fences every handle by native session and
 * runtime generation. This is a Proxy-internal tool-command service — not a
 * session TTY; no PTY, stdin, resize, or interactive shell path exists.
 *
 * Cleanup is fail-closed with a two-level barrier:
 * - Session drains use ref-counted leases (`beginSessionDrain`): the barrier
 *   rises synchronously, in-flight creates are reaped and rejected, and only
 *   the last successful lease release unlocks a non-permanent session.
 * - `fenceRuntime` synchronously seals one generation against new reverse
 *   creates; `drainRuntime` then reaps everything of that generation.
 *
 * In-flight creates can never escape a drain: each create captures its
 * session binding epoch and runtime generation at entry and re-validates
 * after the child spawn settles — a stale create kills its just-spawned
 * process group and rejects without ever registering a record or returning
 * a terminalId. Drains await every pending create of their scope, so a
 * drain cannot report success while a spawn window is still open.
 */
export class KimiTerminalService {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly sessions = new Map<string, { cwd: string; generation: number }>();
  private readonly sessionEpochs = new Map<string, number>();
  /** Sessions with at least one open drain lease; create is refused. */
  private readonly drainingSessions = new Set<string>();
  /** Per-session drain lease accounting: open lease count, whether a
   *  permanent drain owns the session, and whether any lease failed. */
  private readonly drainStates = new Map<
    string,
    { leases: number; permanent: boolean; failed: boolean }
  >();
  /** Sticky: a permanent drain keeps the session closed for good. */
  private readonly permanentSessions = new Set<string>();
  private readonly pendingCreates: PendingCreate[] = [];
  private readonly fencedGenerations = new Set<number>();
  private readonly defaultOutputByteLimit: number;
  private readonly maxPerSession: number;
  private readonly maxTotal: number;
  private readonly groups: TerminalProcessGroupAdapter;
  private readonly termGraceMs: number;
  private readonly groupVerifyMs: number;
  private readonly groupPollMs: number;
  private readonly exitSettleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Test seam: awaited after spawn initiation, before the spawn event —
   *  deterministically holds a create in its in-flight window. */
  private readonly spawnSeam: (() => Promise<void>) | null;
  /** Bounded diagnostic registry of barrier-race children that could not be
   *  reaped, for supervisor visibility (never a success record). */
  private readonly orphanedGroups: Array<{ pgid: number; sessionId: string; message: string }> = [];
  /** Incremented per ACP runtime start; records from older generations are
   *  unreachable through the ACP surface and are reaped by drainRuntime. */
  private generation = 0;

  constructor(options: {
    defaultOutputByteLimit?: number;
    maxPerSession?: number;
    maxTotal?: number;
    processGroupAdapter?: TerminalProcessGroupAdapter;
    termGraceMs?: number;
    groupVerifyMs?: number;
    groupPollMs?: number;
    exitSettleMs?: number;
    delay?: (ms: number) => Promise<void>;
    spawnSeam?: () => Promise<void>;
  } = {}) {
    const defaultLimit = options.defaultOutputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT;
    if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 0
      || defaultLimit > HARD_MAX_OUTPUT_BYTE_LIMIT) {
      throw new Error(
        `defaultOutputByteLimit must be an integer within [0, ${HARD_MAX_OUTPUT_BYTE_LIMIT}].`,
      );
    }
    this.defaultOutputByteLimit = defaultLimit;
    this.maxPerSession = options.maxPerSession ?? MAX_TERMINALS_PER_SESSION;
    this.maxTotal = options.maxTotal ?? MAX_TERMINALS_PER_RUNTIME;
    this.groups = options.processGroupAdapter ?? realProcessGroupAdapter;
    this.termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    this.groupVerifyMs = options.groupVerifyMs ?? DEFAULT_GROUP_VERIFY_MS;
    this.groupPollMs = options.groupPollMs ?? DEFAULT_GROUP_POLL_MS;
    this.exitSettleMs = options.exitSettleMs ?? DEFAULT_EXIT_SETTLE_MS;
    this.sleep = options.delay ?? delay;
    this.spawnSeam = options.spawnSeam ?? null;
  }

  get activeCount(): number {
    return this.records.size;
  }

  /** Diagnostic/test accessor for one record's cleanup-relevant state. */
  recordForTest(terminalId: string): {
    pid: number;
    sessionId: string;
    status: TerminalStatus;
    lastCleanupError?: string;
  } | undefined {
    const record = this.records.get(terminalId);
    if (!record) return undefined;
    const diagnostic: {
      pid: number;
      sessionId: string;
      status: TerminalStatus;
      lastCleanupError?: string;
    } = {
      pid: record.pid,
      sessionId: record.sessionId,
      status: record.status,
    };
    if (record.lastCleanupError !== undefined) diagnostic.lastCleanupError = record.lastCleanupError;
    return diagnostic;
  }

  /** Test accessor: the spawned pid of one in-flight create, if known. */
  pendingCreatePidForTest(sessionId: string): number | undefined {
    return this.pendingCreates.find((pending) => pending.sessionId === sessionId)?.pid;
  }

  /** Test accessor: unreapable barrier-race orphans (bounded diagnostics). */
  orphanedGroupsForTest(): Array<{ pgid: number; sessionId: string; message: string }> {
    return [...this.orphanedGroups];
  }

  /** Number of creates that passed entry validation but have not settled. */
  pendingCreateCount(sessionId?: string, generation?: number): number {
    return this.pendingCreates.filter((pending) => (
      (sessionId === undefined || pending.sessionId === sessionId)
      && (generation === undefined || pending.generation === generation)
    )).length;
  }

  /** Synchronously seal the current runtime generation against new reverse
   *  creates. Returns the generation's pending creates for the caller to
   *  await inside its drain. */
  fenceRuntime(): { generation: number; pending: Promise<void>[] } {
    const generation = this.generation;
    this.fencedGenerations.add(generation);
    return {
      generation,
      pending: this.pendingCreates
        .filter((pending) => pending.generation === generation)
        .map((pending) => pending.promise),
    };
  }

  isGenerationFenced(generation: number): boolean {
    return this.fencedGenerations.has(generation);
  }

  isSessionDraining(nativeSessionId: string): boolean {
    return this.drainingSessions.has(nativeSessionId)
      || this.permanentSessions.has(nativeSessionId);
  }

  advanceGeneration(): number {
    this.generation += 1;
    this.fencedGenerations.clear();
    return this.generation;
  }

  bindSession(nativeSessionId: string, cwd: string): void {
    this.sessions.set(nativeSessionId, { cwd, generation: this.generation });
    this.bumpEpoch(nativeSessionId);
    const previousDrain = this.drainStates.get(nativeSessionId);
    // A clean permanent drain belongs to the closed Proxy attachment. When
    // Host later loads the same native Kimi session, do not let that settled
    // state turn the resumed Session's first normal turn drain permanent too.
    // Active or failed cleanup remains fail-closed until it really settles.
    if (!previousDrain || (previousDrain.leases === 0 && !previousDrain.failed)) {
      this.drainStates.delete(nativeSessionId);
      this.drainingSessions.delete(nativeSessionId);
      this.permanentSessions.delete(nativeSessionId);
    }
  }

  forgetSession(nativeSessionId: string): void {
    this.sessions.delete(nativeSessionId);
    this.bumpEpoch(nativeSessionId);
    this.drainingSessions.delete(nativeSessionId);
    this.permanentSessions.delete(nativeSessionId);
  }

  private bumpEpoch(nativeSessionId: string): void {
    this.sessionEpochs.set(nativeSessionId, (this.sessionEpochs.get(nativeSessionId) ?? 0) + 1);
  }

  /**
   * Synchronously raise the session's terminal barrier. Every later create
   * for the session — including ones already past entry validation but still
   * awaiting their spawn — is refused until the last successful lease
   * releases a non-permanent drain. Permanent drains never reopen.
   */
  beginSessionDrain(
    nativeSessionId: string,
    options: { permanent?: boolean } = {},
  ): SessionDrainLease {
    const state = this.drainStates.get(nativeSessionId)
      ?? { leases: 0, permanent: false, failed: false };
    state.leases += 1;
    if (options.permanent === true) state.permanent = true;
    this.drainStates.set(nativeSessionId, state);
    this.drainingSessions.add(nativeSessionId);
    this.bumpEpoch(nativeSessionId);
    let done = false;
    return {
      drain: () => this.drainSessionRecords(nativeSessionId),
      releaseForNextTurn: () => {
        if (done) return;
        done = true;
        state.leases -= 1;
        if (state.leases > 0) return;
        // A permanent drain (this one or a concurrent one) keeps the session
        // closed; only a purely temporary fully-successful release unlocks.
        if (state.permanent) return;
        state.failed = false;
        this.drainStates.delete(nativeSessionId);
        this.drainingSessions.delete(nativeSessionId);
      },
      keepBlocked: () => {
        if (done) return;
        done = true;
        state.leases -= 1;
        state.failed = true;
        this.drainStates.set(nativeSessionId, state);
        this.drainingSessions.add(nativeSessionId);
      },
    };
  }

  async create(
    params: CreateTerminalRequest,
    options: { env?: NodeJS.ProcessEnv } = {},
  ): Promise<CreateTerminalResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session || session.generation !== this.generation) throw ownershipError();
    if (this.drainingSessions.has(params.sessionId)
      || this.permanentSessions.has(params.sessionId)
      || this.fencedGenerations.has(this.generation)) {
      throw new TerminalOwnershipError('Terminal creation is blocked for this session.');
    }
    // Capture the binding epoch + generation this create was validated
    // against; both are re-checked after the child spawn settles.
    const bindingEpoch = this.sessionEpochs.get(params.sessionId) ?? 0;
    const generation = this.generation;

    if (this.records.size >= this.maxTotal) {
      throw new Error(`Shared runtime terminal limit (${this.maxTotal}) reached; release a terminal first.`);
    }
    let perSession = 0;
    for (const record of this.records.values()) {
      if (record.sessionId === params.sessionId) perSession += 1;
    }
    if (perSession >= this.maxPerSession) {
      throw new Error(`Session terminal limit (${this.maxPerSession}) reached; release a terminal first.`);
    }

    if (typeof params.command !== 'string' || params.command.length === 0) {
      throw invalidParams('command is required.');
    }
    for (const arg of params.args ?? []) {
      if (arg.includes('\0')) throw invalidParams('command arguments must not contain NUL bytes.');
    }
    const cwd = params.cwd || session.cwd;
    if (!isAbsolute(cwd)) throw invalidParams('cwd must be an absolute path.');
    let cwdStats;
    try {
      cwdStats = statSync(cwd);
    } catch {
      throw invalidParams('cwd must be an existing directory.');
    }
    if (!cwdStats.isDirectory()) throw invalidParams('cwd must be an existing directory.');
    const requestedByteLimit = params.outputByteLimit ?? this.defaultOutputByteLimit;
    if (!Number.isSafeInteger(requestedByteLimit) || requestedByteLimit < 0) {
      throw invalidParams('outputByteLimit must be a non-negative integer.');
    }
    // Kimi 0.38 may request a larger buffer than Gian's bounded service is
    // willing to retain. Clamp rather than rejecting terminal/create: the
    // response already reports truncation, so the hard memory cap remains
    // intact without disabling Bash/Grep/Glob for the whole turn.
    const byteLimit = Math.min(requestedByteLimit, HARD_MAX_OUTPUT_BYTE_LIMIT);
    const env: NodeJS.ProcessEnv = { ...options.env };
    for (const variable of params.env ?? []) {
      if (variable.name.includes('\0') || variable.value.includes('\0')) {
        throw invalidParams('environment variables must not contain NUL bytes.');
      }
      env[variable.name] = variable.value;
    }

    // detached:true makes the child its own POSIX process group leader, so
    // the whole tree can be signaled and reaped as one group. Spawn errors
    // (ENOENT, EACCES) reject before any record or quota is committed.
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // From here the create is in flight: track it so drains can wait for the
    // spawn window to settle.
    let settlePending!: () => void;
    const pendingPromise = new Promise<void>((resolve) => {
      settlePending = resolve;
    });
    const pending: PendingCreate = {
      sessionId: params.sessionId,
      generation,
      promise: pendingPromise,
    };
    if (child.pid !== undefined) pending.pid = child.pid;
    this.pendingCreates.push(pending);

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          child.off('spawn', onSpawn);
          child.off('error', onError);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
      if (this.spawnSeam) await this.spawnSeam();

      // Re-validate the captured epoch/generation/barrier state. A drain,
      // close, or runtime fence that began while the spawn was in flight
      // bumped the epoch (or fenced the generation): reap the just-spawned
      // group and refuse — no terminalId, no record, no quota.
      const stillValid = this.sessions.has(params.sessionId)
        && this.sessionEpochs.get(params.sessionId) === bindingEpoch
        && generation === this.generation
        && !this.fencedGenerations.has(generation)
        && !this.drainingSessions.has(params.sessionId);
      if (!stillValid) {
        // Fail closed with the exact failure: an unreapable raced orphan
        // surfaces as TerminalCleanupError (recorded in the orphan registry);
        // a successful reap rejects with the stable barrier error.
        await this.reapOrphanedGroup(child.pid!, params.sessionId);
        throw new TerminalOwnershipError('Terminal creation was cancelled by a cleanup barrier.');
      }
    } finally {
      settlePending();
      const index = this.pendingCreates.indexOf(pending);
      if (index !== -1) this.pendingCreates.splice(index, 1);
    }

    const terminalId = randomUUID();
    let resolveExit!: (exit: TerminalExit) => void;
    const exit = new Promise<TerminalExit>((resolve) => {
      resolveExit = resolve;
    });
    const record: TerminalRecord = {
      terminalId,
      sessionId: params.sessionId,
      generation: this.generation,
      pid: child.pid!,
      byteLimit,
      chunks: [],
      chunkBytes: [],
      totalBytes: 0,
      truncated: false,
      status: 'running',
      exitStatus: null,
      exit,
      harvest: Promise.resolve(),
    };
    this.records.set(terminalId, record);

    child.once('exit', (code, signal) => {
      record.exitStatus = { exitCode: code, signal: signal ?? null };
      resolveExit({ exitCode: code, signal: signal ?? null });
      if (record.status === 'running' || record.status === 'killing') {
        record.status = 'exited';
      }
    });

    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      this.appendOutput(record, stdout.write(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.appendOutput(record, stderr.write(chunk));
    });
    child.stdout.once('end', () => this.appendOutput(record, stdout.end()));
    child.stderr.once('end', () => this.appendOutput(record, stderr.end()));

    return { terminalId };
  }

  /** Kill a just-spawned group whose create lost the barrier race, and wait
   *  for its absence. Bounded and fail-closed: an unreapable orphan surfaces
   *  as the create's rejection reason. */
  private async reapOrphanedGroup(pgid: number, sessionId: string): Promise<void> {
    if (!this.groups.groupExists(pgid)) return;
    try {
      this.groups.signalGroup(pgid, 'SIGKILL');
    } catch (error) {
      this.rememberOrphan(pgid, sessionId, error);
      throw new TerminalCleanupError(
        `Orphaned terminal process group ${pgid} could not be signalled during the barrier race.`,
        { sessionId, pgid, cause: error },
      );
    }
    const deadline = Date.now() + this.groupVerifyMs;
    while (this.groups.groupExists(pgid)) {
      if (Date.now() >= deadline) {
        const error = new TerminalCleanupError(
          `Orphaned terminal process group ${pgid} survived SIGKILL during the barrier race.`,
          { sessionId, pgid },
        );
        this.rememberOrphan(pgid, sessionId, error);
        throw error;
      }
      await this.sleep(this.groupPollMs);
    }
  }

  private rememberOrphan(pgid: number, sessionId: string, error: unknown): void {
    if (this.orphanedGroups.length >= 50) this.orphanedGroups.shift();
    this.orphanedGroups.push({
      pgid,
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private appendOutput(record: TerminalRecord, text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    record.chunks.push(text);
    record.chunkBytes.push(bytes);
    record.totalBytes += bytes;
    while (record.totalBytes > record.byteLimit && record.chunks.length > 1) {
      record.totalBytes -= record.chunkBytes.shift()!;
      record.chunks.shift();
      record.truncated = true;
    }
    if (record.totalBytes > record.byteLimit) {
      // One chunk alone exceeds the budget: keep only its tail within it.
      const kept = tailWithinByteLimit(record.chunks[0]!, record.byteLimit);
      const keptBytes = Buffer.byteLength(kept, 'utf8');
      if (record.totalBytes - keptBytes > 0) record.truncated = true;
      record.chunks[0] = kept;
      record.chunkBytes[0] = keptBytes;
      record.totalBytes = keptBytes;
    }
  }

  private requireRecord(params: { sessionId: string; terminalId: string }): TerminalRecord {
    const record = this.records.get(params.terminalId);
    if (
      !record
      || record.sessionId !== params.sessionId
      || record.generation !== this.generation
      || !this.sessions.has(params.sessionId)
    ) {
      throw ownershipError();
    }
    return record;
  }

  output(params: TerminalOutputRequest): TerminalOutputResponse {
    const record = this.requireRecord(params);
    const response: TerminalOutputResponse = {
      output: record.chunks.join(''),
      truncated: record.truncated,
    };
    if (record.exitStatus !== null) response.exitStatus = record.exitStatus;
    return response;
  }

  waitForExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const record = this.requireRecord(params);
    // Concurrent and repeated waits share the single exit promise.
    return record.exit.then((exit) => ({ exitCode: exit.exitCode, signal: exit.signal }));
  }

  /** Kill the command without releasing the handle; final output stays
   *  readable. A failed harvest surfaces as TerminalCleanupError and keeps
   *  the handle for diagnosis or a later drain retry. */
  async kill(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const record = this.requireRecord(params);
    if (record.status === 'running') {
      record.status = 'killing';
      record.harvest = this.harvestGroup(record)
        .then(() => {
          if (record.status === 'killing') record.status = 'exited';
        })
        .catch((error: unknown) => {
          record.lastCleanupError = error instanceof Error ? error.message : String(error);
          if (record.status === 'killing') record.status = 'running';
          throw error;
        });
    }
    await record.harvest;
    return {};
  }

  /** Harvest (killing a still-running group, reaping leftover background
   *  members), await the exit, then drop the handle. */
  async release(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const record = this.requireRecord(params);
    await this.releaseRecord(record);
    return {};
  }

  private async releaseRecord(record: TerminalRecord): Promise<void> {
    if (record.status === 'released') return;
    if (record.status === 'releasing') {
      // A previous attempt may still be running (await it) or have failed
      // (retry with a fresh bounded harvest).
      try {
        await record.harvest;
        return;
      } catch {
        /* fall through to the retry below */
      }
    }
    record.status = 'releasing';
    record.harvest = (async () => {
      // A live group (root running or only background members left) is
      // TERM→KILLed and verified gone; a vanished group means the root
      // already exited and only its exit status remains to be collected.
      if (this.groups.groupExists(record.pid)) await this.harvestGroup(record);
      else await this.awaitRootExit(record);
      this.records.delete(record.terminalId);
      record.status = 'released';
    })();
    try {
      await record.harvest;
    } catch (error) {
      // Fail closed: keep the record, its PGID, and the reason. It is not
      // released; a later drain (or supervisor) can retry the harvest.
      record.lastCleanupError = error instanceof Error ? error.message : String(error);
      if (record.status === 'releasing') record.status = 'exited';
      throw error;
    }
  }

  /** TERM the whole process group, escalate to KILL after the grace window,
   *  and verify the group no longer exists. Every stage is bounded and every
   *  failure raises TerminalCleanupError instead of reporting success. */
  private async harvestGroup(record: TerminalRecord): Promise<void> {
    const pgid = record.pid;
    const details = { terminalId: record.terminalId, sessionId: record.sessionId, pgid };
    if (this.groups.groupExists(pgid)) {
      try {
        this.groups.signalGroup(pgid, 'SIGTERM');
      } catch (error) {
        throw new TerminalCleanupError(
          `Terminal ${record.terminalId} could not signal process group ${pgid} with SIGTERM.`,
          { ...details, cause: error },
        );
      }
      if (!await this.waitForGroupExit(record, this.termGraceMs)) {
        try {
          this.groups.signalGroup(pgid, 'SIGKILL');
        } catch (error) {
          throw new TerminalCleanupError(
            `Terminal ${record.terminalId} could not escalate process group ${pgid} to SIGKILL.`,
            { ...details, cause: error },
          );
        }
        if (!await this.waitForGroupExit(record, this.groupVerifyMs)) {
          throw new TerminalCleanupError(
            `Terminal ${record.terminalId} process group ${pgid} survived SIGKILL.`,
            details,
          );
        }
      }
    }
    await this.awaitRootExit(record);
  }

  /** Bounded poll of group absence. False means the deadline expired with
   *  members still alive. */
  private async waitForGroupExit(record: TerminalRecord, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (this.groups.groupExists(record.pid)) {
      if (Date.now() >= deadline) return false;
      await this.sleep(this.groupPollMs);
    }
    return true;
  }

  /** The root exit promise with a bounded final wait: no cleanup path can
   *  hang shutdown indefinitely. */
  private async awaitRootExit(record: TerminalRecord): Promise<void> {
    if (record.exitStatus !== null) return;
    const settled = await Promise.race([
      record.exit.then(() => true),
      this.sleep(this.exitSettleMs).then(() => false),
    ]);
    if (!settled) {
      throw new TerminalCleanupError(
        `Terminal ${record.terminalId} root process did not settle before the cleanup deadline.`,
        { terminalId: record.terminalId, sessionId: record.sessionId, pgid: record.pid },
      );
    }
  }

  /** Harvest every record of one session, then wait for its in-flight
   *  creates to settle (each rejected one reaps its own group). Unreapable
   *  barrier-race orphans of this session keep every drain failing: the
   *  barrier may not lift over an unverified PGID. */
  private async drainSessionRecords(nativeSessionId: string): Promise<void> {
    const failures = await this.releaseMatching(
      (record) => record.sessionId === nativeSessionId,
    );
    for (const orphan of this.orphanedGroups) {
      if (orphan.sessionId === nativeSessionId) {
        failures.push(`${orphan.pgid} (orphan): ${orphan.message}`);
      }
    }
    await Promise.allSettled(this.pendingCreates
      .filter((pending) => pending.sessionId === nativeSessionId)
      .map((pending) => pending.promise));
    if (failures.length > 0) {
      throw new TerminalCleanupError(
        `Terminal cleanup failed for session ${nativeSessionId}: ${failures.join(', ')}`,
      );
    }
  }

  /**
   * Convenience full drain for one session on top of the lease state machine:
   * raises the barrier, harvests, and — only on complete success — lifts a
   * temporary barrier or deletes the binding for a permanent one.
   */
  async drainSession(nativeSessionId: string): Promise<void> {
    const lease = this.beginSessionDrain(nativeSessionId);
    try {
      await lease.drain();
      lease.releaseForNextTurn();
    } catch (error) {
      lease.keepBlocked();
      throw error;
    }
  }

  async drainSessionPermanently(nativeSessionId: string): Promise<void> {
    const lease = this.beginSessionDrain(nativeSessionId, { permanent: true });
    try {
      await lease.drain();
      lease.releaseForNextTurn();
    } catch (error) {
      lease.keepBlocked();
      throw error;
    }
  }

  /** Drain every record (optionally one generation only) after awaiting that
   *  generation's in-flight creates, and aggregate all harvest failures;
   *  successful records are still fully cleaned. */
  async drainRuntime(generation?: number): Promise<void> {
    await Promise.allSettled(this.pendingCreates
      .filter((pending) => generation === undefined || pending.generation === generation)
      .map((pending) => pending.promise));
    const failures = await this.releaseMatching(
      (record) => generation === undefined || record.generation === generation,
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((message) => new TerminalCleanupError(message)),
        'Terminal cleanup failed for one or more terminals.',
      );
    }
  }

  /** Best-effort batch: every matching record is harvested; failures are
   *  returned as one message per record (never thrown). */
  private async releaseMatching(
    matches: (record: TerminalRecord) => boolean,
  ): Promise<string[]> {
    const records = [...this.records.values()].filter(matches);
    const failures: string[] = [];
    await Promise.all(records.map(async (record) => {
      try {
        await this.releaseRecord(record);
      } catch (error) {
        failures.push(
          `${record.terminalId} (pgid ${record.pid}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }));
    return failures;
  }
}
