import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export function resolveDataDir(): string {
  const fromEnv = process.env.GIAN_DATA_DIR;
  const dir = fromEnv ?? join(homedir(), '.config', 'gian');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function dbPath(dataDir: string): string {
  return join(dataDir, 'gian.db');
}
