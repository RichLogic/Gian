import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ReplayEvent {
  method: string;
  eventId: string;
  sessionId: string;
  replayStreamId: string;
  sequence: number;
  sourceTurnId: string;
  emittedAt: string;
  data: Record<string, unknown>;
}

export interface NativeReplay {
  streamId: string;
  events: ReplayEvent[];
}

export class CodexNativeHistoryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private signature: string | null = null;
  private filePath: string | null = null;

  constructor(
    private nativeSessionId: string,
    private readonly onChange: () => void,
    private readonly intervalMs = 1_000,
    private readonly homeDir = homedir(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.signature = this.readSignature();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.signature = this.readSignature();
    this.paused = false;
  }

  retarget(nativeSessionId: string): void {
    this.nativeSessionId = nativeSessionId;
    this.filePath = null;
    this.resume();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    if (this.paused) return;
    const next = this.readSignature();
    if (next === this.signature) return;
    this.signature = next;
    this.onChange();
  }

  private readSignature(): string | null {
    if (!this.filePath) {
      this.filePath = findSession(this.nativeSessionId, this.homeDir)?.path ?? null;
    }
    if (!this.filePath) return null;
    try {
      const stat = statSync(this.filePath);
      return `${this.filePath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      this.filePath = null;
      return null;
    }
  }
}

interface CodexFile {
  path: string;
  id: string;
  cwd: string;
  updatedAt: string;
  displayName?: string;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

function inputIdentityHash(input: unknown): string {
  if (Array.isArray(input)) {
    const text = input.flatMap((item) => (
      item
      && typeof item === 'object'
      && (item as Record<string, unknown>).type === 'text'
      && typeof (item as Record<string, unknown>).text === 'string'
        ? [(item as { text: string }).text]
        : []
    ));
    if (text.length > 0) return stableId('input', { text });
  }
  return stableId('input', input);
}

interface NativeTurnIdentity {
  nativeSessionId: string;
  providerTurnId: string;
  inputHash: string;
  replayLineId?: string;
  lastUsedAt: number;
}

export interface NativeTurnIdentityStoreOptions {
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MAX_NATIVE_TURN_IDENTITIES = 4_096;

/** Persists the Provider turn identity associated with a rollout record.
 * Only input hashes are stored; prompt text never enters plugin state. */
export class NativeTurnIdentityStore {
  private readonly identities: NativeTurnIdentity[] = [];
  private readonly filePath: string | null;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    dataDir = process.env.GIAN_PLUGIN_DATA_DIR,
    options: NativeTurnIdentityStoreOptions = {},
  ) {
    this.maxEntries = Number.isSafeInteger(options.maxEntries) && (options.maxEntries ?? 0) > 0
      ? options.maxEntries!
      : DEFAULT_MAX_NATIVE_TURN_IDENTITIES;
    this.now = options.now ?? Date.now;
    this.filePath = dataDir ? join(dataDir, 'codex-native-turn-identities.json') : null;
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return;
      const loadedAt = this.now();
      for (const raw of parsed) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        if (
          typeof entry.nativeSessionId !== 'string'
          || typeof entry.providerTurnId !== 'string'
          || typeof entry.inputHash !== 'string'
        ) continue;
        this.identities.push({
          nativeSessionId: entry.nativeSessionId,
          providerTurnId: entry.providerTurnId,
          inputHash: entry.inputHash,
          ...(typeof entry.replayLineId === 'string' ? { replayLineId: entry.replayLineId } : {}),
          lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt)
            ? entry.lastUsedAt
            : loadedAt,
        });
      }
      if (this.prune()) this.persist();
    } catch {
      // Optional identity state must never prevent Proxy startup.
    }
  }

  recordLive(nativeSessionId: string, providerTurnId: string, input: unknown): string {
    const existing = this.identities.find((entry) => (
      entry.nativeSessionId === nativeSessionId && entry.providerTurnId === providerTurnId
    ));
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.providerTurnId;
    }
    this.identities.push({
      nativeSessionId,
      providerTurnId,
      inputHash: inputIdentityHash(input),
      lastUsedAt: this.now(),
    });
    this.persist();
    return providerTurnId;
  }

  resolveReplay(
    nativeSessionId: string,
    replayLineId: string,
    input: unknown,
    fallback: string,
  ): string {
    const bound = this.identities.find((entry) => (
      entry.nativeSessionId === nativeSessionId && entry.replayLineId === replayLineId
    ));
    if (bound) {
      bound.lastUsedAt = this.now();
      return bound.providerTurnId;
    }
    const inputHash = inputIdentityHash(input);
    const match = this.identities.find((entry) => (
      entry.nativeSessionId === nativeSessionId
      && entry.inputHash === inputHash
      && entry.replayLineId === undefined
    ));
    if (!match) return fallback;
    match.replayLineId = replayLineId;
    match.lastUsedAt = this.now();
    this.persist();
    return match.providerTurnId;
  }

  private prune(): boolean {
    if (this.identities.length <= this.maxEntries) return false;
    const keep = new Set(this.identities
      .map((entry, index) => ({ index, lastUsedAt: entry.lastUsedAt }))
      .sort((left, right) => (
        right.lastUsedAt - left.lastUsedAt || right.index - left.index
      ))
      .slice(0, this.maxEntries)
      .map(({ index }) => index));
    const retained = this.identities.filter((_entry, index) => keep.has(index));
    this.identities.splice(0, this.identities.length, ...retained);
    return true;
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      this.prune();
      const directory = this.filePath.slice(0, this.filePath.lastIndexOf('/'));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.identities)}\n`, { mode: 0o600 });
      renameSync(temporary, this.filePath);
    } catch {
      // Deterministic rollout-line identities remain available as fallback.
    }
  }
}

