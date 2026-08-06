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
  refreshKey,
  onClick,
}: {
  workingTreeId: string | null;
  branch: string | null;
  refreshKey: number;
  onClick: () => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (!workingTreeId) { setStats(null); return; }
    let alive = true;
    // All-changes scope (HEAD vs worktree: staged + unstaged + untracked) —
    // the user's pick over the branch-wide scope, which kept growing as
    // agent commits landed on the branch.
    void loadChanged(workingTreeId, 'all').then(rows => {
      if (!alive) return;
      let added = 0, removed = 0;
      for (const r of rows) { added += r.added; removed += r.removed; }
      setStats({ added, removed, count: rows.length });
    });
    return () => { alive = false; };
  }, [workingTreeId, refreshKey]);

  if (!workingTreeId) return null;
  // Per design decision §B2: main-head chip shows ONLY the +N/-M diff stats,
  // not the branch name (that's already in PathBreadcrumb). Hide entirely
  // when the tree is clean — there's nothing to flag.
  if (!stats || stats.count === 0) return null;

  const tooltip = `${stats.count} file${stats.count === 1 ? '' : 's'} changed${branch ? ` on ${branch}` : ''} · open Changes inspector`;
  return (
    <button
      type="button"
      className="main-head-changes"
      onClick={onClick}
      title={tooltip}
    >
      <span className="scr-plus">+{fmtCount(stats.added)}</span>
      <span className="scr-minus">−{fmtCount(stats.removed)}</span>
    </button>
  );
}
