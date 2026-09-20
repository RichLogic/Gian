import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { protocolCoordinates, protocolRepository, validateProtocolDependency, verifyProtocolArchive } from '../delivery/proxies/scripts/protocol-dependency.mjs';

async function boundedBytes(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Public protocol response has no body');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error('Public protocol response exceeds the declared size limit');
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function importProxyProtocol(version, destination, fetcher = fetch) {
  const expected = protocolCoordinates(version);
  const signal = AbortSignal.timeout(120_000);
  const request = async url => {
    const response = await fetcher(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error(`Public Gian protocol request failed: ${response.status}`);
    return response;
  };
  const json = async url => JSON.parse((await boundedBytes(await request(url), 1024 * 1024)).toString('utf8'));
  const api = `https://api.github.com/repos/${protocolRepository}`;
  const release = await json(`${api}/releases/tags/${expected.tag}`);
  if (release.draft !== false || release.prerelease !== false || release.tag_name !== expected.tag) {
    throw new Error('Only a published stable Gian Proxy Protocol package can be imported');
  }
  const receiptUrl = `https://github.com/${protocolRepository}/releases/download/${expected.tag}/protocol-package.json`;
  const archiveAsset = release.assets?.filter(asset => asset.name === expected.filename);
  const receiptAsset = release.assets?.filter(asset => asset.name === 'protocol-package.json');
  if (archiveAsset?.length !== 1 || archiveAsset[0].browser_download_url !== expected.url
    || receiptAsset?.length !== 1 || receiptAsset[0].browser_download_url !== receiptUrl) {
    throw new Error('Published Proxy Protocol assets are incomplete or ambiguous');
  }
  const coordinate = validateProtocolDependency(await json(receiptUrl));
  if (coordinate.version !== version || archiveAsset[0].size !== coordinate.size
    || (archiveAsset[0].digest && archiveAsset[0].digest !== `sha256:${coordinate.sha256}`)) {
    throw new Error('Proxy Protocol receipt differs from the requested release asset');
  }
  let object = (await json(`${api}/git/ref/tags/${expected.tag}`)).object;
  for (let i = 0; object?.type === 'tag' && i < 4; i++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha ?? '')) throw new Error('Invalid public protocol tag object');
    object = (await json(`${api}/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== 'commit' || object.sha !== coordinate.sourceCommit) {
    throw new Error('Proxy Protocol receipt does not match the public tag commit');
  }
  const comparison = await json(`${api}/compare/${coordinate.sourceCommit}...main`);
  if (!['identical', 'ahead'].includes(comparison.status)
    || comparison.merge_base_commit?.sha !== coordinate.sourceCommit) {
    throw new Error('Proxy Protocol must be published from public Gian main');
  }
  verifyProtocolArchive(coordinate, await boundedBytes(await request(coordinate.url), coordinate.size));
  if (existsSync(destination)) {
    const current = JSON.parse(readFileSync(destination));
    if (current.status !== 'pending-publication') {
      validateProtocolDependency(current);
      if (current.version === coordinate.version && !isDeepStrictEqual(current, coordinate)) {
        throw new Error('Cannot replace a pinned Proxy Protocol version with different release metadata');
      }
    }
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(coordinate, null, 2) + '\n', { flag: 'wx' });
    created = true;
    renameSync(temporary, destination);
  } finally {
    if (created) rmSync(temporary, { force: true });
  }
  return coordinate;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, destination, extra] = process.argv.slice(2);
  if (!destination || extra) throw new Error('Usage: import-proxy-protocol.mjs <version> <coordinate-file>');
  const result = await importProxyProtocol(version, destination);
  console.log(`Pinned ${result.name}@${result.version} from ${protocolRepository}`);
}
