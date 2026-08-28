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
 * block selects the item, opens its detail, and scrolls the matching list row
 * into view. Duration mode keeps real timestamps inside each Turn while
 * capping inter-Turn idle gaps; point events and open spans render as narrow
 * ticks rather than fabricated bars.
 */

import { useMemo } from 'react';
import { useT } from '../i18n/index.js';
import { layoutTraceTimeline, type TraceTimelineMode } from './model.js';
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
  mode,
  onSelect,
}: {
  items: TraceItem[];
  selectedId: string | null;
  mode: TraceTimelineMode;
  onSelect: (itemId: string) => void;
}) {
  const t = useT();
  const positions = useMemo(
    () => layoutTraceTimeline(
      items.filter(item => traceLaneFor(item.kind) !== null),
      mode,
    ),
    [items, mode],
  );
  if (positions.length === 0) return null;
  return (
    <div className="trace-timeline" data-testid="trace-timeline" data-mode={mode}>
      {LANES.map(lane => (
        <div className="trace-lane" data-lane={lane} key={lane}>
          <span className="trace-lane-label">{t(`trace.timeline.lane.${lane}`)}</span>
          <div className="trace-lane-track">
            {positions.map(position => {
              const item = position.item;
              return traceLaneFor(item.kind) === lane && (
                <button
                  key={item.id}
                  type="button"
                  className={
                    `trace-span ${lane} ${position.point ? 'point' : position.open ? 'open' : 'duration'}`
                    + `${item.status === 'failed' ? ' failed' : ''}`
                    + `${selectedId === item.id ? ' selected' : ''}`
                  }
                  style={{
                    left: `${position.leftPct}%`,
                    width: position.widthPct > 0 ? `${position.widthPct}%` : undefined,
                  }}
                  title={item.title}
                  aria-label={item.title}
                  data-shape={item.shape}
                  data-testid={`trace-span-${item.id}`}
                  onClick={() => onSelect(item.id)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
