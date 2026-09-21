import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolPackageName, validateProtocolDependency } from '../delivery/proxies/scripts/protocol-dependency.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const common = new Set(['LICENSE', '.npmrc', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
  'scripts/check-node.js', 'scripts/build-proxy-artifacts.mjs', 'scripts/proxy-release-metadata.mjs',
  'scripts/build-managed-runtime-candidates.mjs', 'scripts/verify-managed-runtime-candidates.mjs',
  'scripts/stage-official-catalog-release.mjs']);

export function proxiesExportPath(path) {
  if (path === 'scripts/check-node.js') return 'scripts/check-node.cjs';
  if (path.startsWith('delivery/proxies/')) return path.slice('delivery/proxies/'.length);
  if (path === 'packages/host/src/runtime/safe-extract.ts' || path === 'packages/host/src/runtime/errors.ts') {
    return `support/runtime-extractor/src/${path.split('/').at(-1)}`;
  }
  if (common.has(path) || path.startsWith('patches/') || path.startsWith('runtimes/deepseek-harness/')) return path;
  if (path.startsWith('catalog/official-source/')) return /\/(dist|node_modules)\//.test(path) ? null : path;
  if (path.startsWith('catalog/proxy-information/')) return /\/(dist|node_modules)\//.test(path) ? null : path;
  if (/^packages\/(proxies\/[^/]+|shared|proxy-catalog-contract)\//.test(path)) {
    if (/\/(dist|node_modules|output|coverage)\//.test(path) || path.endsWith('.tsbuildinfo')) return null;
    if (path.startsWith('packages/shared/test/')) return null;
    return path;
  }
  return null;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString() || 'git failed');
  return result.stdout;
}

function yaml(text) {
  // Use the platform YAML parser; JSON output is also valid pnpm YAML.
  const result = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read, aliases: true))'], {
    input: text, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'A Ruby YAML parser is required for source export');
  return JSON.parse(result.stdout);
}

export function externalProxyLockfile(lock, coordinate, directories, rootDependencies) {
  if (String(lock.lockfileVersion) !== '9.0' || !lock.importers || !lock.packages || !lock.snapshots) throw new Error('Unsupported pnpm lockfile');
  const result = structuredClone(lock);
  const wanted = ['.', ...directories];
  result.importers = Object.fromEntries(wanted.map(path => {
    if (!lock.importers[path]) throw new Error(`Missing source importer: ${path}`);
    return [path, structuredClone(lock.importers[path])];
  }));
  const rootImporter = result.importers['.'];
  rootImporter.devDependencies = Object.fromEntries(Object.entries(rootImporter.devDependencies ?? {}).filter(([name]) => Object.hasOwn(rootDependencies, name)));
  for (const importer of Object.values(result.importers)) {
    for (const section of ['dependencies', 'devDependencies']) {
      const dependency = importer[section]?.[protocolPackageName];
      if (!dependency) continue;
      if (dependency.specifier !== 'workspace:*') throw new Error('Unexpected source protocol dependency');
      importer[section][protocolPackageName] = { specifier: coordinate.url, version: coordinate.url };
    }
  }
  for (const [name, version] of Object.entries(coordinate.dependencies)) {
    if (!Object.hasOwn(result.packages, `${name}@${version}`) || !Object.hasOwn(result.snapshots, `${name}@${version}`)) {
      throw new Error(`Protocol dependency is absent from the source lock: ${name}@${version}`);
    }
  }
  const key = `${protocolPackageName}@${coordinate.url}`;
  result.packages[key] = { resolution: { integrity: coordinate.integrity, tarball: coordinate.url }, version: coordinate.version };
  result.snapshots[key] = { dependencies: coordinate.dependencies };
  return result;
}

