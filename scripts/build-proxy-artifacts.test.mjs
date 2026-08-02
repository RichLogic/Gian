import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildProxyBundle } from './build-proxy-artifacts.mjs';

const execFileAsync = promisify(execFile);

test('proxy bundle has one shebang and supports CommonJS dynamic require', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'spawn.js');
  const dependency = join(root, 'dependency.cjs');
  const output = join(root, 'proxy.mjs');

  await writeFile(dependency, [
    "const path = require('node:path');",
    "module.exports = path.join('proxy', 'ready');",
    '',
  ].join('\n'));
  await writeFile(entry, [
    '#!/usr/bin/env node',
    "import result from './dependency.cjs';",
    "if (process.argv.includes('--self-test')) process.stdout.write(result);",
    '',
  ].join('\n'));

  await buildProxyBundle(entry, output);

  const bundle = await readFile(output, 'utf8');
  assert.equal(bundle.match(/^#!/gm)?.length, 1);
  assert.match(bundle, /^#!\/usr\/bin\/env node\n/);
  const result = await execFileAsync(process.execPath, [output, '--self-test'], {
    encoding: 'utf8',
  });
  assert.equal(result.stdout.trim(), join('proxy', 'ready'));
});
