import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DiffBody } from '../src/components/Sheet.js';

// Each stacked file block in a diff body is tagged with data-path — the
// Changes inspector's row click anchors into panel 2's multi-diff view via
// these tags (and the ChangesDiffBody blocks carry their own data-path).
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

afterEach(() => cleanup());
beforeEach(() => localStorage.clear());

describe('DiffBody file blocks', () => {
  it('tags each stacked file block with data-path', () => {
    const { container } = render(<DiffBody diffText={diffText} />);
    const blocks = container.querySelectorAll('.sheet-diff-file');
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.getAttribute('data-path')).toBe('src/a.ts');
    expect(blocks[1]!.getAttribute('data-path')).toBe('src/b.ts');
  });

  it('renders the side-by-side view when split is on', () => {
    const { container } = render(<DiffBody diffText={diffText} split wrap />);
    expect(container.querySelector('.sheet-diff')).toHaveClass('split');
    expect(container.querySelectorAll('.sheet-diff-side.old').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.sheet-diff-side.new').length).toBeGreaterThan(0);
  });
});
