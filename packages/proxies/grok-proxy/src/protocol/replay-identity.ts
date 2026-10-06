import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface NativeTurnIdentity {
  nativeSessionId: string;
  sourceTurnId: string;
  inputHash: string;
  /** Absolute prompt ordinal in the native session, recorded only when the
   *  attach could prove it (fresh session, verified replay, or fork seed). */
  replayIndex?: number;
  lastUsedAt: number;
}

/** Disk marker distinguishing proven ordinals from legacy hash-guessed ones.
 *  Records written before positional identity was enforced carry a
 *  `replayIndex` derived from text-hash matching; repeated text made those
 *  guesses unreliable, so they are loaded WITHOUT a positional binding. */
const ORDINAL_PROVEN_FIELD = 'ordinalProven';

export interface NativeTurnIdentityStoreOptions {
  maxEntries?: number;
  now?: () => number;
}

export interface ReplayIdentityResolution {
  sourceTurnId: string;
  /** true: ordinal binding and input hash agree. false: the native history at
   *  this ordinal diverges from the recorded identity — the binding must not
   *  be used. null: no ordinal binding exists; the fallback is in use. */
  consistent: boolean | null;
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

/**
 * Persists Host sourceTurnId for Grok native sessions. Only input hashes are
 * stored, never prompt plaintext.
 *
 * Identity is positional: `nativeSessionId + absolute prompt ordinal`. The
 * input hash only *verifies* a positional binding — it never creates one, so
 * repeated identical prompts can never steal each other's identity. Replay
 * turns without a positional binding get a deterministic fallback that is NOT
 * persisted: it cannot collide, and it never claims to be an old live id.
 */
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
        // Legacy records guessed replayIndex from the text hash; only entries
        // written with the proven marker keep a positional binding.
        const provenOrdinal = entry[ORDINAL_PROVEN_FIELD] === true
          && typeof entry.replayIndex === 'number'
          && Number.isSafeInteger(entry.replayIndex)
          ? entry.replayIndex
          : undefined;
        this.identities.push({
          nativeSessionId: entry.nativeSessionId,
          sourceTurnId: entry.sourceTurnId,
          inputHash: entry.inputHash,
          lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt)
            ? entry.lastUsedAt
            : loadedAt,
          ...(provenOrdinal !== undefined ? { replayIndex: provenOrdinal } : {}),
        });
      }
      if (this.prune()) this.persist();
    } catch {
      /* Optional identity state must never prevent Proxy startup. */
    }
  }

  /**
   * Record a live Host turn. Called only after the native prompt was actually
   * dispatched — local input failures and phantom turns never create entries.
   * `ordinal` is the proven absolute native prompt ordinal; without it the
   * entry exists for cross-reference but can never bind a replay position.
   */
  recordLive(nativeSessionId: string, sourceTurnId: string, input: unknown, ordinal?: number): string {
    const inputHash = inputIdentityHash(input);
    const existing = this.identities.find((entry) => (
      entry.nativeSessionId === nativeSessionId && entry.sourceTurnId === sourceTurnId
    ));
    if (existing) {
      existing.lastUsedAt = this.now();
      if (ordinal !== undefined) existing.replayIndex = ordinal;
      existing.inputHash = inputHash;
      this.persist();
      return existing.sourceTurnId;
    }
    this.identities.push({
      nativeSessionId,
      sourceTurnId,
      inputHash,
      lastUsedAt: this.now(),
      ...(ordinal !== undefined ? { replayIndex: ordinal } : {}),
    });
    this.persist();
    return sourceTurnId;
  }

  resolveReplay(
    nativeSessionId: string,
    replayIndex: number,
    input: unknown,
    fallback: string,
  ): ReplayIdentityResolution {
    const bound = this.identities.find((entry) => (
      entry.nativeSessionId === nativeSessionId && entry.replayIndex === replayIndex
    ));
    if (!bound) return { sourceTurnId: fallback, consistent: null };
    bound.lastUsedAt = this.now();
    // A hash mismatch means the native history at this ordinal no longer is
    // the prompt we recorded (compact/rewind/external edit). Never bind.
    if (bound.inputHash !== inputIdentityHash(input)) {
      return { sourceTurnId: fallback, consistent: false };
    }
    return { sourceTurnId: bound.sourceTurnId, consistent: true };
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
      // In-memory replayIndex is only ever set from proven positions; mark
      // that on disk so future loads can tell it apart from legacy guesses.
      const serialized = this.identities.map((entry) => (
        entry.replayIndex !== undefined ? { ...entry, [ORDINAL_PROVEN_FIELD]: true } : entry
      ));
      writeFileSync(temporary, `${JSON.stringify(serialized)}\n`, { mode: 0o600 });
      renameSync(temporary, this.filePath);
    } catch {
      /* Deterministic fallback identities remain available. */
    }
  }
}
