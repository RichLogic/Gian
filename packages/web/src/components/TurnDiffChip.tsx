import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { projectTurnDiff } from '../presentation/turn-diff.js';
import type { TranscriptItem } from '../types.js';

/**
 * Underbar chip for the current turn's file changes — the transcript-level
 * sibling of the Changes inspector's "Last turn" scope. Hidden unless the
 * transcript's current/latest turn touched at least one file; a new turn
 * boundary clears the previous chip immediately.
 *
 * Clicking the chip opens the same underbar-anchored panel pattern used by
 * Plan and Agent. Selecting a file then opens the Diffs inspector pinned to
 * this exact turn's Last-turn scope and reveals that file's diff.
 */
export function TurnDiffChip({
  items,
  sessionId,
  onShowLastTurn,
}: {
  items: TranscriptItem[];
  sessionId: string;
  /** Opens one file in Diffs, pinned to this card's exact Last-turn scope. */
  onShowLastTurn: (turn: number, path: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const diff = useMemo(() => projectTurnDiff(items), [items]);

  useEffect(() => {
    setOpen(false);
  }, [sessionId, diff?.turn]);

  useEffect(() => {
    if (!diff) setOpen(false);
  }, [diff]);

  if (!diff) return null;

  const totalAdd = diff.files.reduce((s, f) => s + f.add, 0);
  const totalDel = diff.files.reduce((s, f) => s + f.del, 0);

  return (
    <div className="turn-diff-shell">
      {open && (
        <section
          className="context-agent-panel turn-diff-panel"
          aria-label={t('changes.scope.lastTurn')}
        >
          <header className="context-agent-panel-head">
            <div>
              <strong>{t('changes.scope.lastTurn')}</strong>
              <span>
                {diff.files.length} {t('changes.files')}
                {(totalAdd > 0 || totalDel > 0) && ` · +${totalAdd} −${totalDel}`}
              </span>
            </div>
            <button
              type="button"
              className="context-panel-close"
              aria-label={t('common.close')}
              title={t('common.close')}
              onClick={() => setOpen(false)}
            >
              <span aria-hidden>&times;</span>
            </button>
          </header>
          <div className="turn-diff-list">
            {diff.files.map(file => (
              <button
                key={file.path}
                type="button"
                className="turn-diff-row"
                title={file.path}
                onClick={() => {
                  setOpen(false);
                  onShowLastTurn(diff.turn, file.path);
                }}
              >
                <span className="turn-diff-path">{file.path}</span>
                <span className="turn-diff-stat">
                  {file.add > 0 && <span className="add">+{file.add}</span>}
                  {file.del > 0 && <span className="del">−{file.del}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <button
        type="button"
        className="context-chip turn-diff-chip"
        aria-expanded={open}
        title={t('changes.scope.lastTurn')}
        onClick={() => setOpen(value => !value)}
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
