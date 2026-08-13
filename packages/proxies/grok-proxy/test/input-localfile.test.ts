import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeInputItems, toPromptBlocks } from '../src/core/input.js';

test('grok-proxy maps a localFile to an ACP resource_link', async () => {
  const input = normalizeInputItems(
    [{
      type: 'localFile',
      path: 'attachments/report final.pdf',
      name: 'report final.pdf',
      mimeType: 'application/pdf',
      size: 42,
    }],
    '/workdir',
  );

  assert.deepEqual(input, [{
    type: 'localFile',
    path: '/workdir/attachments/report final.pdf',
    name: 'report final.pdf',
    mimeType: 'application/pdf',
    size: 42,
  }]);
  assert.deepEqual(await toPromptBlocks(input), [{
    type: 'resource_link',
    uri: 'file:///workdir/attachments/report%20final.pdf',
    name: 'report final.pdf',
    mimeType: 'application/pdf',
    size: 42,
  }]);
});

test('grok-proxy rejects a localFile without a path', () => {
  assert.throws(
    () => normalizeInputItems([{ type: 'localFile', path: ' ' }], '/workdir'),
    /localFile.*path/,
  );
});
