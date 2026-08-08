// Transcript redesign P1 (2026-08-08) — `.trow` single-line system.
// Pins the level-2 threshold routing (docs/work-items/transcript-redesign-acd.md):
//   - command output ≤10 lines expands inline; >10 lines expands but scrolls
//   - single-file diff ≤30 hunk lines expands inline as a mini diff;
//     multi-file / larger diffs keep pushing the inspector (panel 2 is P3)
//   - running rows show the breathing-dot live timer
// plus the shared row grammar (caret only on expandable rows, no timestamps).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommandItem, DiffItem } from '../src/types.js';
import { CommandCard, DiffCard, DiffOpenContext, FileReadCard } from '../src/transcript/items.js';

function commandItem(overrides: Partial<CommandItem> = {}): CommandItem {
  return {
    kind: 'command',
    id: 'cmd-1',
    command: 'pnpm -F @gian/web test',
    status: 'success',
    stdout: '',
    ts: 1_000,
    turn: 1,
    ...overrides,
  };
}

function diffFile(path: string, hunkLineCount: number): DiffItem['files'][number] {
  // One hunk whose lines alternate del/add; the inline threshold counts
  // header + lines, so hunkLineCount excludes the header.
  const lines = Array.from({ length: hunkLineCount }, (_, i) => ({
    kind: (i % 2 === 0 ? 'del' : 'add') as 'del' | 'add',
    text: `  line ${i + 1};`,
  }));
  const add = lines.filter(l => l.kind === 'add').length;
  return {
    path,
    add,
    del: hunkLineCount - add,
    hunks: [{ header: '@@ -1,10 +1,10 @@', lines }],
  };
}

