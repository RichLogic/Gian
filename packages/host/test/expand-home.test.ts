import { homedir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { expandHome } from '../src/workspace/init.js';

test('expandHome resolves a lone tilde to the home directory', () => {
  assert.equal(expandHome('~'), homedir());
});

test('expandHome joins ~/path against home', () => {
  assert.equal(expandHome('~/Coding/repo'), join(homedir(), 'Coding/repo'));
});

test('expandHome leaves absolute and relative paths unchanged', () => {
  assert.equal(expandHome('/tmp/abs'), '/tmp/abs');
  assert.equal(expandHome('relative/path'), 'relative/path');
  assert.equal(expandHome('~not-home'), '~not-home');
});
