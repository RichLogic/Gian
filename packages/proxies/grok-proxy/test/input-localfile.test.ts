import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeInputItems, toPromptBlocks } from '../src/core/input.js';

test('grok-proxy maps local files to links and local images to ACP image blocks', async () => {
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

  const root = await mkdtemp(join(tmpdir(), 'grok-image-input-'));
  try {
    await writeFile(join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = normalizeInputItems(
      [{ type: 'localImage', path: 'shot.png', mime: 'image/png' }],
      root,
    );
    assert.deepEqual(await toPromptBlocks(image), [{
      type: 'image',
      data: 'iVBORw==',
      mimeType: 'image/png',
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grok-proxy rejects a localFile without a path', () => {
  assert.throws(
    () => normalizeInputItems([{ type: 'localFile', path: ' ' }], '/workdir'),
    /localFile.*path/,
  );
});
