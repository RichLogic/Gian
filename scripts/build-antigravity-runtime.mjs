#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';

const execFileAsync = promisify(execFile);
const MAX_RUNTIME_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_MEMBER_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_PAIR_UNCOMPRESSED_BYTES = 700 * 1024 * 1024;
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_HEADER = 0x06054b50;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/**
 * Pinned official ACP registry binary for the Dev darwin-arm64 target.
 * Registry platform id is `darwin-aarch64`; Gian's existing Runtime
 * candidates call that target `darwin-arm64`. The ZIP is source provenance.
 * The product asset is a byte-preserving tar.gz and is not a Gian release URL.
 * https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
 */
export const antigravityRuntimeSource = Object.freeze({
  schemaVersion: 1,
  kind: 'antigravity-pair',
  provider: 'antigravity',
  pluginId: 'io.gian.antigravity',
  runtimeId: 'antigravity-acp',
  version: '1.3.0',
  platform: 'darwin-arm64',
  registryPlatform: 'darwin-aarch64',
  format: 'tar.gz',
  entryRelativePath: 'agy_acp_server.par',
  harnessRelativePath: 'localharness_external',
  members: Object.freeze([
    Object.freeze({ name: 'agy_acp_server.par', mode: 0o755 }),
    Object.freeze({ name: 'localharness_external', mode: 0o555 }),
  ]),
  sourceUrl: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip',
  sourceSha256: '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88',
  sourceSize: 111456962,
});

const MEMBER_NAMES = new Set(antigravityRuntimeSource.members.map(member => member.name));

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function invalidArchive() {
  return new Error('Antigravity source archive is invalid.');
}

function assertExplicitPairName(name) {
  if (name.length === 0 || name.length > 64
    || name.includes('/') || name.includes('\\') || name.includes('\0')
    || name.includes('..') || !MEMBER_NAMES.has(name)) {
    throw new Error('Antigravity source archive member path is not an explicit pair file.');
  }
}

function assertRegularMember(externalAttributes) {
  const type = (externalAttributes >>> 16) & S_IFMT;
  if (type === S_IFLNK) throw new Error('Antigravity source archive member is a link.');
  if (type !== 0 && type !== S_IFREG) {
    throw new Error('Antigravity source archive member is not a regular file.');
  }
}

function findEocd(bytes) {
  if (bytes.length < 22 || bytes.length > MAX_RUNTIME_ASSET_BYTES) throw invalidArchive();
  const limit = Math.max(0, bytes.length - (65535 + 22));
  for (let offset = bytes.length - 22; offset >= limit; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== EOCD_HEADER) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw invalidArchive();
}

function claimSpan(spans, start, end) {
  if (spans.some(span => start < span.end && end > span.start)) throw invalidArchive();
  spans.push({ start, end });
}

function readLocalMember(bytes, member, cdOffset) {
  const start = member.localOffset;
  if (start < 0 || start + 30 > cdOffset || bytes.readUInt32LE(start) !== LOCAL_HEADER) throw invalidArchive();
  const flags = bytes.readUInt16LE(start + 6);
  const method = bytes.readUInt16LE(start + 8);
  const crc = bytes.readUInt32LE(start + 14);
  const compressedSize = bytes.readUInt32LE(start + 18);
  const uncompressedSize = bytes.readUInt32LE(start + 22);
  const nameLength = bytes.readUInt16LE(start + 26);
  const extraLength = bytes.readUInt16LE(start + 28);
  const nameEnd = start + 30 + nameLength;
  if (nameEnd + extraLength > cdOffset) throw invalidArchive();
  const name = bytes.toString('utf8', start + 30, nameEnd);
  if (name !== member.name || flags !== member.flags || method !== member.method
    || crc !== member.crc || compressedSize !== member.compressedSize
    || uncompressedSize !== member.uncompressedSize) throw invalidArchive();
  const dataStart = nameEnd + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > cdOffset) throw invalidArchive();
  const compressed = bytes.subarray(dataStart, dataEnd);
  let payload;
  if (method === 0) {
    if (compressed.length !== uncompressedSize) throw invalidArchive();
    payload = Buffer.from(compressed);
  } else {
    try {
      payload = inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
    } catch {
      throw new Error('Antigravity source archive member is corrupt.');
    }
  }
  if (payload.length !== uncompressedSize || (crc32(payload) >>> 0) !== crc) {
    throw new Error('Antigravity source archive member is corrupt.');
  }
  return { bytes: payload, end: dataEnd };
}

/** Validate the central directory and inflate only the two pinned filenames.
 * Output paths come from the recipe, never from archive member names. */