export function exportProxies({ source = root, output, revision = 'HEAD' }) {
  if (!output) throw new Error('--output is required');
  const target = resolve(output);
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || readdirSync(target).length)) {
    throw new Error('Export target must be new or empty; existing repositories are never overwritten');
  }
  const commit = git(source, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).toString().trim();
  const files = new Map();
  const sourceEntries = [];
  for (const line of git(source, ['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [mode, type] = line.slice(0, tab).split(' ');
    const path = line.slice(tab + 1);
    const dest = proxiesExportPath(path);
    if (!dest) continue;
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || files.has(dest)) throw new Error(`Unsafe export entry: ${path}`);
    const bytes = git(source, ['show', `${commit}:${path}`]);
    files.set(dest, { bytes, mode: mode === '100755' ? 0o755 : 0o644 });
    sourceEntries.push({ source: path, path: dest, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const put = (path, value) => files.set(path, { bytes: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'), mode: 0o644 });
  const json = path => JSON.parse(files.get(path)?.bytes ?? 'null');
  const coordinate = validateProtocolDependency(json('protocol-package.json'));
  const original = JSON.parse(git(source, ['show', `${commit}:package.json`]));
  const directories = [...files.keys()].filter(path => /^packages\/(?:proxies\/[^/]+|shared|proxy-catalog-contract)\/package.json$/.test(path)).map(path => dirname(path)).sort();
  const names = new Set(directories.map(path => json(`${path}/package.json`).name));
  for (const directory of directories) {
    const metadata = json(`${directory}/package.json`);
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, value] of Object.entries(metadata[section] ?? {})) {
        if (name === protocolPackageName) metadata[section][name] = coordinate.url;
        else if (String(value).startsWith('workspace:') && !names.has(name)) throw new Error(`Missing standalone dependency: ${name}`);
      }
    }
    put(`${directory}/package.json`, metadata);
    const config = json(`${directory}/tsconfig.json`);
    if (config.references) config.references = config.references.filter(ref => !ref.path.endsWith('/proxy-protocol'));
    put(`${directory}/tsconfig.json`, config);
    const manifest = json(`${directory}/manifest.json`);
    if (metadata.gianProxy?.shipping && manifest) {
      const entryPath = `catalog/official-source/plugins/${manifest.id}/entry.json`;
      const entry = json(entryPath);
      if (!entry) throw new Error(`Missing Catalog source: ${manifest.id}`);
      entry.channels.stable = { pluginVersion: manifest.pluginVersion };
      put(entryPath, entry);
      put(`catalog/official-source/plugins/${manifest.id}/sidecar.json`, manifest);
    }
  }
  const dependencies = Object.fromEntries(Object.entries(original.devDependencies).filter(([name]) => name !== '@playwright/test'));
  put('package.json', {
    name: 'gian-proxies', private: true, type: 'module',
    description: 'Official Gian Proxy packages and signed Catalog', packageManager: original.packageManager, engines: original.engines,
    scripts: { preinstall: 'node scripts/check-node.cjs', build: 'node scripts/release-product.mjs build',
      qualify: 'node scripts/release-product.mjs qualify', publish: 'node scripts/release-product.mjs publish',
      'catalog:release': 'node scripts/release-product.mjs catalog' }, devDependencies: dependencies,
  });
  put('pnpm-lock.yaml', externalProxyLockfile(yaml(files.get('pnpm-lock.yaml').bytes.toString()), coordinate, directories, dependencies));
  const workspace = yaml(files.get('pnpm-workspace.yaml').bytes.toString());
  workspace.packages = directories;
  workspace.onlyBuiltDependencies = ['esbuild'];
  put('pnpm-workspace.yaml', workspace);
  put('support/runtime-extractor/tsconfig.json', { extends: '../../tsconfig.base.json', compilerOptions: { outDir: './dist', rootDir: './src', types: ['node'] }, include: ['src/*.ts'] });
  const runtimeVerifier = files.get('scripts/verify-managed-runtime-candidates.mjs');
  runtimeVerifier.bytes = Buffer.from(runtimeVerifier.bytes.toString().replace('../packages/host/dist/runtime/safe-extract.js', '../support/runtime-extractor/dist/safe-extract.js'));
  const runtimeBuilder = files.get('scripts/build-managed-runtime-candidates.mjs');
  runtimeBuilder.bytes = Buffer.from(runtimeBuilder.bytes.toString().replaceAll('https://github.com/RichLogic/Gian/releases/download/', 'https://github.com/RichLogic/Gian-Proxies/releases/download/'));
  const provenance = { schema: 1, product: 'Gian-Proxies', sourceRepository: 'RichLogic/Gian-Dev', sourceCommit: commit,
    workingTree: false, externalPackages: [coordinate], sourceEntries,
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, mode: file.mode, sha256: createHash('sha256').update(file.bytes).digest('hex') })) };
  put('.gian-source.json', provenance);
  mkdirSync(target, { recursive: true });
  for (const [path, file] of files) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), file.bytes, { flag: 'wx', mode: file.mode });
  }
  return { output: target, commit, files: files.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output') options.output = args[++i];
    else if (args[i] === '--ref') options.revision = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  console.log(JSON.stringify(exportProxies(options)));
}
