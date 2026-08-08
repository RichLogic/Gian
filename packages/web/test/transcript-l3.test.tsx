// Transcript redesign P3 (2026-08-08) — level-3 detail routing + panel 2.
// Pins:
//   - over-threshold rows (output >10 lines, long reasoning, long result
//     lists, tool output >10 lines) become clickable `.trow` rows with the
//     hover `⇥ panel` hint and open their FULL content in panel 2 via
//     TranscriptDetailOpenContext — instead of the P1 stopgaps (inline
//     scroll cap / inspector push);
//   - in-threshold rows never render the hint (level 2 stays inline);
//   - the panel-2 preview-tab semantics: one preview tab at a time
//     (insertGroupPreviewTab), pinned tabs are never evicted;
//   - the Sheet renders a `text` tab's body.

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommandItem, FileSearchItem, ReasoningItem, ToolItem } from '../src/types.js';
import {
  CommandCard,
  FileSearchCard,
  ReasoningCard,
  ToolEvent,
  TranscriptDetailOpenContext,
  type TranscriptDetailPayload,
} from '../src/transcript/items.js';
import { insertGroupPreviewTab, type SheetTab } from '../src/components/sheet-model.js';
import { Sheet } from '../src/components/Sheet.js';

function commandItem(overrides: Partial<CommandItem> = {}): CommandItem {
  return {
    kind: 'command', id: 'cmd-1', command: 'pnpm test', status: 'success',
    stdout: '', ts: 1_000, turn: 1, ...overrides,
  };
}

const LONG_OUTPUT = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');

function renderWithDetail(node: React.ReactElement, openDetail = vi.fn()) {
  const utils = render(
    <TranscriptDetailOpenContext.Provider value={openDetail}>
      {node}
    </TranscriptDetailOpenContext.Provider>,
  );
  return { ...utils, openDetail };
}

// ---------------------------------------------------------------------------
// Level-3 routing: over-threshold rows carry ⇥ panel and open panel 2
// ---------------------------------------------------------------------------

describe('P3 level-3 routing', () => {
  it('a finished command with >10 output lines renders ⇥ panel and opens the full output on click', async () => {
    const user = userEvent.setup();
    const { container, openDetail } = renderWithDetail(
      <CommandCard item={commandItem({ stdout: LONG_OUTPUT, status: 'error' })} />,
    );
    const row = container.querySelector('.trow') as HTMLElement;
    expect(row).not.toHaveClass('expandable');
    expect(row).toHaveClass('clickable');
    expect(container.querySelector('.trow-caret')).not.toBeNull();
    expect(container.querySelector('.trow-ext')).toHaveTextContent('⇥ panel');
    expect(row.querySelector('.trow-meta .err')).toHaveTextContent('error');
    expect(row.querySelector('.trow-meta')).toHaveTextContent('25 lines');

    await user.click(row);
    expect(openDetail).toHaveBeenCalledWith({
      title: 'Run: pnpm test',
      text: LONG_OUTPUT,
      sourceId: 'cmd-1',
    } satisfies TranscriptDetailPayload);
    // No inline detail — panel 2 owns the content now.
    expect(container.querySelector('.trow-detail')).toBeNull();
  });

  it('a RUNNING command with long output stays inline (live stream, no L3)', () => {
    const { container, openDetail } = renderWithDetail(
      <CommandCard item={commandItem({ status: 'running', stdout: LONG_OUTPUT })} />,
    );
    const row = container.querySelector('.trow') as HTMLElement;
    expect(row).toHaveClass('expandable');
    expect(container.querySelector('.trow-ext')).toBeNull();
    expect(container.querySelector('.trow-run')).not.toBeNull();
    void openDetail;
  });

  it('a long reasoning trace routes to panel 2 with the variant label as the tab title', async () => {
    const user = userEvent.setup();
    const longText = Array.from({ length: 42 }, (_, i) => `trace ${i + 1}`).join('\n');
    const item: ReasoningItem = { kind: 'reasoning', id: 'r-1', text: longText, variant: 'full', ts: 1, turn: 1 };
    const { container, openDetail } = renderWithDetail(<ReasoningCard item={item} />);
    const row = container.querySelector('.trow') as HTMLElement;
    expect(row).toHaveClass('clickable');
    expect(row).toHaveAttribute('data-variant', 'full');
    expect(container.querySelector('.trow-ext')).not.toBeNull();

    await user.click(row);
    expect(openDetail).toHaveBeenCalledWith({ title: 'Reasoning', text: longText, sourceId: 'r-1' });
  });

  it('a short reasoning stays level 2 (inline, no hint)', () => {
    const item: ReasoningItem = { kind: 'reasoning', id: 'r-2', text: 'a\nb', variant: 'summary', ts: 1, turn: 1 };
    const { container } = renderWithDetail(<ReasoningCard item={item} />);
    expect(container.querySelector('.trow-ext')).toBeNull();
    expect(container.querySelector('.trow')).toHaveClass('expandable');
  });

  it('a tool with >10 output lines routes to panel 2', async () => {
    const user = userEvent.setup();
    const item: ToolItem = {
      kind: 'tool', id: 'tool-1', name: 'mcp__github__create_issue',
      summary: '', status: 'success', output: LONG_OUTPUT, ts: 1, turn: 1,
    };
    const { container, openDetail } = renderWithDetail(<ToolEvent item={item} />);
    expect(container.querySelector('.trow-ext')).not.toBeNull();
    await user.click(container.querySelector('.trow') as HTMLElement);
    expect(openDetail).toHaveBeenCalledWith({
      title: 'Tool: mcp__github__create_issue',
      text: LONG_OUTPUT,
      sourceId: 'tool-1',
    });
  });

  it('a long search-result list routes to panel 2; short lists stay inline', async () => {
    const user = userEvent.setup();
    const matches = Array.from({ length: 15 }, (_, i) => `src/file-${i}.ts:10`);
    const item: FileSearchItem = {
      kind: 'file-search', id: 'fs-1', pattern: 'useStableExpand',
      searchKind: 'grep', matchCount: 15, matches, ts: 1, turn: 1,
    };
    const { container, openDetail } = renderWithDetail(<FileSearchCard item={item} />);
    expect(container.querySelector('.trow-ext')).not.toBeNull();
    await user.click(container.querySelector('.trow') as HTMLElement);
    expect(openDetail).toHaveBeenCalledWith({
      title: 'Grep: /useStableExpand/',
      text: matches.join('\n'),
      sourceId: 'fs-1',
    });
  });

  it('without a provider the over-threshold row keeps the P1 fallback (inline scroll cap)', async () => {
    const user = userEvent.setup();
    const { container } = render(<CommandCard item={commandItem({ stdout: LONG_OUTPUT })} />);
    expect(container.querySelector('.trow-ext')).toBeNull();
    const row = container.querySelector('.trow') as HTMLElement;
    expect(row).toHaveClass('expandable');
    await user.click(row);
    expect(container.querySelector('.trow-detail.cmd')).toHaveClass('scroll');
  });
});

