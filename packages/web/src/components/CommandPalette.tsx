import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';

interface SessionResult {
  id: string;
  label: string;
  workspace?: string;
}

function match(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function CommandPalette({
  open,
  onClose,
  sessions,
  workspaces,
  onJumpToSession,
  initialQuery,
}: {
  open: boolean;
  onClose: () => void;
  sessions: Session[];
  workspaces: Workspace[];
  onJumpToSession: (id: string) => void;
  initialQuery?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setIdx(0);
      return;
    }
    setQuery(initialQuery ?? '');
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, initialQuery]);

  const results = useMemo<SessionResult[]>(() => sessions
    .filter(session => session.archived === 0)
    .filter(session => {
      const name = session.name?.trim() ?? '';
      return name.length > 0 && (!query || match(name, query));
    })
    .map(session => ({
      id: session.id,
      label: session.name!.trim(),
      workspace: workspaces.find(workspace => workspace.id === session.workspace_id)?.name,
    })), [query, sessions, workspaces]);

  useEffect(() => {
    setIdx(0);
  }, [query]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  function pick(item: SessionResult) {
    onJumpToSession(item.id);
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIdx(current => Math.min(current + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIdx(current => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = results[idx];
      if (item) pick(item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  if (!open) return null;

  return (
    <div className="pal-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pal-modal" role="dialog" aria-modal="true" aria-label={t('palette.dialog')}>
        <div className="pal-search-row">
          <svg className="pal-search-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="pal-input"
            type="text"
            placeholder={t('palette.placeholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="pal-esc-hint">Esc</kbd>
        </div>

        <div ref={listRef} className="pal-list">
          {results.length === 0 ? (
            <div className="pal-empty">{t('palette.noResults')} "{query}"</div>
          ) : (
            <>
              <div className="pal-section-head">{t('palette.section.sessions')}</div>
              {results.map((item, index) => (
                <button
                  type="button"
                  className={`pal-row${index === idx ? ' active' : ''}`}
                  data-idx={index}
                  key={item.id}
                  onPointerDown={event => { event.preventDefault(); pick(item); }}
                  onMouseEnter={() => setIdx(index)}
                >
                  <span className="pal-row-label">{item.label}</span>
                  {item.workspace && <span className="pal-row-sub">{item.workspace}</span>}
                  <span className="pal-row-tag">{t('palette.tag.session')}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="pal-footer">
          <span><kbd className="kc">↑↓</kbd> {t('palette.navigate')}</span>
          <span><kbd className="kc">↵</kbd> {t('palette.select')}</span>
          <span><kbd className="kc">Esc</kbd> {t('palette.close')}</span>
        </div>
      </div>
    </div>
  );
}
