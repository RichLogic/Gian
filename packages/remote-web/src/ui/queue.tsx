/**
 * Queue UI (B6, §12.3): stable-height drawer with internal scrolling so a
 * long queue never pushes the composer out. Every entry shows text plus
 * attachment/context/document summaries; edit keeps position and the
 * structured payload. Mutations carry the queue revision; on
 * PRECONDITION_FAILED the controller replaces the queue wholesale and the
 * notice stays until the next queue change.
 */

import { useState } from 'react';
import type { RemoteQueueEntry, RemoteSession } from '@gian/remote-protocol';
import { mutationsEnabled } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { Icon } from './icons.js';

function EntrySummary({ entry }: { entry: RemoteQueueEntry }) {
  const attachmentCount = (entry.items ?? []).filter((i) => i.type === 'attachment').length;
  const contextCount = entry.context_items?.length ?? 0;
  return (
    <span className="qd-text-cell">
      <span className="qd-text">{entry.text}</span>
      {(attachmentCount > 0 || contextCount > 0 || entry.composer_document) && (
        <span className="qd-chips">
          {attachmentCount > 0 && <span className="qd-chip">📎 {attachmentCount}</span>}
          {contextCount > 0 && <span className="qd-chip">@ {contextCount}</span>}
          {entry.composer_document && <span className="qd-chip">▤ doc</span>}
        </span>
      )}
    </span>
  );
}

function QueueEntryRow({
  session,
  entry,
  index,
  disabled,
}: {
  session: RemoteSession;
  entry: RemoteQueueEntry;
  index: number;
  disabled: boolean;
}) {
  const t = useT();
  const actions = useRemoteActions();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);

  return (
    <div className="qd-item" data-queue-id={entry.id}>
      <span className="qd-idx">{index + 1}</span>
      {editing ? (
        <span className="qd-text-cell">
          <textarea
            className="qd-edit"
            value={text}
            aria-label={t('queue.edit')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                setEditing(false);
                actions.editQueueEntry(session.id, entry.id, text);
              }
              if (event.key === 'Escape') setEditing(false);
            }}
          />
          <button
            type="button"
            className="btn xs secondary"
            disabled={disabled}
            onClick={() => {
              setEditing(false);
              actions.editQueueEntry(session.id, entry.id, text);
            }}
          >
            {t('queue.save')}
          </button>
        </span>
      ) : (
        <EntrySummary entry={entry} />
      )}
      <div className="qd-item-act">
        <button
          type="button"
          className="btn xs ghost icon"
          title={t('queue.edit')}
          aria-label={t('queue.edit')}
          disabled={disabled || editing}
          onClick={() => {
            setText(entry.text);
            setEditing(true);
          }}
        >
          <Icon name="edit" size={13} />
        </button>
        <button
          type="button"
          className="btn xs ghost icon"
          title={t('queue.remove')}
          aria-label={t('queue.remove')}
          disabled={disabled}
          onClick={() => actions.removeQueueEntry(session.id, entry.id)}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}

export function QueueDrawer({ session }: { session: RemoteSession }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const entries = session.queue.entries;
  // Disable while any queue mutation for this session is in flight — the
  // optimistic value is never presented as canonical.
  const queuePending = Object.values(state.mutations).some(
    (m) => m.phase === 'pending' && m.label.startsWith('queue.'),
  );
  const disabled = !mutationsEnabled(state.connection) || queuePending;

  if (entries.length === 0 && !state.queueNotice) return null;

  return (
    <div className="queue-drawer" data-testid="queue-drawer">
      {state.queueNotice?.kind === 'replaced-remotely' && (
        <div className="qd-note" role="status">
          <Icon name="refresh" size={12} />
          {t('queue.notice.replaced')}
        </div>
      )}
      {entries.length > 0 && (
        <>
          <div className="qd-head">
            <span className="qd-title">{t('queue.title')}</span>
            <div className="qd-actions">
              <button
                type="button"
                className="btn xs secondary"
                disabled={disabled}
                onClick={() => actions.sendQueueNow(session.id)}
              >
                {t('queue.sendNow')}
              </button>
              <button
                type="button"
                className="btn xs ghost"
                disabled={disabled}
                onClick={() => actions.clearQueue(session.id)}
              >
                {t('queue.clear')}
              </button>
            </div>
          </div>
          <div className="qd-body">
            {entries.map((entry, index) => (
              <QueueEntryRow
                key={entry.id}
                session={session}
                entry={entry}
                index={index}
                disabled={disabled}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Narrow-layout collapsed queue row (mockup F17): one summary line that
 *  expands into the drawer, so the soft keyboard never hides Send/Stop. */
export function QueueCollapsedRow({ session }: { session: RemoteSession }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  if (session.queue.entries.length === 0) return null;
  if (expanded) return <QueueDrawer session={session} />;
  return (
    <button
      type="button"
      className="rw-q-collapsed"
      aria-expanded={false}
      onClick={() => setExpanded(true)}
    >
      <Icon name="caret-right" size={11} />
      {t('queue.collapsed', { count: session.queue.entries.length })}
      <span className="rw-q-expand-hint">{t('queue.expand')}</span>
    </button>
  );
}
