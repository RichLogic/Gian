import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/Sheet.js';

// Each stacked file block in a diff body is tagged with data-path (kept from
// the anchor-jump experiment — the attribute is retained even though the
// click→scroll behavior was reverted in the 6.1 fixes).
const diffText = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1 +1 @@',
  '-foo',
  '+bar',
].join('\n');

function diffTab(extra?: Partial<SheetTab>): SheetTab {
  return {
    id: 'd1', group: 'diffs', name: 'a.ts', kind: 'diff', icoKind: 'diff', ico: '±',
    diffText, ...extra,
  };
}

const actions = {
  activateTab: () => {}, closeTab: () => {}, pinTab: () => {}, setTabViewMode: () => {},
};

afterEach(() => cleanup());

describe('Sheet diff file blocks', () => {
  it('tags each stacked file block with data-path', () => {
    const { container } = render(
      <Sheet tabs={[diffTab()]} activeByGroup={{ diffs: 'd1' }} activeGroup="diffs" actions={actions} />,
    );
    const blocks = container.querySelectorAll('.sheet-diff-file');
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.getAttribute('data-path')).toBe('src/a.ts');
    expect(blocks[1]!.getAttribute('data-path')).toBe('src/b.ts');
  });
});
