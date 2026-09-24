import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRemoteApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { SECURITY_HEADERS } from '../src/static/headers.js';
import { loadAndVerifyManifest } from '../src/static/manifest.js';
import { writeStaticManifest } from '../src/static/write-manifest.js';
import { makeRemoteTestApp, writeStaticArtifact } from './fixture.js';

test('writeStaticManifest emits sha256 entries that verify', () => {
  const dir = writeStaticArtifact('build-write');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  const written = writeStaticManifest(dir, 'build-write-2');
  assert.equal(written.build_id, 'build-write-2');
  assert.ok(written.files['index.html']);
  assert.ok(written.files['app.js']);
  assert.equal(written.files['manifest.json'], undefined);
  const verified = loadAndVerifyManifest(dir);
  assert.equal(verified.build_id, 'build-write-2');
});

test('static manifest verification fails closed on missing or mismatched files', () => {
  const dir = writeStaticArtifact('build-static');
  const manifest = loadAndVerifyManifest(dir);
  assert.equal(manifest.build_id, 'build-static');
  writeFileSync(join(dir, 'index.html'), '<html>tampered</html>');
  assert.throws(() => loadAndVerifyManifest(dir), /hash mismatch/);
  assert.throws(() => loadAndVerifyManifest(join(dir, 'missing')), /static manifest is missing/);
});

test('static HTML injects only public origin and build id and ships CSP', async () => {
  const staticDir = writeStaticArtifact('build-csp');
  const { fetch, handle, publicOrigin } = await makeRemoteTestApp({ staticDir });
  const response = await fetch('/');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<script src="\/__gian_remote_runtime\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>window\.__GIAN_REMOTE__/);
  assert.doesNotMatch(html, /admin-test-token|enrollment|refresh|ciphertext/);
  assert.equal(response.headers.get('Content-Security-Policy'), SECURITY_HEADERS['Content-Security-Policy']);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  const enrollment = await fetch('/enrollment');
  assert.equal(enrollment.status, 200);
  assert.equal(await enrollment.text(), html);
  const runtime = await fetch('/__gian_remote_runtime.js');
  assert.equal(runtime.status, 200);
  const script = await runtime.text();
  assert.match(script, /window\.__GIAN_REMOTE__/);
  assert.match(script, new RegExp(publicOrigin));
  assert.match(script, /build-csp/);
  assert.match(String(runtime.headers.get('Content-Type')), /javascript/);
  handle.shutdown();
});

test('createRemoteApp refuses a partial static artifact', async () => {
  const dir = writeStaticArtifact('broken');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    build_id: 'broken',
    files: { 'index.html': '00'.repeat(32), 'missing.js': '11'.repeat(32) },
  }));
  await assert.rejects(
    () => createRemoteApp(createConfig({
      dataDir: dir,
      publicOrigin: 'https://remote.test',
      adminToken: 'admin-test-token',
      staticDir: dir,
    })),
    /static artifact/,
  );
});
