/**
 * Git History — panel 3 (Inspector): commit timeline with a slim DAG graph,
 * search, branch/author filters, refs chips, Refresh/Fetch, and cursor
 * pagination. Visual + interaction baseline: design/git-history/index.html.
 *
 * All view state lives in controllers/use-history.ts keyed by workingTreeId
 * (this component unmounts on rail collapse without losing anything), and the
 * Fetch mutation goes through the registered `git.historyFetch` operation —
 * everything else on this surface is read-only (Issue #3).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitHistoryCommit, GitHistoryRef } from '../api.js';
import { useT } from '../i18n/index.js';
import {
  dismissHistoryMoved,
  ensureHistoryLoaded,
  loadMoreHistory,
  refreshHistory,
  setHistoryAuthor,
  setHistoryQuery,
  setHistoryRef,
  clearHistoryFilters,
  saveHistoryScroll,
  useHistoryState,
} from '../controllers/use-history.js';
import { assignHistoryLanes, type HistoryGraphRow } from '../presentation/history-graph.js';
import { relTime } from '../views/session-list-status.js';
import {
  gitHistoryFetchEntityKey,
  lastGitHistoryFetchFailure,
} from '../operations/git-history.js';
import {
  useOperationDispatch,
  useOperationRun,
  usePendingOperations,
} from '../operations/use-operations.js';

function Icon({ d, size = 13, stroke = 1.5 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const I = {
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66 M20 4v4h-4',
  fetch: 'M12 3v8 M8.5 7.5L12 11l3.5-3.5 M3.5 14.5L12 19l8.5-4.5 M3.5 18.5L12 23l8.5-4.5',
  search: 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M19.5 19.5l-4.6-4.6',
  branch: 'M6 3v12 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  tag: 'M3.5 3.5h7L20 13l-7 7L3.5 10.5z M8 8h.01',
  author: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M5 20a7 7 0 0 1 14 0',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z',
  lock: 'M6 11V7a6 6 0 1 1 12 0v4 M5 11h14v9.5H5z',
  warnTri: 'M12 4l9.5 16.5h-19z M12 10v4.5 M12 17.8h.01',
  check: 'M5 12l5 5L20 7',
  history: 'M3 3v5h5 M3.05 13A9 9 0 1 0 6 5.3L3 8 M12 7v5l4 2',
};

/* ---- graph geometry (22px gutter, lanes at x=8/16, node center y=14) ---- */
const LANE_X = [8, 16];
const LANE_COLOR = ['var(--accent)', 'var(--ok)'];
const CY = 14;
const ROWH = 46;
const DAYH = 24;

function laneStroke(dashed: boolean): string {
  return dashed ? '3 2.5' : '';
}

function GraphCell({ row, head, selected }: { row: HistoryGraphRow; head: boolean; selected: boolean }) {
  const x = LANE_X[row.lane]!;
  const col = LANE_COLOR[row.lane]!;
  return (
    <svg width="22" height={ROWH} aria-hidden="true">
      {row.linesTop.map(l => (
        <line key={`t${l.lane}`} x1={LANE_X[l.lane]} y1={0} x2={LANE_X[l.lane]} y2={CY}
              style={{ stroke: LANE_COLOR[l.lane], strokeWidth: 1.5 }}
              strokeDasharray={laneStroke(l.dashed)} />
      ))}
      {row.linesBottom.map(l => (
        <line key={`b${l.lane}`} x1={LANE_X[l.lane]} y1={CY} x2={LANE_X[l.lane]} y2={ROWH}
              style={{ stroke: LANE_COLOR[l.lane], strokeWidth: 1.5 }}
              strokeDasharray={laneStroke(l.dashed)} />
      ))}
      {row.curves.map((c, i) => c.dir === 'down' ? (
        <path key={i}
              d={`M ${LANE_X[c.fromLane]} ${CY} L ${LANE_X[c.fromLane]} ${CY + 7} C ${LANE_X[c.fromLane]} ${CY + 20}, ${LANE_X[c.toLane]} ${ROWH - 12}, ${LANE_X[c.toLane]} ${ROWH}`}
              style={{ fill: 'none', stroke: LANE_COLOR[c.toLane], strokeWidth: 1.5 }}
              strokeDasharray={laneStroke(c.dashed)} />
      ) : (
        <path key={i}
              d={`M ${LANE_X[c.fromLane]} 0 C ${LANE_X[c.fromLane]} ${CY - 8}, ${LANE_X[c.toLane]} ${CY - 6}, ${LANE_X[c.toLane]} ${CY}`}
              style={{ fill: 'none', stroke: LANE_COLOR[c.fromLane], strokeWidth: 1.5 }}
              strokeDasharray={laneStroke(c.dashed)} />
      ))}
      {head && (
        <circle cx={x} cy={CY} r={6.2}
                style={{ fill: 'none', stroke: 'var(--accent)', strokeOpacity: 0.45, strokeWidth: 1.5 }} />
      )}
      <circle cx={x} cy={CY} r={3.5}
              style={{ fill: selected ? col : 'var(--surface)', stroke: col, strokeWidth: 1.5 }} />
    </svg>
  );
}

