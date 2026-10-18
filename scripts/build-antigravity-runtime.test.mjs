import assert from 'node:assert/strict';
import { chmod, mkdtemp, lstat, mkdir, open, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  antigravityRuntimeSource,
  buildAntigravityRuntimeCandidate,
  extractAntigravityPair,
  packAntigravityPair,
} from './build-antigravity-runtime.mjs';

const MAX_MEMBER_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.from('member');
    const method = entry.method ?? 8;
    const flags = entry.flags ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const checksum = entry.crc ?? (crc32(data) >>> 0);
    const mode = entry.mode ?? 0o100644;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

function pair(server = {}, harness = {}) {
  return [
    { name: 'agy_acp_server.par', data: Buffer.from('server-bytes'), mode: 0o100755, ...server },
    { name: 'localharness_external', data: Buffer.from('harness-bytes'), mode: 0o100555, ...harness },
  ];
}

test('the Antigravity source recipe pins the published darwin-arm64 ZIP', () => {
  assert.equal(antigravityRuntimeSource.schemaVersion, 1);
  assert.equal(antigravityRuntimeSource.kind, 'antigravity-pair');
  assert.equal(antigravityRuntimeSource.provider, 'antigravity');
  assert.equal(antigravityRuntimeSource.pluginId, 'io.gian.antigravity');
  assert.equal(antigravityRuntimeSource.runtimeId, 'antigravity-acp');
  assert.equal(antigravityRuntimeSource.version, '1.3.0');
  assert.equal(antigravityRuntimeSource.platform, 'darwin-arm64');
  assert.equal(antigravityRuntimeSource.registryPlatform, 'darwin-aarch64');
  assert.equal(antigravityRuntimeSource.format, 'tar.gz');
  assert.equal(antigravityRuntimeSource.entryRelativePath, 'agy_acp_server.par');
  assert.equal(antigravityRuntimeSource.harnessRelativePath, 'localharness_external');
  assert.deepEqual(antigravityRuntimeSource.members, [
    { name: 'agy_acp_server.par', mode: 0o755 },
    { name: 'localharness_external', mode: 0o555 },
  ]);
  assert.equal(antigravityRuntimeSource.sourceUrl,
    'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip');
  assert.equal(antigravityRuntimeSource.sourceSha256,
    '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88');
  assert.equal(antigravityRuntimeSource.sourceSize, 111456962);
  assert.equal(Object.hasOwn(antigravityRuntimeSource, 'publish'), false);
});

test('pair extraction keeps only the two explicit deflated members', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-pair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'out');
  await extractAntigravityPair(zip(pair()), destination);
  assert.equal(await readFile(join(destination, 'agy_acp_server.par'), 'utf8'), 'server-bytes');
  assert.equal(await readFile(join(destination, 'localharness_external'), 'utf8'), 'harness-bytes');
  assert.equal((await lstat(join(destination, 'agy_acp_server.par'))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(destination, 'localharness_external'))).mode & 0o777, 0o555);
});

test('pair extraction rejects traversal, links, duplicates, and unbounded members', async t => {
  const destination = await mkdtemp(join(tmpdir(), 'agy-pair-reject-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await assert.rejects(extractAntigravityPair(zip(pair({ name: '../agy_acp_server.par' })), destination),
    /explicit pair file/);
  await assert.rejects(extractAntigravityPair(zip(pair({ name: '/agy_acp_server.par' })), destination),
    /explicit pair file/);
  await assert.rejects(extractAntigravityPair(zip(pair({ name: 'nested/agy_acp_server.par' })), destination),
    /explicit pair file/);
  await assert.rejects(extractAntigravityPair(zip(pair({ mode: 0o120777 })), destination),
    /is a link/);
  await assert.rejects(extractAntigravityPair(zip([
    { name: 'agy_acp_server.par', data: Buffer.from('a'), mode: 0o100755 },
    { name: 'agy_acp_server.par', data: Buffer.from('b'), mode: 0o100755 },
  ]), destination), /duplicate member/);
  await assert.rejects(extractAntigravityPair(zip(pair({
    uncompressedSize: MAX_MEMBER_UNCOMPRESSED_BYTES + 1,
  })), destination), /unbounded/);
  await assert.rejects(extractAntigravityPair(zip([
    ...pair(),
    { name: 'extra', data: Buffer.from('nope'), mode: 0o100644 },
  ]), destination), /exactly the paired/);
  await assert.rejects(extractAntigravityPair(zip(pair({ flags: 0x0001 })), destination),
    /encrypted/);
});

test('the darwin product tar.gz is reproducible and has no gzip timestamp', {
  skip: process.platform !== 'darwin' ? 'The pinned Dev product uses macOS bsdtar.' : false,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'pair');
  await mkdir(runtimeRoot);
  await writeFile(join(runtimeRoot, 'agy_acp_server.par'), 'server-bytes');
  await writeFile(join(runtimeRoot, 'localharness_external'), 'harness-bytes');
  const first = join(root, 'first.tar.gz');
  const second = join(root, 'second.tar.gz');
  await packAntigravityPair(runtimeRoot, first, join(root, 'list-a'));
  const later = new Date('2026-10-13T00:00:00.000Z');
  await writeFile(join(runtimeRoot, 'agy_acp_server.par'), 'server-bytes', { mode: 0o600 });
  await chmod(join(runtimeRoot, 'localharness_external'), 0o644);
  await utimes(join(runtimeRoot, 'agy_acp_server.par'), later, later);
  await utimes(join(runtimeRoot, 'localharness_external'), later, later);
  await packAntigravityPair(runtimeRoot, second, join(root, 'list-b'));
  const packed = await readFile(first);
  assert.deepEqual(packed, await readFile(second));
  assert.equal(packed[0], 0x1f);
  assert.equal(packed[1], 0x8b);
  assert.equal(packed.readUInt32LE(4), 0);
});

