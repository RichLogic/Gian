import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { exportRemote, remoteExportPath, remotePackages } from './export-remote.mjs';
import '../delivery/remote/test/release.test.mjs';
import '../delivery/remote/test/runtime-bundle.test.mjs';
import '../delivery/remote/test/adoption.test.mjs';
import { verifySource } from '../delivery/remote/scripts/verify-source.mjs';
import '../delivery/remote/test/protocol-dependency.test.mjs';
import { protocolFixture, protocolLockFixture } from '../delivery/remote/test/protocol-fixture.mjs';

test('Remote source boundary includes its build closure and excludes other products/private files', () => {
  for (const path of ['AGENTS.md', '.ai/STATE.md', 'docs/protocol.md', '.git/config', 'packages/host/src/index.ts', 'packages/proxies/codex-proxy/manifest.json', 'packages/desktop/package.json', 'packages/remote-protocol/package.json', 'packages/remote-protocol/src/control.ts']) assert.equal(remoteExportPath(path), null, path);
  for (const name of remotePackages) assert.equal(remoteExportPath(`packages/${name}/package.json`), `packages/${name}/package.json`);
  assert.equal(remoteExportPath('delivery/remote/.github/workflows/ci.yml'), '.github/workflows/ci.yml');
  assert.equal(remoteExportPath('packages/remote-server/dist/index.js'), null);
});

test('export is reproducible, verifies dependencies and never overwrites an existing checkout', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'gian-remote-export-test-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'source'); mkdirSync(source);
  const put = (path, value) => { const p = join(source, path); mkdirSync(resolve(p, '..'), { recursive: true }); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
  put('package.json', { packageManager: 'pnpm@10.33.2', engines: { node: '>=24 <25' }, devDependencies: {} });
  put('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'packages/proxies/*'\n\nonlyBuiltDependencies:\n  - better-sqlite3\n");
  put('delivery/remote/release.json', { product: 'Gian Remote', repository: 'RichLogic/Gian-Remote', version: '1.0.0' });
  put('delivery/remote/protocol-package.json', protocolFixture());
  put('pnpm-lock.yaml', protocolLockFixture());
  for (const name of remotePackages) put(`packages/${name}/package.json`, { name: `@gian/${name}`, version: '1.0.0' });
  for (const name of ['remote-server', 'remote-web']) {
    put(`packages/${name}/package.json`, { name: `@gian/${name}`, version: '1.0.0', dependencies: { '@gian/remote-protocol': 'workspace:*' } });
    put(`packages/${name}/tsconfig.json`, { references: [{ path: '../remote-protocol' }] });
  }
  put('packages/remote-protocol/src/index.ts', 'protocol source must stay in Gian');
  put('AGENTS.md', 'private'); put('packages/remote-server/src/index.ts', 'export const fixture = true;');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  const first = exportRemote({ source, output: join(temporary, 'a') });
  exportRemote({ source, output: join(temporary, 'b') });
  const raw = readFileSync(join(first.output, '.gian-source.json'));
  assert.deepEqual(raw, readFileSync(join(temporary, 'b/.gian-source.json')));
  const manifest = JSON.parse(raw);
  assert.equal(manifest.workingTree, false);
  assert.equal(existsSync(join(first.output, 'AGENTS.md')), false);
  assert.equal(existsSync(join(first.output, 'packages/remote-protocol')), false);
  assert.equal(JSON.parse(readFileSync(join(first.output, 'packages/remote-server/package.json'))).dependencies['@gian/remote-protocol'], protocolFixture().url);
  for (const file of manifest.files) assert.equal(createHash('sha256').update(readFileSync(join(first.output, file.path))).digest('hex'), file.sha256);
  assert.match(readFileSync(join(first.output, 'pnpm-workspace.yaml'), 'utf8'), /packages\/remote-server/);
  assert.equal(verifySource(first.output).sourceCommit, first.commit);
  writeFileSync(join(first.output, 'packages/remote-server/src/index.ts'), 'unexpected change');
  assert.throws(() => verifySource(first.output), /differs from exported snapshot/);
  assert.throws(() => exportRemote({ source, output: first.output }), /never overwritten/);
  put('packages/remote-web/package.json', { dependencies: { '@gian/remote-protocol': 'workspace:*', '@gian/host': 'workspace:*' } });
  assert.throws(() => exportRemote({ source, output: join(temporary, 'bad'), workingTree: true }), /Missing Remote dependency/);
  put('delivery/remote/protocol-package.json', { status: 'pending-publication' });
  assert.throws(() => exportRemote({ source, output: join(temporary, 'not-ready'), workingTree: true }), /Publish the Remote Protocol package/);
  assert.equal(existsSync(join(temporary, 'not-ready')), false);
});
