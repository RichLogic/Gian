/**
 * TraceTimeline — the three-lane sequence timeline at the top of the Trace
 * tab (Trace view rework, 2026-08-19).
 *
 * Lane mapping from the item kind: input/notice → Input,
 * assistant/reasoning/plan/step/request → Model, tool/agent → Tools. `kind: 'turn'`
 * items are never plotted — they bound the turn groups below. Sequence mode
 * only: items are sorted by `at` and rendered as equal-width blocks at
 * inline-style percentage positions, because the current projection carries
 * a single timestamp per item (no token/TTFT data to justify a duration
 * axis). Color follows the lane; `status: 'failed'` renders red. Clicking a
 * block selects the item and scrolls the matching list row into view — the
 * detail itself opens from the row (panel 2), not from the timeline.
 */

import { useMemo } from 'react';
import { useT } from '../i18n/index.js';
import { sortTraceItems } from './model.js';
import type { TraceItem, TraceItemKind } from './types.js';

export type TraceLane = 'input' | 'model' | 'tools';

const LANES: readonly TraceLane[] = ['input', 'model', 'tools'];

/** Lane one item kind is plotted on; null = not plotted (turn boundaries). */
export function traceLaneFor(kind: TraceItemKind): TraceLane | null {
  switch (kind) {
    case 'input':
    case 'notice':
      return 'input';
    case 'assistant':
    case 'reasoning':
    case 'plan':
    case 'step':
    case 'request':
      return 'model';
    case 'tool':
    case 'agent':
      return 'tools';
    case 'turn':
      return null;
  }
}

export function TraceTimeline({
  items,
  selectedId,
  onSelect,
}: {
  items: TraceItem[];
  selectedId: string | null;
  onSelect: (itemId: string) => void;
}) {
  const t = useT();
  const spans = useMemo(
    () => sortTraceItems(items.filter(item => traceLaneFor(item.kind) !== null)),
    [items],
  );
  if (spans.length === 0) return null;
  const width = 100 / spans.length;
  return (
    <div className="trace-timeline" data-testid="trace-timeline">
      {LANES.map(lane => (
        <div className="trace-lane" data-lane={lane} key={lane}>
          <span className="trace-lane-label">{t(`trace.timeline.lane.${lane}`)}</span>
          <div className="trace-lane-track">
            {spans.map((item, index) =>
              traceLaneFor(item.kind) === lane && (
                <button
                  key={item.id}
                  type="button"
                  className={
                    `trace-span ${lane}`
                    + `${item.status === 'failed' ? ' failed' : ''}`
                    + `${selectedId === item.id ? ' selected' : ''}`
                  }
                  style={{ left: `${index * width}%`, width: `${width}%` }}
                  title={item.title}
                  aria-label={item.title}
                  data-testid={`trace-span-${item.id}`}
                  onClick={() => onSelect(item.id)}
                />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
