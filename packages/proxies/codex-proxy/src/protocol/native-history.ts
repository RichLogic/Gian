import { createHash } from 'node:crypto';
import {
  existsSync,
  openSync,
  closeSync,
  readSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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

export class CodexNativeHistoryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private signature: string | null = null;
  private filePath: string | null = null;
  private refreshing = false;

  constructor(
    private nativeSessionId: string,
    private readonly onChange: () => void | Promise<void>,
    private readonly intervalMs = 1_000,
    private readonly homeDir?: string,
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
    if (this.paused || this.refreshing) return;
    const next = this.readSignature();
    if (next === this.signature) return;
    this.signature = next;
    this.refreshing = true;
    Promise.resolve().then(() => this.onChange()).catch(error => {
      console.warn(`[codex-history] refresh failed: ${String(error)}`);
    }).finally(() => { this.refreshing = false; });
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

export interface CodexFile {
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

function collectRollouts(homeDir?: string, includeArchived = false): string[] {
  const configured = process.env.CODEX_HOME;
  const configHome = homeDir !== undefined
    ? join(homeDir, '.codex')
    : configured && isAbsolute(configured) ? configured : join(homedir(), '.codex');
  const roots = [join(configHome, 'sessions'), ...(includeArchived ? [join(configHome, 'archived_sessions')] : [])];
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
  for (const root of roots) if (existsSync(root)) walk(root, 0);
  return files;
}

function preview(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

function describe(path: string): CodexFile | null {
  let fd: number | undefined;
  try {
    // Discovery needs metadata and an optional preview, never the whole log.
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, count).toString('utf8');
    const lines = text.split('\n');
    if (count === buffer.length) lines.pop();
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
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function listCodexNativeSessions(
  cwd: string | undefined,
  homeDir?: string,
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

export function findSession(nativeSessionId: string, homeDir?: string): CodexFile | null {
  const candidates = collectRollouts(homeDir, true).filter(path => path.endsWith(`-${nativeSessionId}.jsonl`));
  const matches = candidates.flatMap(path => {
    const file = describe(path);
    return file?.id === nativeSessionId ? [file] : [];
  });
  if (candidates.length && !matches.length) throw new Error('Codex native history metadata is unavailable or invalid.');
  matches.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return matches[0] ?? null;
}
