import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { protocolPackageName, validateProtocolDependency } from './protocol-dependency.mjs';

export function verifySource(root = process.cwd()) {
  const manifest = JSON.parse(readFileSync(join(root, '.gian-source.json')));
  const protocol = validateProtocolDependency(JSON.parse(readFileSync(join(root, 'protocol-package.json'))));
  if (manifest.schema !== 1 || manifest.product !== 'Gian-Proxies' || manifest.workingTree !== false
    || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') || !Array.isArray(manifest.files)
    || !manifest.files.length || JSON.stringify(manifest.externalPackages) !== JSON.stringify([protocol])) throw new Error('Invalid Proxy source provenance');
  for (const forbidden of ['packages/host', 'packages/web', 'packages/desktop', 'packages/proxy-protocol', '.ai']) {
    if (existsSync(join(root, forbidden))) throw new Error(`Forbidden product source: ${forbidden}`);
  }
  const paths = new Set(['.gian-source.json']);
  let consumers = 0;
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || file.path.includes('\\')
      || file.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(file.path)) throw new Error('Unsafe source manifest path');
    const path = join(root, file.path);
    if (realpathSync(path) !== join(realpathSync(root), file.path) || !lstatSync(path).isFile()
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) throw new Error(`Source differs from export: ${file.path}`);
    paths.add(file.path);
    if (file.path.endsWith('/package.json')) {
      const metadata = JSON.parse(readFileSync(path));
      const dependency = metadata.dependencies?.[protocolPackageName];
      if (dependency) {
        if (dependency !== protocol.url) throw new Error('Proxy protocol dependency is not the public pinned archive');
        consumers++;
      }
    }
  }
  if (!consumers) throw new Error('No public protocol consumers');
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot inspect tracked public source');
  for (const path of result.stdout.split('\0').filter(Boolean)) if (!paths.has(path)) throw new Error(`Unrecorded tracked source: ${path}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Verified ${verifySource().files.length} exported Proxy product files`);
}
