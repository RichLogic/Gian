/**
 * Global search palette (Issue #168 / 0.6.7): replaces the session-name-only
 * model with typed groups. Business kinds come from the Host `/api/search`
 * contract (shared/search.ts); settings and commands come from the local
 * static registry (search/registry.ts) keyed by real section anchors and
 * keymap command ids. An empty query shows recent sessions plus common
 * available commands.
 *
 * Requests are debounced and cancelled; a stale response can never overwrite
 * a newer query. Partial index coverage is labelled, never presented as
 * exhaustive. Archived hits are marked. Settings deep-link to their real
 * section anchor; commands run through the App's keymap dispatcher with
 * their availability predicates.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeymapCommand,
  SearchBusinessKind,
  SearchResult,
  Session,
  Workspace,
} from '@gian/shared';
import { useT } from '../i18n/index.js';
import { EN } from '../i18n/en.js';
import { ZH } from '../i18n/zh.js';
import { SearchApiError, searchGlobal } from '../api.js';
import type { NavKey } from './SettingsBody.js';
import {
  COMMANDS_SEARCH_REGISTRY,
  SETTINGS_SEARCH_REGISTRY,
  matchRegistryEntries,
  settingAnchorId,
  type CommandSearchEntry,
  type SearchPaletteContext,
  type SettingSearchEntry,
} from '../search/registry.js';

type KindFilter = 'all' | SearchBusinessKind | 'setting' | 'command';

const KIND_ORDER: readonly SearchBusinessKind[] = [
  'session', 'message', 'workspace', 'worktree', 'task', 'agent', 'schedule', 'inbox',
];

/** Common commands offered on the empty query, first available first. */
const EMPTY_QUERY_COMMANDS: readonly KeymapCommand[] = [
  'session.new', 'task.new', 'app.settings', 'tool.files', 'tool.terminal',
];

const RECENT_LIMIT = 8;
const SEARCH_DEBOUNCE_MS = 200;

type PaletteRow =
  | { kind: 'result'; id: string; result: SearchResult }
  | { kind: 'setting'; id: string; entry: SettingSearchEntry }
  | { kind: 'command'; id: string; entry: CommandSearchEntry }
  | { kind: 'recent'; id: string; session: Session };

interface RemoteState {
  status: 'idle' | 'loading' | 'error' | 'ready';
  page: import('@gian/shared').SearchPage | null;
  /** The query/filters this page answers. Rows of a page answering an older
   *  query render dimmed and refuse pick while the new query is in flight. */
  query: string;
  loadingMore: boolean;
}

const IDLE_REMOTE: RemoteState = { status: 'idle', page: null, query: '', loadingMore: false };

/** Both locales' titles — a zh UI still answers to the English name. */
function registryTitles(entry: { titleKey: string }): string[] {
  const titles: string[] = [];
  const en = EN[entry.titleKey];
  const zh = ZH[entry.titleKey];
  if (en) titles.push(en);
  if (zh && zh !== en) titles.push(zh);
  if (titles.length === 0) titles.push(entry.titleKey);
  return titles;
}

/** Ranges are UTF-16 offsets into `text` (the returned snippet). */
function Snippet({ text, ranges }: { text: string; ranges: Array<{ start: number; end: number }> }) {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    if (end > start) parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return (
    <span className="pal-snippet">
      {parts.map((part, index) => part.hit ? <mark key={index}>{part.text}</mark> : part.text)}
    </span>
  );
}

