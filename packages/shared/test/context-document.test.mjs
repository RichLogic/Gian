import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentReferenceNumbers,
  composerDocumentPlainText,
  composerDocumentUserText,
  normalizeComposerDocument,
  numberImageAttachmentLabels,
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

test('composer documents pass the session kind through normalization', () => {
  const document = normalizeComposerDocument({
    version: 1,
    segments: [
      { type: 'text', text: 'continue ' },
      { type: 'reference', id: 's1', referenceType: 'context', label: 'Refactor plan', kind: 'session' },
    ],
  });
  assert.deepEqual(document, {
    version: 1,
    segments: [
      { type: 'text', text: 'continue ' },
      { type: 'reference', id: 's1', referenceType: 'context', label: 'Refactor plan', kind: 'session' },
    ],
  });
  assert.ok(document);
  assert.equal(composerDocumentPlainText(document), 'continue "Refactor plan"');
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

test('attachment reference numbers follow document order, counting files and images', () => {
  const document = normalizeComposerDocument({
    version: 1,
    segments: [
      { type: 'reference', id: 'img-1', referenceType: 'attachment', label: 'a.png' },
      { type: 'text', text: ' ' },
      { type: 'reference', id: 'doc-1', referenceType: 'attachment', label: 'notes.txt' },
      { type: 'text', text: ' ' },
      { type: 'reference', id: 'img-2', referenceType: 'attachment', label: 'b.png' },
      { type: 'text', text: ' again ' },
      { type: 'reference', id: 'img-1', referenceType: 'attachment', label: 'a.png' },
    ],
  });
  assert.ok(document);
  // A repeated reference keeps its first-appearance number; context
  // references never enter the numbering. This is the same N the Host's
  // compile emits as [Attached resource N].
  assert.deepEqual(
    [...attachmentReferenceNumbers(document).entries()],
    [['img-1', 1], ['doc-1', 2], ['img-2', 3]],
  );
});

test('image attachment labels become image<N> by document position; files keep their names', () => {
  const document = normalizeComposerDocument({
    version: 1,
    segments: [
      { type: 'text', text: 'look ' },
      { type: 'reference', id: 'doc-1', referenceType: 'attachment', label: 'notes.txt' },
      { type: 'reference', id: 'img-1', referenceType: 'attachment', label: 'screenshot one.png' },
      { type: 'reference', id: 'img-2', referenceType: 'attachment', label: 'screenshot two.png' },
    ],
  });
  assert.ok(document);
  const images = new Set(['img-1', 'img-2']);
  const numbered = numberImageAttachmentLabels(document, id => images.has(id));
  assert.notEqual(numbered, document);
  assert.deepEqual(
    numbered.segments.filter(s => s.type === 'reference').map(s => s.type === 'reference' ? s.label : ''),
    ['notes.txt', 'image2', 'image3'],
  );
  // The input document is not mutated.
  assert.equal(document.segments[2]?.type === 'reference' && document.segments[2].label, 'screenshot one.png');
});

test('label rewrite is a no-op (same reference) without image attachments', () => {
  const document = normalizeComposerDocument({
    version: 1,
    segments: [
      { type: 'reference', id: 'doc-1', referenceType: 'attachment', label: 'notes.txt' },
      { type: 'reference', id: 'ctx-1', referenceType: 'context', label: 'pasted text' },
    ],
  });
  assert.ok(document);
  assert.equal(numberImageAttachmentLabels(document, () => false), document);
});
