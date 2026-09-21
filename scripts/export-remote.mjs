import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalProtocolLockfile, protocolPackageName, validateProtocolDependency } from '../delivery/remote/scripts/protocol-dependency.mjs';

export const remotePackages = ['shared', 'chat-ui', 'remote-server', 'remote-web'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commonFiles = new Set(['LICENSE', '.npmrc', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'scripts/check-node.js']);
export function remoteExportPath(path) {
  if (path === 'scripts/remote-deployment-system.test.mjs') return 'test/deployment.test.mjs';
  if (path.startsWith('delivery/remote/')) return path.slice('delivery/remote/'.length);
  if (commonFiles.has(path) || path.startsWith('patches/')) return path;
  if (remotePackages.some(name => path.startsWith(`packages/${name}/`))) {
    if (/\/(dist|node_modules|output|coverage)\//.test(path) || path.endsWith('.tsbuildinfo')) return null;
    if (path.startsWith('packages/shared/test/')) return null; // monorepo source-scan tests stay in GianDev
    return path;
  }
  return null;
}
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString() || 'git failed');
  return result.stdout;
}
export function exportRemote({ source = root, output, revision = 'HEAD', workingTree = false, protocolCoordinate }) {
  if (!output) throw new Error('--output is required');
  const target = resolve(output);
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || readdirSync(target).length)) {
    throw new Error('Export target must be a new or empty directory; existing repositories are never overwritten.');
  }
  const commit = git(source, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).toString().trim();
  const paths = git(source, workingTree
    ? ['ls-files', '--cached', '--others', '--exclude-standard', '-z']
    : ['ls-tree', '-r', '--name-only', '-z', commit]).toString().split('\0').filter(Boolean);
  const files = new Map();
  const sourceEntries = [];
  for (const path of [...new Set(paths)].sort()) {
    const dest = remoteExportPath(path);
    if (!dest) continue;
    if (dest.startsWith('/') || dest.split('/').some(part => !part || part === '..')) throw new Error(`Unsafe export path: ${dest}`);
    const mode = workingTree ? lstatSync(join(source, path)).mode : Number.parseInt(git(source, ['ls-tree', commit, '--', path]).toString().split(' ')[0], 8);
    if ((mode & 0o170000) !== 0o100000) throw new Error(`Export only accepts regular source files: ${path}`);
    const bytes = workingTree ? readFileSync(join(source, path)) : git(source, ['show', `${commit}:${path}`]);
    if (files.has(dest)) throw new Error(`Duplicate export path: ${dest}`);
    files.set(dest, { bytes, mode: mode & 0o111 ? 0o755 : 0o644 });
    sourceEntries.push({ source: path, path: dest, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const readSource = path => workingTree ? readFileSync(join(source, path)) : git(source, ['show', `${commit}:${path}`]);
  const original = JSON.parse(readSource('package.json'));
  const release = JSON.parse(files.get('release.json')?.bytes ?? 'null');
  if (!release || !/^\d+\.\d+\.\d+$/.test(release.version)) throw new Error('Missing stable Remote release configuration');
  const protocol = validateProtocolDependency(protocolCoordinate ?? JSON.parse(files.get('protocol-package.json')?.bytes ?? 'null'));
  const putJson = (path, value) => files.set(path, { bytes: Buffer.from(JSON.stringify(value, null, 2) + '\n'), mode: 0o644 });
  putJson('protocol-package.json', protocol);
  for (const name of ['remote-server', 'remote-web']) {
    const path = `packages/${name}/package.json`;
    const metadata = JSON.parse(files.get(path).bytes);
    if (metadata.dependencies?.[protocolPackageName] !== 'workspace:*') throw new Error(`Expected ${name} to declare its protocol dependency`);
    metadata.dependencies[protocolPackageName] = protocol.url;
    putJson(path, metadata);
    const configPath = `packages/${name}/tsconfig.json`;
    const config = JSON.parse(files.get(configPath).bytes);
    config.references = (config.references ?? []).filter(ref => ref.path !== '../remote-protocol');
    putJson(configPath, config);
  }
  const lockfile = files.get('pnpm-lock.yaml');
  if (!lockfile) throw new Error('A source lockfile is required');
  lockfile.bytes = Buffer.from(externalProtocolLockfile(lockfile.bytes.toString(), protocol, remotePackages.map(name => `packages/${name}`)));
  const build = ['shared', 'chat-ui', 'remote-server', 'remote-web'].map(name => `pnpm --filter @gian/${name} build`).join(' && ');
  const scripts = {
    preinstall: 'node scripts/check-node.js', build,
    typecheck: 'pnpm build && pnpm -r --if-present typecheck',
    test: 'node --test test/*.test.mjs && pnpm build && pnpm --filter @gian/remote-server test && pnpm --filter @gian/chat-ui test && pnpm --filter @gian/remote-web test',
    start: 'node packages/remote-server/dist/src/cli.js',
  };
  const packageJson = { name: 'gian-remote', version: release.version, private: true, description: 'Gian Remote Server and Web client', packageManager: original.packageManager, engines: original.engines, scripts, devDependencies: original.devDependencies };
  files.set('package.json', { bytes: Buffer.from(JSON.stringify(packageJson, null, 2) + '\n'), mode: 0o644 });
  const workspace = files.get('pnpm-workspace.yaml');
  workspace.bytes = Buffer.from(workspace.bytes.toString().replace(/^packages:\n(?:[ \t]+.*\n)+/, `packages:\n${remotePackages.map(name => `  - 'packages/${name}'`).join('\n')}\n`));
  files.set('tsconfig.json', { bytes: Buffer.from(JSON.stringify({ files: [], references: remotePackages.map(name => ({ path: `./packages/${name}` })) }, null, 2) + '\n'), mode: 0o644 });
  for (const name of remotePackages) {
    const metadata = JSON.parse(files.get(`packages/${name}/package.json`).bytes);
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [dep, version] of Object.entries(metadata[section] ?? {})) {
        if (String(version).startsWith('workspace:') && !remotePackages.some(p => dep === `@gian/${p}`)) throw new Error(`Missing Remote dependency: ${name} -> ${dep}`);
      }
    }
  }
  const manifest = { schema: 1, product: release.product, sourceRepository: 'RichLogic/Gian-Dev', sourceCommit: commit, workingTree, sharedPackages: ['shared', 'chat-ui'], externalPackages: [protocol], sourceEntries, files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, mode: file.mode, sha256: createHash('sha256').update(file.bytes).digest('hex') })) };
  files.set('.gian-source.json', { bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o644 });
  mkdirSync(target, { recursive: true });
  for (const [path, file] of files) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), file.bytes, { flag: 'wx', mode: file.mode });
    chmodSync(join(target, path), file.mode);
  }
  return { output: target, commit, workingTree, files: files.size };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output') options.output = args[++i];
    else if (args[i] === '--ref') options.revision = args[++i];
    else if (args[i] === '--working-tree') options.workingTree = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  console.log(JSON.stringify(exportRemote(options)));
}
