import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/Sheet.js';

// Each stacked file block in a diff body is tagged with data-path so a Changes
// row can reveal the matching file without replacing the multi-file overview.
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
beforeEach(() => localStorage.clear());

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

  it('renders and persists the side-by-side diff view', () => {
    const { container } = render(
      <Sheet
        tabs={[diffTab({ fullPath: '/repo/src/a.ts' })]}
        activeByGroup={{ diffs: 'd1' }}
        activeGroup="diffs"
        actions={actions}
      />,
    );

    expect(container.querySelector('.sheet-diff')).not.toHaveClass('split');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Side-by-side view' }));

    expect(container.querySelector('.sheet-diff')).toHaveClass('split');
    expect(container.querySelectorAll('.sheet-diff-side.old').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.sheet-diff-side.new').length).toBeGreaterThan(0);
    expect(localStorage.getItem('gian.sheet.diffsplit')).toBe('on');
  });
});
