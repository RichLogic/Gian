import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stageProxyProtocolPackage, proxyProtocolPackageReceipt } from './proxy-protocol-package.mjs';
import { importProxyProtocol } from './import-proxy-protocol.mjs';
import { protocolCoordinates, validateProtocolDependency, verifyProtocolArchive } from '../delivery/proxies/scripts/protocol-dependency.mjs';

const archiveBytes = Buffer.from('synthetic protocol archive; never a publication coordinate');
const revision = 'a'.repeat(40);
function coordinateFixture() {
  return {
    schema: 1, name: '@gian/proxy-protocol', repository: 'RichLogic/Gian', version: '1.0.0',
    ...protocolCoordinates('1.0.0'), sourceCommit: revision, size: archiveBytes.length,
    sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`,
    dependencies: { zod: '4.4.3' },
  };
}
function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'gian-proxy-protocol-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function packageFixture(root) {
  const put = (path, value) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const exports = {};
  for (const [key, file] of [['.', 'index'], ['./schemas', 'schemas'], ['./conformance', 'conformance'], ['./node', 'node']]) {
    exports[key] = { types: `./dist/src/${file}.d.ts`, default: `./dist/src/${file}.js` };
    put(`packages/proxy-protocol/dist/src/${file}.js`, 'export const fixture = true;');
    put(`packages/proxy-protocol/dist/src/${file}.d.ts`, 'export declare const fixture: boolean;');
  }
  put('LICENSE', 'fixture license');
  put('packages/proxy-protocol/README.md', '# Fixture protocol');
  put('packages/proxy-protocol/CHANGELOG.md', '# Fixture changes');
  put('packages/proxy-protocol/package.json', {
    name: '@gian/proxy-protocol', version: '1.0.0', private: true, type: 'module',
    main: './dist/src/index.js', types: './dist/src/index.d.ts', exports,
    scripts: { postinstall: 'must-not-ship' }, dependencies: { zod: '^4.3.6' },
  });
  put('packages/proxy-protocol/node_modules/zod/package.json', { name: 'zod', version: '4.4.3' });
  put('packages/proxy-protocol/src/index.ts', 'raw source must not ship');
  put('packages/proxy-protocol/dist/test/private.test.js', 'test source must not ship');
  return put;
}

test('Proxy Protocol packages all public compiled exports, exact dependencies and no install scripts', t => {
  const root = temporaryRoot(t);
  packageFixture(root);
  const output = join(root, 'package');
  const manifest = stageProxyProtocolPackage({ root, output, revision });
  assert.equal(manifest.name, '@gian/proxy-protocol');
  assert.deepEqual(manifest.dependencies, { zod: '4.4.3' });
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.gianSourceCommit, revision);
  for (const entry of Object.values(manifest.exports)) {
    assert.equal(existsSync(join(output, entry.default)), true);
    assert.equal(existsSync(join(output, entry.types)), true);
  }
  for (const path of ['src', 'dist/test', 'node_modules']) assert.equal(existsSync(join(output, path)), false);
  const archive = join(root, protocolCoordinates('1.0.0').filename);
  writeFileSync(archive, archiveBytes);
  assert.deepEqual(proxyProtocolPackageReceipt({ staging: output, archive, revision }), coordinateFixture());
  assert.throws(() => proxyProtocolPackageReceipt({ staging: output, archive, revision: 'b'.repeat(40) }), /another source/);
  assert.throws(() => stageProxyProtocolPackage({ root, output, revision }), /must not exist/);
  assert.throws(() => stageProxyProtocolPackage({ root, output: join(root, 'packages/proxy-protocol/output'), revision }), /outside/);
});

test('incomplete builds and symlinked implementation never enter the package', t => {
  const root = temporaryRoot(t);
  packageFixture(root);
  const path = join(root, 'packages/proxy-protocol/dist/src/node.d.ts');
  rmSync(path);
  const output = join(root, 'package');
  assert.throws(() => stageProxyProtocolPackage({ root, output, revision }), /every Proxy Protocol export/);
  assert.equal(existsSync(output), false);
  symlinkSync('index.d.ts', path);
  assert.throws(() => stageProxyProtocolPackage({ root, output, revision }), /symlinks/);
  assert.equal(existsSync(output), false);
});

test('coordinates fail closed on mutable/private URLs, unknown fields and unpinned dependencies', () => {
  const coordinate = coordinateFixture();
  assert.equal(verifyProtocolArchive(coordinate, archiveBytes), coordinate);
  for (const changes of [
    { repository: 'RichLogic/Gian-Dev' }, { name: '@gian/remote-protocol' },
    { tag: 'main' }, { url: coordinate.url + '?temporary=true' },
    { sourceCommit: 'main' }, { size: 0 }, { size: 17 * 1024 * 1024 },
    { integrity: 'sha512-invalid' }, { dependencies: { zod: '^4.4.3' } },
    { extra: true }, { status: 'pending-publication' },
  ]) assert.throws(() => validateProtocolDependency({ ...coordinate, ...changes }));
  assert.throws(() => protocolCoordinates('1.0.0-beta1'), /exact stable/);
  assert.throws(() => verifyProtocolArchive(coordinate, Buffer.from('wrong')), /differ/);
});

function releaseFixture(coordinate) {
  const state = { draft: false, prerelease: false, tagCommit: revision, comparison: 'ahead', bytes: archiveBytes, annotated: false };
  const receiptUrl = coordinate.url.replace(coordinate.filename, 'protocol-package.json');
  const fetcher = async url => {
    if (url.includes('/releases/tags/')) return Response.json({
      draft: state.draft, prerelease: state.prerelease, tag_name: coordinate.tag,
      assets: [
        { name: coordinate.filename, browser_download_url: coordinate.url, size: coordinate.size, digest: `sha256:${coordinate.sha256}` },
        { name: 'protocol-package.json', browser_download_url: receiptUrl },
      ],
    });
    if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: state.annotated ? 'tag' : 'commit', sha: state.annotated ? 'c'.repeat(40) : state.tagCommit } });
    if (url.includes('/git/tags/')) return Response.json({ object: { type: 'commit', sha: state.tagCommit } });
    if (url.includes('/compare/')) return Response.json({ status: state.comparison, merge_base_commit: { sha: revision } });
    if (url === receiptUrl) return Response.json(coordinate);
    if (url === coordinate.url) return new Response(state.bytes);
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  return { state, fetcher };
}

test('import verifies public release, tag ancestry and exact bytes before atomically replacing the pending marker', async t => {
  const root = temporaryRoot(t);
  const output = join(root, 'protocol-package.json');
  const coordinate = coordinateFixture();
  const { state, fetcher } = releaseFixture(coordinate);
  writeFileSync(output, JSON.stringify({ status: 'pending-publication' }));
  await importProxyProtocol('1.0.0', output, fetcher);
  assert.deepEqual(JSON.parse(readFileSync(output)), coordinate);
  state.annotated = true;
  await importProxyProtocol('1.0.0', output, fetcher);
  const previous = readFileSync(output);
  for (const [field, value, pattern] of [
    ['draft', true, /published stable/], ['prerelease', true, /published stable/],
    ['tagCommit', 'b'.repeat(40), /tag commit/], ['comparison', 'diverged', /public Gian main/],
    ['bytes', Buffer.from('wrong'), /differ/],
    ['bytes', Buffer.alloc(archiveBytes.length + 1), /size limit/],
  ]) {
    const original = state[field];
    state[field] = value;
    await assert.rejects(importProxyProtocol('1.0.0', output, fetcher), pattern);
    assert.deepEqual(readFileSync(output), previous);
    state[field] = original;
  }
  writeFileSync(output, JSON.stringify({ ...coordinate, dependencies: { zod: '4.4.4' } }));
  await assert.rejects(importProxyProtocol('1.0.0', output, fetcher), /Cannot replace/);
});

test('failed public requests and oversized metadata do not create a consumer pin', async t => {
  const root = temporaryRoot(t);
  const output = join(root, 'protocol-package.json');
  await assert.rejects(importProxyProtocol('1.0.0', output, async () => new Response('unavailable', { status: 503 })), /503/);
  assert.equal(existsSync(output), false);
  await assert.rejects(importProxyProtocol('1.0.0', output, async () => new Response(Buffer.alloc(1024 * 1024 + 1))), /size limit/);
  assert.equal(existsSync(output), false);
});

test('publication tests the archive in isolation, publishes only certified bytes and stays outside App packaging', () => {
  const workflow = readFileSync(new URL('../.github/workflows/proxy-protocol-release.yml', import.meta.url), 'utf8');
  for (const required of [
    "github.repository == 'RichLogic/Gian'", 'git merge-base --is-ancestor',
    'pnpm --filter @gian/proxy-protocol test', 'node --test scripts/proxy-protocol-package.test.mjs',
    'npm install --ignore-scripts', 'node compiled/consumer.mjs', 'verifyProtocolArchive', '--latest=false',
  ]) assert.ok(workflow.includes(required), `missing publication boundary: ${required}`);
  for (const forbidden of ['GIAN_DEV_READ_TOKEN', 'quality:package', 'verify:preview', 'secrets.APPLE', '--clobber']) {
    assert.ok(!workflow.includes(forbidden), `unexpected App coupling: ${forbidden}`);
  }
});
