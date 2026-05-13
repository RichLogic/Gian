/**
 * IM-side config shim. rvc has a `config.ts` at host root with constants
 * like `DISCORD_SECRET_KEY_FILE` + an `ensureDataDir()` helper. Gian's data
 * dir lives under `~/.config/gian/` (see `host/src/storage/paths.ts`); the
 * IM-specific keys live under that.
 */

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GIAN_DATA_DIR = join(homedir(), '.config', 'gian');

export const DISCORD_SECRET_KEY_FILE = join(GIAN_DATA_DIR, 'discord.key');
export const SLACK_SECRET_KEY_FILE = join(GIAN_DATA_DIR, 'slack.key');

/** Idempotent — used by `messaging/secrets.ts` before key file create. */
export async function ensureDataDir(): Promise<void> {
  await mkdir(GIAN_DATA_DIR, { recursive: true });
}
