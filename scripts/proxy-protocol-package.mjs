import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolCoordinates, protocolPackageName, protocolRepository, validateProtocolDependency } from '../delivery/proxies/scripts/protocol-dependency.mjs';

function assertRegularTree(directory) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error('Protocol distribution must be a regular directory');
  }
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error('Protocol artifact cannot contain symlinks or special files');
    }
    if (stat.isDirectory()) assertRegularTree(path);
  }
}

export function stageProxyProtocolPackage({ root = process.cwd(), output, revision }) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('An exact public Gian commit is required');
  const source = join(root, 'packages/proxy-protocol');
  const original = JSON.parse(readFileSync(join(source, 'package.json')));
  protocolCoordinates(original.version);
  if (original.name !== protocolPackageName || original.type !== 'module') throw new Error('Unexpected Proxy Protocol package');
  const exports = original.exports;
  const expectedExports = ['.', './schemas', './conformance', './node'];
  if (!exports || Object.keys(exports).length !== expectedExports.length
    || expectedExports.some(key => !Object.hasOwn(exports, key))) {
    throw new Error('Review the Proxy Protocol public exports before publishing');
  }
  assertRegularTree(join(source, 'dist/src'));
  for (const entry of Object.values(exports)) {
    for (const field of ['types', 'default']) {
      const path = entry[field];
      if (typeof path !== 'string' || !/^\.\/dist\/src\/[a-z0-9-]+\.(?:js|d\.ts)$/.test(path)
        || !existsSync(join(source, path)) || !lstatSync(join(source, path)).isFile()) {
        throw new Error(`Build every Proxy Protocol export before packaging: ${String(path)}`);
      }
    }
  }
  if (original.main !== exports['.'].default || original.types !== exports['.'].types) {
    throw new Error('Proxy Protocol root entry differs from its exports');
  }
  const destination = resolve(output);
  const relativeOutput = relative(resolve(source), destination);
  if (!relativeOutput || (relativeOutput !== '..' && !relativeOutput.startsWith(`..${sep}`))) {
    throw new Error('Package output must be outside the protocol source directory');
  }
  if (existsSync(destination)) throw new Error('Package staging directory must not exist');
  const require = createRequire(join(source, 'package.json'));
  const dependencies = {};
  for (const name of Object.keys(original.dependencies ?? {})) {
    dependencies[name] = JSON.parse(readFileSync(require.resolve(`${name}/package.json`))).version;
  }
  const manifest = {
    name: original.name, version: original.version, type: original.type,
    main: original.main, types: original.types, exports, dependencies,
    files: ['dist/src', 'LICENSE', 'README.md', 'CHANGELOG.md'], license: 'MIT',
    engines: { node: '>=24 <25' },
    repository: { type: 'git', url: `https://github.com/${protocolRepository}.git`, directory: 'packages/proxy-protocol' },
    gianSourceCommit: revision,
  };
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, 'dist/src'), join(destination, 'dist/src'), { recursive: true });
  cpSync(join(root, 'LICENSE'), join(destination, 'LICENSE'));
  for (const file of ['README.md', 'CHANGELOG.md']) cpSync(join(source, file), join(destination, file));
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export function proxyProtocolPackageReceipt({ staging, archive, revision }) {
  const manifest = JSON.parse(readFileSync(join(staging, 'package.json')));
  if (manifest.gianSourceCommit !== revision) throw new Error('Protocol staging belongs to another source revision');
  const bytes = readFileSync(archive);
  return validateProtocolDependency({
    schema: 1, name: manifest.name, repository: protocolRepository, version: manifest.version,
    ...protocolCoordinates(manifest.version), sourceCommit: revision, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    dependencies: manifest.dependencies,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory, extra] = process.argv.slice(2);
  if (mode !== 'pack' || !directory || extra) throw new Error('Usage: proxy-protocol-package.mjs pack <new-output-directory>');
  if (process.env.GITHUB_REPOSITORY !== protocolRepository) throw new Error('Publish Proxy Protocol only from public RichLogic/Gian');
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error('Cannot resolve the package source revision');
  const revision = git.stdout.trim();
  const output = resolve(directory);
  if (existsSync(output)) throw new Error('Package output directory must not exist');
  const staging = join(output, 'package');
  const manifest = stageProxyProtocolPackage({ output: staging, revision });
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output], { cwd: staging, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack failed');
  const coordinate = protocolCoordinates(manifest.version);
  const archive = join(output, coordinate.filename);
  const actual = join(output, packed.stdout.trim().split('\n').at(-1));
  if (realpathSync(actual) !== realpathSync(archive)) throw new Error('Unexpected Proxy Protocol archive name');
  const receipt = proxyProtocolPackageReceipt({ staging, archive, revision });
  writeFileSync(join(output, 'protocol-package.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(output, 'SHA256SUMS'), `${receipt.sha256}  ${coordinate.filename}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ archive, version: manifest.version, sourceCommit: revision }));
}
