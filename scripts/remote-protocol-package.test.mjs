import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stageProtocolPackage } from './remote-protocol-package.mjs';
import { importRemoteProtocol } from './import-remote-protocol.mjs';
import { protocolFixture, protocolBytes } from '../delivery/remote/test/protocol-fixture.mjs';

test('Gian protocol package contains compiled API and declarations with pinned runtime dependencies', t => {
  const temp = mkdtempSync(join(tmpdir(), 'protocol-package-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const put = (path, value) => { const file = join(temp, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  put('LICENSE', 'fixture license');
  put('packages/remote-protocol/CHANGELOG.md', '# Fixture package changes');
  put('packages/remote-protocol/package.json', { name: '@gian/remote-protocol', version: '1.0.0', type: 'module', main: './dist/src/index.js', types: './dist/src/index.d.ts', dependencies: { zod: '^4.3.6' } });
  put('packages/remote-protocol/dist/src/index.js', 'export const sample = true;');
  put('packages/remote-protocol/dist/src/index.d.ts', 'export declare const sample: boolean;');
  put('packages/remote-protocol/src/index.ts', 'must not ship raw source');
  put('packages/remote-protocol/node_modules/zod/package.json', { name: 'zod', version: '4.4.3' });
  const output = join(temp, 'package');
  const metadata = stageProtocolPackage({ root: temp, output, revision: 'a'.repeat(40) });
  assert.equal(metadata.repository.url, 'https://github.com/RichLogic/Gian.git');
  assert.deepEqual(metadata.dependencies, { zod: '4.4.3' });
  assert.equal(existsSync(join(output, 'src')), false);
  assert.equal(existsSync(join(output, 'dist/src/index.d.ts')), true);
  assert.equal(metadata.scripts, undefined);
});

test('import only writes a coordinate after a stable public tag and archive digest match', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'protocol-import-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const coordinate = protocolFixture();
  const receiptUrl = coordinate.url.replace(coordinate.filename, 'protocol-package.json');
  let draft = false; let wrongBytes = false;
  const fetcher = async url => {
    if (url.includes('/releases/tags/')) return Response.json({ draft, prerelease: false, tag_name: coordinate.tag, assets: [{ name: coordinate.filename, browser_download_url: coordinate.url }, { name: 'protocol-package.json', browser_download_url: receiptUrl }] });
    if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: coordinate.sourceCommit } });
    if (url === receiptUrl) return Response.json(coordinate);
    if (url === coordinate.url) return new Response(wrongBytes ? Buffer.from('wrong') : protocolBytes);
    throw new Error(`Unexpected URL: ${url}`);
  };
  const output = join(temp, 'coordinate.json');
  await importRemoteProtocol('1.0.0', output, fetcher);
  assert.deepEqual(JSON.parse(readFileSync(output)), coordinate);
  const original = readFileSync(output);
  draft = true;
  await assert.rejects(importRemoteProtocol('1.0.0', output, fetcher), /published stable/);
  draft = false; wrongBytes = true;
  await assert.rejects(importRemoteProtocol('1.0.0', output, fetcher), /differ/);
  assert.deepEqual(readFileSync(output), original);
});
