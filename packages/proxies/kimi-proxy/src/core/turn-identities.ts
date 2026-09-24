import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Persist only turn IDs, never prompt text. ACP replay can enrich the user's
 * input with runtime reminders, so re-hashing replay text changes live IDs. */
export class KimiTurnIdentityStore {
  private readonly sessions = new Map<string, Map<number, string>>();
  constructor(private readonly dataDir = process.env.GIAN_PLUGIN_DATA_DIR) {}

  private file(nativeSessionId: string): string | null {
    if (!this.dataDir) return null;
    const key = createHash('sha256').update(nativeSessionId).digest('hex');
    return join(this.dataDir, 'kimi-turn-identities', `${key}.json`);
  }

  private entries(nativeSessionId: string): Map<number, string> {
    const known = this.sessions.get(nativeSessionId);
    if (known) return known;
    const entries = new Map<number, string>();
    const file = this.file(nativeSessionId);
    if (file && existsSync(file)) {
      if (statSync(file).size > 4 * 1024 * 1024) throw new Error('Kimi turn identity record exceeds its read limit.');
      const saved = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!Array.isArray(saved)) throw new Error('Invalid Kimi turn identity record.');
      for (const row of saved) {
        if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0
          || typeof row[1] !== 'string' || !/^kimi-turn-[a-f0-9]+$/.test(row[1])) {
          throw new Error('Invalid Kimi turn identity entry.');
        }
        entries.set(row[0] as number, row[1]);
      }
    }
    this.sessions.set(nativeSessionId, entries);
    return entries;
  }

  resolve(nativeSessionId: string, turnIndex: number, fallback: string): string {
    return this.entries(nativeSessionId).get(turnIndex) ?? fallback;
  }

  remember(nativeSessionId: string, turnIndex: number, sourceTurnId: string): void {
    const entries = this.entries(nativeSessionId);
    if (entries.has(turnIndex)) return;
    entries.set(turnIndex, sourceTurnId);
    const file = this.file(nativeSessionId);
    if (!file || !this.dataDir) return;
    try {
      mkdirSync(join(this.dataDir, 'kimi-turn-identities'), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify([...entries]), { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      entries.delete(turnIndex);
      throw new Error('Could not persist Kimi turn identity; turn was not started.');
    }
  }
}
