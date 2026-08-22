import { homedir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { locateCcJsonl, locateNativeJsonl } from '../src/native/locate-jsonl.js';

test('locateCcJsonl encodes cwd slashes as dashes and does not scan disk', () => {
  const cwd = '/Users/dev/My Project/repo';
  const expected = join(homedir(), '.claude', 'projects', '-Users-dev-My Project-repo', 'sess-1.jsonl');
  assert.equal(locateCcJsonl('sess-1', cwd), expected);
});

test('locateCcJsonl is deterministic for the same inputs', () => {
  const a = locateCcJsonl('abc', '/tmp/ws');
  const b = locateCcJsonl('abc', '/tmp/ws');
  assert.equal(a, b);
  assert.notEqual(locateCcJsonl('abc', '/tmp/other'), a);
});

test('locateNativeJsonl delegates claude to locateCcJsonl', () => {
  const cwd = '/opt/code';
  assert.equal(locateNativeJsonl('claude', 'n-9', cwd), locateCcJsonl('n-9', cwd));
});
