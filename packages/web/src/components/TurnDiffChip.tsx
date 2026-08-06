import { useContext, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { DiffOpenContext } from '../transcript/items.js';
import { projectTurnDiff } from '../presentation/turn-diff.js';
import type { DiffFile, DiffItem, TranscriptItem } from '../types.js';

/**
 * Underbar chip for the current turn's file changes — the transcript-level
 * sibling of the Changes inspector's "Last turn" scope. Hidden unless the
 * most recent change-producing turn touched at least one file.
 *
 * The chip/panel chrome reuses the PlanChip vocabulary (`.context-chip`,
 * `.context-agent-panel`); the shell stays position:static so the panel
 * anchors to the underbar row, exactly composer-width. Clicking a file row
 * routes through DiffOpenContext, the same path the transcript's DiffCard
 * uses — files without inline hunks (kimi) fall back to a live git diff.
 */
export function TurnDiffChip({
  items,
  sessionId,
}: {
  items: TranscriptItem[];
  sessionId: string;
}) {
  const t = useT();
  const openDiff = useContext(DiffOpenContext);
  const [open, setOpen] = useState(false);
  const diff = useMemo(() => projectTurnDiff(items), [items]);

  useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!diff) setOpen(false);
  }, [diff]);

  if (!diff) return null;

  const totalAdd = diff.files.reduce((s, f) => s + f.add, 0);
  const totalDel = diff.files.reduce((s, f) => s + f.del, 0);

  const openFile = (f: DiffFile) => {
    setOpen(false);
    const item: DiffItem = {
      kind: 'diff',
      id: `turn-diff-${diff.turn}-${f.path}`,
      files: [f],
      ts: Date.now(),
      turn: diff.turn,
    };
    openDiff?.(item);
  };

  return (
    <div className="turn-diff-shell">
      {open && (
        <section className="context-agent-panel turn-diff-panel" aria-label={t('changes.scope.lastTurn')}>
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
            {diff.files.map(f => (
              <button
                key={f.path}
                type="button"
                className="turn-diff-row"
                title={f.path}
                onClick={() => openFile(f)}
              >
                <span className="turn-diff-path">{f.path}</span>
                <span className="turn-diff-stat">
                  {f.add > 0 && <span className="add">+{f.add}</span>}
                  {f.del > 0 && <span className="del">−{f.del}</span>}
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
        onClick={() => setOpen(o => !o)}
      >
        <span>{t('changes.scope.lastTurn')}</span>
        <span className="context-chip-count">{diff.files.length}</span>
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
