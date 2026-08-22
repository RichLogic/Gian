import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface NativeTurnIdentity {
  nativeSessionId: string;
  sourceTurnId: string;
  inputHash: string;
  replayIndex?: number;
  lastUsedAt: number;
}

export interface NativeTurnIdentityStoreOptions {
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MAX_NATIVE_TURN_IDENTITIES = 4_096;

function inputIdentityHash(input: unknown): string {
  const texts: string[] = [];
  if (typeof input === 'string') {
    texts.push(input);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const record = item as { type?: unknown; text?: unknown };
      if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text);
    }
  }
  return createHash('sha256').update(JSON.stringify(texts)).digest('hex').slice(0, 32);
}

/** Persists Host sourceTurnId for Grok native sessions. Only input hashes are stored. */
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
    this.filePath = dataDir ? join(dataDir, 'grok-native-turn-identities.json') : null;
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
          || typeof entry.sourceTurnId !== 'string'
          || typeof entry.inputHash !== 'string'
        ) continue;
        this.identities.push({
          nativeSessionId: entry.nativeSessionId,
          sourceTurnId: entry.sourceTurnId,
          inputHash: entry.inputHash,
          lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt)
            ? entry.lastUsedAt
            : loadedAt,
          ...(typeof entry.replayIndex === 'number' && Number.isSafeInteger(entry.replayIndex)
            ? { replayIndex: entry.replayIndex }
            : {}),
        });
      }
      if (this.prune()) this.persist();
    } catch {
      /* Optional identity state must never prevent Proxy startup. */
    }
  }

  recordLive(nativeSessionId: string, sourceTurnId: string, input: unknown): string {
    const existing = this.identities.find((entry) => (
      entry.nativeSessionId === nativeSessionId && entry.sourceTurnId === sourceTurnId
    ));
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.sourceTurnId;
    }
    this.identities.push({
      nativeSessionId,
      sourceTurnId,
      inputHash: inputIdentityHash(input),
      lastUsedAt: this.now(),
    });
    this.persist();
    return sourceTurnId;
  }

  resolveReplay(
    nativeSessionId: string,
    replayIndex: number,
    input: unknown,
    fallback: string,
  ): string {
    const bound = this.identities.find((entry) => (
      entry.nativeSessionId === nativeSessionId && entry.replayIndex === replayIndex
    ));
    if (bound) {
      bound.lastUsedAt = this.now();
      return bound.sourceTurnId;
    }
    const inputHash = inputIdentityHash(input);
    const match = this.identities.find((entry) => (
      entry.nativeSessionId === nativeSessionId
      && entry.inputHash === inputHash
      && entry.replayIndex === undefined
    ));
    if (!match) return fallback;
    match.replayIndex = replayIndex;
    match.lastUsedAt = this.now();
    this.persist();
    return match.sourceTurnId;
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
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.identities)}\n`, { mode: 0o600 });
      renameSync(temporary, this.filePath);
    } catch {
      /* Deterministic fallback identities remain available. */
    }
  }
}
