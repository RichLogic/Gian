import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MAX_PICKED_FILE_BYTES,
  mimeForPickedFile,
  readPickedComposerResources,
} from '../src/resource-picker.js';

test('resource picker classifies files and folders without embedding directory contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-resource-picker-'));
  const folder = join(root, 'reference');
  const file = join(root, 'notes.txt');
  mkdirSync(folder);
  writeFileSync(join(folder, 'secret.txt'), 'must not be embedded');
  writeFileSync(file, 'hello');
  try {
    const result = readPickedComposerResources([file, folder]);
    assert.deepEqual(result.rejectedFiles, []);
    assert.deepEqual(result.resources[0], {
      type: 'file',
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      data: new Uint8Array(Buffer.from('hello')),
    });
    assert.deepEqual(result.resources[1], {
      type: 'folder',
      name: 'reference',
      path: realpathSync.native(folder),
    });
    assert.equal(JSON.stringify(result.resources).includes('must not be embedded'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resource picker rejects oversized files and infers bounded MIME types', () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-resource-picker-large-'));
  const file = join(root, 'large.bin');
  writeFileSync(file, Buffer.alloc(MAX_PICKED_FILE_BYTES + 1));
  try {
    assert.deepEqual(readPickedComposerResources([file]), {
      resources: [],
      rejectedFiles: ['large.bin'],
    });
    assert.equal(mimeForPickedFile('/tmp/photo.PNG'), 'image/png');
    assert.equal(mimeForPickedFile('/tmp/archive.unknown'), 'application/octet-stream');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