function collectRollouts(homeDir = homedir()): string[] {
  const root = join(homeDir, '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 3) return;
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (stat.isFile() && entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
        files.push(path);
      }
    }
  };
  walk(root, 0);
  return files;
}

function preview(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

function describe(path: string): CodexFile | null {
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    const first = lines[0];
    if (!first) return null;
    const metadata = JSON.parse(first) as Record<string, unknown>;
    if (metadata.type !== 'session_meta') return null;
    const payload = metadata.payload as Record<string, unknown> | undefined;
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
    if (!id || !cwd) return null;
    let displayName = '';
    for (const line of lines.slice(1)) {
      if (!line) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (record.type !== 'event_msg') continue;
      const event = record.payload as Record<string, unknown> | undefined;
      if (event?.type === 'user_message' && typeof event.message === 'string') {
        displayName = preview(event.message);
        break;
      }
    }
    return {
      path,
      id,
      cwd,
      updatedAt: statSync(path).mtime.toISOString(),
      ...(displayName ? { displayName } : {}),
    };
  } catch {
    return null;
  }
}

export function listCodexNativeSessions(
  cwd: string | undefined,
  homeDir = homedir(),
): Array<{ id: string; displayName?: string; cwd?: string; updatedAt?: string }> {
  return collectRollouts(homeDir)
    .flatMap(path => {
      const file = describe(path);
      return file && (!cwd || file.cwd === cwd) ? [file] : [];
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(file => ({
      id: file.id,
      ...(file.displayName ? { displayName: file.displayName } : {}),
      cwd: file.cwd,
      updatedAt: file.updatedAt,
    }));
}

function findSession(nativeSessionId: string, homeDir = homedir()): CodexFile | null {
  const matches = collectRollouts(homeDir).flatMap(path => {
    if (!path.endsWith(`-${nativeSessionId}.jsonl`)) return [];
    const file = describe(path);
    return file?.id === nativeSessionId ? [file] : [];
  });
  matches.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return matches[0] ?? null;
}

export function replayCodexNativeSession(
  hostSessionId: string,
  nativeSessionId: string,
  homeDir = homedir(),
  identityStore?: NativeTurnIdentityStore,
): NativeReplay {
  const file = findSession(nativeSessionId, homeDir);
  if (!file) return { streamId: stableId('replay', { nativeSessionId, empty: true }), events: [] };
  const content = readFileSync(file.path, 'utf8');
  const fallback = new Date(0).toISOString();
  const turns: Array<{
    id: string;
    timestamp: string;
    input: string;
    messages: Array<{ id: string; timestamp: string; text: string }>;
  }> = [];
  let turn: (typeof turns)[number] | null = null;
  for (const [lineIndex, line] of content.split('\n').entries()) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (record.type !== 'event_msg') continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    const timestamp = typeof record.timestamp === 'string' && !Number.isNaN(Date.parse(record.timestamp))
      ? new Date(Date.parse(record.timestamp)).toISOString()
      : fallback;
    const lineId = stableId('codex-line', { nativeSessionId, lineIndex, line });
    if (payload?.type === 'user_message' && typeof payload.message === 'string') {
      turn = { id: lineId, timestamp, input: payload.message, messages: [] };
      turns.push(turn);
    } else if (
      payload?.type === 'agent_message'
      && typeof payload.message === 'string'
      && turn
    ) {
      turn.messages.push({ id: lineId, timestamp, text: payload.message });
    }
  }

  const streamId = stableId('replay', { nativeSessionId });
  let sequence = 0;
  const events: ReplayEvent[] = [];
  const append = (
    sourceTurnId: string,
    emittedAt: string,
    eventId: string,
    method: string,
    data: Record<string, unknown>,
  ) => {
    sequence += 1;
    events.push({
      method,
      eventId,
      sessionId: hostSessionId,
      replayStreamId: streamId,
      sequence,
      sourceTurnId,
      emittedAt,
      data,
    });
  };
  for (const [index, item] of turns.entries()) {
    const fallbackSourceTurnId = stableId('replay-turn', { nativeSessionId, inputId: item.id, index });
    const sourceTurnId = identityStore?.resolveReplay(
      nativeSessionId,
      item.id,
      [{ type: 'text', text: item.input }],
      fallbackSourceTurnId,
    ) ?? fallbackSourceTurnId;
    append(
      sourceTurnId,
      item.timestamp,
      stableId('provider-event', {
        nativeSessionId,
        sourceTurnId,
        method: 'turn.started',
        identity: 'lifecycle',
      }),
      'turn.started',
      {},
    );
    append(sourceTurnId, item.timestamp, stableId('input', item.id), 'input.recorded', {
      input: [{ type: 'text', text: item.input }],
    });
    for (const [messageIndex, message] of item.messages.entries()) {
      const contentId = `text:${messageIndex + 1}`;
      append(
        sourceTurnId,
        message.timestamp,
        stableId('provider-event', {
          nativeSessionId,
          sourceTurnId,
          method: 'content.completed',
          identity: contentId,
        }),
        'content.completed',
        {
          contentId,
          kind: 'text',
          content: message.text,
        },
      );
    }
    const completedAt = item.messages.at(-1)?.timestamp ?? item.timestamp;
    append(
      sourceTurnId,
      completedAt,
      stableId('provider-event', {
        nativeSessionId,
        sourceTurnId,
        method: 'turn.completed',
        identity: 'lifecycle',
      }),
      'turn.completed',
      { stopReason: 'completed' },
    );
  }
  return { streamId, events };
}

function turnGroups(snapshot: NativeReplay): Map<string, ReplayEvent[]> {
  const groups = new Map<string, ReplayEvent[]>();
  for (const event of snapshot.events) {
    const events = groups.get(event.sourceTurnId) ?? [];
    events.push(event);
    groups.set(event.sourceTurnId, events);
  }
  return groups;
}

function groupFingerprint(events: ReplayEvent[]): string {
  return JSON.stringify(events.map((event) => ({
    method: event.method,
    sourceTurnId: event.sourceTurnId,
    data: event.data,
  })));
}

function revisionStreamId(
  snapshot: NativeReplay,
  fingerprints: Map<string, string>,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([...fingerprints]))
    .digest('hex')
    .slice(0, 24);
  return `${snapshot.streamId}-revision-${digest}`;
}

