import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { InputItem } from '@gian/shared';

import {
  assertLocalFilesBelongToSession,
  buildAttachmentsFromItems,
  kimiContentText,
  translateItemsForExecutor,
} from '../src/session/input-items.js';
import { resolveAttachmentPath } from '../src/storage/attachments.js';

function withDataDir(): { cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-input-items-'));
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

const skill: InputItem = { type: 'skill', name: 'review', path: '/skills/review' };
const text: InputItem = { type: 'text', text: 'hello' };

test('translateItemsForExecutor keeps Codex skills and maps others to slash text', () => {
  const items = [text, skill];
  assert.deepEqual(translateItemsForExecutor('codex', items), items);
  assert.deepEqual(translateItemsForExecutor('claude', items), [
    text,
    { type: 'text', text: '/review' },
  ]);
  assert.deepEqual(translateItemsForExecutor('kimi', items), [
    text,
    { type: 'text', text: '/review' },
  ]);
});

test('buildAttachmentsFromItems shapes image and file chips', () => {
  const items: InputItem[] = [
    text,
    {
      type: 'localImage',
      path: '/tmp/ignored/photo.PNG',
      name: 'paste.png',
      size: 12,
    },
    {
      type: 'localFile',
      path: '/tmp/ignored/notes.md',
      mime: 'text/markdown',
    },
  ];

  assert.deepEqual(buildAttachmentsFromItems('sess-1', items), [
    {
      name: 'paste.png',
      mime: 'image/png',
      url: '/api/sessions/sess-1/attachments/photo.PNG',
      size: 12,
    },
    {
      name: 'notes.md',
      mime: 'text/markdown',
      url: '/api/sessions/sess-1/attachments/notes.md',
    },
  ]);
  assert.deepEqual(buildAttachmentsFromItems('sess-1', undefined), []);
});

test('kimiContentText only returns ACP text parts', () => {
  assert.equal(kimiContentText({ type: 'text', text: 'hi' }), 'hi');
  assert.equal(kimiContentText({ type: 'image', text: 'nope' }), '');
  assert.equal(kimiContentText(null), '');
  assert.equal(kimiContentText('plain'), '');
});

test('assertLocalFilesBelongToSession requires a real session-store file', () => {
  const { cleanup } = withDataDir();
  try {
    assert.doesNotThrow(() => assertLocalFilesBelongToSession('s1', undefined));
    assert.doesNotThrow(() => assertLocalFilesBelongToSession('s1', [
      { type: 'localImage', path: '/tmp/outside.png' },
    ]));

    assert.throws(
      () => assertLocalFilesBelongToSession('s1', [
        { type: 'localFile', path: '/tmp/outside.md' },
      ]),
      /invalid local file attachment for session s1/,
    );

    const stored = resolveAttachmentPath('s1', 'notes.md');
    assert.ok(stored);
    mkdirSync(dirname(stored), { recursive: true });
    writeFileSync(stored, 'ok');
    assert.doesNotThrow(() => assertLocalFilesBelongToSession('s1', [
      { type: 'localFile', path: stored },
    ]));
  } finally {
    cleanup();
  }
});
