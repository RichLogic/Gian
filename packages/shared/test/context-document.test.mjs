import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composerDocumentPlainText,
  composerDocumentUserText,
  normalizeComposerDocument,
} from '../dist/context.js';

test('composer documents pass the file kind through normalization', () => {
  const document = normalizeComposerDocument({
    version: 1,
    segments: [
      { type: 'text', text: 'see ' },
      { type: 'reference', id: 'f1', referenceType: 'context', label: 'index.ts', kind: 'file' },
    ],
  });
  assert.deepEqual(document, {
    version: 1,
    segments: [
      { type: 'text', text: 'see ' },
      { type: 'reference', id: 'f1', referenceType: 'context', label: 'index.ts', kind: 'file' },
    ],
  });
  assert.ok(document);
  assert.equal(composerDocumentPlainText(document), 'see "index.ts"');
  assert.equal(composerDocumentUserText(document), 'see ');
});

test('composer documents reject unknown reference kinds', () => {
  assert.equal(normalizeComposerDocument({
    version: 1,
    segments: [
      { type: 'reference', id: 'f1', referenceType: 'context', label: 'x', kind: 'folder' },
    ],
  }), null);
});

test('composer documents reject conflicting kinds for a repeated reference id', () => {
  assert.equal(normalizeComposerDocument({
    version: 1,
    segments: [
      { type: 'reference', id: 'f1', referenceType: 'context', label: 'index.ts', kind: 'file' },
      { type: 'reference', id: 'f1', referenceType: 'context', label: 'index.ts' },
    ],
  }), null);
  // Same id, same kind: still fine.
  const document = normalizeComposerDocument({
    version: 1,
    segments: [
      { type: 'reference', id: 'f1', referenceType: 'context', label: 'index.ts', kind: 'file' },
      { type: 'text', text: ' ' },
      { type: 'reference', id: 'f1', referenceType: 'context', label: 'index.ts', kind: 'file' },
    ],
  });
  assert.ok(document);
});