export function CommandPalette({
  open,
  onClose,
  sessions,
  workspaces,
  context,
  onNavigate,
  onOpenSetting,
  onCommand,
  initialQuery,
}: {
  open: boolean;
  onClose: () => void;
  sessions: Session[];
  workspaces: Workspace[];
  context: SearchPaletteContext;
  onNavigate: (result: SearchResult) => void;
  onOpenSetting: (navKey: NavKey, anchorId: string | null) => void;
  onCommand: (command: KeymapCommand) => void;
  initialQuery?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('');
  const [includeArchived, setIncludeArchived] = useState(true);
  const [remote, setRemote] = useState<RemoteState>(IDLE_REMOTE);
  const [retryNonce, setRetryNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setIdx(0);
      setRemote(IDLE_REMOTE);
      return;
    }
    setQuery(initialQuery ?? '');
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, initialQuery]);

  // Business kinds from the Host index. UI-only kinds are matched locally —
  // the Host contract rejects `setting`/`command` types.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q || kindFilter === 'setting' || kindFilter === 'command') {
      requestSeqRef.current += 1;
      setRemote(IDLE_REMOTE);
      return;
    }
    setRemote(previous => ({ ...previous, status: 'loading', loadingMore: false }));
    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchGlobal({
        q,
        types: kindFilter === 'all' ? undefined : [kindFilter],
        workspaceId: workspaceFilter || null,
        includeArchived,
        limit: 20,
      }, controller.signal)
        .then(page => {
          if (requestSeqRef.current !== seq) return;
          setRemote({ status: 'ready', page, query: q, loadingMore: false });
        })
        .catch(() => {
          if (controller.signal.aborted || requestSeqRef.current !== seq) return;
          setRemote({ status: 'error', page: null, query: q, loadingMore: false });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, kindFilter, workspaceFilter, includeArchived, retryNonce]);

  /** Continue the current query: the cursor binds query/filters/index
   *  revision Host-side; a 409 stale cursor restarts the same query from
   *  the top instead of failing the list. */
  function loadMoreResults() {
    const page = remote.page;
    if (!page?.next_cursor || remote.loadingMore) return;
    const seq = requestSeqRef.current;
    const cursor = page.next_cursor;
    setRemote(previous => ({ ...previous, loadingMore: true }));
    void searchGlobal({
      q: remote.query,
      types: kindFilter === 'all' ? undefined : [kindFilter as SearchBusinessKind],
      workspaceId: workspaceFilter || null,
      includeArchived,
      limit: 20,
      cursor,
    })
      .then(next => {
        if (requestSeqRef.current !== seq) return;
        setRemote(previous => {
          if (!previous.page) return previous;
          const seen = new Set(previous.page.results.map(result => result.id));
          return {
            ...previous,
            loadingMore: false,
            page: {
              ...next,
              results: [...previous.page.results, ...next.results.filter(result => !seen.has(result.id))],
            },
          };
        });
      })
      .catch(error => {
        if (requestSeqRef.current !== seq) return;
        if (error instanceof SearchApiError && error.code === 'stale_cursor') {
          setRetryNonce(nonce => nonce + 1);
          return;
        }
        setRemote(previous => ({ ...previous, loadingMore: false }));
      });
  }

  const groups = useMemo(() => {
    const q = query.trim();
    const out: Array<{ key: string; label: string; rows: PaletteRow[] }> = [];
    if (!q) {
      const recents = sessions
        .filter(session => session.archived === 0)
        .slice()
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, RECENT_LIMIT)
        .map(session => ({ kind: 'recent' as const, id: `recent:${session.id}`, session }));
      if (recents.length > 0) out.push({ key: 'recent', label: t('palette.group.recent'), rows: recents });
      const common = EMPTY_QUERY_COMMANDS
        .map(command => COMMANDS_SEARCH_REGISTRY.find(entry => entry.command === command))
        .filter((entry): entry is CommandSearchEntry => !!entry && entry.available(context))
        .map(entry => ({ kind: 'command' as const, id: `command:${entry.command}`, entry }));
      if (common.length > 0) out.push({ key: 'command', label: t('palette.group.command'), rows: common });
      return out;
    }
    const page = remote.page;
    if (page) {
      const byKind = new Map<SearchBusinessKind, SearchResult[]>();
      for (const result of page.results) {
        const list = byKind.get(result.kind) ?? [];
        list.push(result);
        byKind.set(result.kind, list);
      }
      for (const kind of KIND_ORDER) {
        const results = byKind.get(kind);
        if (!results || results.length === 0) continue;
        out.push({
          key: kind,
          label: t(`palette.group.${kind}`),
          rows: results.map(result => ({ kind: 'result' as const, id: `result:${result.id}`, result })),
        });
      }
    }
    if (kindFilter === 'all' || kindFilter === 'setting') {
      const rows = matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, q, registryTitles)
        .map(({ entry }) => ({ kind: 'setting' as const, id: `setting:${entry.id}`, entry }));
      if (rows.length > 0) out.push({ key: 'setting', label: t('palette.group.setting'), rows });
    }
    if (kindFilter === 'all' || kindFilter === 'command') {
      const rows = matchRegistryEntries(
        COMMANDS_SEARCH_REGISTRY.filter(entry => entry.available(context)),
        q,
        registryTitles,
      ).map(({ entry }) => ({ kind: 'command' as const, id: `command:${entry.command}`, entry }));
      if (rows.length > 0) out.push({ key: 'command', label: t('palette.group.command'), rows });
    }
    return out;
  }, [query, remote.page, sessions, context, kindFilter, t]);

  const flatRows = useMemo(() => groups.flatMap(group => group.rows), [groups]);

  // A page answering an older query stays visible (no flash) but refuses
  // selection — Enter must never jump to a stale target.
  const remoteStale = remote.page !== null && remote.query !== query.trim();

  useEffect(() => {
    setIdx(0);
  }, [query, kindFilter, workspaceFilter, includeArchived]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  function pick(row: PaletteRow) {
    switch (row.kind) {
      case 'result':
        if (remoteStale) return;
        onNavigate(row.result);
        break;
      case 'setting':
        onOpenSetting(row.entry.navKey, settingAnchorId(row.entry));
        break;
      case 'command':
        onCommand(row.entry.command);
        break;
      case 'recent':
        onNavigate({
          id: `recent:${row.session.id}`,
          kind: 'session',
          title: row.session.name?.trim() || '',
          ranges: [],
          target: { type: 'session', session_id: row.session.id, archived: false },
          updated_at: row.session.updated_at,
          archived: false,
        });
        break;
    }
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIdx(current => Math.min(current + 1, flatRows.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIdx(current => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = flatRows[idx];
      if (row) pick(row);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  if (!open) return null;

  const kindFilters: Array<{ key: KindFilter; label: string }> = [
    { key: 'all', label: t('palette.filter.all') },
    { key: 'session', label: t('palette.group.session') },
    { key: 'message', label: t('palette.group.message') },
    { key: 'task', label: t('palette.group.task') },
    { key: 'agent', label: t('palette.group.agent') },
    { key: 'schedule', label: t('palette.group.schedule') },
    { key: 'inbox', label: t('palette.group.inbox') },
    { key: 'setting', label: t('palette.group.setting') },
    { key: 'command', label: t('palette.group.command') },
  ];

  const showRemoteStatus = query.trim() !== '' && kindFilter !== 'setting' && kindFilter !== 'command';

  let flatIndex = -1;

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

        <div className="pal-filters">
          {kindFilters.map(filter => (
            <button
              key={filter.key}
              type="button"
              className={`pal-chip${kindFilter === filter.key ? ' active' : ''}`}
              data-testid={`pal-filter-${filter.key}`}
              onClick={() => setKindFilter(filter.key)}
            >
              {filter.label}
            </button>
          ))}
          <select
            className="pal-ws-select"
            aria-label={t('palette.allWorkspaces')}
            value={workspaceFilter}
            onChange={event => setWorkspaceFilter(event.target.value)}
          >
            <option value="">{t('palette.allWorkspaces')}</option>
            {workspaces.map(workspace => (
              <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
            ))}
          </select>
          <button
            type="button"
            className={`pal-chip${includeArchived ? ' active' : ''}`}
            data-testid="pal-filter-archived"
            aria-pressed={includeArchived}
            onClick={() => setIncludeArchived(value => !value)}
          >
            {t('palette.includeArchived')}
          </button>
        </div>

        <div ref={listRef} className={`pal-list${remoteStale ? ' pal-stale' : ''}`}>
          {showRemoteStatus && remote.status === 'error' && (
            <div className="pal-error" role="alert">
              <span>{t('palette.error')}</span>
              <button type="button" className="pal-retry" onClick={() => setRetryNonce(nonce => nonce + 1)}>
                {t('palette.retry')}
              </button>
            </div>
          )}
          {showRemoteStatus && remote.page && !remote.page.coverage.complete && (
            <div className="pal-partial" role="status">{t('palette.partial')}</div>
          )}
          {groups.length === 0 && remote.status !== 'loading' ? (
            <div className="pal-empty">{t('palette.noResults')} "{query}"</div>
          ) : (
            groups.map(group => (
              <div key={group.key}>
                <div className="pal-section-head">{group.label}</div>
                {group.rows.map(row => {
                  flatIndex += 1;
                  const rowIndex = flatIndex;
                  const active = rowIndex === idx;
                  if (row.kind === 'result') {
                    const { result } = row;
                    return (
                      <button
                        type="button"
                        className={`pal-row${active ? ' active' : ''}`}
                        data-idx={rowIndex}
                        key={row.id}
                        onPointerDown={event => { event.preventDefault(); pick(row); }}
                        onMouseEnter={() => setIdx(rowIndex)}
                      >
                        <span className="pal-row-main">
                          <span className="pal-row-label">{result.title}</span>
                          {result.snippet && <Snippet text={result.snippet} ranges={result.ranges} />}
                        </span>
                        {result.subtitle && <span className="pal-row-sub">{result.subtitle}</span>}
                        {result.archived && <span className="pal-row-tag">{t('palette.archived')}</span>}
                        <span className="pal-row-tag">{t(`palette.group.${result.kind}`)}</span>
                      </button>
                    );
                  }
                  if (row.kind === 'setting') {
                    return (
                      <button
                        type="button"
                        className={`pal-row${active ? ' active' : ''}`}
                        data-idx={rowIndex}
                        key={row.id}
                        onPointerDown={event => { event.preventDefault(); pick(row); }}
                        onMouseEnter={() => setIdx(rowIndex)}
                      >
                        <span className="pal-row-label">{t(row.entry.titleKey)}</span>
                        <span className="pal-row-tag cmd">{t('palette.group.setting')}</span>
                      </button>
                    );
                  }
                  if (row.kind === 'command') {
                    return (
                      <button
                        type="button"
                        className={`pal-row${active ? ' active' : ''}`}
                        data-idx={rowIndex}
                        key={row.id}
                        onPointerDown={event => { event.preventDefault(); pick(row); }}
                        onMouseEnter={() => setIdx(rowIndex)}
                      >
                        <span className="pal-row-label">{t(row.entry.titleKey)}</span>
                        <span className="pal-row-tag cmd">{t('palette.group.command')}</span>
                      </button>
                    );
                  }
                  return (
                    <button
                      type="button"
                      className={`pal-row${active ? ' active' : ''}`}
                      data-idx={rowIndex}
                      key={row.id}
                      onPointerDown={event => { event.preventDefault(); pick(row); }}
                      onMouseEnter={() => setIdx(rowIndex)}
                    >
                      <span className="pal-row-label">{row.session.name?.trim() || t('coding.session.untitled')}</span>
                      <span className="pal-row-sub">
                        {workspaces.find(workspace => workspace.id === row.session.workspace_id)?.name ?? ''}
                      </span>
                      <span className="pal-row-tag">{t('palette.tag.session')}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
          {!remoteStale && remote.page?.next_cursor && (
            <button
              type="button"
              className="pal-more"
              data-testid="pal-load-more"
              disabled={remote.loadingMore}
              onClick={loadMoreResults}
            >
              {remote.loadingMore ? t('inbox.loading') : t('palette.loadMore')}
            </button>
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
