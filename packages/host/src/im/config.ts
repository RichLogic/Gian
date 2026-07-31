/** Paths for encrypted IM credentials in Gian's data directory. */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDataDir } from '../storage/paths.js';

const GIAN_DATA_DIR = resolveDataDir();

export const DISCORD_SECRET_KEY_FILE = join(GIAN_DATA_DIR, 'discord.key');
export const SLACK_SECRET_KEY_FILE = join(GIAN_DATA_DIR, 'slack.key');

/** Idempotent — used by `messaging/secrets.ts` before key file create. */
export async function ensureDataDir(): Promise<void> {
  await mkdir(GIAN_DATA_DIR, { recursive: true });
}
