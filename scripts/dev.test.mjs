import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEV_HOST_URL,
  DEV_WEB_URL,
  parseDevArguments,
  resolveDevEnvironment,
} from './dev.mjs';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

test('dev environment pins isolated GianDev services and desktop targets', () => {
  const env = resolveDevEnvironment({
    PATH: '/usr/bin',
    GIAN_PORT: '8990',
    GIAN_DATA_DIR: '/tmp/production-must-not-leak',
    GIAN_DEV_DATA_DIR: '/tmp/gian-dev-test',
  });

  assert.equal(env.GIAN_HOST, '127.0.0.1');
  assert.equal(env.GIAN_PORT, '8991');
  assert.equal(env.GIAN_WEB_PORT, '5191');
  assert.equal(env.GIAN_DATA_DIR, '/tmp/gian-dev-test');
  assert.equal(env.GIAN_DESKTOP_HOST_URL, DEV_HOST_URL);
  assert.equal(env.GIAN_DESKTOP_WEB_URL, DEV_WEB_URL);
  assert.equal(env.GIAN_DESKTOP_DISABLE_HOST_MANAGEMENT, '1');
});

test('dev command launches desktop unless explicitly disabled', () => {
  assert.deepEqual(parseDevArguments([]), { desktop: true });
  assert.deepEqual(parseDevArguments(['--no-desktop']), { desktop: false });
  assert.throws(() => parseDevArguments(['--browser']), /unknown dev option/);
});

test('desktop clean invalidates incremental state before rebuilding', async () => {
  const source = await readFile(join(rootDir, 'packages/desktop/package.json'), 'utf8');
  const pkg = JSON.parse(source);
  assert.match(pkg.scripts.clean, /\*\.tsbuildinfo/);
});
