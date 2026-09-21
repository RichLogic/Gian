import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { protocolPackageName, validateProtocolDependency } from './protocol-dependency.mjs';

export function verifySource(root = process.cwd()) {
  const manifest = JSON.parse(readFileSync(join(root, '.gian-source.json')));
  if (existsSync(join(root, 'packages/remote-protocol'))) throw new Error('Remote must consume the Gian protocol package, not a protocol source directory');
  const protocol = validateProtocolDependency(JSON.parse(readFileSync(join(root, 'protocol-package.json'))));
  if (JSON.stringify(manifest.externalPackages) !== JSON.stringify([protocol])) throw new Error('Protocol dependency differs from exported provenance');
  for (const name of ['remote-server', 'remote-web']) {
    const metadata = JSON.parse(readFileSync(join(root, `packages/${name}/package.json`)));
    if (metadata.dependencies?.[protocolPackageName] !== protocol.url) throw new Error('Remote protocol dependency must point to its exact public Gian archive');
  }
  if (manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid source provenance');
  const paths = new Set(['.gian-source.json']);
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(file.path)) throw new Error('Unsafe or duplicate source manifest path');
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid source digest');
    paths.add(file.path);
    const full = join(root, file.path);
    if (realpathSync(full) !== join(realpathSync(root), file.path)) throw new Error(`Source traverses a symlink: ${file.path}`);
    if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) throw new Error(`Source must be a regular file: ${file.path}`);
    if (createHash('sha256').update(readFileSync(full)).digest('hex') !== file.sha256) throw new Error(`Source differs from exported snapshot: ${file.path}`);
  }
  if (existsSync(join(root, '.git'))) {
    const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Cannot inspect public source boundary');
    for (const path of result.stdout.split('\0').filter(Boolean)) if (!paths.has(path)) throw new Error(`Unrecorded tracked source file: ${path}`);
  }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = verifySource();
  console.log(`Verified ${manifest.files.length} Remote source files from ${manifest.sourceCommit}`);
}