// ---------------------------------------------------------------------------
// Preview-tab semantics (sheet-model)
// ---------------------------------------------------------------------------

function tab(id: string, over: Partial<SheetTab> = {}): SheetTab {
  return { id, group: 'diffs', name: id, kind: 'text', icoKind: 'term', ico: '›', ...over };
}

describe('P3 preview tab semantics (insertGroupPreviewTab)', () => {
  it('appends when the group has no preview tab', () => {
    const tabs = [tab('a'), tab('b', { preview: false })];
    const next = insertGroupPreviewTab(tabs, 'diffs', tab('c', { preview: true }));
    expect(next.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('opening the next detail evicts the current preview tab', () => {
    const tabs = [tab('old', { preview: true }), tab('pinned', { preview: false })];
    const next = insertGroupPreviewTab(tabs, 'diffs', tab('new', { preview: true }));
    expect(next.map(t => t.id)).toEqual(['pinned', 'new']);
  });

  it('a pinned (double-clicked) tab is never evicted — the new detail opens alongside', () => {
    const pinned = tab('pinned', { preview: false });
    const withPreview = insertGroupPreviewTab([pinned], 'diffs', tab('p1', { preview: true }));
    // Pin p1 (what pinTab does), then open the next detail.
    const afterPin = withPreview.map(t => t.id === 'p1' ? { ...t, preview: false } : t);
    const next = insertGroupPreviewTab(afterPin, 'diffs', tab('p2', { preview: true }));
    expect(next.map(t => t.id)).toEqual(['pinned', 'p1', 'p2']);
  });

  it('preview tabs in OTHER groups are left alone', () => {
    const filesPreview = tab('file-prev', { group: 'files', kind: 'file', preview: true });
    const next = insertGroupPreviewTab([filesPreview], 'diffs', tab('d1', { preview: true }));
    expect(next.map(t => t.id)).toEqual(['file-prev', 'd1']);
  });
});

// ---------------------------------------------------------------------------
// Sheet: text tab body + pin on double-click
// ---------------------------------------------------------------------------

describe('P3 Sheet text tabs', () => {
  const actions = {
    activateTab: vi.fn(),
    closeTab: vi.fn(),
    pinTab: vi.fn(),
    setTabViewMode: vi.fn(),
    setTabName: vi.fn(),
  };

  it('renders a text tab with its full mono body', () => {
    const t = tab('txt-1', { name: 'Run: pnpm test', preview: true, text: LONG_OUTPUT });
    const { container } = render(
      <Sheet tabs={[t]} activeByGroup={{ diffs: 'txt-1' }} activeGroup="diffs" actions={actions} />,
    );
    const tabEl = container.querySelector('.sheet-tab');
    expect(tabEl).toHaveClass('preview');
    expect(tabEl).toHaveTextContent('Run: pnpm test');
    const body = container.querySelector('.sheet-text');
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe(LONG_OUTPUT);
  });

  it('double-clicking the tab pins it', async () => {
    const user = userEvent.setup();
    const t = tab('txt-2', { name: 'Reasoning', preview: true, text: 'trace' });
    const { container } = render(
      <Sheet tabs={[t]} activeByGroup={{ diffs: 'txt-2' }} activeGroup="diffs" actions={actions} />,
    );
    await user.dblClick(container.querySelector('.sheet-tab') as HTMLElement);
    expect(actions.pinTab).toHaveBeenCalledWith('txt-2');
  });
});
