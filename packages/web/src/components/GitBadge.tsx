import { useEffect, useState } from 'react';
import { loadChanged } from '../api.js';

interface Stats {
  added: number;
  removed: number;
  count: number;
}

function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function GitBadge({
  workingTreeId,
  branch,
  isWorktree,
  refreshKey,
  onClick,
}: {
  workingTreeId: string | null;
  branch: string | null;
  isWorktree: boolean;
  refreshKey: number;
  onClick: () => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (!workingTreeId) { setStats(null); return; }
    let alive = true;
    void loadChanged(workingTreeId).then(rows => {
      if (!alive) return;
      let added = 0, removed = 0;
      for (const r of rows) { added += r.added; removed += r.removed; }
      setStats({ added, removed, count: rows.length });
    });
    return () => { alive = false; };
  }, [workingTreeId, refreshKey]);

  if (!workingTreeId) return null;

  const tooltip = stats
    ? `${stats.count} file${stats.count === 1 ? '' : 's'} changed · click to view diff`
    : 'View diff';

  return (
    <button
      type="button"
      className="main-head-changes"
      onClick={onClick}
      title={tooltip}
    >
      <svg className="ghb-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {/* simple branch glyph: two dots joined by a forked line */}
        <circle cx="4" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="4" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M4 5v6M4 8c0-2 2-2 4-2h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="ghb-branch">{branch ?? 'no branch'}</span>
      {isWorktree && <span className="ghb-wt">wt</span>}
      {stats && stats.count > 0 && (
        <>
          <span className="scr-plus">+{fmtCount(stats.added)}</span>
          <span className="scr-minus">−{fmtCount(stats.removed)}</span>
        </>
      )}
      {stats && stats.count === 0 && <span className="ghb-clean">clean</span>}
    </button>
  );
}
