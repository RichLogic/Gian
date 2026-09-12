import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  FALLBACK_ATTACHMENT_MIME,
  mimeForAttachment,
  previewMimeForAttachment,
  resolveAttachmentPath,
} from '../src/storage/attachments.js';

function withDataDir(): { cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-att-path-'));
  const prev = process.env.GIAN_DATA_DIR;
  process.env.GIAN_DATA_DIR = dataDir;
  return {
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.GIAN_DATA_DIR;
      else process.env.GIAN_DATA_DIR = prev;
    },
  };
}

test('resolveAttachmentPath rejects traversal, absolute, and nested names', () => {
  const { cleanup } = withDataDir();
  try {
    assert.equal(resolveAttachmentPath('s1', '../etc/passwd'), null);
    assert.equal(resolveAttachmentPath('s1', '/etc/passwd'), null);
    assert.equal(resolveAttachmentPath('s1', 'nested/photo.png'), null);
  } finally {
    cleanup();
  }
});

test('resolveAttachmentPath keeps a basename inside the session store', () => {
  const { cleanup } = withDataDir();
  try {
    const resolved = resolveAttachmentPath('s1', 'photo.PNG');
    assert.ok(resolved);
    assert.ok(resolved.endsWith(`${join('attachments', 's1', 'photo.PNG')}`));
  } finally {
    cleanup();
  }
});

test('attachment MIME keeps HTTP downloads opaque but allows safe Remote preview types', () => {
  assert.equal(mimeForAttachment('photo.PNG'), 'image/png');
  assert.equal(mimeForAttachment('shot.JPG'), 'image/jpeg');
  assert.equal(mimeForAttachment('notes.md'), FALLBACK_ATTACHMENT_MIME);
  assert.equal(previewMimeForAttachment('scan.JPEG'), 'image/jpeg');
  assert.equal(previewMimeForAttachment('notes.md'), 'text/markdown');
  assert.equal(previewMimeForAttachment('trace.JSONL'), 'application/x-ndjson');
  assert.equal(previewMimeForAttachment('script.ts'), 'text/typescript');
  assert.equal(mimeForAttachment('README'), FALLBACK_ATTACHMENT_MIME);
  assert.equal(previewMimeForAttachment('archive.zip'), FALLBACK_ATTACHMENT_MIME);
});