function diffItem(overrides: Partial<DiffItem> = {}): DiffItem {
  return {
    kind: 'diff',
    id: 'diff-1',
    files: [diffFile('packages/web/src/styles/login.css', 6)],
    ts: 1_000,
    turn: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Row grammar: caret only on expandable rows, no per-line timestamps
// ---------------------------------------------------------------------------

describe('P1 trow grammar', () => {
  it('a row without detail renders no caret and is not expandable', () => {
    const { container } = render(<CommandCard item={commandItem()} />);
    const row = container.querySelector('.trow');
    expect(row).not.toBeNull();
    expect(row).not.toHaveClass('expandable');
    expect(container.querySelector('.trow-caret')).toBeNull();
  });

  it('read rows carry no timestamp — meta holds state only', () => {
    const { container } = render(
      <FileReadCard item={{ kind: 'file-read', id: 'fr-1', path: '/w/a.ts', startLine: 40, endLine: 120, ts: 1_000, turn: 1 }} />,
    );
    const row = container.querySelector('.trow');
    expect(row).not.toBeNull();
    expect(row).not.toHaveClass('expandable');
    expect(row!.querySelector('.trow-meta')).toBeNull();
    expect(row!.textContent).toContain('/w/a.ts :40–120');
  });
});

// ---------------------------------------------------------------------------
// Command output threshold: ≤10 inline, >10 inline but scroll-capped
// ---------------------------------------------------------------------------

describe('P1 command output threshold routing', () => {
  it('output of ≤10 lines expands inline without the scroll cap', async () => {
    const user = userEvent.setup();
    const stdout = Array.from({ length: 10 }, (_, i) => `ok ${i + 1}`).join('\n');
    const { container } = render(<CommandCard item={commandItem({ stdout })} />);
    const row = container.querySelector('.trow') as HTMLElement;
    expect(row).toHaveClass('expandable');
    expect(container.querySelector('.trow-detail')).toBeNull();

    await user.click(row);
    const detail = container.querySelector('.trow-detail.cmd');
    expect(detail).not.toBeNull();
    expect(detail).not.toHaveClass('scroll');
    expect(detail!.textContent).toContain('ok 10');

    await user.click(row);
    expect(container.querySelector('.trow-detail')).toBeNull();
  });

  it('output of >10 lines still expands inline but with the scroll cap (panel 2 is P3)', async () => {
    const user = userEvent.setup();
    const stdout = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
    const { container } = render(<CommandCard item={commandItem({ stdout })} />);
    await user.click(container.querySelector('.trow') as HTMLElement);
    const detail = container.querySelector('.trow-detail.cmd');
    expect(detail).not.toBeNull();
    expect(detail).toHaveClass('scroll');
  });

  it('stderr appends to the expanded output', async () => {
    const user = userEvent.setup();
    const { container } = render(<CommandCard item={commandItem({ stdout: 'out', stderr: 'boom', status: 'error' })} />);
    await user.click(container.querySelector('.trow') as HTMLElement);
    expect(container.querySelector('.trow-detail')!.textContent).toBe('out\nboom');
  });

  it('a failed command shows an error meta, not a status badge', () => {
    const { container } = render(<CommandCard item={commandItem({ status: 'error', stdout: 'x' })} />);
    const err = container.querySelector('.trow-meta .err');
    expect(err).not.toBeNull();
    expect(err).toHaveTextContent('error');
    expect(container.querySelector('.evt-status')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Running rows: breathing dot + live timer from the item's ts
// ---------------------------------------------------------------------------

describe('P1 running rows', () => {
  it('a running command renders `running · Ns` with the breathing dot', () => {
    const { container } = render(
      <CommandCard item={commandItem({ status: 'running', stdout: 'partial', ts: Date.now() - 8_000 })} />,
    );
    const run = container.querySelector('.trow-run');
    expect(run).not.toBeNull();
    expect(run).toHaveTextContent(/running · [78]s/);
  });
});

// ---------------------------------------------------------------------------
// Diff threshold routing: single file ≤30 lines inline; otherwise inspector
// ---------------------------------------------------------------------------

describe('P1 diff threshold routing', () => {
  it('a single-file diff of ≤30 hunk lines expands inline as a mini diff', async () => {
    const user = userEvent.setup();
    const openDiff = vi.fn();
    const { container } = render(
      <DiffOpenContext.Provider value={openDiff}>
        <DiffCard item={diffItem()} />
      </DiffOpenContext.Provider>,
    );
    const row = container.querySelector('.trow') as HTMLElement;
    expect(row).toHaveClass('expandable');
    expect(row).toHaveTextContent('packages/web/src/styles/login.css');
    expect(row.querySelector('.trow-meta .add')).toHaveTextContent('+3');
    expect(row.querySelector('.trow-meta .del')).toHaveTextContent('−3');

    await user.click(row);
    const detail = container.querySelector('.trow-detail.diff');
    expect(detail).not.toBeNull();
    expect(detail!.querySelector('.dline.hunk')).toHaveTextContent('@@ -1,10 +1,10 @@');
    expect(detail!.querySelectorAll('.dline.add')).toHaveLength(3);
    expect(detail!.querySelectorAll('.dline.del')).toHaveLength(3);
    expect(detail!.querySelector('.dline.add .dsign')).toHaveTextContent('+');
    expect(detail!.querySelector('.dline.del .dsign')).toHaveTextContent('−');
    // The inline path never touches the inspector.
    expect(openDiff).not.toHaveBeenCalled();
  });

  it('a multi-file diff routes to panel 2 on click (P3: caret + ⇥ panel hint, no inline expand)', async () => {
    const user = userEvent.setup();
    const openDiff = vi.fn();
    const item = diffItem({
      files: [diffFile('a.ts', 4), diffFile('b.ts', 4), diffFile('c.ts', 4)],
    });
    const { container } = render(
      <DiffOpenContext.Provider value={openDiff}>
        <DiffCard item={item} />
      </DiffOpenContext.Provider>,
    );
    const row = container.querySelector('.trow') as HTMLElement;
    expect(row).not.toHaveClass('expandable');
    expect(row).toHaveClass('clickable');
    // P3: level-3 rows carry the caret glyph and the hover ⇥ panel hint.
    expect(container.querySelector('.trow-caret')).not.toBeNull();
    expect(container.querySelector('.trow-ext')).not.toBeNull();
    expect(row).toHaveTextContent('Changed files 3');

    await user.click(row);
    expect(openDiff).toHaveBeenCalledWith(item);
    expect(container.querySelector('.trow-detail')).toBeNull();
  });

  it('a single-file diff over 30 hunk lines also routes to panel 2', async () => {
    const user = userEvent.setup();
    const openDiff = vi.fn();
    const item = diffItem({ files: [diffFile('big.ts', 31)] });
    const { container } = render(
      <DiffOpenContext.Provider value={openDiff}>
        <DiffCard item={item} />
      </DiffOpenContext.Provider>,
    );
    const row = container.querySelector('.trow') as HTMLElement;
    expect(row).not.toHaveClass('expandable');
    expect(container.querySelector('.trow-ext')).not.toBeNull();
    await user.click(row);
    expect(openDiff).toHaveBeenCalledWith(item);
    expect(container.querySelector('.trow-detail')).toBeNull();
  });
});
