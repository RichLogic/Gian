// Transcript redesign P3 (2026-08-08) — level-3 detail routing + panel 2.
// Pins:
//   - over-threshold rows (output >10 lines, long reasoning, long result
//     lists, tool output >10 lines) become clickable `.trow` rows and open
//     their FULL content in panel 2 via ChatPanelOpenContext — instead of
//     the P1 stopgaps (inline scroll cap / Diffs-owned Sheet tabs);
//   - rows render NO ⇥ panel hint (removed 2026-08-27): the click alone
//     routes to panel 2;
//   - transcript details identify themselves as chat-owned panel-2 content;
//   - independent diff-event text tabs keep their Sheet preview semantics.

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommandItem, FileSearchItem, ReasoningItem, ToolItem, TranscriptItem } from '../src/types.js';
import {
  CommandCard,
  FileSearchCard,
  ReasoningCard,
  ToolEvent,
} from '../src/transcript/items.js';
import { ChatPanelOpenContext, type ChatPanelRequest } from '../src/presentation/chat-panel.js';
import { insertGroupPreviewTab, type SheetTab } from '../src/components/sheet-model.js';
import { Sheet } from '../src/components/Sheet.js';
import { Transcript } from '../src/transcript/Transcript.js';

function commandItem(overrides: Partial<CommandItem> = {}): CommandItem {
  return {
    kind: 'command', id: 'cmd-1', command: 'pnpm test', status: 'success',
    stdout: '', ts: 1_000, turn: 1, ...overrides,
  };
}

const LONG_OUTPUT = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');

function renderWithDetail(node: React.ReactElement, openDetail = vi.fn()) {
  const utils = render(
    <ChatPanelOpenContext.Provider value={openDetail}>
      {node}
    </ChatPanelOpenContext.Provider>,
  );
  return { ...utils, openDetail };
}

// ---------------------------------------------------------------------------
// Level-3 routing: over-threshold rows carry ⇥ panel and open panel 2
// ---------------------------------------------------------------------------

