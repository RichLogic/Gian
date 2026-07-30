import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/Sheet.js';

// The diffs rail's flat all-diff tab: Changes-tree clicks anchor-scroll to a
// file's block (data-path) instead of opening a single-file diff.
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
    id: 'd1', group: 'diffs', name: 'All changes', kind: 'diff', icoKind: 'diff', ico: '±',
    diffText, diffAll: true, ...extra,
  };
}

const actions = {
  activateTab: () => {}, closeTab: () => {}, pinTab: () => {}, setTabViewMode: () => {},
};

function renderSheet(tab: SheetTab) {
  return render(
    <Sheet tabs={[tab]} activeByGroup={{ diffs: 'd1' }} activeGroup="diffs" actions={actions} />,
  );
}

afterEach(() => cleanup());

describe('Sheet diff anchor jump', () => {
  it('tags each stacked file block with data-path', () => {
    const { container } = renderSheet(diffTab());
    const blocks = container.querySelectorAll('.sheet-diff-file');
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.getAttribute('data-path')).toBe('src/a.ts');
    expect(blocks[1]!.getAttribute('data-path')).toBe('src/b.ts');
  });

  it('scrolls only the matching block into view on scrollPath change', () => {
    const { container, rerender } = renderSheet(diffTab());
    const blocks = container.querySelectorAll<HTMLElement>('.sheet-diff-file');
    // jsdom has no scrollIntoView — spy per block.
    const spyA = vi.fn();
    const spyB = vi.fn();
    blocks[0]!.scrollIntoView = spyA;
    blocks[1]!.scrollIntoView = spyB;

    rerender(
      <Sheet
        tabs={[diffTab({ scrollToPath: 'src/b.ts', scrollToPathTs: 1 })]}
        activeByGroup={{ diffs: 'd1' }}
        activeGroup="diffs"
        actions={actions}
      />,
    );
    expect(spyB).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(spyA).not.toHaveBeenCalled();
  });
});