export function readAntigravityPair(bytes) {
  if (!Buffer.isBuffer(bytes)) throw invalidArchive();
  const eocd = findEocd(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== 2 || totalEntries !== 2) {
    throw new Error('Antigravity source archive must contain exactly the paired server and harness.');
  }
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize > eocd) throw invalidArchive();
  const members = new Map();
  const spans = [];
  let cursor = centralOffset;
  const end = centralOffset + centralSize;
  while (cursor < end) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== CENTRAL_HEADER) throw invalidArchive();
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const memberDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > end) throw invalidArchive();
    const name = bytes.toString('utf8', nameStart, nameEnd);
    assertExplicitPairName(name);
    if (members.has(name)) throw new Error('Antigravity source archive contains a duplicate member.');
    if (memberDisk !== 0) throw invalidArchive();
    assertRegularMember(externalAttributes);
    if (flags & 0x0001) throw new Error('Antigravity source archive member is encrypted.');
    const bounded = (flags & 0x0008) === 0
      && compressedSize !== 0xffffffff
      && uncompressedSize !== 0xffffffff
      && uncompressedSize > 0
      && uncompressedSize <= MAX_MEMBER_UNCOMPRESSED_BYTES
      && compressedSize <= MAX_MEMBER_UNCOMPRESSED_BYTES;
    if (!bounded) throw new Error('Antigravity source archive member is unbounded.');
    if (method !== 0 && method !== 8) throw invalidArchive();
    const payload = readLocalMember(bytes, {
      name, flags, method, crc, compressedSize, uncompressedSize, localOffset,
    }, centralOffset);
    claimSpan(spans, localOffset, payload.end);
    members.set(name, payload.bytes);
    cursor = nameEnd + extraLength + commentLength;
  }
  if (cursor !== end || members.size !== MEMBER_NAMES.size) throw invalidArchive();
  let total = 0;
  for (const name of MEMBER_NAMES) total += members.get(name).length;
  if (total > MAX_PAIR_UNCOMPRESSED_BYTES) {
    throw new Error('Antigravity source archive member is unbounded.');
  }
  return members;
}

export async function extractAntigravityPair(bytes, destination) {
  const info = await lstat(destination).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new Error('Antigravity pair directory must be a real directory.');
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const members = readAntigravityPair(bytes);
  for (const member of antigravityRuntimeSource.members) {
    const target = join(destination, member.name);
    await writeFile(target, members.get(member.name), { flag: 'wx', mode: member.mode });
    await chmod(target, member.mode);
  }
}

async function readPinnedArchive(archivePath) {
  const info = await lstat(archivePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Antigravity source archive must be a regular file.');
  }
  if (info.size !== antigravityRuntimeSource.sourceSize) {
    throw archiveMismatch('file-size', { actualSize: info.size });
  }
  const bytes = await readFile(archivePath);
  const actualSha256 = digest(bytes);
  if (bytes.length !== antigravityRuntimeSource.sourceSize
    || actualSha256 !== antigravityRuntimeSource.sourceSha256) {
    throw archiveMismatch('file-integrity', { actualSize: bytes.length, actualSha256 });
  }
  return bytes;
}

function archiveMismatch(stage, observed) {
  return new Error(`Antigravity source archive differs from the pinned recipe. ${JSON.stringify({
    stage,
    expectedSize: antigravityRuntimeSource.sourceSize,
    expectedSha256: antigravityRuntimeSource.sourceSha256,
    ...observed,
  })}`);
}