describe('P3 level-3 routing', () => {
  it('a finished command with >10 output lines opens the full output in panel 2 on click (no hint)', async () => {
    const user = userEvent.setup();
    const { container, openDetail } = renderWithDetail(
      <CommandCard item={commandItem({ stdout: LONG_OUTPUT, status: 'error' })} />,
    );
    const row = container.querySelector('.trow') as HTMLElement;
    expect(row).not.toHaveClass('expandable');
    expect(row).toHaveClass('clickable');
    expect(container.querySelector('.trow-caret')).not.toBeNull();
    // 2026-08-27: even level-3 rows render no ⇥ panel hint anywhere.
    expect(container.querySelector('.trow-ext')).toBeNull();
    expect(row.querySelector('.trow-meta .err')).toHaveTextContent('error');
    expect(row.querySelector('.trow-meta')).toHaveTextContent('25 lines');

    await user.click(row);
    expect(openDetail).toHaveBeenCalledWith({
      kind: 'transcript-detail',
      title: 'Run: pnpm test',
      text: LONG_OUTPUT,
      sourceId: '1:command:cmd-1',
    } satisfies ChatPanelRequest);
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

    await user.click(row);
    expect(openDetail).toHaveBeenCalledWith({
      kind: 'transcript-detail',
      title: 'Reasoning', text: longText, sourceId: '1:reasoning:full:r-1',
    });
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
    await user.click(container.querySelector('.trow') as HTMLElement);
    expect(openDetail).toHaveBeenCalledWith({
      kind: 'transcript-detail',
      title: 'Tool: mcp__github__create_issue',
      text: LONG_OUTPUT,
      sourceId: '1:tool:tool-1',
    });
  });

  it('counts wrapped rows for a giant one-line tool output and preserves the full text', async () => {
    const user = userEvent.setup();
    const output = 'x'.repeat(120 * 10 + 1);
    const item: ToolItem = {
      kind: 'tool', id: 'tool-one-line', name: 'mcp__demo__dump',
      summary: '', status: 'success', output, ts: 1, turn: 2,
    };
    const { container, openDetail } = renderWithDetail(<ToolEvent item={item} />);

    await user.click(container.querySelector('.trow') as HTMLElement);
    expect(openDetail).toHaveBeenCalledWith({
      kind: 'transcript-detail',
      title: 'Tool: mcp__demo__dump',
      text: output,
      sourceId: '2:tool:tool-one-line',
    });
  });

  it('keeps exactly ten wrapped rows inline', () => {
    const item: ToolItem = {
      kind: 'tool', id: 'tool-threshold', name: 'mcp__demo__dump',
      summary: '', status: 'success', output: 'x'.repeat(120 * 10), ts: 1, turn: 2,
    };
    const { container } = renderWithDetail(<ToolEvent item={item} />);

    expect(container.querySelector('.trow-ext')).toBeNull();
    expect(container.querySelector('.trow')).toHaveClass('expandable');
  });

  it('routes a stale-running long tool after its enclosing turn is terminal', async () => {
    const user = userEvent.setup();
    const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    const tool: ToolItem = {
      kind: 'tool', id: 'stale-running', name: 'mcp__demo__run',
      summary: '', status: 'running', output, ts: 10, turn: 5,
    };
    const items: TranscriptItem[] = [
      tool,
      { kind: 'turn-end', id: 'end-5', text: 'complete', ts: 20, turn: 5 },
    ];
    const { container, openDetail } = renderWithDetail(
      <Transcript items={items} pending={false} onApprove={() => {}} />,
    );

    // 2026-08-27: the expanded terminal block is the single-line scroll
    // area. The stale-running row shows NO live timer and jumps to the
    // anchored panel-2 event feed (whose rows expand the full output in
    // place) instead of the old transcript-detail routing.
    await user.click(container.querySelector('.turnsum') as HTMLElement);
    const row = container.querySelector('.turnsum-body.turn-work-scroll .trow') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector('.trow-run')).toBeNull();
    await user.click(row);
    expect(openDetail).toHaveBeenCalledWith({
      kind: 'event-feed',
      turn: 5,
      anchorId: '5:tool:stale-running',
    });
  });

  it('routes long tool input to panel 2 even when the tool has no output', async () => {
    const user = userEvent.setup();
    const input = JSON.stringify({
      repository: 'openai/gian',
      title: 'Regression',
      body: 'x'.repeat(240),
    });
    const item: ToolItem = {
      kind: 'tool', id: 'tool-input', name: 'mcp__github__create_issue',
      summary: input, status: 'success', ts: 1, turn: 3,
    };
    const { container, openDetail } = renderWithDetail(<ToolEvent item={item} />);

    expect(container.querySelector('.trow-detail')).toBeNull();
    await user.click(container.querySelector('.trow') as HTMLElement);
    expect(openDetail).toHaveBeenCalledWith({
      kind: 'transcript-detail',
      title: 'Tool: mcp__github__create_issue',
      text: JSON.stringify(JSON.parse(input), null, 2),
      sourceId: '3:tool:tool-input',
    });
  });

  it('measures combined tool input and output instead of output alone', async () => {
    const user = userEvent.setup();
    const summary = JSON.stringify(Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`arg${index}`, index]),
    ));
    const item: ToolItem = {
      kind: 'tool', id: 'tool-combined', name: 'mcp__demo__run',
      summary, status: 'success', output: 'one\ntwo\nthree', ts: 1, turn: 4,
    };
    const { container, openDetail } = renderWithDetail(<ToolEvent item={item} />);

    await user.click(container.querySelector('.trow') as HTMLElement);
    expect(openDetail).toHaveBeenCalledWith({
      kind: 'transcript-detail',
      title: 'Tool: mcp__demo__run',
      text: `${JSON.stringify(JSON.parse(summary), null, 2)}\n\none\ntwo\nthree`,
      sourceId: '4:tool:tool-combined',
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
    await user.click(container.querySelector('.trow') as HTMLElement);
    expect(openDetail).toHaveBeenCalledWith({
      kind: 'transcript-detail',
      title: 'Grep: /useStableExpand/',
      text: matches.join('\n'),
      sourceId: '1:file-search:fs-1',
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
// Diff-event preview-tab semantics (sheet-model)
// ---------------------------------------------------------------------------

function tab(id: string, over: Partial<SheetTab> = {}): SheetTab {
  return { id, group: 'diffs', name: id, kind: 'text', icoKind: 'term', ico: '›', ...over };
}

describe('diff-event preview tab semantics (insertGroupPreviewTab)', () => {
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
// Sheet: diff-event text tab body + pin on double-click
// ---------------------------------------------------------------------------

describe('diff-event Sheet text tabs', () => {
  const actions = {
    activateTab: vi.fn(),
    closeTab: vi.fn(),
    pinTab: vi.fn(),
    setTabViewMode: vi.fn(),
    setTabName: vi.fn(),
  };
  // The diffs group hides its tab strip while only the singleton Changes tab
  // exists; a text detail tab brings the strip back ([Changes][text…]).
  const changesTab: SheetTab = {
    id: 'tab-changes', group: 'diffs', name: 'Diffs', kind: 'changes', icoKind: 'diff', ico: '±',
  };

  it('renders a text tab with its full mono body', () => {
    const t = tab('txt-1', { name: 'Run: pnpm test', preview: true, text: LONG_OUTPUT });
    const { container } = render(
      <Sheet tabs={[changesTab, t]} activeByGroup={{ diffs: 'txt-1' }} activeGroup="diffs"
             actions={actions} renderTab={() => null} />,
    );
    const tabEl = container.querySelector('.sheet-tab.preview');
    expect(tabEl).not.toBeNull();
    expect(tabEl!).toHaveTextContent('Run: pnpm test');
    const body = container.querySelector('.sheet-text');
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe(LONG_OUTPUT);
  });

  it('double-clicking the tab pins it', async () => {
    const user = userEvent.setup();
    const t = tab('txt-2', { name: 'Reasoning', preview: true, text: 'trace' });
    const { container } = render(
      <Sheet tabs={[changesTab, t]} activeByGroup={{ diffs: 'txt-2' }} activeGroup="diffs"
             actions={actions} renderTab={() => null} />,
    );
    await user.dblClick(container.querySelector('.sheet-tab.preview') as HTMLElement);
    expect(actions.pinTab).toHaveBeenCalledWith('txt-2');
  });
});