/** Tracks complete replay turns instead of raw file bytes. A changed turn is
 * replayed as one lifecycle-complete unit, while turns already observed from
 * Gian's own runtime writes stay out of external-history refreshes. */
export class IncrementalReplayTracker {
  private observed = new Map<string, string>();
  private includedTurns = new Set<string>();
  private latest: NativeReplay = { streamId: 'replay-empty', events: [] };
  private replayStreamId = 'replay-empty';

  attach(snapshot: NativeReplay, includeHistory: boolean): void {
    this.latest = snapshot;
    const groups = turnGroups(snapshot);
    this.observed = new Map(
      [...groups].map(([turnId, events]) => [turnId, groupFingerprint(events)]),
    );
    this.includedTurns = includeHistory ? new Set(groups.keys()) : new Set();
    this.replayStreamId = snapshot.streamId;
  }

  observe(snapshot: NativeReplay): boolean {
    const groups = turnGroups(snapshot);
    const nextFingerprints = new Map(
      [...groups].map(([turnId, events]) => [turnId, groupFingerprint(events)]),
    );
    const currentOrder = [...groups.keys()];
    const previousIncluded = [...this.includedTurns];
    const lastPreviousIndex = previousIncluded.reduce(
      (last, turnId) => Math.max(last, currentOrder.indexOf(turnId)),
      -1,
    );
    let changed = false;
    let rewritten = snapshot.streamId !== this.latest.streamId;

    for (const [turnId, events] of groups) {
      const fingerprint = groupFingerprint(events);
      const previous = this.observed.get(turnId);
      if (previous === fingerprint) continue;
      changed = true;
      if (previous !== undefined || currentOrder.indexOf(turnId) < lastPreviousIndex) {
        rewritten = true;
      }
      this.includedTurns.add(turnId);
    }
    for (const turnId of previousIncluded) {
      if (groups.has(turnId)) continue;
      this.includedTurns.delete(turnId);
      changed = true;
      rewritten = true;
    }
    this.observed = nextFingerprints;
    this.latest = snapshot;
    if (rewritten) this.replayStreamId = revisionStreamId(snapshot, nextFingerprints);
    return changed;
  }

  rebase(snapshot: NativeReplay): void {
    const included = new Set(this.includedTurns);
    this.latest = snapshot;
    const groups = turnGroups(snapshot);
    this.observed = new Map(
      [...groups].map(([turnId, events]) => [turnId, groupFingerprint(events)]),
    );
    this.includedTurns = new Set([...included].filter((turnId) => groups.has(turnId)));
  }

  replay(): NativeReplay {
    const selected = this.latest.events.filter((event) => (
      this.includedTurns.has(event.sourceTurnId)
    ));
    return {
      streamId: this.replayStreamId,
      events: selected.map((event, index) => ({
        ...event,
        replayStreamId: this.replayStreamId,
        sequence: index + 1,
      })),
    };
  }

  acknowledge(): void {
    // Acknowledgement ends the current paging pass. Published turns stay in
    // the replay snapshot so later append-only refreshes preserve their
    // sequence numbers and Host can deduplicate them by stable eventId.
  }
}
