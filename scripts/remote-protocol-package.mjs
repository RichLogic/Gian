import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolCoordinates, protocolPackageName, protocolRepository, validateProtocolDependency } from '../delivery/remote/scripts/protocol-dependency.mjs';

export function stageProtocolPackage({ root = process.cwd(), output, revision }) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('An exact public Gian commit is required');
  const source = join(root, 'packages/remote-protocol');
  const original = JSON.parse(readFileSync(join(source, 'package.json')));
  protocolCoordinates(original.version);
  if (original.name !== protocolPackageName || !existsSync(join(source, 'dist/src/index.js')) || !existsSync(join(source, 'dist/src/index.d.ts'))) throw new Error('Build the Remote Protocol package before packaging');
  const destination = resolve(output);
  const relativeOutput = relative(resolve(source), destination);
  if (!relativeOutput || (relativeOutput !== '..' && !relativeOutput.startsWith(`..${sep}`))) throw new Error('Package output must be outside the protocol source directory');
  if (existsSync(destination)) throw new Error('Package staging directory must not exist');
  const dependencies = {};
  const require = createRequire(join(source, 'package.json'));
  for (const name of Object.keys(original.dependencies ?? {})) {
    const installed = require.resolve(`${name}/package.json`);
    dependencies[name] = JSON.parse(readFileSync(installed)).version;
  }
  const assertRegularTree = directory => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry); const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Protocol artifact cannot contain symlinks or special files');
      if (stat.isDirectory()) assertRegularTree(path);
    }
  };
  assertRegularTree(join(source, 'dist/src'));
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, 'dist/src'), join(destination, 'dist/src'), { recursive: true });
  cpSync(join(root, 'LICENSE'), join(destination, 'LICENSE'));
  cpSync(join(source, 'CHANGELOG.md'), join(destination, 'CHANGELOG.md'));
  const manifest = { name: original.name, version: original.version, type: original.type, main: original.main, types: original.types, exports: original.exports, dependencies, files: ['dist/src', 'LICENSE', 'CHANGELOG.md'], license: 'MIT', repository: { type: 'git', url: `https://github.com/${protocolRepository}.git`, directory: 'packages/remote-protocol' }, gianSourceCommit: revision };
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export function protocolPackageReceipt({ staging, archive, revision }) {
  const manifest = JSON.parse(readFileSync(join(staging, 'package.json')));
  if (manifest.gianSourceCommit !== revision) throw new Error('Package staging belongs to another source revision');
  const bytes = readFileSync(archive);
  return validateProtocolDependency({ schema: 1, name: manifest.name, repository: protocolRepository, version: manifest.version, ...protocolCoordinates(manifest.version), sourceCommit: revision, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, dependencies: manifest.dependencies });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2);
  if (mode !== 'pack' || !directory) throw new Error('Usage: remote-protocol-package.mjs pack <new-output-directory>');
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot resolve the package source revision');
  const revision = result.stdout.trim();
  if (process.env.GITHUB_REPOSITORY !== protocolRepository) throw new Error('Protocol publication tooling runs in public RichLogic/Gian');
  const output = resolve(directory);
  if (existsSync(output)) throw new Error('Package output directory must not exist');
  const staging = join(output, 'package');
  const manifest = stageProtocolPackage({ output: staging, revision });
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output], { cwd: staging, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack failed');
  const coordinate = protocolCoordinates(manifest.version);
  const archive = join(output, coordinate.filename);
  const actual = join(output, packed.stdout.trim().split('\n').at(-1));
  if (realpathSync(actual) !== realpathSync(archive)) throw new Error('Unexpected npm package archive name');
  const receipt = protocolPackageReceipt({ staging, archive, revision });
  writeFileSync(join(output, 'protocol-package.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(output, 'SHA256SUMS'), `${receipt.sha256}  ${coordinate.filename}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ archive, version: manifest.version, sourceCommit: revision }));
}
