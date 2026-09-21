import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolCoordinates, protocolRepository, validateProtocolDependency, verifyProtocolArchive } from '../delivery/remote/scripts/protocol-dependency.mjs';

export async function importRemoteProtocol(version, destination, fetcher = fetch) {
  const expected = protocolCoordinates(version);
  const request = async url => {
    const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Public Gian protocol request failed: ${response.status}`);
    return response;
  };
  const api = `https://api.github.com/repos/${protocolRepository}`;
  const release = await (await request(`${api}/releases/tags/${expected.tag}`)).json();
  if (release.draft || release.prerelease || release.tag_name !== expected.tag) throw new Error('Only a published stable Gian protocol package can be imported');
  const receiptUrl = `https://github.com/${protocolRepository}/releases/download/${expected.tag}/protocol-package.json`;
  if (!release.assets?.some(asset => asset.name === expected.filename && asset.browser_download_url === expected.url)
    || !release.assets.some(asset => asset.name === 'protocol-package.json' && asset.browser_download_url === receiptUrl)) throw new Error('Published protocol assets are incomplete');
  const coordinate = validateProtocolDependency(await (await request(receiptUrl)).json());
  if (coordinate.version !== version) throw new Error('Protocol receipt version differs from requested release');
  let object = (await (await request(`${api}/git/ref/tags/${expected.tag}`)).json()).object;
  for (let i = 0; object?.type === 'tag' && i < 4; i++) object = (await (await request(`${api}/git/tags/${object.sha}`)).json()).object;
  if (object?.type !== 'commit' || object.sha !== coordinate.sourceCommit) throw new Error('Protocol receipt does not match the public tag commit');
  const response = await request(coordinate.url);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Protocol archive response has no body');
  const chunks = []; let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > coordinate.size) { await reader.cancel(); throw new Error('Protocol package bytes differ from the declared size'); }
    chunks.push(Buffer.from(next.value));
  }
  const bytes = Buffer.concat(chunks);
  verifyProtocolArchive(coordinate, bytes);
  if (existsSync(destination)) {
    const current = JSON.parse(readFileSync(destination));
    if (current.status !== 'pending-publication' && current.version === coordinate.version && !isDeepStrictEqual(current, coordinate)) throw new Error('Cannot replace an already pinned protocol version with different release metadata');
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(coordinate, null, 2) + '\n', { flag: 'wx' });
    created = true;
    renameSync(temporary, destination);
  } finally { if (created) rmSync(temporary, { force: true }); }
  return coordinate;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, destination] = process.argv.slice(2);
  if (!destination) throw new Error('Usage: import-remote-protocol.mjs <version> <coordinate-file>');
  const result = await importRemoteProtocol(version, destination);
  console.log(`Pinned ${result.name}@${result.version} from ${protocolRepository}`);
}
