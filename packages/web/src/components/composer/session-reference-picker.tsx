import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session, Workspace } from '@gian/shared';
import { loadSessions, loadWorkspaces } from '../../api.js';
import { useT } from '../../i18n/index.js';
import { relTime } from '../../views/session-list-status.js';

export interface SessionReferenceChoice {
  sessionId: string;
  title: string;
  workspaceName?: string;
}

/** Same display-name rule as the Sessions rail. */
export function sessionReferenceTitle(session: Pick<Session, 'id' | 'name'>): string {
  return session.name?.trim() || `session ${session.id.slice(0, 6)}`;
}

const SESSION_ROW_ICON = (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.25 3.25h11.5v8H8.75l-3.5 3v-3h-3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

export const SESSION_PICKER_WIDTH = 340;

/**
 * Searchable session picker for the composer's "Reference conversation" add
 * menu entry. Opens as an upward popover right-aligned to the + button's
 * right edge (the same anchor useUpDrop gives the + menu itself), lists every
 * session the Host knows (any workspace may be referenced), and reports the
 * pick through onSelect. Rows reuse the `@` file popover's row styling
 * (.cmp-file-*).
 */
export function SessionReferencePicker({
  anchor,
  excludeSessionId,
  onSelect,
  onClose,
}: {
  anchor: { left: number; bottom: number };
  /** The session owning the composer cannot reference itself. */
  excludeSessionId?: string;
  onSelect: (choice: SessionReferenceChoice) => void;
  onClose: () => void;
}) {
  const t = useT();
  const popRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  useEffect(() => {
    let alive = true;
    void Promise.all([loadSessions(), loadWorkspaces()])
      .then(([sessionList, workspaceList]) => {
        if (!alive) return;
        setSessions(sessionList);
        setWorkspaces(workspaceList);
      })
      .catch(() => {
        if (alive) setSessions([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const rows = useMemo(() => {
    const workspaceName = (id: string | null) => workspaces.find(w => w.id === id)?.name;
    const list = (sessions ?? [])
      .filter(session => session.id !== excludeSessionId)
      .map(session => ({
        session,
        title: sessionReferenceTitle(session),
        workspace: workspaceName(session.workspace_id),
      }))
      .sort((left, right) => right.session.updated_at.localeCompare(left.session.updated_at));
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(row => (
      row.title.toLowerCase().includes(needle)
      || (row.workspace ?? '').toLowerCase().includes(needle)
    ));
  }, [sessions, workspaces, query, excludeSessionId]);

  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - SESSION_PICKER_WIDTH - 8));

  return createPortal(
    <div
      ref={popRef}
      className="popover cmp-session-pop"
      role="dialog"
      aria-label={t('composer.sessionPicker.title')}
      style={{ left, bottom: anchor.bottom, width: SESSION_PICKER_WIDTH }}
    >
      <div className="mp-section-head">
        <span className="mp-section-title">{t('composer.sessionPicker.title')}</span>
      </div>
      <input
        className="cmp-session-search"
        type="text"
        autoFocus
        value={query}
        placeholder={t('composer.sessionPicker.search')}
        aria-label={t('composer.sessionPicker.search')}
        onChange={event => setQuery(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && rows.length > 0) {
            event.preventDefault();
            const row = rows[0]!;
            onSelect({
              sessionId: row.session.id,
              title: row.title,
              ...(row.workspace ? { workspaceName: row.workspace } : {}),
            });
          }
        }}
      />
      <div className="cmp-session-list" role="listbox">
        {sessions === null ? (
          <div className="cmp-file-empty">{t('composer.sessionPicker.loading')}</div>
        ) : rows.length === 0 ? (
          <div className="cmp-file-empty">{t('composer.sessionPicker.empty')}</div>
        ) : (
          rows.map(row => (
            <button
              key={row.session.id}
              type="button"
              role="option"
              aria-selected={false}
              className="cmp-file-row"
              data-testid={`session-reference-row-${row.session.id}`}
              onClick={() => onSelect({
                sessionId: row.session.id,
                title: row.title,
                ...(row.workspace ? { workspaceName: row.workspace } : {}),
              })}
            >
              <span className="cmp-file-icon" aria-hidden="true">{SESSION_ROW_ICON}</span>
              <span className="cmp-file-name">{row.title}</span>
              {row.workspace && (
                <span className="cmp-file-path" title={row.workspace}>{row.workspace}</span>
              )}
              <span className="cmp-session-time">{relTime(row.session.updated_at)}</span>
            </button>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
