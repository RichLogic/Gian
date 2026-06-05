import { useT } from '../i18n/index.js';
import type { QueueEntry } from '../types.js';

export function QueueList({
  queue,
  onRemove,
  onReorder,
  onClear,
  onSendNow,
}: {
  queue: QueueEntry[];
  onRemove: (queueId: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onClear: () => void;
  onSendNow?: () => void;
}) {
  const t = useT();
  if (queue.length === 0) return null;

  function moveUp(index: number) {
    if (index === 0) return;
    const ids = queue.map(e => e.id);
    const tmp = ids[index - 1]!;
    ids[index - 1] = ids[index]!;
    ids[index] = tmp;
    onReorder(ids);
  }

  function moveDown(index: number) {
    if (index === queue.length - 1) return;
    const ids = queue.map(e => e.id);
    const tmp = ids[index]!;
    ids[index] = ids[index + 1]!;
    ids[index + 1] = tmp;
    onReorder(ids);
  }

  return (
    <div className="queue-drawer">
      <div className="qd-head">
        <span className="qd-title">
          {t('queue.title')}
          <span className="qd-count">{queue.length}</span>
        </span>
        <span className="qd-sub">· {t('queue.subtitle')}</span>
        <div className="qd-actions">
          {onSendNow != null ? (
            <button className="btn xs secondary" onClick={onSendNow}>
              {t('queue.sendNow')}
            </button>
          ) : null}
          <button className="btn xs ghost" onClick={onClear}>
            {t('common.clear')}
          </button>
        </div>
      </div>
      <div className="qd-body">
        {queue.map((entry, i) => (
          <div key={entry.id} className="qd-item">
            <span className="qd-idx">{i + 1}</span>
            <span className="qd-text" title={entry.text}>{entry.text}</span>
            <div className="qd-item-act">
              <button
                className="btn xs ghost icon"
                onClick={() => moveUp(i)}
                disabled={i === 0}
                title={t('queue.moveUp')}
                aria-label={t('queue.moveUp')}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 12V4M4 7l4-4 4 4" />
                </svg>
              </button>
              <button
                className="btn xs ghost icon"
                onClick={() => moveDown(i)}
                disabled={i === queue.length - 1}
                title={t('queue.moveDown')}
                aria-label={t('queue.moveDown')}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 4v8M4 9l4 4 4-4" />
                </svg>
              </button>
              <button
                className="btn xs ghost icon"
                onClick={() => onRemove(entry.id)}
                title={t('queue.remove')}
                aria-label={t('queue.remove')}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
