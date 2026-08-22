// Trace view rework — TraceView + TraceTimeline rendering tests.
// Pins: the three-lane timeline renders one span per non-turn item in its
// lane (failed spans marked), clicking a span selects the row and scrolls it
// into view; rows render grouped by turn with kind chip, summary, status
// badge and HH:MM:SS time; a row click opens the item detail through
// ChatPanelOpenContext; the partial banner and the empty state.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocaleProvider } from '../src/i18n/index.js';
import { ChatPanelOpenContext } from '../src/presentation/chat-panel.js';
import {
  traceFixtureFailure,
  traceFixtureMultiTurn,
  traceFixturePartialCapability,
  traceFixtureStreaming,
} from '../src/trace/fixtures.js';
import { TraceView } from '../src/trace/TraceView.js';
import type { TraceSnapshot } from '../src/trace/types.js';

function renderTrace(
  snapshot: TraceSnapshot,
  openChatPanel?: (request: unknown) => void,
) {
  return render(
    <LocaleProvider locale="en">
      <ChatPanelOpenContext.Provider value={openChatPanel ?? null}>
        <TraceView snapshot={snapshot} />
      </ChatPanelOpenContext.Provider>
    </LocaleProvider>,
  );
}

function laneOf(testid: string): string | null {
  return screen.getByTestId(testid).closest('.trace-lane')?.getAttribute('data-lane') ?? null;
}

