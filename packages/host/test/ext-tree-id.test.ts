import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extTreeId } from '../src/web/working-tree-git.js';

test('extTreeId is ext:<workspaceId>:<base64url(path)>', () => {
  const path = '/Users/dev/project';
  const id = extTreeId('ws-1', path);
  const encoded = Buffer.from(path, 'utf8').toString('base64url');
  assert.equal(id, `ext:ws-1:${encoded}`);
});

test('extTreeId differs for different paths and is reversible', () => {
  const a = extTreeId('ws-1', '/tmp/alpha');
  const b = extTreeId('ws-1', '/tmp/beta');
  assert.notEqual(a, b);
  const decode = (id: string): string =>
    Buffer.from(id.split(':').slice(2).join(':'), 'base64url').toString('utf8');
  assert.equal(decode(a), '/tmp/alpha');
  assert.equal(decode(b), '/tmp/beta');
});

test('extTreeId keeps workspace id and encodes path characters that would break ids', () => {
  const path = '/tmp/work tree/+plus';
  const id = extTreeId('ws+id', path);
  assert.match(id, /^ext:ws\+id:[A-Za-z0-9_-]+$/);
  const encoded = id.slice(`ext:ws+id:`.length);
  assert.equal(Buffer.from(encoded, 'base64url').toString('utf8'), path);
});
