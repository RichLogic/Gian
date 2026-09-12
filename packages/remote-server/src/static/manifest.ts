import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';

export interface StaticManifest {
  build_id: string;
  files: Record<string, string>;
}

export function loadAndVerifyManifest(staticDir: string): StaticManifest {
  const manifestPath = join(staticDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('static manifest is missing.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StaticManifest;
  if (!manifest.build_id || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('static manifest is malformed.');
  }
  for (const [relativePath, expected] of Object.entries(manifest.files)) {
    if (relativePath.includes('..') || relativePath.startsWith('/') || relativePath.includes('\\')) {
      throw new Error('static manifest path is unsafe.');
    }
    const absolute = join(staticDir, relativePath);
    const normalized = normalize(absolute);
    if (relative(staticDir, normalized).split(sep).includes('..')) {
      throw new Error('static manifest path escaped the artifact directory.');
    }
    if (!existsSync(normalized) || !statSync(normalized).isFile()) {
      throw new Error(`static artifact is missing: ${relativePath}`);
    }
    const actual = createHash('sha256').update(readFileSync(normalized)).digest('hex');
    if (actual !== expected) {
      throw new Error(`static artifact hash mismatch: ${relativePath}`);
    }
  }
  return manifest;
}