test('an archive other than the pinned official ZIP is rejected before packing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'agy.zip');
  await writeFile(archive, Buffer.from('not the official archive'));
  await assert.rejects(buildAntigravityRuntimeCandidate(join(root, 'out'), join(root, 'work'), {
    archivePath: archive,
  }), /pinned recipe/);
  const link = join(root, 'linked.zip');
  await symlink(archive, link);
  await assert.rejects(buildAntigravityRuntimeCandidate(join(root, 'out-2'), join(root, 'work-2'), {
    archivePath: link,
  }), /regular file/);

  const sameSize = join(root, 'same-size.zip');
  const file = await open(sameSize, 'wx');
  try { await file.truncate(antigravityRuntimeSource.sourceSize); }
  finally { await file.close(); }
  await assert.rejects(buildAntigravityRuntimeCandidate(join(root, 'out-3'), join(root, 'work-3'), {
    archivePath: sameSize,
  }), error => {
    assert.match(error.message, /"stage":"file-integrity"/);
    assert.match(error.message, /"actualSize":111456962/);
    assert.match(error.message, /"actualSha256":"[a-f0-9]{64}"/);
    assert.match(error.message, /"expectedSha256":"7cd97045/);
    return true;
  });
});

test('download requests identity bytes and distinguishes HTTP, encoding, declared and actual size failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { name: 'http', response: () => new Response('private response body', { status: 503 }), error: /download failed \(503\)/ },
    { name: 'no-body', response: () => new Response(null), error: /download failed \(200\)/ },
    { name: 'encoded', response: () => new Response('private response body', { headers: { 'content-encoding': 'gzip', 'content-length': '111404059' } }), error: /"stage":"content-encoding".*"declaredSize":111404059/ },
    { name: 'declared', response: () => new Response('private response body', { headers: { 'content-length': '111404059' } }), error: /"stage":"content-length".*"declaredSize":111404059/ },
    { name: 'short', response: () => new Response('zip', { headers: { 'content-length': String(antigravityRuntimeSource.sourceSize) } }), error: /"stage":"download-size".*"declaredSize":111456962,"actualSize":3/ },
    { name: 'unknown-length', response: () => new Response('zip'), error: /"stage":"download-size".*"declaredSize":null,"actualSize":3/ },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const work = join(root, fixture.name);
      let calls = 0;
      await assert.rejects(buildAntigravityRuntimeCandidate(join(work, 'out'), work, {
        fetch: async (url, init) => {
          calls += 1;
          assert.equal(url, antigravityRuntimeSource.sourceUrl);
          assert.equal(new Headers(init.headers).get('accept-encoding'), 'identity');
          assert.equal(init.redirect, 'follow');
          assert.ok(init.signal instanceof AbortSignal);
          return fixture.response();
        },
      }), error => {
        assert.match(error.message, fixture.error);
        assert.doesNotMatch(error.message, /private response body/);
        return true;
      });
      assert.equal(calls, 1);
      await assert.rejects(lstat(join(work, 'agy-acp-source.zip')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(work, 'antigravity-pair')), { code: 'ENOENT' });
    });
  }
});
