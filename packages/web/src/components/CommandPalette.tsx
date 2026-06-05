import { useEffect, useRef, useState, useMemo } from 'react';
import type { Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import type { TranscriptItem } from '../types.js';
import { loadChanged } from '../api.js';
import type { ChangedEntry } from '../api.js';

const SLASH_COMMANDS = {
  claude: [
    { cmd: '/clear', desc: 'Clear conversation context' },
    { cmd: '/compact', desc: 'Compact context to free up space' },
    { cmd: '/help', desc: 'Show CLI help' },
    { cmd: '/init', desc: 'Initialize CLAUDE.md' },
    { cmd: '/login', desc: 'Authenticate with Anthropic' },
    { cmd: '/logout', desc: 'Sign out' },
    { cmd: '/model', desc: 'Show or set current model' },
    { cmd: '/status', desc: 'Show CLI status' },
  ],
  codex: [
    { cmd: '/clear', desc: 'Clear conversation context' },
    { cmd: '/compact', desc: 'Compact context to free up space' },
    { cmd: '/init', desc: 'Initialize AGENTS.md' },
    { cmd: '/status', desc: 'Show CLI status' },
  ],
} as const;

type Section = 'sessions' | 'files' | 'commands';

interface ResultItem {
  section: Section;
  key: string;
  label: string;
  sublabel?: string;
}

function match(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function CommandPalette({
  open,
  onClose,
  sessions,
  workspaces,
  activeSessionId,
  activeWorkingTreeId,
  transcriptItems,
  onJumpToSession,
  onOpenFile,
  initialQuery,
}: {
  open: boolean;
  onClose: () => void;
  sessions: Session[];
  workspaces: Workspace[];
  activeSessionId: string | null;
  /** The working tree to source "Changed files" from. Null = no source. */
  activeWorkingTreeId: string | null;
  transcriptItems: TranscriptItem[];
  onJumpToSession: (id: string) => void;
  onOpenFile: (workingTreeId: string, path: string) => void;
  initialQuery?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const [changedFiles, setChangedFiles] = useState<ChangedEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setIdx(0);
      setChangedFiles([]);
      return;
    }
    setQuery(initialQuery ?? '');
    setTimeout(() => inputRef.current?.focus(), 0);

    if (activeWorkingTreeId) {
      void loadChanged(activeWorkingTreeId).then(setChangedFiles);
    }
  }, [open, initialQuery, activeWorkingTreeId]);

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;
  const executor: 'claude' | 'codex' = activeSession?.executor ?? 'claude';

  const results = useMemo<ResultItem[]>(() => {
    const out: ResultItem[] = [];

    const sessionResults = sessions.filter(s => {
      if (!query) return true;
      const name = s.name ?? s.id;
      return match(name, query) || match(s.id.slice(0, 8), query);
    });
    for (const s of sessionResults) {
      const ws = workspaces.find(w => w.id === s.workspace_id);
      out.push({
        section: 'sessions',
        key: `session:${s.id}`,
        label: s.name ?? `${t('topbar.mode.sessions')} ${s.id.slice(0, 8)}`,
        sublabel: ws?.name,
      });
    }

    const fileSet = new Set<string>();
    for (const f of changedFiles) {
      if (!query || match(f.path, query)) {
        fileSet.add(f.path);
      }
    }
    if (fileSet.size === 0 && transcriptItems) {
      for (const item of transcriptItems) {
        if (item.kind === 'file-read' || item.kind === 'diff') {
          if (item.kind === 'file-read') {
            const p = item.path;
            if (!query || match(p, query)) fileSet.add(p);
          } else {
            for (const f of item.files) {
              if (!query || match(f.path, query)) fileSet.add(f.path);
            }
          }
        }
      }
    }
    for (const path of fileSet) {
      out.push({
        section: 'files',
        key: `file:${path}`,
        label: path.split('/').pop() ?? path,
        sublabel: path,
      });
    }

    const cmds = SLASH_COMMANDS[executor];
    for (const c of cmds) {
      if (!query || match(c.cmd, query) || match(c.desc, query)) {
        out.push({
        section: 'commands',
          key: `cmd:${c.cmd}`,
          label: c.cmd,
          sublabel: c.desc,
        });
      }
    }

    return out;
  }, [query, sessions, workspaces, changedFiles, transcriptItems, executor, t]);

  useEffect(() => {
    setIdx(0);
  }, [query]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${idx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  function pick(item: ResultItem) {
    if (item.section === 'sessions') {
      const id = item.key.slice('session:'.length);
      onJumpToSession(id);
    } else if (item.section === 'files') {
      const path = item.sublabel ?? item.key.slice('file:'.length);
      if (activeWorkingTreeId) onOpenFile(activeWorkingTreeId, path);
    } else {
      document.dispatchEvent(new CustomEvent('gian:palette-command', { detail: { cmd: item.label } }));
    }
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[idx];
      if (item) pick(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  if (!open) return null;

  let lastSection: Section | null = null;

  return (
    <div className="pal-overlay" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
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
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="pal-esc-hint">Esc</kbd>
        </div>

        <div ref={listRef} className="pal-list">
          {results.length === 0 && (
            <div className="pal-empty">{t('palette.noResults')} "{query}"</div>
          )}
          {results.map((item, i) => {
            const showHeader = item.section !== lastSection;
            lastSection = item.section;
            return (
              <div key={item.key}>
                {showHeader && (
                  <div className="pal-section-head">{t(`palette.section.${item.section}`)}</div>
                )}
                <button
                  type="button"
                  className={`pal-row${i === idx ? ' active' : ''}`}
                  data-idx={i}
                  onPointerDown={e => { e.preventDefault(); pick(item); }}
                  onMouseEnter={() => setIdx(i)}
                >
                  <span className="pal-row-label">{item.label}</span>
                  {item.sublabel && (
                    <span className="pal-row-sub">{item.sublabel}</span>
                  )}
                  {item.section === 'sessions' && (
                    <span className="pal-row-tag">{t('palette.tag.session')}</span>
                  )}
                  {item.section === 'files' && (
                    <span className="pal-row-tag files">{t('palette.tag.file')}</span>
                  )}
                  {item.section === 'commands' && (
                    <span className="pal-row-tag cmd">{t('palette.tag.command')}</span>
                  )}
                </button>
              </div>
            );
          })}
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
