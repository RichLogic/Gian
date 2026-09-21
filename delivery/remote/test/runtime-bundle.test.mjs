import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { bundleRuntime } from '../scripts/bundle-runtime.mjs';

test('runtime bundling uses installed transitive dependencies without registry metadata or an installer', t => {
  const temp = mkdtempSync(join(tmpdir(), 'remote-bundle-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'); const out = join(temp, 'runtime');
  const put = (path, value) => { const p = join(source, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
  put('packages/remote-server/package.json', { name: '@gian/remote-server', dependencies: { a: '^1.0.0' }, devDependencies: { absent: '*' } });
  put('node_modules/a/package.json', { name: 'a', version: '1.2.3', main: 'index.js', dependencies: { b: '^1.0.0' }, optionalDependencies: { unavailable: '*' } });
  put('node_modules/a/index.js', 'module.exports = require("b");');
  put('node_modules/b/package.json', { name: 'b', version: '1.5.1', main: 'index.js' });
  put('node_modules/b/index.js', 'module.exports = "exact-installed-version";');
  assert.equal(bundleRuntime(out, source).packages, 3);
  assert.equal(createRequire(join(out, 'package.json'))('a'), 'exact-installed-version');
  assert.equal(existsSync(join(out, 'node_modules/absent')), false);
  assert.throws(() => bundleRuntime(join(source, 'nested'), source), /outside the source tree/);
  assert.throws(() => bundleRuntime(out, source), /must not exist/);
});
