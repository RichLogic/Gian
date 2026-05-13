import type { TokenUsage } from '../types.js';
import { formatCount } from '../utils/format.js';

export function UsageChip({ usage }: { usage: TokenUsage }) {
  const cw = usage.contextWindow;
  const pct = cw ? Math.round((usage.total / cw) * 100) : null;
  const title = `total ${usage.total.toLocaleString()} · input ${usage.input.toLocaleString()} · output ${usage.output.toLocaleString()} · cached ${usage.cached.toLocaleString()}${cw ? ` · context ${cw.toLocaleString()}` : ''}`;
  return (
    <span className="usage-chip" title={title}>
      <span className="usage-num">{formatCount(usage.total)}</span>
      {pct !== null && <span className="usage-pct">{pct}%</span>}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    new: ['idle', 'New'],
    running: ['run', 'Running'],
    pending: ['wait', 'Pending'],
    archived: ['idle', 'Archived'],
    error: ['err', 'Error'],
    done: ['done', 'Done'],
  };
  const m = map[status];
  if (!m) return null;
  return <span className={`pill ${m[0]}`}>{m[1]}</span>;
}
