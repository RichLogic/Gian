import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { projectTurnDiff } from '../presentation/turn-diff.js';
import type { TranscriptItem } from '../types.js';
import { useUnderbarPanelController } from './UnderbarPanelGroup.js';

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
  const panelController = useUnderbarPanelController();
  const [standaloneOpen, setStandaloneOpen] = useState(false);
  const open = panelController
    ? panelController.openPanel === 'diff'
    : standaloneOpen;
  const groupedOpenPanelRef = useRef(panelController?.openPanel);
  groupedOpenPanelRef.current = panelController?.openPanel;
  const groupedClosePanel = panelController?.closePanel;
  const groupedTogglePanel = panelController?.togglePanel;
  const closePanel = useCallback(() => {
    if (groupedClosePanel) groupedClosePanel();
    else setStandaloneOpen(false);
  }, [groupedClosePanel]);
  const togglePanel = useCallback(() => {
    if (groupedTogglePanel) groupedTogglePanel('diff');
    else setStandaloneOpen(value => !value);
  }, [groupedTogglePanel]);
  const diff = useMemo(() => projectTurnDiff(items), [items]);

  useEffect(() => {
    setStandaloneOpen(false);
    if (groupedOpenPanelRef.current === 'diff') groupedClosePanel?.();
  }, [diff?.turn, groupedClosePanel, sessionId]);

  useEffect(() => {
    if (!diff && open) closePanel();
  }, [closePanel, diff, open]);

  if (!diff) return null;

  const totalAdd = diff.files.reduce((s, f) => s + f.add, 0);
  const totalDel = diff.files.reduce((s, f) => s + f.del, 0);

  return (
    <div className="turn-diff-shell">
      {open && (
        <section
          className="context-agent-panel turn-diff-panel"
          aria-label={t('changes.scope.lastTurn')}
          data-underbar-panel-interactive
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
              onClick={closePanel}
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
                  closePanel();
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
        data-underbar-panel-interactive
        onClick={togglePanel}
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
