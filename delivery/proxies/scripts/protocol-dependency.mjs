import { createHash } from 'node:crypto';

export const protocolPackageName = '@gian/proxy-protocol';
export const protocolRepository = 'RichLogic/Gian';
export const maxProtocolPackageBytes = 16 * 1024 * 1024;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const coordinateKeys = ['schema', 'name', 'repository', 'version', 'tag', 'filename', 'url', 'sourceCommit', 'size', 'sha256', 'integrity', 'dependencies'];

export function protocolCoordinates(version) {
  if (typeof version !== 'string' || !stableVersion.test(version)) {
    throw new Error('Expected an exact stable Proxy Protocol package version');
  }
  const tag = `proxy-protocol-v${version}`;
  const filename = `gian-proxy-protocol-${version}.tgz`;
  return { tag, filename, url: `https://github.com/${protocolRepository}/releases/download/${tag}/${filename}` };
}

export function validateProtocolDependency(value) {
  if (value?.status === 'pending-publication') {
    throw new Error('Publish Proxy Protocol from public Gian, then import its verified coordinate before exporting Gian-Proxies');
  }
  const expected = protocolCoordinates(value?.version);
  if (!value || Object.keys(value).length !== coordinateKeys.length
    || coordinateKeys.some(key => !Object.hasOwn(value, key))
    || value.schema !== 1 || value.name !== protocolPackageName || value.repository !== protocolRepository
    || value.tag !== expected.tag || value.filename !== expected.filename || value.url !== expected.url
    || !/^[a-f0-9]{40}$/.test(value.sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')
    || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > maxProtocolPackageBytes
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity ?? '')) {
    throw new Error('Invalid public Gian Proxy Protocol coordinate');
  }
  const digest = Buffer.from(value.integrity.slice(7), 'base64');
  if (digest.length !== 64 || `sha512-${digest.toString('base64')}` !== value.integrity) {
    throw new Error('Invalid Proxy Protocol package integrity');
  }
  if (!value.dependencies || Array.isArray(value.dependencies) || typeof value.dependencies !== 'object') {
    throw new Error('Proxy Protocol must declare exact runtime dependencies');
  }
  for (const [name, version] of Object.entries(value.dependencies)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
      || typeof version !== 'string' || !stableVersion.test(version)) {
      throw new Error('Proxy Protocol runtime dependencies must be exact registry versions');
    }
  }
  return value;
}

export function verifyProtocolArchive(value, bytes) {
  const coordinate = validateProtocolDependency(value);
  if (bytes.length !== coordinate.size
    || createHash('sha256').update(bytes).digest('hex') !== coordinate.sha256
    || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== coordinate.integrity) {
    throw new Error('Proxy Protocol bytes differ from the public release coordinate');
  }
  return coordinate;
}