async function downloadAntigravitySource(destination, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(antigravityRuntimeSource.sourceUrl, {
    headers: { 'Accept-Encoding': 'identity' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Antigravity source archive download failed (${response.status}).`);
  }
  const declared = response.headers.get('content-length');
  const declaredSize = declared === null ? null : Number(declared);
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  // Fetch decodes HTTP compression, while Content-Length counts encoded
  // bytes. Require identity before comparing it with the pinned ZIP size.
  if (encoding && encoding !== 'identity') {
    await response.body.cancel().catch(() => undefined);
    throw archiveMismatch('content-encoding', { declaredSize, contentEncoding: 'non-identity' });
  }
  if (declared !== null && Number(declared) !== antigravityRuntimeSource.sourceSize) {
    await response.body.cancel().catch(() => undefined);
    throw archiveMismatch('content-length', { declaredSize });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      received += step.value.byteLength;
      if (received > antigravityRuntimeSource.sourceSize) {
        throw archiveMismatch('download-size', { declaredSize, actualSize: received });
      }
      chunks.push(Buffer.from(step.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (received !== antigravityRuntimeSource.sourceSize) {
    throw archiveMismatch('download-size', { declaredSize, actualSize: received });
  }
  await writeFile(destination, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
  return destination;
}

export async function packAntigravityPair(runtimeRoot, archivePath, listPath) {
  const names = antigravityRuntimeSource.members.map(member => member.name)
    .sort((left, right) => left.localeCompare(right));
  const present = (await readdir(runtimeRoot)).sort((left, right) => left.localeCompare(right));
  if (present.length !== names.length || present.some((name, index) => name !== names[index])) {
    throw new Error('Antigravity pair directory does not match the pinned members.');
  }
  const epoch = new Date('2000-01-01T00:00:00.000Z');
  for (const member of antigravityRuntimeSource.members) {
    const path = join(runtimeRoot, member.name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Antigravity pair member must be a regular file.');
    }
    await chmod(path, 0o644);
    await utimes(path, epoch, epoch);
    await chmod(path, member.mode);
  }
  await writeFile(listPath, Buffer.from(`${names.join('\0')}\0`, 'utf8'));
  await execFileAsync('/usr/bin/tar', [
    '-czhf', archivePath,
    '--format', 'ustar',
    '--uid', '0',
    '--gid', '0',
    '--uname', 'root',
    '--gname', 'root',
    '--numeric-owner',
    '--no-xattrs',
    '--no-acls',
    '--no-fflags',
    '--no-mac-metadata',
    '--options', 'gzip:!timestamp',
    '-C', runtimeRoot,
    '--null',
    '-T', listPath,
  ], {
    maxBuffer: 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = await readFile(archivePath);
  if (bytes.length === 0 || bytes.length > MAX_RUNTIME_ASSET_BYTES) {
    throw new Error('Antigravity Runtime archive exceeds the size limit.');
  }
  return bytes;
}

/** Build the non-shipping Dev Runtime asset. `options.archivePath` selects an
 * already cached official ZIP. Omitting it downloads the pinned registry URL.
 * This does not spawn the server, harness, model, or App, and it does not
 * consult proxy release metadata. */
export async function buildAntigravityRuntimeCandidate(outputDir, workDir, options = {}) {
  if (!outputDir || !workDir) throw new Error('Antigravity Runtime build requires output and work directories.');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const archivePath = options.archivePath
    ?? await downloadAntigravitySource(join(workDir, 'agy-acp-source.zip'), options.fetch);
  const bytes = await readPinnedArchive(archivePath);
  const pairRoot = join(workDir, 'antigravity-pair');
  await extractAntigravityPair(bytes, pairRoot);
  const name = `gian-runtime-antigravity-${antigravityRuntimeSource.version}-darwin-arm64.tar.gz`;
  const path = join(outputDir, name);
  const packed = await packAntigravityPair(pairRoot, path, join(workDir, 'antigravity-runtime-files'));
  return {
    provider: antigravityRuntimeSource.provider,
    version: antigravityRuntimeSource.version,
    format: antigravityRuntimeSource.format,
    entryRelativePath: antigravityRuntimeSource.entryRelativePath,
    asset: {
      name,
      path,
      sha256: digest(packed),
      size: packed.length,
      publish: false,
    },
    candidateBin: join(pairRoot, antigravityRuntimeSource.entryRelativePath),
  };
}

function hashFile(path) {
  return new Promise((done, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')));
  });
}

function parseArgs(argv) {
  const options = { archivePath: '', outputDir: '', workDir: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--archive') options.archivePath = argv[++index];
    else if (arg === '--output') options.outputDir = argv[++index];
    else if (arg === '--work') options.workDir = argv[++index];
    else throw new Error(`Unknown Antigravity Runtime argument ${arg}.`);
  }
  if (!options.archivePath || !options.outputDir || !options.workDir) {
    throw new Error('Antigravity Runtime build requires --archive, --output, and --work.');
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  buildAntigravityRuntimeCandidate(options.outputDir, options.workDir, {
    archivePath: options.archivePath,
  }).then(async candidate => {
    const harness = join(dirname(candidate.candidateBin), antigravityRuntimeSource.harnessRelativePath);
    console.log(JSON.stringify({
      provider: candidate.provider,
      version: candidate.version,
      format: candidate.format,
      entryRelativePath: candidate.entryRelativePath,
      asset: candidate.asset,
      candidateBin: candidate.candidateBin,
      memberSha256: {
        [antigravityRuntimeSource.entryRelativePath]: await hashFile(candidate.candidateBin),
        [antigravityRuntimeSource.harnessRelativePath]: await hashFile(harness),
      },
    }, null, 2));
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