function DayGraphCell({ lanes }: { lanes: Array<{ lane: number; dashed: boolean }> }) {
  return (
    <svg width="22" height={DAYH} aria-hidden="true">
      {lanes.map(l => (
        <line key={l.lane} x1={LANE_X[l.lane]} y1={0} x2={LANE_X[l.lane]} y2={DAYH}
              style={{ stroke: LANE_COLOR[l.lane], strokeWidth: 1.5 }}
              strokeDasharray={laneStroke(l.dashed)} />
      ))}
    </svg>
  );
}

/* ---- day bands ---- */
function dayLabel(iso: string, todayStart: number, yesterdayStart: number, locale: string, t: (k: string) => string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  if (ts >= todayStart) return t('history.day.today');
  if (ts >= yesterdayStart) return t('history.day.yesterday');
  return new Date(ts).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function refChipIcon(kind: GitHistoryRef['kind']): string {
  return kind === 'local' ? I.branch : kind === 'remote' ? I.globe : I.tag;
}

interface Props {
  workingTreeId: string | null;
  /** Full sha of the commit shown in the active history tab for THIS tree —
   *  the selected row. Null when no commit is open. */
  selectedSha: string | null;
  onOpenCommit: (commit: { sha: string; subject: string }, permanent: boolean) => void;
}

export function HistoryInspector({ workingTreeId, selectedSha, onOpenCommit }: Props) {
  const t = useT();
  const state = useHistoryState(workingTreeId);
  const dispatch = useOperationDispatch();
  const scrollRef = useRef<HTMLDivElement>(null);

  /* Local, ephemeral UI state (not worth persisting per tree). */
  const [searchDraftState, setSearchDraftState] = useState<{
    workingTreeId: string;
    value: string;
  } | null>(null);
  const [openMenu, setOpenMenu] = useState<null | 'ref' | 'author'>(null);
  const [menuSearch, setMenuSearch] = useState('');
  const [focusState, setFocusState] = useState<{ workingTreeId: string; sha: string } | null>(null);
  const [fetchNoteState, setFetchNoteState] = useState<{
    workingTreeId: string;
    note: null | { kind: 'ok' | 'auth' | 'err' | 'unknown'; message?: string };
  } | null>(null);
  const [fetchAttempt, setFetchAttempt] = useState<{
    workingTreeId: string;
    runId: string;
  } | null>(null);
  const fetchRun = useOperationRun(
    fetchAttempt?.workingTreeId === workingTreeId ? fetchAttempt.runId : undefined,
  );
  const searchDraft = searchDraftState?.workingTreeId === workingTreeId
    ? searchDraftState.value
    : null;
  const focusSha = focusState?.workingTreeId === workingTreeId ? focusState.sha : null;
  const fetchNote = fetchNoteState?.workingTreeId === workingTreeId ? fetchNoteState.note : null;
  const fetchEntityKey = workingTreeId ? gitHistoryFetchEntityKey(workingTreeId) : null;
  const pendingRuns = usePendingOperations(fetchEntityKey ?? undefined);
  const fetchPending = pendingRuns.some(run => run.name === 'git.historyFetch');

  useEffect(() => {
    if (workingTreeId) ensureHistoryLoaded(workingTreeId);
  }, [workingTreeId]);

  useEffect(() => {
    setOpenMenu(null);
    setMenuSearch('');
  }, [workingTreeId]);

  function setFetchNote(note: null | { kind: 'ok' | 'auth' | 'err' | 'unknown'; message?: string }): void {
    if (!workingTreeId) return;
    setFetchNoteState({ workingTreeId, note });
  }

  /* Restore the tree's scroll position on mount / tree switch. */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = state.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingTreeId]);

  /* Fetch outcome → status bar (pending is derived from the store above). */
  const fetchPhase = fetchRun?.phase;
  useEffect(() => {
    if (!fetchPhase || !workingTreeId || fetchAttempt?.workingTreeId !== workingTreeId) return;
    if (fetchPhase === 'confirmed') {
      const refsChanged = (fetchRun?.result as { refsChanged?: boolean } | undefined)?.refsChanged;
      // refsChanged already triggered reconcileHistoryAfterFetch inside the
      // operation (mount-independent); the bar just reports it.
      setFetchNote(refsChanged
        ? { kind: 'ok', message: t('history.fetch.changed') }
        : { kind: 'ok', message: t('history.fetch.upToDate') });
    } else if (fetchPhase === 'failed') {
      const failure = lastGitHistoryFetchFailure(workingTreeId);
      if (failure?.unknownOutcome) {
        setFetchNote({ kind: 'unknown' });
      } else if (failure?.code === 'git_authentication_failed') {
        setFetchNote({ kind: 'auth', message: failure.message });
      } else {
        setFetchNote({ kind: 'err', message: failure?.message ?? fetchRun?.error });
      }
    } else if (fetchPhase === 'timed-out') {
      setFetchNote({ kind: 'unknown' });
    }
    // `fetchRun` result/error are immutable once this phase settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPhase, workingTreeId, fetchAttempt?.workingTreeId]);

  /* Auto-dismiss the success note. */
  useEffect(() => {
    if (fetchNote?.kind !== 'ok') return;
    const timer = setTimeout(() => setFetchNote(null), 4000);
    return () => clearTimeout(timer);
  }, [fetchNote]);

  function runFetch(): void {
    if (!workingTreeId || fetchPending) return;
    setFetchNote(null);
    const run = dispatch('git.historyFetch', { workingTreeId });
    setFetchAttempt({ workingTreeId, runId: run.id });
  }

  function runRefresh(): void {
    if (!workingTreeId) return;
    if (fetchNote?.kind === 'unknown') setFetchNote(null);
    refreshHistory(workingTreeId);
  }

  /* Search input is instant locally, debounced into the store (which refetches). */
  useEffect(() => {
    if (searchDraft === null || !workingTreeId) return;
    const timer = setTimeout(() => setHistoryQuery(workingTreeId, searchDraft), 300);
    return () => clearTimeout(timer);
  }, [searchDraft, workingTreeId]);

  const graphRows = useMemo(() => assignHistoryLanes(state.items), [state.items]);

  /* Day-band + commit row merge; graph lanes ride through the band using the
   * following commit row's incoming lanes. */
  const listRows = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86_400_000;
    const locale = document.documentElement.lang || 'en';
    const rows: Array<
      | { type: 'day'; label: string; lanes: Array<{ lane: number; dashed: boolean }> }
      | { type: 'commit'; commit: GitHistoryCommit; graph: HistoryGraphRow }
    > = [];
    let lastLabel: string | null = null;
    state.items.forEach((commit, i) => {
      const label = dayLabel(commit.authoredAt, todayStart, yesterdayStart, locale, t);
      const graph = graphRows[i]!;
      if (label !== lastLabel) {
        rows.push({ type: 'day', label, lanes: graph.linesTop.length > 0 ? graph.linesTop : graph.linesBottom });
        lastLabel = label;
      }
      rows.push({ type: 'commit', commit, graph });
    });
    return rows;
  }, [state.items, graphRows, t]);

  const headSha = state.headSha;

  function openCommit(commit: GitHistoryCommit, permanent: boolean): void {
    onOpenCommit({ sha: commit.sha, subject: commit.subject }, permanent);
  }

  function onListKeyDown(e: React.KeyboardEvent, commit: GitHistoryCommit): void {
    const items = state.items;
    const idx = items.findIndex(c => c.sha === commit.sha);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[idx + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        setFocusState({ workingTreeId: workingTreeId!, sha: next.sha });
        scrollRef.current
          ?.querySelector<HTMLElement>(`.h-row[data-sha="${next.sha.slice(0, 7)}"]`)
          ?.focus();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openCommit(commit, e.shiftKey);
    }
  }

  function refChips(commit: GitHistoryCommit): React.ReactNode {
    const isHead = headSha === commit.sha;
    const refs: Array<{ n: string; t: 'head' | GitHistoryRef['kind'] }> = [
      ...(isHead ? [{ n: 'HEAD', t: 'head' as const }] : []),
      ...commit.refs.map(r => ({ n: r.shortName, t: r.kind })),
    ];
    if (refs.length === 0) return null;
    const shown = refs.slice(0, 2);
    const rest = refs.slice(2);
    return (
      <>
        {shown.map(r => (
          <span key={`${r.t}:${r.n}`} className={`h-ref ${r.t}`}
                title={r.t === 'head' ? t('history.refs.head') : r.n}>
            {r.t !== 'head' && <Icon d={refChipIcon(r.t)} size={9} stroke={1.8} />}
            <span className="n">{r.n}</span>
          </span>
        ))}
        {rest.length > 0 && (
          <span className="h-ref more" title={rest.map(r => r.n).join(', ')}>+{rest.length}</span>
        )}
      </>
    );
  }

  const query = searchDraft ?? state.query;
  const filtersActive = !!(state.ref || state.author || state.query);
  const refLabel = state.ref
    ? state.availableRefs.find(r => r.name === state.ref)?.shortName ?? state.ref
    : t('history.filter.allBranches');
  const authorLabel = state.author
    ? state.availableAuthors.find(a => a.email === state.author)?.name ?? state.author
    : t('history.filter.allAuthors');

  return (
    <aside className="inspector" aria-label={t('dock.history')}>
      <div className="insp-head">
        <span className="label">{t('dock.history')}</span>
        <button className="iconbtn" title={t('history.refresh.title')} aria-label={t('history.refresh.title')}
                onClick={runRefresh} disabled={!workingTreeId}>
          <Icon d={I.refresh} />
        </button>
        <button className="iconbtn" title={t('history.fetch.title')} aria-label={t('history.fetch.title')}
                data-testid="history-fetch"
                onClick={runFetch} disabled={!workingTreeId || fetchPending}>
          <Icon d={I.fetch} />
          {state.moved && <span className="nudge" />}
        </button>
      </div>

      {fetchPending && (
        <div className="h-fetchbar pending" role="status">
          <span className="ic"><span className="spinner" /></span>
          <span className="txt">{t('history.fetch.pending')}<span className="sub">{t('history.fetch.pendingSub')}</span></span>
        </div>
      )}
      {!fetchPending && fetchNote?.kind === 'ok' && (
        <div className="h-fetchbar ok" role="status">
          <span className="ic"><Icon d={I.check} stroke={1.8} /></span>
          <span className="txt">{fetchNote.message}</span>
          <button className="x" aria-label={t('common.dismiss')} onClick={() => setFetchNote(null)}>✕</button>
        </div>
      )}
      {!fetchPending && fetchNote?.kind === 'auth' && (
        <div className="h-fetchbar err" role="alert">
          <span className="ic"><Icon d={I.lock} stroke={1.6} /></span>
          <span className="txt">
            <b>{t('history.fetch.authFailed')}</b>
            {fetchNote.message && <span className="sub" title={fetchNote.message}>{fetchNote.message}</span>}
          </span>
          <span className="act"><button className="btn secondary sm" onClick={runFetch}>{t('common.retry')}</button></span>
        </div>
      )}
      {!fetchPending && fetchNote?.kind === 'err' && (
        <div className="h-fetchbar err" role="alert">
          <span className="ic"><Icon d={I.warnTri} stroke={1.7} /></span>
          <span className="txt">
            {t('history.fetch.failed')}
            {fetchNote.message && <span className="sub" title={fetchNote.message}>{fetchNote.message}</span>}
          </span>
          <span className="act"><button className="btn secondary sm" onClick={runFetch}>{t('common.retry')}</button></span>
        </div>
      )}
      {!fetchPending && fetchNote?.kind === 'unknown' && (
        <div className="h-fetchbar warn" role="alert">
          <span className="ic"><Icon d={I.warnTri} stroke={1.7} /></span>
          <span className="txt">
            {t('history.fetch.unknown')}
            <span className="sub">{t('history.fetch.unknownSub')}</span>
          </span>
          <span className="act"><button className="btn secondary sm" onClick={runRefresh}>{t('history.refresh')}</button></span>
        </div>
      )}

      {workingTreeId && state.currentRef === null && state.headSha !== null && (
        <div className="h-detached" role="status">
          <Icon d={I.warnTri} size={12} stroke={1.7} />
          <span>{t('history.detached')} <code>{state.headSha.slice(0, 7)}</code></span>
        </div>
      )}

      <div className="insp-search">
        <Icon d={I.search} size={12} stroke={1.7} />
        <input
          value={query}
          onChange={e => workingTreeId && setSearchDraftState({ workingTreeId, value: e.target.value })}
          placeholder={t('history.search')}
          aria-label={t('history.search')}
          spellCheck={false}
          disabled={!workingTreeId}
        />
        {query && (
          <button className="insp-search-x" aria-label={t('common.clear')}
                  onClick={() => {
                    if (!workingTreeId) return;
                    setSearchDraftState({ workingTreeId, value: '' });
                    setHistoryQuery(workingTreeId, '');
                  }}>
            ✕
          </button>
        )}
      </div>

      <div className="h-filters">
        <span className="h-menu-anchor">
          <button className={`h-chip${state.ref ? ' on' : ''}`} aria-haspopup="menu"
                  aria-expanded={openMenu === 'ref'} title={t('history.filter.branchTitle')}
                  onClick={() => { setOpenMenu(m => (m === 'ref' ? null : 'ref')); setMenuSearch(''); }}>
            <Icon d={I.branch} size={10} stroke={1.8} />
            <span className="v">{refLabel}</span>
            <span className="caret">▾</span>
          </button>
          {openMenu === 'ref' && (
            <>
              <div className="h-menu-backdrop" onClick={() => setOpenMenu(null)} />
              <div className="h-menu" role="menu" aria-label={t('history.filter.branchTitle')}>
                <input autoFocus className="h-menu-search" placeholder={t('history.filter.searchRefs')}
                       aria-label={t('history.filter.searchRefs')}
                       value={menuSearch} onChange={e => setMenuSearch(e.target.value)} />
                <button role="menuitemradio" aria-checked={!state.ref} className={!state.ref ? 'active' : ''}
                        onClick={() => { if (workingTreeId) setHistoryRef(workingTreeId, null); setOpenMenu(null); }}>
                  <span className="ck">{!state.ref ? '✓' : ''}</span>{t('history.filter.allBranches')}
                </button>
                {(['local', 'remote', 'tag'] as const).map((kind, gi) => {
                  const refs = state.availableRefs
                    .filter(r => r.kind === kind)
                    .filter(r => !menuSearch || r.shortName.toLowerCase().includes(menuSearch.toLowerCase()));
                  if (refs.length === 0) return null;
                  return (
                    <span key={kind}>
                      {gi > 0 && <div className="h-menu-sep" role="separator" />}
                      {refs.map(r => (
                        <button key={r.name} role="menuitemradio" aria-checked={state.ref === r.name}
                                className={state.ref === r.name ? 'active' : ''} title={r.name}
                                onClick={() => { if (workingTreeId) setHistoryRef(workingTreeId, r.name); setOpenMenu(null); }}>
                          <span className="ck">{state.ref === r.name ? '✓' : ''}</span>{r.shortName}
                          <span className="sub">{kind === 'tag' ? 'tag' : kind === 'remote' ? 'remote' : ''}</span>
                        </button>
                      ))}
                    </span>
                  );
                })}
              </div>
            </>
          )}
        </span>
        <span className="h-menu-anchor">
          <button className={`h-chip${state.author ? ' on' : ''}`} aria-haspopup="menu"
                  aria-expanded={openMenu === 'author'} title={t('history.filter.authorTitle')}
                  onClick={() => { setOpenMenu(m => (m === 'author' ? null : 'author')); setMenuSearch(''); }}>
            <Icon d={I.author} size={10} stroke={1.8} />
            <span className="v">{authorLabel}</span>
            <span className="caret">▾</span>
          </button>
          {openMenu === 'author' && (
            <>
              <div className="h-menu-backdrop" onClick={() => setOpenMenu(null)} />
              <div className="h-menu" role="menu" aria-label={t('history.filter.authorTitle')}>
                <input autoFocus className="h-menu-search" placeholder={t('history.filter.searchAuthors')}
                       aria-label={t('history.filter.searchAuthors')}
                       value={menuSearch} onChange={e => setMenuSearch(e.target.value)} />
                <button role="menuitemradio" aria-checked={!state.author} className={!state.author ? 'active' : ''}
                        onClick={() => { if (workingTreeId) setHistoryAuthor(workingTreeId, null); setOpenMenu(null); }}>
                  <span className="ck">{!state.author ? '✓' : ''}</span>{t('history.filter.allAuthors')}
                </button>
                {state.availableAuthors
                  .filter(a => !menuSearch
                    || a.name.toLowerCase().includes(menuSearch.toLowerCase())
                    || a.email.toLowerCase().includes(menuSearch.toLowerCase()))
                  .map(a => (
                    <button key={a.email} role="menuitemradio" aria-checked={state.author === a.email}
                            className={state.author === a.email ? 'active' : ''}
                            onClick={() => { if (workingTreeId) setHistoryAuthor(workingTreeId, a.email); setOpenMenu(null); }}>
                      <span className="ck">{state.author === a.email ? '✓' : ''}</span>{a.name}
                      <span className="sub">{a.email}</span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </span>
        {(state.ref || state.author) && (
          <button className="h-chip" title={t('history.filter.clear')}
                  onClick={() => workingTreeId && clearHistoryFilters(workingTreeId)}>
            <span className="x">✕</span>
          </button>
        )}
      </div>

      <div className="insp-scroll" ref={scrollRef}
           onScroll={e => workingTreeId && saveHistoryScroll(workingTreeId, e.currentTarget.scrollTop)}>
        {!workingTreeId ? (
          <div className="insp-note">{t('history.noTree')}</div>
        ) : state.moved && (
          <div className="h-moved" role="status">
            <Icon d={I.warnTri} size={12} stroke={1.7} />
            <span>
              {t('history.moved')}
              <span className="lnk" role="button" tabIndex={0}
                    onClick={() => dismissHistoryMoved(workingTreeId)}
                    onKeyDown={e => e.key === 'Enter' && dismissHistoryMoved(workingTreeId)}>
                {t('common.dismiss')}
              </span>
            </span>
          </div>
        )}

        {workingTreeId && state.status === 'loading' && state.items.length === 0 && (
          <div className="insp-note"><span className="spinner" aria-hidden="true" /> {t('history.loading')}</div>
        )}
        {workingTreeId && state.status === 'error' && state.items.length === 0 && (
          <div className="h-empty">
            <span className="t">{t('history.loadFailed')}</span>
            {state.error && <span className="s">{state.error}</span>}
            <button className="btn secondary sm" onClick={runRefresh}>{t('common.retry')}</button>
          </div>
        )}
        {workingTreeId && state.status === 'error' && state.items.length > 0 && (
          <div className="h-foot-err h-refresh-err" role="alert">
            <Icon d={I.warnTri} size={12} stroke={1.7} />
            <span title={state.error ?? undefined}>{t('history.loadFailed')}</span>
            <button className="btn secondary sm" onClick={runRefresh}>{t('common.retry')}</button>
          </div>
        )}
        {workingTreeId && state.status === 'ready' && state.snapshot === null && (
          <div className="h-empty">
            <Icon d={I.history} size={26} stroke={1.4} />
            <span className="t">{t('history.empty.title')}</span>
            <span className="s">{t('history.empty.sub')}</span>
          </div>
        )}
        {workingTreeId && state.status !== 'idle' && state.snapshot !== null && state.items.length === 0 && state.status === 'ready' && (
          <div className="h-empty">
            <Icon d={I.search} size={26} stroke={1.4} />
            <span className="t">{t('history.noMatch')}{state.query ? ` “${state.query}”` : ''}</span>
            <span className="s">{t('history.noMatchSub')}</span>
            {filtersActive && (
              <button className="btn secondary sm"
                      onClick={() => {
                        setSearchDraftState({ workingTreeId, value: '' });
                        clearHistoryFilters(workingTreeId);
                      }}>
                {t('history.filter.clear')}
              </button>
            )}
          </div>
        )}

        {state.items.length > 0 && (
          <div className="h-list" role="listbox" aria-label={t('history.listbox')}>
            {listRows.map((row, i) => row.type === 'day' ? (
              <div className="h-day" key={`day-${row.label}-${i}`}>
                <span className="g"><DayGraphCell lanes={row.lanes} /></span>
                <span>{row.label}</span>
              </div>
            ) : (
              <div
                key={row.commit.sha}
                className={`h-row${selectedSha === row.commit.sha ? ' sel' : ''}`}
                role="option"
                aria-selected={selectedSha === row.commit.sha}
                tabIndex={(focusSha ?? selectedSha ?? state.items[0]?.sha) === row.commit.sha ? 0 : -1}
                data-sha={row.commit.sha.slice(0, 7)}
                title={`${row.commit.subject} — ${row.commit.sha.slice(0, 7)} · ${row.commit.author.name}`}
                onClick={() => openCommit(row.commit, false)}
                onDoubleClick={() => openCommit(row.commit, true)}
                onKeyDown={e => onListKeyDown(e, row.commit)}
                onFocus={() => setFocusState({ workingTreeId: workingTreeId!, sha: row.commit.sha })}
              >
                <span className="g">
                  <GraphCell row={row.graph} head={headSha === row.commit.sha}
                             selected={selectedSha === row.commit.sha} />
                </span>
                <span className="c">
                  <span className="l1">
                    {refChips(row.commit)}
                    <span className="subject">{row.commit.subject}</span>
                  </span>
                  <span className="l2">
                    <span className="sha">{row.commit.sha.slice(0, 7)}</span>
                    <span className="sep">·</span>
                    <span className="who">{row.commit.author.name}</span>
                    {row.commit.isMerge && <span className="merge-tag">{t('history.tag.merge')}</span>}
                    {row.commit.isRoot && <span className="merge-tag">{t('history.tag.root')}</span>}
                    <span className="when">{relTime(row.commit.authoredAt)}</span>
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}

        {workingTreeId && state.items.length > 0 && (
          <div className="h-foot">
            {state.loadMoreError ? (
              <div className="h-foot-err" role="alert">
                <Icon d={I.warnTri} size={12} stroke={1.7} />
                <span>{t('history.loadMoreFailed')}</span>
                <button className="btn secondary sm" onClick={() => loadMoreHistory(workingTreeId)}>{t('common.retry')}</button>
              </div>
            ) : state.nextCursor ? (
              <button className="btn secondary sm" data-testid="history-load-more"
                      disabled={state.loadingMore}
                      onClick={() => loadMoreHistory(workingTreeId)}>
                {state.loadingMore ? <><span className="spinner" /> {t('history.loadingMore')}</> : t('history.loadMore')}
              </button>
            ) : null}
            <span className="count">
              {t('history.count').replace('{n}', String(state.items.length))}{state.nextCursor ? '' : ` · ${t('history.countEnd')}`}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
