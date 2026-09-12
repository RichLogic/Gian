import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { type StaticManifest } from './manifest.js';

export function writeStaticManifest(staticDir: string, buildId: string): StaticManifest {
  if (!existsSync(staticDir) || !statSync(staticDir).isDirectory()) {
    throw new Error(`static directory is missing: ${staticDir}`);
  }
  const files: Record<string, string> = {};
  walkFiles(staticDir, staticDir, files);
  const manifest: StaticManifest = { build_id: buildId, files };
  writeFileSync(join(staticDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function walkFiles(root: string, current: string, files: Record<string, string>): void {
  for (const entry of readdirSync(current)) {
    if (entry === 'manifest.json') continue;
    const absolute = join(current, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      walkFiles(root, absolute, files);
      continue;
    }
    if (!stats.isFile()) continue;
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (relativePath.includes('..')) {
      throw new Error(`static artifact path escaped the directory: ${relativePath}`);
    }
    files[relativePath] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  }
}

export function ensureStaticDir(staticDir: string): void {
  mkdirSync(staticDir, { recursive: true });
}
