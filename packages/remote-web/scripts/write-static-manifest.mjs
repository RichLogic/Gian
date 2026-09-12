import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(process.argv[2] ?? join(root, '..', 'dist'));
const buildId = process.env.GIAN_REMOTE_BUILD_ID?.trim() || `remote-web-${Date.now()}`;

if (!existsSync(staticDir) || !statSync(staticDir).isDirectory()) {
  throw new Error(`vite dist is missing: ${staticDir}`);
}

const files = {};
const walk = (current) => {
  for (const entry of readdirSync(current)) {
    if (entry === 'manifest.json') continue;
    const absolute = join(current, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (!stats.isFile()) continue;
    const relativePath = relative(staticDir, absolute).split(sep).join('/');
    files[relativePath] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  }
};
walk(staticDir);
writeFileSync(join(staticDir, 'manifest.json'), `${JSON.stringify({ build_id: buildId, files }, null, 2)}\n`);
process.stdout.write(`wrote ${join(staticDir, 'manifest.json')} (${Object.keys(files).length} files)\n`);
