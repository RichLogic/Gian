import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy the already installed, locked graph, including native build outputs.
// Never run an installer or resolve a semver range again while packaging.
export function bundleRuntime(output, sourceRoot = process.cwd()) {
  sourceRoot = realpathSync(sourceRoot);
  const target = resolve(output);
  const targetRelative = relative(sourceRoot, target);
  if (targetRelative === '' || (targetRelative !== '..' && !targetRelative.startsWith(`..${sep}`))) throw new Error('Runtime target must be outside the source tree');
  if (existsSync(target)) throw new Error('Runtime target must not exist');
  const entry = realpathSync(join(sourceRoot, 'packages/remote-server'));
  const nodes = new Map([[entry, target]]);
  const pending = [entry];
  const edges = [];
  const contained = path => { const rel = relative(sourceRoot, path); return rel !== '..' && !rel.startsWith(`..${sep}`); };
  function installedPackage(from, name) {
    for (const search of createRequire(join(from, 'package.json')).resolve.paths(name) ?? []) {
      const candidate = join(search, name);
      if (existsSync(join(candidate, 'package.json'))) {
        const actual = realpathSync(candidate);
        if (!contained(actual)) throw new Error(`Dependency outside the standalone source: ${name}`);
        return actual;
      }
    }
    return null;
  }
  for (let i = 0; i < pending.length; i++) {
    const source = pending[i];
    const metadata = JSON.parse(readFileSync(join(source, 'package.json')));
    const dependencies = { ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      if (name === '.' || name === '..' || !/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid dependency name');
      const dependency = installedPackage(source, name);
      if (!dependency) {
        if (Object.hasOwn(metadata.optionalDependencies ?? {}, name) || metadata.peerDependenciesMeta?.[name]?.optional) continue;
        throw new Error(`Missing installed dependency ${name} of ${metadata.name}`);
      }
      if (!nodes.has(dependency)) {
        const id = createHash('sha256').update(relative(sourceRoot, dependency)).digest('hex').slice(0, 24);
        nodes.set(dependency, join(target, '.modules', id)); pending.push(dependency);
      }
      edges.push({ from: source, name, to: dependency });
    }
  }
  for (const [source, destination] of nodes) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) {
      if (name === 'node_modules' || name === '.git') continue;
      cpSync(join(source, name), join(destination, name), { recursive: true, verbatimSymlinks: true, filter: path => !['node_modules', 'node_gyp_bins', '.git'].includes(basename(path)) });
    }
  }
  for (const edge of edges) {
    const link = join(nodes.get(edge.from), 'node_modules', edge.name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), nodes.get(edge.to)), link, 'dir');
  }
  // No dependency symlink may retain a reference to the build machine.
  function verify(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name); const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const rel = relative(realpathSync(target), realpathSync(path));
        if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Runtime symlink escapes artifact: ${path}`);
      } else if (stat.isDirectory()) verify(path);
    }
  }
  verify(target);
  return { packages: nodes.size, output: target };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(bundleRuntime(process.argv[2])));
