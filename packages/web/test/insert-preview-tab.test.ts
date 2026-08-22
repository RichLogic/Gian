import { describe, expect, it } from 'vitest';
import { insertGroupPreviewTab, type SheetTab } from '../src/components/sheet-model.js';

function tab(id: string, group: SheetTab['group'], preview = false): SheetTab {
  return {
    id,
    group,
    name: id,
    kind: 'file',
    icoKind: 'ts',
    ico: id,
    preview,
  };
}

describe('insertGroupPreviewTab', () => {
  it('appends onto an empty group', () => {
    const next = insertGroupPreviewTab([], 'files', tab('fresh', 'files', true));
    expect(next.map(row => row.id)).toEqual(['fresh']);
  });

  it('replaces the current preview tab in the same group', () => {
    const next = insertGroupPreviewTab(
      [tab('keep', 'files'), tab('old', 'files', true)],
      'files',
      tab('new', 'files', true),
    );
    expect(next.map(row => row.id)).toEqual(['keep', 'new']);
  });

  it('does not evict a preview that belongs to another group', () => {
    const diffsPreview = tab('diff-preview', 'diffs', true);
    const next = insertGroupPreviewTab([diffsPreview], 'files', tab('file-preview', 'files', true));
    expect(next.map(row => row.id)).toEqual(['diff-preview', 'file-preview']);
  });

  it('never evicts a non-preview tab', () => {
    const pinned = tab('pinned', 'files');
    const next = insertGroupPreviewTab([pinned], 'files', tab('preview', 'files', true));
    expect(next).toEqual([pinned, tab('preview', 'files', true)]);
  });
});
