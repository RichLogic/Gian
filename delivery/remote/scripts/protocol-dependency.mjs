import { createHash } from 'node:crypto';

export const protocolPackageName = '@gian/remote-protocol';
export const protocolRepository = 'RichLogic/Gian';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function protocolCoordinates(version) {
  if (!versionPattern.test(version ?? '')) throw new Error('Expected an exact stable protocol package version');
  const tag = `remote-protocol-v${version}`;
  const filename = `gian-remote-protocol-${version}.tgz`;
  return { tag, filename, url: `https://github.com/${protocolRepository}/releases/download/${tag}/${filename}` };
}

export function validateProtocolDependency(value) {
  if (value?.status === 'pending-publication') throw new Error('Publish the Remote Protocol package from public Gian, then import its verified coordinate before exporting Remote');
  const expected = protocolCoordinates(value?.version);
  if (value?.schema !== 1 || value.name !== protocolPackageName || value.repository !== protocolRepository
    || value.tag !== expected.tag || value.filename !== expected.filename || value.url !== expected.url
    || !/^[a-f0-9]{40}$/.test(value.sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')
    || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 16 * 1024 * 1024
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity ?? '')) throw new Error('Invalid public Gian protocol package coordinate');
  const digest = Buffer.from(value.integrity.slice(7), 'base64');
  if (digest.length !== 64 || `sha512-${digest.toString('base64')}` !== value.integrity) throw new Error('Invalid package integrity');
  if (!value.dependencies || Array.isArray(value.dependencies) || typeof value.dependencies !== 'object') throw new Error('Protocol package must declare its exact runtime dependencies');
  for (const [name, version] of Object.entries(value.dependencies)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || !versionPattern.test(version)) throw new Error('Protocol runtime dependencies must be pinned registry versions');
  }
  return value;
}

export function verifyProtocolArchive(value, bytes) {
  const coordinate = validateProtocolDependency(value);
  if (bytes.length !== coordinate.size || createHash('sha256').update(bytes).digest('hex') !== coordinate.sha256
    || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== coordinate.integrity) throw new Error('Protocol package bytes differ from the Gian release coordinate');
  return coordinate;
}

// Deliberately limited to this repository's pnpm v9 lockfile. Preserve all
// locked registry snapshots; only project selection and the protocol edge change.
// Never resolve a new registry version or keep an expiring GitHub CDN URL.
export function externalProtocolLockfile(text, value, packageDirectories) {
  const coordinate = validateProtocolDependency(value);
  if (!/^lockfileVersion: ['"]9\.0['"]/m.test(text)) throw new Error('Unsupported pnpm lockfile format');
  const importerStart = text.indexOf('\nimporters:\n');
  const packageStart = text.indexOf('\npackages:\n');
  const snapshotStart = text.indexOf('\nsnapshots:\n');
  if (importerStart < 0 || packageStart < importerStart || snapshotStart < packageStart) throw new Error('Missing pnpm lockfile sections');
  const wanted = new Set(['.', ...packageDirectories]);
  const blocks = text.slice(importerStart + '\nimporters:\n'.length, packageStart).split(/(?=^  \S)/m);
  const selected = [];
  let changed = 0;
  for (let block of blocks) {
    const match = block.match(/^  (?:'([^']+)'|([^:\n]+)):/);
    if (!match || !wanted.delete(match[1] ?? match[2])) continue;
    block = block.replace(/(      ['"]?@gian\/remote-protocol['"]?:\n)        specifier: workspace:\*\n        version: link:\.\.\/remote-protocol(?=\n)/g, (_, prefix) => {
      changed += 1;
      return `${prefix}        specifier: ${JSON.stringify(coordinate.url)}\n        version: ${JSON.stringify(coordinate.url)}`;
    });
    selected.push(block.trimEnd());
  }
  if (wanted.size || changed !== 2) throw new Error('Expected complete Remote importers and exactly two protocol consumers');
  const packages = text.slice(packageStart + '\npackages:\n'.length, snapshotStart);
  const snapshots = text.slice(snapshotStart + '\nsnapshots:\n'.length);
  for (const [name, version] of Object.entries(coordinate.dependencies)) {
    const key = `${name}@${version}`;
    const contains = section => section.split('\n').some(line => line.startsWith(`  ${key}:`) || line.startsWith(`  '${key}':`) || line.startsWith(`  "${key}":`));
    if (!contains(packages) || !contains(snapshots)) throw new Error(`Update the source lockfile for the protocol's pinned dependency ${key}`);
  }
  const key = JSON.stringify(`${protocolPackageName}@${coordinate.url}`);
  const packageEntry = `  ${key}:\n    resolution:\n      integrity: ${JSON.stringify(coordinate.integrity)}\n      tarball: ${JSON.stringify(coordinate.url)}\n    version: ${JSON.stringify(coordinate.version)}\n`;
  const dependencies = Object.entries(coordinate.dependencies).map(([name, version]) => `      ${JSON.stringify(name)}: ${JSON.stringify(version)}`).join('\n');
  const snapshotEntry = dependencies ? `  ${key}:\n    dependencies:\n${dependencies}\n` : `  ${key}: {}\n`;
  return `${text.slice(0, importerStart)}\nimporters:\n\n${selected.join('\n\n')}\n\npackages:\n\n${packageEntry}${packages}\nsnapshots:\n\n${snapshotEntry}${snapshots}`;
}