describe('TraceTimeline', () => {
  it('plots every non-turn item as an equal-width span on its lane', () => {
    renderTrace(traceFixtureMultiTurn);
    expect(screen.getByTestId('trace-timeline')).toBeInTheDocument();
    // kind → lane: input → Input, reasoning/assistant/plan → Model,
    // tool/agent → Tools.
    expect(laneOf('trace-span-t1-input')).toBe('input');
    expect(laneOf('trace-span-t1-reasoning')).toBe('model');
    expect(laneOf('trace-span-t1-assistant')).toBe('model');
    expect(laneOf('trace-span-t2-plan')).toBe('model');
    expect(laneOf('trace-span-t1-tool-read')).toBe('tools');
    expect(laneOf('trace-span-t2-agent')).toBe('tools');
    // Turn items bound the groups; they are never plotted.
    expect(screen.queryByTestId('trace-span-turn-1')).not.toBeInTheDocument();
    // Sequence mode: equal widths, chronological positions.
    const plottable = traceFixtureMultiTurn.items.filter(i => i.kind !== 'turn');
    const span = screen.getByTestId('trace-span-t1-input');
    expect(span.style.width).toBe(`${100 / plottable.length}%`);
    expect(span.style.left).toBe('0%');
    expect(span).toHaveAttribute('title', 'Add a greeting endpoint to the server');
  });

  it('marks failed spans red', () => {
    renderTrace(traceFixtureFailure);
    expect(screen.getByTestId('trace-span-f1-tool')).toHaveClass('failed');
    expect(screen.getByTestId('trace-span-f2-input')).not.toHaveClass('failed');
  });

  it('selects the row and scrolls it into view when a span is clicked', async () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderTrace(traceFixtureMultiTurn);
    await userEvent.click(screen.getByTestId('trace-span-t1-tool-edit'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(screen.getByTestId('trace-span-t1-tool-edit')).toHaveClass('selected');
    expect(screen.getByTestId('trace-row-t1-tool-edit')).toHaveClass('selected');
    // The timeline never opens the detail itself.
    expect(screen.queryByTestId('trace-detail')).not.toBeInTheDocument();
  });
});

describe('TraceView event list', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('renders turns grouped and stably ordered with durations', () => {
    renderTrace(traceFixtureMultiTurn);
    const turns = screen.getAllByTestId(/^trace-turn-/);
    expect(turns.map(el => el.getAttribute('data-testid'))).toEqual([
      'trace-turn-turn-1',
      'trace-turn-turn-2',
    ]);
    const turn1 = within(turns[0]!);
    expect(turn1.getByText('Turn 1')).toBeInTheDocument();
    expect(turn1.getByText('2m 00s')).toBeInTheDocument();
  });

  it('shows rows with kind chip, title, summary, status badge, and time', () => {
    renderTrace(traceFixtureMultiTurn);
    const row = screen.getByTestId('trace-row-t1-tool-read');
    expect(row).toHaveTextContent('Read');
    expect(row).toHaveTextContent('{"file_path":"/src/server.ts"}');
    expect(within(row).getByTestId('trace-status-succeeded')).toBeInTheDocument();
    expect(within(row).getByText(/\d{2}:\d{2}:\d{2}/)).toBeInTheDocument();
    expect(row.querySelector('.trace-kind.tool')).not.toBeNull();
  });

  it('opens the item detail in panel 2 when a row is clicked', async () => {
    const open = vi.fn();
    renderTrace(traceFixtureMultiTurn, open);
    await userEvent.click(screen.getByTestId('trace-row-t1-tool-edit'));
    expect(open).toHaveBeenCalledTimes(1);
    const request = open.mock.calls[0]![0] as { kind: string; item: { id: string; correlationId?: string } };
    expect(request.kind).toBe('trace-item');
    expect(request.item.id).toBe('t1-tool-edit');
    expect(request.item.correlationId).toBe('call-edit-1');
    // The clicked row is the selected one, synced with the timeline.
    expect(screen.getByTestId('trace-row-t1-tool-edit')).toHaveClass('selected');
    expect(screen.getByTestId('trace-span-t1-tool-edit')).toHaveClass('selected');
  });

  it('works without a chat panel context (row click is a no-op)', async () => {
    render(
      <LocaleProvider locale="en">
        <TraceView snapshot={traceFixtureMultiTurn} />
      </LocaleProvider>,
    );
    await userEvent.click(screen.getByTestId('trace-row-t1-tool-edit'));
    expect(screen.getByTestId('trace-row-t1-tool-edit')).toHaveClass('selected');
  });

  it('shows the partial hint while the trace is still generating', () => {
    renderTrace(traceFixtureStreaming);
    expect(screen.getByTestId('trace-partial')).toBeInTheDocument();
    // Turn header and the running tool both carry the running badge.
    expect(screen.getAllByTestId('trace-status-running').length).toBeGreaterThan(0);
  });

  it('does not dress a complete trace up with a partial hint', () => {
    renderTrace(traceFixtureMultiTurn);
    expect(screen.queryByTestId('trace-partial')).not.toBeInTheDocument();
  });

  it('renders failed tools and interrupted turns honestly', () => {
    renderTrace(traceFixtureFailure);
    expect(screen.getAllByTestId('trace-status-failed').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('trace-status-interrupted').length).toBeGreaterThan(0);
    const turn2 = screen.getByTestId('trace-turn-turn-2');
    expect(turn2.querySelector('.trace-turn-head .trace-badge.interrupted')).not.toBeNull();
  });

  it('renders an explicit empty state instead of a fake track', () => {
    renderTrace({
      sessionId: 'sess-empty',
      generatedAt: '2026-08-15T10:00:00.000Z',
      partial: false,
      items: [],
    });
    expect(screen.getByTestId('trace-empty')).toBeInTheDocument();
    expect(screen.queryByTestId(/^trace-turn-/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('trace-timeline')).not.toBeInTheDocument();
  });

  it('renders no reasoning/plan rows or spans for a partial-capability session', () => {
    renderTrace(traceFixturePartialCapability);
    expect(document.querySelectorAll('[data-kind="reasoning"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-kind="plan"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-kind="agent"]')).toHaveLength(0);
    expect(screen.getByTestId('trace-row-pc-tool')).toBeInTheDocument();
    expect(screen.queryByTestId(/^trace-span-.*reasoning/)).not.toBeInTheDocument();
  });

  it('renders pre-step sessions flat: no step groups, carets, or durations', () => {
    renderTrace(traceFixtureMultiTurn);
    expect(document.querySelectorAll('[data-kind="step"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-kind="request"]')).toHaveLength(0);
    expect(document.querySelectorAll('.trace-step-caret')).toHaveLength(0);
    expect(document.querySelectorAll('.trace-step-group')).toHaveLength(0);
    expect(screen.queryByTestId(/^trace-step-dur-/)).not.toBeInTheDocument();
  });

  it('shows no duration on a step row that never reported durationMs', () => {
    const snapshot: TraceSnapshot = {
      sessionId: 'sess-step-running',
      generatedAt: '2026-08-15T10:20:00.000Z',
      partial: true,
      items: [
        {
          id: 'turn-1', turnId: 'turn-1', kind: 'turn', title: 'Turn 1',
          status: 'running', at: '2026-08-15T10:00:00.000Z',
          evidence: 'synthetic', sourceEventIds: ['evt-turn-1'],
        },
        {
          id: 'step-running', turnId: 'turn-1', kind: 'step', title: 'Step 1',
          status: 'running', at: '2026-08-15T10:00:01.000Z',
          evidence: 'synthetic', sourceEventIds: ['evt-step-1'],
        },
      ],
    };
    renderTrace(snapshot);
    const row = screen.getByTestId('trace-row-step-running');
    expect(row).toBeInTheDocument();
    expect(screen.queryByTestId('trace-step-dur-step-running')).not.toBeInTheDocument();
  });

  it('degrades an unknown future kind to a plain row instead of throwing', () => {
    const future = {
      id: 'future-1', turnId: 'turn-1', kind: 'future-kind', title: 'Future item',
      at: '2026-08-15T10:00:01.000Z', evidence: 'synthetic', sourceEventIds: ['evt-f1'],
    } as unknown as TraceSnapshot['items'][number];
    const snapshot: TraceSnapshot = {
      sessionId: 'sess-future',
      generatedAt: '2026-08-15T10:20:00.000Z',
      partial: false,
      items: [
        {
          id: 'turn-1', turnId: 'turn-1', kind: 'turn', title: 'Turn 1',
          status: 'succeeded', at: '2026-08-15T10:00:00.000Z',
          endAt: '2026-08-15T10:01:00.000Z',
          evidence: 'synthetic', sourceEventIds: ['evt-turn-1'],
        },
        future,
      ],
    };
    renderTrace(snapshot);
    const row = screen.getByTestId('trace-row-future-1');
    expect(row).toHaveTextContent('Future item');
    // Unknown kinds plot on no lane but never break the timeline.
    expect(screen.getByTestId('trace-timeline')).toBeInTheDocument();
  });
});
