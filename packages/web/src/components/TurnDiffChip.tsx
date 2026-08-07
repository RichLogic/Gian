import { useMemo } from 'react';
import { useT } from '../i18n/index.js';
import { projectTurnDiff } from '../presentation/turn-diff.js';
import type { TranscriptItem } from '../types.js';

/**
 * Underbar chip for the current turn's file changes — the transcript-level
 * sibling of the Changes inspector's "Last turn" scope. Hidden unless the
 * most recent change-producing turn touched at least one file.
 *
 * Clicking the chip jumps straight to the Diffs inspector with the Last-turn
 * scope selected (no inline file-list panel — the inspector IS the file
 * list). The chip chrome reuses the PlanChip vocabulary (`.context-chip`).
 */
export function TurnDiffChip({
  items,
  onShowLastTurn,
}: {
  items: TranscriptItem[];
  /** Opens the Diffs inspector pinned to the Last-turn scope. */
  onShowLastTurn: () => void;
}) {
  const t = useT();
  const diff = useMemo(() => projectTurnDiff(items), [items]);

  if (!diff) return null;

  const totalAdd = diff.files.reduce((s, f) => s + f.add, 0);
  const totalDel = diff.files.reduce((s, f) => s + f.del, 0);

  return (
    <div className="turn-diff-shell">
      <button
        type="button"
        className="context-chip turn-diff-chip"
        title={t('changes.scope.lastTurn')}
        onClick={onShowLastTurn}
      >
        <span>{diff.files.length} {t('changes.files')}</span>
        {(totalAdd > 0 || totalDel > 0) && (
          <span className="turn-diff-chip-stat">
            {totalAdd > 0 && <span className="add">+{totalAdd}</span>}
            {totalDel > 0 && <span className="del">−{totalDel}</span>}
          </span>
        )}
      </button>
    </div>
  );
}
