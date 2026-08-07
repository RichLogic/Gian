import { useContext, useState } from 'react';
import { isNativeImageMime } from '../attachments.js';
import { useT } from '../i18n/index.js';
import { useQueueWithOverlays, useSessionOperationPending } from '../operations/use-operations.js';
import { ImageZoomContext } from '../transcript/items.js';
import type { QueueEntry } from '../types.js';

/** Host-served URL for a queued attachment: the upload already lives in the
 *  per-session attachment store, so the queue drawer renders the same
 *  `/api/sessions/:id/attachments/:filename` endpoint the transcript uses. */
function attachmentUrl(sessionId: string, path: string): string {
  const filename = path.split('/').pop() ?? path;
  return `/api/sessions/${sessionId}/attachments/${filename}`;
}

export function QueueList({
  sessionId,
  queue,
  onRemove,
  onUpdate,
  onClear,
  onSendNow,
}: {
  sessionId: string;
  queue: QueueEntry[];
  onRemove: (queueId: string) => void;
  onUpdate: (queueId: string, text: string) => void;
  onClear: () => void;
  onSendNow?: () => void;
}) {
  const t = useT();
  const zoomImage = useContext(ImageZoomContext);
  /** Inline edit (2026-08-05): the row swaps to a textarea; Enter saves,
   *  Escape cancels. Position in the queue is kept (host `queue:update`). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // Rendered queue = canonical + the whole-array overlay (proposal §4.3):
  // add/update/remove/clear reflect immediately, the queue:updated broadcast
  // + operation:result settle, a failure reveals the canonical array again.
  const displayQueue = useQueueWithOverlays(sessionId, queue);
  // Pending queue.sendNow run: the button disables and duplicate dispatches
  // are blocked by the operation layer (⌘Enter included).
  const sendingNow = useSessionOperationPending(sessionId, 'queue.sendNow');
  if (displayQueue.length === 0) return null;

  function startEdit(entry: QueueEntry) {
    setEditingId(entry.id);
    setEditText(entry.text);
  }

  function commitEdit() {
    if (!editingId) return;
    const next = editText.trim();
    const original = displayQueue.find(e => e.id === editingId);
    // Attachments-only entries have no text — an empty save keeps the old
    // text rather than blanking it (blank text + items is still sendable,
    // but never silently mutate on an accidental Enter).
    if (original && next && next !== original.text) onUpdate(editingId, next);
    setEditingId(null);
  }

  return (
    <div className="queue-drawer">
      <div className="qd-head">
        <span className="qd-title">
          {t('queue.title')}
          <span className="qd-count">{displayQueue.length}</span>
        </span>
        <span className="qd-sub">· {t('queue.subtitle')}</span>
        <div className="qd-actions">
          {onSendNow != null ? (
            <button className="btn xs secondary" onClick={onSendNow} disabled={sendingNow}>
              {sendingNow ? t('queue.sending') : t('queue.sendNow')}
            </button>
          ) : null}
          <button className="btn xs ghost" onClick={onClear}>
            {t('common.clear')}
          </button>
        </div>
      </div>
      <div className="qd-body">
        {displayQueue.map((entry, i) => {
          const attachments = (entry.items ?? []).filter(
            item => item.type === 'localImage' || item.type === 'localFile',
          );
          return (
            <div key={entry.id} className="qd-item">
              <span className="qd-idx">{i + 1}</span>
              {editingId === entry.id ? (
                <textarea
                  className="qd-edit"
                  autoFocus
                  rows={Math.min(6, Math.max(1, editText.split('\n').length))}
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  onKeyDown={e => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                    if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                  }}
                />
              ) : (
                <span className="qd-text-cell">
                  {entry.text && <span className="qd-text" title={entry.text}>{entry.text}</span>}
                  {attachments.length > 0 && (
                    <span className="qd-atts">
                      {attachments.map((item, j) => {
                        const url = attachmentUrl(sessionId, item.path);
                        const name = item.name ?? item.path.split('/').pop() ?? '';
                        return isNativeImageMime(item.mime ?? '') ? (
                          <button
                            key={j}
                            type="button"
                            className="qd-att-thumb"
                            title={name}
                            onClick={() => zoomImage?.(url, name)}
                          >
                            <img src={url} alt={name} />
                          </button>
                        ) : (
                          <span key={j} className="qd-att-file" title={name}>
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" strokeWidth="1.2" />
                              <path d="M9 1.75v3h3" stroke="currentColor" strokeWidth="1.2" />
                            </svg>
                            {name}
                          </span>
                        );
                      })}
                    </span>
                  )}
                </span>
              )}
              <div className="qd-item-act">
                {editingId === entry.id ? (
                  <button
                    className="btn xs ghost icon"
                    onClick={commitEdit}
                    title={t('queue.save')}
                    aria-label={t('queue.save')}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 8.5l3.5 3.5L13 4.5" />
                    </svg>
                  </button>
                ) : (
                  <button
                    className="btn xs ghost icon"
                    onClick={() => startEdit(entry)}
                    title={t('queue.edit')}
                    aria-label={t('queue.edit')}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11.3 2.7l2 2L6 12H4v-2l7.3-7.3z" />
                    </svg>
                  </button>
                )}
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
          );
        })}
      </div>
    </div>
  );
}
